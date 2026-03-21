'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('whatsapp-adapter');

const WHATSAPP_CONFIG = {
  API_URL: process.env.WHATSAPP_API_URL
    || '/* TBC: WhatsApp Business API base URL (Meta Cloud API or on-premises) */',
  PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID
    || '/* TBC: SAINS WhatsApp Business Phone Number ID from Meta */',
  ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN
    || '/* TBC: WhatsApp Business API permanent access token from Meta — store in BTP Credential Store */',
  BUSINESS_ACCOUNT_ID: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID
    || '/* TBC: SAINS WhatsApp Business Account ID from Meta */',
  // Message templates must be pre-approved by Meta before use.
  // Template names below are examples — register these exact names in Meta Business Manager.
  TEMPLATES: {
    INVOICE_NOTIFICATION: 'sains_invoice_notification',   // Language: ms
    PAYMENT_REMINDER:     'sains_payment_reminder',
    PAYMENT_CONFIRMATION: 'sains_payment_confirmation',
    PTP_CONFIRMATION:     'sains_ptp_confirmation',
    DISCONNECTION_NOTICE: 'sains_disconnection_notice',
    QR_PAYMENT_LINK:      'sains_qr_payment_link',
  },
};

/**
 * Send a WhatsApp template message to a customer.
 * Messages MUST use pre-approved Meta templates — free-text messages
 * require an active conversation window (24 hours from last customer message).
 *
 * @param {String} toPhone     - Malaysian mobile (+60XXXXXXXXX)
 * @param {String} templateName - Approved template name
 * @param {String} language    - ms | en | zh_CN | ta
 * @param {Array}  components  - Template header, body, button components with variables
 * @returns {{ success, wamID, errorMessage }}
 */
async function sendTemplateMessage(toPhone, templateName, language, components) {
  // Validate phone number format
  if (!/^\+60[0-9]{8,10}$/.test(toPhone)) {
    return { success: false, wamID: null, errorMessage: `Invalid Malaysian phone: ${toPhone}` };
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language },
      components: components || [],
    },
  };

  try {
    const response = await axios.post(
      `${WHATSAPP_CONFIG.API_URL}/${WHATSAPP_CONFIG.PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: {
          'Authorization': `Bearer ${WHATSAPP_CONFIG.ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    const wamID = response.data?.messages?.[0]?.id;
    logger.info(`WhatsApp sent to ${toPhone.substring(0, 7)}XXX template=${templateName} wamID=${wamID}`);
    return { success: true, wamID, errorMessage: null };

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    logger.error(`WhatsApp send failed to ${toPhone.substring(0, 7)}XXX: ${msg}`);
    return { success: false, wamID: null, errorMessage: msg };
  }
}

/**
 * Send a payment reminder with embedded DuitNow QR payment link.
 * Uses the sains_qr_payment_link template with:
 * - {{1}} = Customer name
 * - {{2}} = Account number
 * - {{3}} = Amount due (RM)
 * - {{4}} = Due date (DD/MM/YYYY)
 * - {{5}} = Payment URL (shortened DuitNow QR link)
 *
 * @param {Object} account  - CustomerAccount record
 * @param {Object} invoice  - Invoice record
 * @param {String} language - ms | en
 */
async function sendPaymentReminder(account, invoice, language = 'ms') {
  const db = await cds.connect.to('db');

  // Get QR code for this invoice
  const qrCode = await db.run(
    SELECT.one.from('sains.ar.payment.DuitNowQRCode')
      .columns('qrPayload', 'expiryDate')
      .where({ invoice_ID: invoice.ID, status: 'ACTIVE' })
  );

  const dueDate = new Date(invoice.dueDate);
  const dueDateStr = `${dueDate.getDate().toString().padStart(2,'0')}/${(dueDate.getMonth()+1).toString().padStart(2,'0')}/${dueDate.getFullYear()}`;

  // Payment URL: deep link to iSAINS or web portal pre-filled with account
  const paymentURL = `${process.env.APP_URL || '/* TBC: SAINS portal URL */'}/pay?acc=${account.accountNumber}&inv=${invoice.invoiceNumber}&amt=${invoice.amountOutstanding.toFixed(2)}`;

  const components = [
    {
      type: 'body',
      parameters: [
        { type: 'text', text: account.legalName },
        { type: 'text', text: account.accountNumber },
        { type: 'text', text: `RM ${invoice.amountOutstanding.toFixed(2)}` },
        { type: 'text', text: dueDateStr },
        { type: 'text', text: paymentURL },
      ],
    },
  ];

  const result = await sendTemplateMessage(
    account.primaryPhone,
    WHATSAPP_CONFIG.TEMPLATES.QR_PAYMENT_LINK,
    language,
    components
  );

  // Log the WhatsApp message
  await db.run(INSERT.into('sains.ar.payment.WhatsAppMessage').entries({
    account_ID: account.ID,
    invoice_ID: invoice.ID,
    phoneNumber: account.primaryPhone,
    messageType: 'PAYMENT_REMINDER',
    templateName: WHATSAPP_CONFIG.TEMPLATES.QR_PAYMENT_LINK,
    language,
    messageBody: JSON.stringify(components),
    paymentLink: paymentURL,
    status: result.success ? 'SENT' : 'FAILED',
    wamID: result.wamID,
    sentAt: result.success ? new Date().toISOString() : null,
    failureReason: result.errorMessage,
  }));

  return result;
}

/**
 * Process incoming WhatsApp message (customer reply or opt-out).
 * Called from the webhook endpoint.
 *
 * @param {Object} webhookBody - WhatsApp webhook payload
 */
async function processIncomingMessage(webhookBody) {
  const db = await cds.connect.to('db');

  const entries = webhookBody?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      const messages = change?.value?.messages || [];
      for (const msg of messages) {
        if (msg.type === 'text' && msg.text?.body) {
          const body = msg.text.body.toLowerCase().trim();
          // Handle opt-out keywords
          if (['stop', 'berhenti', 'unsubscribe', 'opt out'].includes(body)) {
            await _handleOptOut(msg.from);
          }
        }
        // Handle statuses (delivered, read)
        const statuses = change?.value?.statuses || [];
        for (const status of statuses) {
          await _updateMessageStatus(status.id, status.status, status.timestamp);
        }
      }
    }
  }
}

async function _handleOptOut(phoneNumber) {
  const db = await cds.connect.to('db');
  // Mark all pending messages for this phone as opted out
  await db.run(
    UPDATE('sains.ar.payment.WhatsAppMessage').set({
      customerOptedOut: true,
      optOutAt: new Date().toISOString(),
    }).where({ phoneNumber })
  );
  // Update CustomerAccount to suppress WhatsApp
  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .columns('ID')
      .where({ primaryPhone: phoneNumber.replace(/^\+60/, '0') })
  );
  if (account) {
    await db.run(
      UPDATE('sains.ar.CustomerAccount')
        .set({ whatsAppOptOut: true, whatsAppOptOutAt: new Date().toISOString() })
        .where({ ID: account.ID })
    );
  }
  logger.info(`WhatsApp opt-out recorded for ${phoneNumber.substring(0, 7)}XXX`);
}

async function _updateMessageStatus(wamID, status, timestamp) {
  const db = await cds.connect.to('db');
  const updates = {};
  if (status === 'delivered') updates.deliveredAt = new Date(timestamp * 1000).toISOString();
  if (status === 'read') updates.readAt = new Date(timestamp * 1000).toISOString();
  if (status === 'failed') updates.status = 'FAILED';

  if (Object.keys(updates).length > 0) {
    updates.status = status === 'failed' ? 'FAILED' : status === 'read' ? 'READ' : 'DELIVERED';
    await db.run(
      UPDATE('sains.ar.payment.WhatsAppMessage').set(updates).where({ wamID })
    );
  }
}

module.exports = {
  sendTemplateMessage,
  sendPaymentReminder,
  processIncomingMessage,
};
