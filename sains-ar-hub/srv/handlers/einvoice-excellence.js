'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const {
  buildInvoiceDocument, signDocument, submitDocuments,
  cancelDocument, isWithinCancellationWindow, getCancellationDeadline,
  buildConsolidatedB2CDocument, MYINVOIS_CONFIG,
} = require('../external/myinvois-adapter');
const { logAction, logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('einvoice-excellence');

/**
 * Submit a single invoice to LHDN MyInvois.
 * Used for individual B2B e-invoices and on-demand B2C requests.
 */
async function submitInvoiceToLHDN(invoiceID) {
  const db = await cds.connect.to('db');

  const invoice = await db.run(
    SELECT.one.from('sains.ar.Invoice')
      .columns('*')
      .where({ ID: invoiceID })
  );
  if (!invoice) throw new Error(`Invoice ${invoiceID} not found`);
  if (!invoice.einvoiceRequired) throw new Error(`Invoice ${invoiceID} does not require e-invoice`);
  if (invoice.einvoiceStatus === 'ACCEPTED') {
    throw new Error(`Invoice ${invoiceID} already accepted by LHDN`);
  }
  if (invoice.einvoiceStatus === 'HELD_NO_TIN') {
    throw new Error(`Invoice ${invoiceID} held — buyer TIN not verified`);
  }

  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount').where({ ID: invoice.account_ID })
  );
  const lineItems = await db.run(
    SELECT.from('sains.ar.InvoiceLineItem').where({ invoice_ID: invoiceID })
  );

  const documentUUID = cds.utils.uuid();
  const document = buildInvoiceDocument(invoice, account, lineItems, documentUUID);
  const signedDocument = await signDocument(document);

  // Validate payload size
  const docSize = JSON.stringify(signedDocument).length;
  if (docSize > MYINVOIS_CONFIG.MAX_INVOICE_SIZE_BYTES) {
    throw new Error(`Invoice document size ${docSize} bytes exceeds 300KB LHDN limit`);
  }

  // Create submission batch
  const batchID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.einvoice.EInvoiceSubmissionBatch').entries({
    ID: batchID,
    batchDate: new Date().toISOString().substring(0, 10),
    invoiceType: 'INDIVIDUAL',
    documentCount: 1,
    submittedAt: new Date().toISOString(),
    status: 'SUBMITTED',
  }));

  try {
    const result = await submitDocuments([{ uuid: documentUUID, document: signedDocument }]);

    const accepted = result.acceptedDocuments?.find(d => d.uuid === documentUUID);
    const rejected = result.rejectedDocuments?.find(d => d.uuid === documentUUID);

    if (accepted) {
      const lhdnUUID = accepted.longId || accepted.uuid;
      const validationDate = new Date().toISOString();
      const cancelDeadline = getCancellationDeadline(validationDate);

      // Update invoice
      await db.run(UPDATE('sains.ar.Invoice').set({
        einvoiceStatus: 'ACCEPTED',
        einvoiceUUID: lhdnUUID,
        einvoiceSubmittedAt: validationDate,
        einvoiceCancelDeadline: cancelDeadline.toISOString(),
        einvoiceSequenceNo: invoice.invoiceNumber,
      }).where({ ID: invoiceID }));

      // Update submission line
      await db.run(INSERT.into('sains.ar.einvoice.EInvoiceSubmissionLine').entries({
        ID: cds.utils.uuid(),
        batch_ID: batchID,
        invoice_ID: invoiceID,
        lineSequence: 1,
        documentUUID,
        invoiceNumber: invoice.invoiceNumber,
        buyerTIN: account.buyerTIN || MYINVOIS_CONFIG.B2C_PLACEHOLDER_TIN,
        buyerName: account.legalName,
        totalExcludingTax: invoice.totalAmount - (invoice.taxAmount || 0),
        taxAmount: invoice.taxAmount || 0,
        totalIncludingTax: invoice.totalAmount,
        status: 'ACCEPTED',
        lhdnUUID,
        lhdnValidationDate: validationDate,
        cancelDeadline: cancelDeadline.toISOString(),
      }));

      await db.run(UPDATE('sains.ar.einvoice.EInvoiceSubmissionBatch').set({
        status: 'FULLY_ACCEPTED', acceptedCount: 1, lhdnSubmissionUID: result.submissionUID,
      }).where({ ID: batchID }));

      return { success: true, lhdnUUID, cancelDeadline };

    } else if (rejected) {
      const errorMsg = JSON.stringify(rejected.error || rejected);
      await db.run(UPDATE('sains.ar.Invoice').set({
        einvoiceStatus: 'REJECTED',
      }).where({ ID: invoiceID }));
      await _logError(db, batchID, invoiceID, 'REJECTED', errorMsg);
      return { success: false, lhdnUUID: null, cancelDeadline: null, errorMessage: errorMsg };
    }

  } catch (err) {
    await db.run(UPDATE('sains.ar.Invoice').set({ einvoiceStatus: 'FAILED' }).where({ ID: invoiceID }));
    await db.run(UPDATE('sains.ar.einvoice.EInvoiceSubmissionBatch').set({
      status: 'FAILED', errorSummary: JSON.stringify([err.message]),
    }).where({ ID: batchID }));
    await _logError(db, batchID, invoiceID, 'NETWORK', err.message);
    throw err;
  }
}

/**
 * Cancel an e-invoice within the 72-hour window.
 */
async function cancelEInvoiceWithLHDN(invoiceID, reason) {
  const db = await cds.connect.to('db');

  const invoice = await db.run(
    SELECT.one.from('sains.ar.Invoice').where({ ID: invoiceID })
  );
  if (!invoice) throw new Error(`Invoice ${invoiceID} not found`);
  if (invoice.einvoiceStatus !== 'ACCEPTED') {
    throw new Error(`Invoice ${invoiceID} is not in ACCEPTED status — cannot cancel`);
  }
  if (!invoice.einvoiceUUID) {
    throw new Error(`Invoice ${invoiceID} has no LHDN UUID — cannot cancel`);
  }
  if (!isWithinCancellationWindow(invoice.einvoiceSubmittedAt)) {
    throw new Error(
      `72-hour cancellation window has expired for invoice ${invoice.invoiceNumber}. ` +
      `Issue a Credit Note instead.`
    );
  }

  const result = await cancelDocument(invoice.einvoiceUUID, reason);

  if (result.success) {
    await db.run(UPDATE('sains.ar.Invoice').set({
      einvoiceStatus: 'CANCELLED',
    }).where({ ID: invoiceID }));

    await db.run(
      UPDATE('sains.ar.einvoice.EInvoiceSubmissionLine').set({
        status: 'CANCELLED',
        cancelledAt: new Date().toISOString(),
        cancellationReason: reason,
      }).where({ invoice_ID: invoiceID })
    );
  }

  return result;
}

/**
 * Submit consolidated B2C e-invoice for a billing period.
 * All domestic B2C invoices for the month aggregated into one submission.
 * Must be submitted within 7 calendar days of month-end.
 */
async function submitMonthlyConsolidatedB2C(year, month) {
  const db = await cds.connect.to('db');
  const periodStr = `${year}-${String(month).padStart(2, '0')}`;
  const fromDate = `${periodStr}-01`;
  const toDate = dayjs(`${periodStr}-01`).endOf('month').format('YYYY-MM-DD');
  const deadline = dayjs(`${periodStr}-01`).endOf('month').add(7, 'day').format('YYYY-MM-DD');

  // Get all B2C invoices for the period
  const invoices = await db.run(
    SELECT.from('sains.ar.Invoice')
      .columns('ID', 'invoiceNumber', 'totalAmount', 'taxAmount', 'invoiceDate', 'account_ID')
      .where({
        invoiceDate: { between: fromDate, and: toDate },
        einvoiceRequired: false,      // B2C domestic invoices
        status: { '!=': 'REVERSED' },
      })
  );

  if (invoices.length === 0) {
    logger.info(`Consolidated B2C: no B2C invoices for ${periodStr}`);
    return { batchID: null, documentCount: 0 };
  }

  const documentUUID = cds.utils.uuid();
  const document = buildConsolidatedB2CDocument(year, month, invoices, documentUUID);
  const signedDocument = await signDocument(document);

  const batchID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.einvoice.ConsolidatedB2CBatch').entries({
    ID: batchID,
    periodYear: year,
    periodMonth: month,
    invoiceDate: toDate,
    submissionDeadline: deadline,
    totalTransactions: invoices.length,
    totalAmount: invoices.reduce((s, i) => s + Number(i.totalAmount), 0),
    taxAmount: invoices.reduce((s, i) => s + Number(i.taxAmount || 0), 0),
    status: 'READY',
    documentUUID,
  }));

  try {
    const result = await submitDocuments([{ uuid: documentUUID, document: signedDocument }]);
    const accepted = result.acceptedDocuments?.find(d => d.uuid === documentUUID);

    if (accepted) {
      const lhdnUUID = accepted.longId || accepted.uuid;
      const validationDate = new Date().toISOString();

      await db.run(UPDATE('sains.ar.einvoice.ConsolidatedB2CBatch').set({
        status: 'ACCEPTED',
        lhdnUUID,
        lhdnValidationDate: validationDate,
        cancelDeadline: getCancellationDeadline(validationDate).toISOString(),
      }).where({ ID: batchID }));

      logger.info(`Consolidated B2C ${periodStr}: accepted by LHDN UUID=${lhdnUUID}`);
      return { batchID, documentCount: invoices.length, lhdnUUID };
    } else {
      await db.run(UPDATE('sains.ar.einvoice.ConsolidatedB2CBatch').set({ status: 'REJECTED' }).where({ ID: batchID }));
      throw new Error(`Consolidated B2C ${periodStr} rejected by LHDN`);
    }
  } catch (err) {
    await db.run(UPDATE('sains.ar.einvoice.ConsolidatedB2CBatch').set({ status: 'REJECTED' }).where({ ID: batchID }));
    throw err;
  }
}

/**
 * Submit all PENDING individual e-invoices in a batch.
 * Runs hourly. Groups invoices into batches of 100 respecting the 5MB limit.
 */
async function submitPendingIndividualQueue() {
  const db = await cds.connect.to('db');

  const pendingInvoices = await db.run(
    SELECT.from('sains.ar.Invoice')
      .columns('ID', 'invoiceNumber', 'invoiceDate', 'account_ID',
               'totalAmount', 'taxAmount', 'einvoiceStatus', 'einvoiceRequired')
      .where({ einvoiceRequired: true, einvoiceStatus: { in: ['PENDING', 'FAILED'] } })
      .limit(MYINVOIS_CONFIG.MAX_INVOICES_PER_SUBMISSION)
  );

  if (pendingInvoices.length === 0) return { submitted: 0, failed: 0 };

  let submitted = 0, failed = 0;

  for (const invoice of pendingInvoices) {
    try {
      await submitInvoiceToLHDN(invoice.ID);
      submitted++;
    } catch (err) {
      logger.error(`Individual queue: failed to submit ${invoice.invoiceNumber}: ${err.message}`);
      failed++;
    }
  }

  return { submitted, failed };
}

async function _logError(db, batchID, invoiceID, errorCategory, errorMessage) {
  await db.run(INSERT.into('sains.ar.einvoice.EInvoiceErrorLog').entries({
    ID: cds.utils.uuid(),
    submissionBatch_ID: batchID,
    invoice_ID: invoiceID,
    occurredAt: new Date().toISOString(),
    errorCategory,
    errorMessage: errorMessage.substring(0, 2000),
    resolved: false,
  }));
}

module.exports = {
  submitInvoiceToLHDN,
  cancelEInvoiceWithLHDN,
  submitMonthlyConsolidatedB2C,
  submitPendingIndividualQueue,
};
