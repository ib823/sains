'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const dayjs = require('dayjs');
const { logAction } = require('../lib/audit-logger');
const { EINVOICE_CANCEL_WINDOW_HOURS } = require('../lib/constants');

const logger = cds.log('einvoice-adapter');
const DESTINATION_NAME = 'SAINS_EINVOICE_MW';

async function submitInvoice(invoice, account) {
  if (!invoice.einvoiceRequired) return null;
  if (invoice.einvoiceStatus === 'HELD_NO_TIN') {
    logger.warn(`Invoice ${invoice.invoiceNumber} held — no verified Buyer TIN`);
    return null;
  }

  const dest = await _getDestination();
  const payload = _buildMyInvoisPayload(invoice, account);

  try {
    const response = await axios.post(`${dest.url}/submit`, payload, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      timeout: 60000,
      auth: dest.auth,
    });

    const uuid = response.data?.uuid || response.data?.UUID || null;
    logger.info(`eInvoice submitted for ${invoice.invoiceNumber} — UUID: ${uuid}`);
    return { success: true, uuid, errorMessage: null };
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    logger.error(`eInvoice submission failed for ${invoice.invoiceNumber}: ${msg}`);
    return { success: false, uuid: null, errorMessage: msg };
  }
}

async function cancelInvoice(invoice, reason) {
  if (!invoice.einvoiceUUID) return { success: false, errorMessage: 'No UUID on invoice — never submitted' };

  const submittedAt = dayjs(invoice.einvoiceSubmittedAt);
  const hoursElapsed = dayjs().diff(submittedAt, 'hour');
  if (hoursElapsed > EINVOICE_CANCEL_WINDOW_HOURS) {
    return {
      success: false,
      errorMessage: `Cannot cancel — ${hoursElapsed} hours since submission (max ${EINVOICE_CANCEL_WINDOW_HOURS} hours). Raise a credit note instead.`
    };
  }

  const dest = await _getDestination();
  try {
    await axios.delete(`${dest.url}/cancel/${invoice.einvoiceUUID}`,
      { data: { reason }, timeout: 60000, auth: dest.auth }
    );
    return { success: true, errorMessage: null };
  } catch (error) {
    return { success: false, errorMessage: error.response?.data?.message || error.message };
  }
}

function _buildMyInvoisPayload(invoice, account) {
  return {
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.invoiceDate,
    invoiceType: _mapInvoiceTypeCode(invoice.invoiceType),
    currency: 'MYR',
    supplierTIN: process.env.SAINS_TIN || 'C20654321090', // MOCK: confirm SAINS TIN with Finance during Blueprint
    supplierSSTNumber: process.env.SAINS_SST_NUMBER || 'W10-2345-67890123', // MOCK: confirm SAINS SST Number with Finance during Blueprint
    supplierName: 'Syarikat Air Negeri Sembilan Sdn Bhd',
    supplierAddress: _buildSAINSAddress(),
    buyerTIN: account.buyerTIN || '',
    buyerName: account.legalName,
    buyerAddress: _formatAddress(account),
    lineItems: (invoice.lineItems || []).map(li => ({
      description: li.description || li.chargeType?.name || li.chargeType_code,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      lineAmount: li.lineAmount,
      taxCategory: li.taxCategory,
      taxAmount: li.taxAmount || 0,
    })),
    totalExcludingTax: invoice.totalAmount - (invoice.taxAmount || 0),
    taxAmount: invoice.taxAmount || 0,
    totalPayable: invoice.totalAmount,
    originalInvoiceUUID: invoice.originalInvoiceID ? undefined : undefined,
  };
}

function _mapInvoiceTypeCode(invoiceType) {
  const map = { STANDARD: '01', MANUAL: '01', ESTIMATED: '01',
                CREDIT_NOTE: '02', DEBIT_NOTE: '03', ADJUSTMENT: '02' };
  return map[invoiceType] || '01';
}

function _formatAddress(account) {
  return [account.serviceAddress1, account.serviceAddress2,
          account.serviceCity, account.serviceState, account.servicePostcode]
    .filter(Boolean).join(', ');
}

function _buildSAINSAddress() {
  return 'Syarikat Air Negeri Sembilan Sdn Bhd, Seremban, Negeri Sembilan';
}

async function _getDestination() {
  const destService = await cds.connect.to('destination');
  const dest = await destService.getDestination(DESTINATION_NAME);
  if (!dest) throw new Error(`Destination ${DESTINATION_NAME} not configured in BTP Cockpit.`);
  return dest;
}

module.exports = { submitInvoice, cancelInvoice };
