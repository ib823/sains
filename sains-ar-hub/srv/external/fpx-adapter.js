'use strict';

const cds = require('@sap/cds');
const crypto = require('crypto');
const axios = require('axios');
const { PAYMENT_CHANNEL } = require('../lib/constants');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('fpx-adapter');

// ── FPX CONFIGURATION ────────────────────────────────────────────────────────
// SAINS registers as an FPX merchant with PayNet.
// The merchant ID, IPN secret, and callback URL are obtained during registration.

const FPX_CONFIG = {
  MERCHANT_ID: process.env.FPX_MERCHANT_ID
    || '/* TBC: SAINS FPX Merchant ID from PayNet merchant registration */',
  IPN_VERIFICATION_URL: process.env.FPX_IPN_VERIFY_URL
    || '/* TBC: FPX IPN verification endpoint from PayNet */',
  SELLER_EXCHANGE_ID: process.env.FPX_SELLER_EXCHANGE_ID
    || '/* TBC: FPX Seller Exchange ID from PayNet */',
  SHARED_SECRET: process.env.FPX_SHARED_SECRET
    || '/* TBC: FPX shared secret for HMAC verification — store in BTP Credential Store / Vault */',
  PAYMENT_PAGE_URL: process.env.FPX_PAYMENT_PAGE_URL
    || '/* TBC: FPX payment page URL for customer redirect from iSAINS */',
  // Standard FPX parameters
  SELLER_ORDER_PREFIX: 'SAINS-FPX-',
  CURRENCY: 'MYR',
  COUNTRY: 'MY',
  LANGUAGE: 'ms',
};

/**
 * Validate an FPX IPN (Instant Payment Notification) webhook signature.
 * FPX signs the callback with HMAC-SHA256 using the merchant's shared secret.
 * Verification is mandatory before processing any payment notification.
 *
 * FPX IPN standard fields (POST form data or JSON, TBC with PayNet):
 * fpx_msgToken       - FPX message token (unique transaction identifier)
 * fpx_msgType        - Message type ('AR' = Payment Response)
 * fpx_sellerOrderNo  - SAINS-assigned order reference
 * fpx_sellerExId     - Seller Exchange ID
 * fpx_txnStatus      - Transaction status ('00' = approved, other = declined)
 * fpx_debitAuthCode  - Debit authorisation code
 * fpx_debitAuthNo    - Debit authorisation number
 * fpx_creditAuthCode - Credit authorisation code
 * fpx_creditAuthNo   - Credit authorisation number
 * fpx_buyerBankId    - Buyer's bank FI code
 * fpx_txnAmount      - Transaction amount (RM, 2 decimal places as string)
 * fpx_checkSum       - HMAC-SHA256 checksum of all fields
 *
 * TBC: Confirm exact FPX IPN field names and checksum algorithm with PayNet
 *
 * @param {Object} payload   - FPX IPN payload (parsed POST body)
 * @returns {Boolean}
 */
function validateIPNSignature(payload) {
  if (!payload || !payload.fpx_checkSum) {
    logger.warn('FPX IPN: no checksum in payload');
    return false;
  }

  // Build the string to verify — sorted field names, pipe-delimited
  // /* TBC: Confirm exact field ordering and delimiter with PayNet FPX Merchant Integration Guide */
  const fieldsToSign = Object.keys(payload)
    .filter(k => k !== 'fpx_checkSum' && k.startsWith('fpx_'))
    .sort()
    .map(k => `${payload[k]}`)
    .join('|');

  const expected = crypto
    .createHmac('sha256', FPX_CONFIG.SHARED_SECRET)
    .update(fieldsToSign)
    .digest('hex')
    .toUpperCase();

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from((payload.fpx_checkSum || '').toUpperCase(), 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Process an FPX IPN payment notification.
 * This is called when PayNet POSTs the payment result to the AR Hub's webhook endpoint.
 * Creates a PaymentOrchestratorEvent for the clearing engine.
 *
 * @param {Object} payload - FPX IPN payload (parsed POST body)
 * @returns {{ success, eventID, message }}
 */
async function processIPNNotification(payload) {
  const db = await cds.connect.to('db');

  // Status '00' = approved. All other codes = declined/failed.
  // /* TBC: Confirm FPX status code list with PayNet */
  const isApproved = payload.fpx_txnStatus === '00';

  if (!isApproved) {
    logger.info(`FPX IPN: payment declined — status ${payload.fpx_txnStatus} for order ${payload.fpx_sellerOrderNo}`);
    return { success: false, eventID: null, message: `FPX declined: ${payload.fpx_txnStatus}` };
  }

  // Extract account reference from order number (format: SAINS-FPX-{accountNumber}-{timestamp})
  const orderNo = payload.fpx_sellerOrderNo || '';
  const parts = orderNo.replace(FPX_CONFIG.SELLER_ORDER_PREFIX, '').split('-');
  const accountNumber = parts[0]; // First segment after prefix = account number

  if (!accountNumber) {
    logger.error(`FPX IPN: cannot extract account number from order ${orderNo}`);
    return { success: false, eventID: null, message: `Cannot parse account from order ${orderNo}` };
  }

  // Resolve account
  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountStatus')
      .where({ accountNumber })
  );

  const amount = parseFloat(payload.fpx_txnAmount || '0');
  const fpxMsgToken = payload.fpx_msgToken || '';
  const today = new Date().toISOString().substring(0, 10);

  const eventID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.payment.PaymentOrchestratorEvent').entries({
    ID: eventID,
    sourceChannel: PAYMENT_CHANNEL.FPX,
    rawReference: fpxMsgToken,
    payerReference: accountNumber,
    resolvedAccountID: account?.ID || null,
    amount,
    currency: FPX_CONFIG.CURRENCY,
    transactionDate: today,
    transactionTime: null,
    valueDate: today, // FPX typically settles T+1 but T+0 for clearing purposes
    status: account ? 'RESOLVED' : 'SUSPENSE',
    sourceMetadata: JSON.stringify({
      fpxMsgToken,
      fpxSellerOrderNo: orderNo,
      fpxBuyerBankId: payload.fpx_buyerBankId,
      fpxDebitAuthCode: payload.fpx_debitAuthCode,
      fpxDebitAuthNo: payload.fpx_debitAuthNo,
      fpxCreditAuthCode: payload.fpx_creditAuthCode,
      fpxTxnStatus: payload.fpx_txnStatus,
    }),
  }));

  logger.info(`FPX IPN: payment RM ${amount} for ${accountNumber} queued — event ${eventID}`);
  return {
    success: true,
    eventID,
    message: `FPX payment RM ${amount} queued for account ${accountNumber}`,
  };
}

/**
 * Build an FPX payment initiation URL for iSAINS.
 * iSAINS calls this to get the redirect URL when customer chooses FPX payment.
 * Customer is redirected to the FPX payment page. After payment, FPX POSTs
 * the result to the AR Hub's IPN endpoint.
 *
 * @param {String} accountNumber
 * @param {Number} amount
 * @param {String} invoiceNumber  - Reference for the order number
 * @returns {{ paymentURL, orderNo }}
 */
function buildPaymentInitiationURL(accountNumber, amount, invoiceNumber) {
  const orderNo = `${FPX_CONFIG.SELLER_ORDER_PREFIX}${accountNumber}-${Date.now()}`;
  const amountStr = amount.toFixed(2);
  const returnUrl = `${process.env.APP_URL || '/* TBC: AR Hub public URL */'}/payment/fpx/ipn`;

  // Build FPX payment parameters
  // /* TBC: Confirm exact parameter names and order with PayNet FPX Merchant Integration Guide */
  const params = new URLSearchParams({
    fpx_msgType:       'AR',
    fpx_msgToken:      'extended',
    fpx_sellerExId:    FPX_CONFIG.SELLER_EXCHANGE_ID,
    fpx_sellerOrderNo: orderNo,
    fpx_sellerId:      FPX_CONFIG.MERCHANT_ID,
    fpx_sellerBankCode:'MBB0227', // /* TBC: SAINS bank code */
    fpx_txnCurrency:   FPX_CONFIG.CURRENCY,
    fpx_txnAmount:     amountStr,
    fpx_buyerEmail:    '',         // Optional
    fpx_checkSum:      '',         // Will be computed below
    fpx_productDesc:   `SAINS Water Bill ${invoiceNumber}`.substring(0, 100),
    fpx_version:       '7.0',      // /* TBC: FPX version — confirm with PayNet */
    fpx_returnURL:     returnUrl,
    fpx_callbackURL:   returnUrl,
    fpx_language:      FPX_CONFIG.LANGUAGE,
    fpx_buyerBankId:   '',         // Left empty — buyer selects on FPX page
  });

  // Compute checksum
  // /* TBC: Confirm checksum fields and order with PayNet */
  const fieldsForHash = [
    'AR', 'extended',
    FPX_CONFIG.SELLER_EXCHANGE_ID,
    orderNo,
    FPX_CONFIG.MERCHANT_ID,
    'MBB0227',
    FPX_CONFIG.CURRENCY,
    amountStr,
  ].join('|');

  const checkSum = crypto
    .createHmac('sha256', FPX_CONFIG.SHARED_SECRET)
    .update(fieldsForHash)
    .digest('hex')
    .toUpperCase();

  params.set('fpx_checkSum', checkSum);

  const paymentURL = `${FPX_CONFIG.PAYMENT_PAGE_URL}?${params.toString()}`;

  logger.debug(`FPX payment URL built for account ${accountNumber} amount RM ${amountStr}`);
  return { paymentURL, orderNo };
}

module.exports = {
  validateIPNSignature,
  processIPNNotification,
  buildPaymentInitiationURL,
  FPX_CONFIG,
};
