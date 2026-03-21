'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const crypto = require('crypto');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('duitnow-adapter');

const DUITNOW_CONFIG = {
  MERCHANT_ID: process.env.DUITNOW_MERCHANT_ID
    || '/* TBC: SAINS DuitNow Merchant ID from PayNet after merchant registration */',
  MERCHANT_NAME: 'SAINS',
  MERCHANT_CITY: 'SEREMBAN',
  MERCHANT_POSTAL: '70100',
  MERCHANT_COUNTRY: 'MY',
  MERCHANT_CATEGORY_CODE: '4941', // MCC 4941 = Water Supply — standard utility MCC
  CURRENCY_CODE: '458',           // MYR ISO 4217 numeric code
  QR_EXPIRY_DAYS: 14,             // QR expires 14 days after bill date
  WEBHOOK_SECRET: process.env.DUITNOW_WEBHOOK_SECRET
    || '/* TBC: DuitNow webhook HMAC secret from PayNet */',
  WEBHOOK_ENDPOINT: process.env.APP_URL
    ? `${process.env.APP_URL}/payment/processWebhookNotification`
    : '/* TBC: SAINS AR Hub public URL + /payment/processWebhookNotification */',
};

/**
 * Generate an EMVCo-compliant DuitNow QR payload for a specific invoice.
 * Format follows PayNet DuitNow QR specification (based on EMVCo QR Code Specification v1.1).
 *
 * The QR payload is a TLV (Tag-Length-Value) string with CRC16/CCITT checksum.
 *
 * Required fields per PayNet specification:
 * - Tag 00: Payload Format Indicator = "01"
 * - Tag 01: Point of Initiation Method = "12" (dynamic, single-use) or "11" (static)
 * - Tag 26: Merchant Account Information (DuitNow sub-tags)
 *   - Sub-tag 00: GUID = "A0000007200001" (PayNet DuitNow GUID)
 *   - Sub-tag 01: Merchant ID
 *   - Sub-tag 02: Bill Reference (account number, max 30 chars)
 * - Tag 52: Merchant Category Code = "4941"
 * - Tag 53: Transaction Currency = "458" (MYR)
 * - Tag 54: Transaction Amount (conditional, pre-filled for dynamic QR)
 * - Tag 58: Country Code = "MY"
 * - Tag 59: Merchant Name (max 25 chars)
 * - Tag 60: Merchant City (max 15 chars)
 * - Tag 61: Postal Code
 * - Tag 62: Additional Data Field Template
 *   - Sub-tag 05: Reference Label (invoice number, max 25 chars)
 *   - Sub-tag 07: Terminal Label = "BILL PAYMENT"
 * - Tag 63: CRC (4-hex-digit checksum)
 *
 * @param {String} accountNumber - SAINS account number (used as bill reference)
 * @param {String} invoiceNumber - Invoice reference for tag 62
 * @param {Number} amount        - Bill amount in RM (e.g., 123.45)
 * @param {Date}   billDate      - Invoice date (QR expiry = billDate + 14 days)
 * @returns {{ qrPayload, qrImageBase64, expiryDate }}
 */
function generateQRPayload(accountNumber, invoiceNumber, amount, billDate) {
  const billRef = accountNumber.substring(0, 30);  // Max 30 chars per PayNet spec
  const productDetail = 'BAYARAN BILL AIR';         // Max 25 chars
  const merchantName = 'SAINS'.substring(0, 25);    // Max 25 chars

  const amountStr = amount.toFixed(2);              // "123.45"
  const invoiceRef = invoiceNumber.substring(0, 25); // Max 25 chars for tag 62-05

  // Build QR payload as EMVCo TLV string
  function tlv(tag, value) {
    const len = String(value.length).padStart(2, '0');
    return `${tag}${len}${value}`;
  }

  // Tag 26: Merchant Account Information (DuitNow)
  const merchantAcctInfo = [
    tlv('00', 'A0000007200001'),           // PayNet DuitNow GUID
    tlv('01', DUITNOW_CONFIG.MERCHANT_ID),
    tlv('02', billRef),
  ].join('');
  const tag26 = tlv('26', merchantAcctInfo);

  // Tag 62: Additional Data Field Template
  const additionalData = [
    tlv('05', invoiceRef),                 // Reference label = invoice number
    tlv('07', 'BILL PAYMENT'),             // Terminal label
    tlv('08', productDetail),              // Purpose of transaction
  ].join('');
  const tag62 = tlv('62', additionalData);

  // Assemble payload (without CRC)
  const payloadWithoutCRC = [
    tlv('00', '01'),                       // Payload format indicator
    tlv('01', '12'),                       // Dynamic QR (single use)
    tag26,                                 // Merchant account info
    tlv('52', DUITNOW_CONFIG.MERCHANT_CATEGORY_CODE), // MCC 4941
    tlv('53', DUITNOW_CONFIG.CURRENCY_CODE),          // MYR = 458
    tlv('54', amountStr),                  // Pre-filled amount
    tlv('58', DUITNOW_CONFIG.MERCHANT_COUNTRY),       // MY
    tlv('59', merchantName),               // SAINS
    tlv('60', DUITNOW_CONFIG.MERCHANT_CITY),          // SEREMBAN
    tlv('61', DUITNOW_CONFIG.MERCHANT_POSTAL),        // 70100
    tag62,                                 // Additional data
    '6304',                                // CRC tag and 4-char placeholder
  ].join('');

  // CRC16/CCITT checksum over entire string including '6304'
  const crc = _calculateCRC16(payloadWithoutCRC);
  const qrPayload = payloadWithoutCRC + crc;

  // Calculate expiry date
  const expiryDate = new Date(billDate);
  expiryDate.setDate(expiryDate.getDate() + DUITNOW_CONFIG.QR_EXPIRY_DAYS);
  const expiryDateStr = expiryDate.toISOString().substring(0, 10);

  logger.debug(`DuitNow QR generated for account ${accountNumber} invoice ${invoiceNumber}`);

  return {
    qrPayload,
    qrImageBase64: null, // TBC: Generate QR image using 'qrcode' npm package
    expiryDate: expiryDateStr,
  };
}

/**
 * CRC16/CCITT calculation as specified in EMVCo QR Code Specification v1.1 Annex A.
 * Polynomial: 0x1021, Initial value: 0xFFFF
 *
 * @param {String} data - Input string
 * @returns {String} 4-character uppercase hex CRC
 */
function _calculateCRC16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Validate a DuitNow webhook notification received from PayNet.
 * PayNet signs the webhook body with HMAC-SHA256 using the shared secret.
 * The signature is in the 'X-PayNet-Signature' header.
 *
 * @param {String} body      - Raw request body
 * @param {String} signature - Signature from X-PayNet-Signature header
 * @returns {Boolean}
 */
function validateWebhookSignature(body, signature) {
  const expected = crypto
    .createHmac('sha256', DUITNOW_CONFIG.WEBHOOK_SECRET)
    .update(body)
    .digest('hex');
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Process a DuitNow QR push notification from PayNet.
 * Called when a customer scans and pays via DuitNow QR.
 * Creates a PaymentOrchestratorEvent for the orchestrator.
 *
 * @param {Object} payload - Webhook payload from PayNet
 * @returns {{ eventID }}
 */
async function processWebhookNotification(payload) {
  const db = await cds.connect.to('db');

  const {
    merchantID, billRef, amount, payerRef, transDateTime,
    transactionID, status: txStatus
  } = payload;

  if (txStatus !== 'SUCCESS' && txStatus !== 'PENDING_SETTLEMENT') {
    logger.warn(`DuitNow webhook: ignoring status ${txStatus} for billRef ${billRef}`);
    return null;
  }

  // Resolve account
  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountStatus')
      .where({ accountNumber: billRef })
  );

  const eventID = cds.utils.uuid();
  const txDate = transDateTime
    ? new Date(transDateTime).toISOString().substring(0, 10)
    : new Date().toISOString().substring(0, 10);

  await db.run(INSERT.into('sains.ar.payment.PaymentOrchestratorEvent').entries({
    ID: eventID,
    sourceChannel: 'DUITNOW_QR',
    rawReference: transactionID || payerRef,
    payerReference: billRef,
    resolvedAccountID: account?.ID || null,
    amount: Number(amount),
    currency: 'MYR',
    transactionDate: txDate,
    transactionTime: null,
    valueDate: txDate,
    status: account ? 'RESOLVED' : 'SUSPENSE',
    sourceMetadata: JSON.stringify(payload),
  }));

  // Mark QR as paid
  if (account) {
    await db.run(
      UPDATE('sains.ar.payment.DuitNowQRCode').set({
        status: 'PAID',
        paidAt: new Date().toISOString(),
        payerRef,
        paymentEventID: eventID,
      }).where({ account_ID: account.ID, status: 'ACTIVE', billRef })
    );
  }

  logger.info(`DuitNow QR payment received: ${billRef} RM ${amount} event ${eventID}`);
  return { eventID };
}

module.exports = {
  generateQRPayload,
  validateWebhookSignature,
  processWebhookNotification,
  _calculateCRC16,
};
