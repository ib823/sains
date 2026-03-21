'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('emandate-adapter');

// PayNet eMandate API endpoint and credentials
// After registration with PayNet as a Direct Debit Originator
const EMANDATE_CONFIG = {
  API_BASE_URL: process.env.EMANDATE_API_URL
    || '/* TBC: PayNet eMandate API base URL */',
  CLIENT_ID: process.env.EMANDATE_CLIENT_ID
    || '/* TBC: PayNet eMandate Client ID */',
  CLIENT_SECRET: process.env.EMANDATE_CLIENT_SECRET
    || '/* TBC: PayNet eMandate Client Secret — store in BTP Credential Store */',
  ORIGINATOR_ID: process.env.EMANDATE_ORIGINATOR_ID
    || '/* TBC: SAINS Direct Debit Originator ID from PayNet */',
  SERVICE_NAME: 'SAINS Water Bill',
  RETURN_URL: process.env.APP_URL
    ? `${process.env.APP_URL}/payment/emandate-callback`
    : '/* TBC: SAINS AR Hub eMandate callback URL */',
};

/**
 * Initiate an eMandate registration for a customer.
 * Returns a URL for the customer to be redirected to complete registration
 * on the PayNet eMandate portal with their bank.
 *
 * @param {Object} account - CustomerAccount record
 * @param {Object} params  - Registration parameters
 * @returns {{ registrationURL, mandateRef }}
 */
async function initiateRegistration(account, params) {
  const token = await _getAccessToken();
  const mandateRef = `SAINS-MD-${account.accountNumber}-${Date.now()}`;

  try {
    const response = await axios.post(
      `${EMANDATE_CONFIG.API_BASE_URL}/v2/mandate/initiate`,
      {
        originatorId: EMANDATE_CONFIG.ORIGINATOR_ID,
        mandateRef,
        productDescription: EMANDATE_CONFIG.SERVICE_NAME,
        serviceName: EMANDATE_CONFIG.SERVICE_NAME,
        registrationMethod: 'ONLINE',
        callbackUrl: EMANDATE_CONFIG.RETURN_URL,
        maxAmountPerDebit: params.maxAmountPerDebit || 999.99,
        frequency: params.frequency || 'MONTHLY',
        effectiveDate: params.effectiveDate,
        expiryDate: params.expiryDate || null,
        payerName: account.legalName,
        payerEmail: account.emailAddress || null,
        payerPhone: account.primaryPhone || null,
        billRef: account.accountNumber,
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const registrationURL = response.data?.registrationUrl || response.data?.redirectUrl;
    if (!registrationURL) {
      throw new Error('PayNet eMandate: no registration URL in response');
    }

    logger.info(`eMandate registration initiated for account ${account.accountNumber}`);
    return { registrationURL, mandateRef };

  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    logger.error(`eMandate initiation failed: ${msg}`);
    throw new Error(`eMandate initiation failed: ${msg}`);
  }
}

/**
 * Check mandate status from PayNet.
 * Called on callback from PayNet portal after customer completes registration.
 *
 * @param {String} mandateRef - SAINS-assigned mandate reference
 * @returns {{ mandateID, status, bankCode, bankAccountNumber, bankAccountName }}
 */
async function checkMandateStatus(mandateRef) {
  const token = await _getAccessToken();

  try {
    const response = await axios.get(
      `${EMANDATE_CONFIG.API_BASE_URL}/v2/mandate/status/${mandateRef}`,
      {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000,
      }
    );

    return {
      mandateID: response.data?.mandateId,
      status: response.data?.status || 'UNKNOWN',
      bankCode: response.data?.bankCode,
      bankAccountNumber: response.data?.bankAccountNo,
      bankAccountName: response.data?.bankAccountName,
    };
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    logger.error(`eMandate status check failed for ${mandateRef}: ${msg}`);
    throw new Error(`eMandate status check failed: ${msg}`);
  }
}

/**
 * Submit a direct debit instruction to PayNet for a specific account.
 * Called on the billing due date for all ACTIVE mandates.
 *
 * @param {Object} debitRun - eMandateDebitRun record
 * @param {Object} mandate  - eMandate record
 * @returns {{ success, bankRef, returnCode }}
 */
async function submitDebitInstruction(debitRun, mandate) {
  const token = await _getAccessToken();

  try {
    const response = await axios.post(
      `${EMANDATE_CONFIG.API_BASE_URL}/v2/mandate/debit`,
      {
        originatorId: EMANDATE_CONFIG.ORIGINATOR_ID,
        mandateId: mandate.mandateID,
        mandateRef: mandate.mandateRef,
        debitDate: debitRun.debitDate,
        amount: debitRun.amount.toFixed(2),
        currency: 'MYR',
        billRef: `SAINS-DD-${mandate.mandateRef}-${debitRun.runDate}`,
        productDescription: `SAINS Water Bill ${debitRun.runDate}`,
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    return {
      success: true,
      bankRef: response.data?.transactionId || response.data?.bankRef,
      returnCode: null,
    };
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    const returnCode = error.response?.data?.returnCode || 'E999';
    logger.error(`eMandate debit failed for mandate ${mandate.mandateID}: ${msg}`);
    return { success: false, bankRef: null, returnCode, errorMessage: msg };
  }
}

/**
 * Cancel a mandate with PayNet.
 *
 * @param {String} mandateID - PayNet mandate ID
 * @param {String} reason    - Cancellation reason
 * @returns {Boolean}
 */
async function cancelMandateWithPayNet(mandateID, reason) {
  const token = await _getAccessToken();

  try {
    await axios.post(
      `${EMANDATE_CONFIG.API_BASE_URL}/v2/mandate/cancel`,
      {
        originatorId: EMANDATE_CONFIG.ORIGINATOR_ID,
        mandateId: mandateID,
        cancellationReason: reason.substring(0, 255),
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    return true;
  } catch (error) {
    logger.error(`eMandate cancellation failed for ${mandateID}: ${error.message}`);
    return false;
  }
}

async function _getAccessToken() {
  try {
    const response = await axios.post(
      `${EMANDATE_CONFIG.API_BASE_URL}/oauth/token`,
      `grant_type=client_credentials&client_id=${EMANDATE_CONFIG.CLIENT_ID}&client_secret=${EMANDATE_CONFIG.CLIENT_SECRET}`,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );
    return response.data.access_token;
  } catch (error) {
    throw new Error(`eMandate OAuth token failed: ${error.message}`);
  }
}

module.exports = {
  initiateRegistration,
  checkMandateStatus,
  submitDebitInstruction,
  cancelMandateWithPayNet,
};
