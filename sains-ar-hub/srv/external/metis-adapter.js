'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('metis-adapter');

const METIS_CONFIG = {
  API_BASE_URL: process.env.METIS_API_URL
    || '/* TBC: Metis work order system API base URL — from Metis vendor */',
  API_KEY: process.env.METIS_API_KEY
    || '/* TBC: Metis API key — store in BTP Credential Store / Vault */',
  AUTH_METHOD: process.env.METIS_AUTH_METHOD || 'API_KEY',
    // API_KEY | OAUTH2 | BASIC — TBC: confirm with Metis vendor
  WORK_ORDER_TYPE_DISCONNECT: '/* TBC: Metis work order type code for disconnection */',
  WORK_ORDER_TYPE_RECONNECT:  '/* TBC: Metis work order type code for reconnection */',
  REQUEST_TIMEOUT_MS: 30000,
};

/**
 * Create a disconnection work order in Metis.
 * Called after BILSupervisor authorises disconnection in the AR Hub.
 *
 * Payload sent to Metis (TBC — confirm field names with Metis vendor):
 * workOrderType    - Disconnection type code (TBC)
 * accountNumber    - SAINS account number
 * customerName     - Customer legal name
 * serviceAddress   - Full service address
 * meterReference   - Meter reference number
 * authorisationRef - AR Hub authorisation reference
 * authorisedBy     - User ID of authoriser
 * requestedDate    - Requested disconnection date
 * outstandingBalance - RM balance at time of authorisation
 * dunningLevel     - Dunning level at time of authorisation
 * arHubWorkOrderID - AR Hub MetisWorkOrder.ID (for completion callback)
 *
 * @param {Object} account         - CustomerAccount record
 * @param {String} authorisedBy    - User ID
 * @param {UUID}   workOrderID     - MetisWorkOrder.ID (AR Hub side)
 * @returns {{ success, metisWorkOrderRef }}
 */
async function createDisconnectionWorkOrder(account, authorisedBy, workOrderID) {
  const db = await cds.connect.to('db');

  if (!METIS_CONFIG.API_BASE_URL || METIS_CONFIG.API_BASE_URL.startsWith('/*')) {
    logger.warn(`Metis API not configured — logging disconnection work order only`);
    logger.info(`METIS DISCONNECTION: account=${account.accountNumber} workOrder=${workOrderID}`);

    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: 'PENDING',
      metisWorkOrderRef: `TBC-${workOrderID}`,
    }).where({ ID: workOrderID }));

    return { success: false, metisWorkOrderRef: null, reason: 'TBC: Metis API not configured' };
  }

  try {
    const payload = {
      // /* TBC: Confirm exact Metis field names with Metis vendor */
      workOrderType: METIS_CONFIG.WORK_ORDER_TYPE_DISCONNECT,
      externalReference: workOrderID, // AR Hub reference for callback
      accountNumber: account.accountNumber,
      customerName: account.legalName,
      serviceAddress: [
        account.serviceAddress1,
        account.serviceAddress2,
        account.serviceAddress3,
        account.serviceAddress4,
        account.servicePostcode,
        account.serviceCity,
      ].filter(Boolean).join(', '),
      meterReference: account.meterReference,
      authorisedBy,
      authorisationRef: workOrderID,
      requestedDate: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
        .toISOString().substring(0, 10), // T+2 business days
      outstandingBalance: account.balanceOutstanding,
      dunningLevel: account.dunningLevel,
      callbackURL: `${process.env.APP_URL || '/* TBC */'}/integration/receiveMetisCompletion`,
    };

    const headers = _buildHeaders();
    const response = await axios.post(
      `${METIS_CONFIG.API_BASE_URL}/work-orders`,
      payload,
      { headers, timeout: METIS_CONFIG.REQUEST_TIMEOUT_MS }
    );

    const metisRef = response.data?.workOrderId || response.data?.ref || response.data?.id;

    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: 'SENT',
      metisWorkOrderRef: metisRef?.toString().substring(0, 50),
    }).where({ ID: workOrderID }));

    await logSystemAction({
      accountID: account.ID,
      actionType: 'SEND_WORK_ORDER',
      entityType: 'MetisWorkOrder',
      entityID: workOrderID,
      afterState: { metisRef, workOrderType: 'DISCONNECTION', accountNumber: account.accountNumber },
      sourceSystem: 'METIS',
    });

    logger.info(`Metis: Disconnection work order created for ${account.accountNumber} — Metis ref ${metisRef}`);
    return { success: true, metisWorkOrderRef: metisRef?.toString() };

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error(`Metis: Disconnection work order failed for ${account.accountNumber}: ${msg}`);

    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: 'FAILED',
      retryCount: { '+=': 1 },
      lastRetryAt: new Date().toISOString(),
    }).where({ ID: workOrderID }));

    // Alert Finance Admin — manual Metis entry required
    const notif = require('./notification-service');
    await notif.sendSystemAlert({
      type: 'METIS_WORK_ORDER_FAILED',
      subject: `Metis disconnection work order failed — ${account.accountNumber}`,
      body: `Failed to create Metis work order for account ${account.accountNumber}. Error: ${msg}. Manual work order creation in Metis is required. AR Hub authorisation ref: ${workOrderID}.`,
      recipients: 'BILSupervisor',
    });

    return { success: false, metisWorkOrderRef: null, reason: msg };
  }
}

/**
 * Create a reconnection work order in Metis.
 * Called automatically when a TEMP_DISCONNECTED account's balance reaches zero.
 *
 * @param {Object} account         - CustomerAccount record
 * @param {String} paymentReference - Payment that cleared the balance
 * @returns {{ success, metisWorkOrderRef }}
 */
async function createReconnectionWorkOrder(account, paymentReference) {
  const db = await cds.connect.to('db');

  // Create MetisWorkOrder record first
  const workOrderID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.integration.MetisWorkOrder').entries({
    ID: workOrderID,
    account_ID: account.ID,
    workOrderType: 'RECONNECTION',
    status: 'PENDING',
    authorisedBy: 'SYSTEM', // Automatic trigger
    authorisedAt: new Date().toISOString(),
    requestedDate: new Date().toISOString().substring(0, 10), // ASAP
    outstandingBalance: 0,
    dunningLevelAtAuth: 0,
  }));

  if (!METIS_CONFIG.API_BASE_URL || METIS_CONFIG.API_BASE_URL.startsWith('/*')) {
    logger.warn(`Metis API not configured — logging reconnection work order only for ${account.accountNumber}`);
    return { success: false, metisWorkOrderRef: null, reason: 'TBC: Metis API not configured' };
  }

  try {
    const payload = {
      // /* TBC: Confirm exact Metis field names with Metis vendor */
      workOrderType: METIS_CONFIG.WORK_ORDER_TYPE_RECONNECT,
      externalReference: workOrderID,
      accountNumber: account.accountNumber,
      customerName: account.legalName,
      serviceAddress: [account.serviceAddress1, account.serviceCity].filter(Boolean).join(', '),
      meterReference: account.meterReference,
      reason: `Balance cleared by payment ${paymentReference}`,
      requestedDate: new Date().toISOString().substring(0, 10),
      callbackURL: `${process.env.APP_URL || '/* TBC */'}/integration/receiveMetisCompletion`,
    };

    const headers = _buildHeaders();
    const response = await axios.post(
      `${METIS_CONFIG.API_BASE_URL}/work-orders`,
      payload,
      { headers, timeout: METIS_CONFIG.REQUEST_TIMEOUT_MS }
    );

    const metisRef = response.data?.workOrderId || response.data?.ref || response.data?.id;

    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: 'SENT',
      metisWorkOrderRef: metisRef?.toString().substring(0, 50),
    }).where({ ID: workOrderID }));

    logger.info(`Metis: Reconnection work order created for ${account.accountNumber} — Metis ref ${metisRef}`);
    return { success: true, metisWorkOrderRef: metisRef?.toString() };

  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    logger.error(`Metis: Reconnection work order failed for ${account.accountNumber}: ${msg}`);

    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: 'FAILED',
    }).where({ ID: workOrderID }));

    const notif = require('./notification-service');
    await notif.sendSystemAlert({
      type: 'METIS_WORK_ORDER_FAILED',
      subject: `Metis reconnection work order failed — ${account.accountNumber}`,
      body: `Failed to create Metis reconnection work order for account ${account.accountNumber}. Payment ${paymentReference} cleared the balance. Manual reconnection work order required in Metis.`,
      recipients: 'BILSupervisor',
    });

    return { success: false, metisWorkOrderRef: null, reason: msg };
  }
}

function _buildHeaders() {
  if (METIS_CONFIG.AUTH_METHOD === 'API_KEY') {
    return {
      'Authorization': `Bearer ${METIS_CONFIG.API_KEY}`,
      'Content-Type': 'application/json',
      'X-Source': 'SAINS-AR-HUB',
    };
  }
  // /* TBC: Add OAuth2 token fetch if Metis uses OAuth2 */
  return {
    'Authorization': `Bearer ${METIS_CONFIG.API_KEY}`,
    'Content-Type': 'application/json',
  };
}

module.exports = {
  createDisconnectionWorkOrder,
  createReconnectionWorkOrder,
};
