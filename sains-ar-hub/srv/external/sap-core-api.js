'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const { SAP_CORE, GL_POSTING_MAX_RETRIES } = require('../lib/constants');

const logger = cds.log('sap-core-api');
const DESTINATION_NAME = 'SAINS_SAP_CORE';

async function postJournalEntry(payload, batchID) {
  let dest;
  try {
    dest = await _getDestination();
  } catch (destErr) {
    logger.warn(`GL batch ${batchID} — SAP destination not available (POC/dev mode): ${destErr.message}`);
    const mockDocNumber = `DEV-${batchID}-${Date.now()}`;
    // Log to simulator GL posting log
    _logToSimulatorGL(batchID, mockDocNumber, payload);
    return { success: true, documentNumber: mockDocNumber, errorMessage: null, dev: true };
  }

  const token = await _fetchCSRFToken(dest);

  try {
    const response = await axios.post(
      `${dest.url}${SAP_CORE.JOURNAL_ENTRY_API_PATH}/A_JournalEntry`,
      payload,
      {
        headers: {
          'x-csrf-token': token,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'sap-client': dest.sapClient,
        },
        timeout: 30000,
        auth: dest.auth,
      }
    );

    const docNumber = response.data?.d?.AccountingDocument ||
                      response.data?.AccountingDocument || null;
    logger.info(`GL batch ${batchID} accepted by SAP Core — doc ${docNumber}`);
    return { success: true, documentNumber: docNumber, errorMessage: null };

  } catch (error) {
    const msg = _extractErrorMessage(error);
    logger.error(`GL batch ${batchID} rejected by SAP Core: ${msg}`);
    return { success: false, documentNumber: null, errorMessage: msg };
  }
}

async function businessPartnerExists(businessPartnerNumber) {
  let dest;
  try {
    dest = await _getDestination();
  } catch {
    logger.warn(`BP check skipped — SAP destination not available (POC/dev mode)`);
    return true; // Assume exists in dev mode
  }
  try {
    const response = await axios.get(
      `${dest.url}${SAP_CORE.BUSINESS_PARTNER_API_PATH}/A_BusinessPartner('${businessPartnerNumber}')`,
      { headers: { 'Accept': 'application/json' }, timeout: 15000, auth: dest.auth }
    );
    return !!response.data?.d;
  } catch {
    return false;
  }
}

async function _fetchCSRFToken(destination) {
  try {
    const response = await axios.get(
      `${destination.url}${SAP_CORE.JOURNAL_ENTRY_API_PATH}/$metadata`,
      {
        headers: { 'x-csrf-token': 'fetch', 'Accept': 'application/json' },
        timeout: 15000,
        auth: destination.auth,
      }
    );
    return response.headers['x-csrf-token'] || '';
  } catch {
    return '';
  }
}

async function _getDestination() {
  const destService = await cds.connect.to('destination');
  const dest = await destService.getDestination(DESTINATION_NAME);
  if (!dest) {
    throw new Error(`Destination ${DESTINATION_NAME} not found in BTP Destination service. `
      + `Configure this destination in BTP Cockpit per Part 1 Section 6 before deployment.`);
  }
  return dest;
}

function _extractErrorMessage(error) {
  return error.response?.data?.error?.message?.value ||
         error.response?.data?.message ||
         error.message ||
         'Unknown SAP Core API error';
}

async function _logToSimulatorGL(batchID, docNumber, payload) {
  try {
    const db = await cds.connect.to('db');
    const { v4: uuidv4 } = require('uuid');
    const items = payload?.to_JournalEntryItem?.results || [];
    let totalDebit = 0, totalCredit = 0;
    for (const item of items) {
      const amt = parseFloat(item.AmountInTransactionCurrency || 0);
      if (item.DebitCreditCode === 'S') totalDebit += amt;
      else totalCredit += amt;
    }
    await db.run(INSERT.into('sains.simulator.GLPostingLog').entries({
      ID: uuidv4(),
      batchID,
      documentNumber: docNumber,
      companyCode: payload?.CompanyCode || SAP_CORE.COMPANY_CODE,
      documentDate: payload?.DocumentDate,
      postingDate: payload?.PostingDate,
      documentType: payload?.DocumentType || SAP_CORE.DOCUMENT_TYPE_AR,
      totalDebitAmount: totalDebit,
      totalCreditAmount: totalCredit,
      lineCount: items.length,
      payload: JSON.stringify(payload),
      status: 'ACCEPTED',
    }));
  } catch (err) {
    logger.debug(`Simulator GL log skipped: ${err.message}`);
  }
}

module.exports = { postJournalEntry, businessPartnerExists };
