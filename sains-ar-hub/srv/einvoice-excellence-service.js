'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const {
  submitInvoiceToLHDN,
  cancelEInvoiceWithLHDN,
  submitMonthlyConsolidatedB2C,
  submitPendingIndividualQueue,
} = require('./handlers/einvoice-excellence');
const {
  buildInvoiceDocument, submitDocuments, cancelDocument,
  isWithinCancellationWindow, getCancellationDeadline,
  buildConsolidatedB2CDocument, MYINVOIS_CONFIG,
} = require('./external/myinvois-adapter');
const { sendEmail, sendSystemAlert } = require('./external/notification-service');
const { logAction, logSystemAction } = require('./lib/audit-logger');

const logger = cds.log('einvoice-excellence-service');

module.exports = cds.service.impl(async function () {
  const db = await cds.connect.to('db');
  const {
    EInvoiceSubmissionBatch, EInvoiceSubmissionLine,
    ConsolidatedB2CBatch,
    DigitalCertificate,
    EInvoiceErrorLog,
  } = db.entities('sains.ar.einvoice');
  const ar = db.entities('sains.ar');

  // ── SUBMISSION BATCHES ──────────────────────────────────────────────

  this.on('retryBatch', 'SubmissionBatches', async (req) => {
    const { ID } = req.params[0];

    const batch = await SELECT.one.from(EInvoiceSubmissionBatch).where({ ID });
    if (!batch) return req.error(404, 'Submission batch not found');

    // Get rejected/failed lines for retry
    const failedLines = await SELECT.from(EInvoiceSubmissionLine)
      .where({ batch_ID: ID, status: { in: ['REJECTED', 'FAILED'] } });

    if (failedLines.length === 0) {
      return req.error(409, 'No failed or rejected lines to retry');
    }

    let accepted = 0, rejected = 0;

    for (const line of failedLines) {
      try {
        const result = await submitInvoiceToLHDN(line.invoice_ID);
        if (result.success) {
          await UPDATE(EInvoiceSubmissionLine).set({
            status: 'ACCEPTED',
            lhdnUUID: result.lhdnUUID,
            cancelDeadline: result.cancelDeadline,
            retryCount: (line.retryCount || 0) + 1,
            lastRetryAt: new Date().toISOString(),
          }).where({ ID: line.ID });
          accepted++;
        } else {
          await UPDATE(EInvoiceSubmissionLine).set({
            status: 'REJECTED',
            errorMessage: result.errorMessage,
            retryCount: (line.retryCount || 0) + 1,
            lastRetryAt: new Date().toISOString(),
          }).where({ ID: line.ID });
          rejected++;
        }
      } catch (err) {
        await UPDATE(EInvoiceSubmissionLine).set({
          status: 'FAILED',
          errorMessage: err.message,
          retryCount: (line.retryCount || 0) + 1,
          lastRetryAt: new Date().toISOString(),
        }).where({ ID: line.ID });

        await INSERT.into(EInvoiceErrorLog).entries({
          batch_ID: ID,
          line_ID: line.ID,
          invoice_ID: line.invoice_ID,
          errorCode: 'RETRY_FAILED',
          errorMessage: err.message,
          occurredAt: new Date().toISOString(),
        });

        rejected++;
      }
    }

    // Update batch status
    const allLines = await SELECT.from(EInvoiceSubmissionLine).where({ batch_ID: ID });
    const allAccepted = allLines.every(l => l.status === 'ACCEPTED');
    const hasFailures = allLines.some(l => l.status === 'REJECTED' || l.status === 'FAILED');

    await UPDATE(EInvoiceSubmissionBatch).set({
      status: allAccepted ? 'COMPLETED' : (hasFailures ? 'PARTIAL' : 'COMPLETED'),
      lastRetryAt: new Date().toISOString(),
    }).where({ ID });

    await logSystemAction('EINVOICE_BATCH_RETRIED', 'EInvoiceSubmissionBatch', ID, { accepted, rejected });

    logger.info(`E-invoice batch ${ID} retry: ${accepted} accepted, ${rejected} rejected`);
    return { accepted, rejected };
  });

  this.on('cancelSubmission', 'SubmissionBatches', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const batch = await SELECT.one.from(EInvoiceSubmissionBatch).where({ ID });
    if (!batch) return req.error(404, 'Submission batch not found');

    const acceptedLines = await SELECT.from(EInvoiceSubmissionLine)
      .where({ batch_ID: ID, status: 'ACCEPTED' });

    let cancelledCount = 0;
    for (const line of acceptedLines) {
      try {
        const result = await cancelEInvoiceWithLHDN(line.invoice_ID);
        if (result.success) {
          await UPDATE(EInvoiceSubmissionLine).set({
            status: 'CANCELLED',
            cancelledAt: new Date().toISOString(),
            cancellationReason: reason,
          }).where({ ID: line.ID });
          cancelledCount++;
        }
      } catch (err) {
        logger.error(`Failed to cancel line ${line.ID}: ${err.message}`);
        await INSERT.into(EInvoiceErrorLog).entries({
          batch_ID: ID,
          line_ID: line.ID,
          invoice_ID: line.invoice_ID,
          errorCode: 'CANCELLATION_FAILED',
          errorMessage: err.message,
          occurredAt: new Date().toISOString(),
        });
      }
    }

    await UPDATE(EInvoiceSubmissionBatch).set({
      status: 'CANCELLED',
      cancelledBy: req.user.id,
      cancelledAt: new Date().toISOString(),
      cancellationReason: reason,
    }).where({ ID });

    await logAction(req, 'EINVOICE_BATCH_CANCELLED', 'EInvoiceSubmissionBatch', ID, {
      reason, cancelledCount,
    });

    logger.info(`E-invoice batch ${ID} cancelled: ${cancelledCount} lines cancelled`);
    return true;
  });

  // ── CONSOLIDATED BATCHES ────────────────────────────────────────────

  this.on('approveConsolidated', 'ConsolidatedBatches', async (req) => {
    const { ID } = req.params[0];

    const batch = await SELECT.one.from(ConsolidatedB2CBatch).where({ ID });
    if (!batch) return req.error(404, 'Consolidated batch not found');
    if (batch.status !== 'DRAFT' && batch.status !== 'PENDING_APPROVAL') {
      return req.error(409, `Batch status "${batch.status}" cannot be approved`);
    }

    await UPDATE(ConsolidatedB2CBatch).set({
      status: 'READY',
      approvedBy: req.user.id,
      approvedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'CONSOLIDATED_BATCH_APPROVED', 'ConsolidatedB2CBatch', ID, {});

    logger.info(`Consolidated B2C batch ${ID} approved`);
    return true;
  });

  this.on('submitConsolidated', 'ConsolidatedBatches', async (req) => {
    const { ID } = req.params[0];

    const batch = await SELECT.one.from(ConsolidatedB2CBatch).where({ ID });
    if (!batch) return req.error(404, 'Consolidated batch not found');
    if (batch.status !== 'READY') {
      return req.error(409, 'Batch must be in READY status for submission');
    }

    try {
      const result = await submitMonthlyConsolidatedB2C(batch.periodYear, batch.periodMonth);

      await UPDATE(ConsolidatedB2CBatch).set({
        status: 'SUBMITTED',
        lhdnUUID: result.lhdnUUID || null,
        submittedAt: new Date().toISOString(),
      }).where({ ID });

      await logSystemAction('CONSOLIDATED_B2C_SUBMITTED', 'ConsolidatedB2CBatch', ID, {
        lhdnUUID: result.lhdnUUID,
      });

      logger.info(`Consolidated B2C batch ${ID} submitted to LHDN`);
      return { lhdnUUID: result.lhdnUUID || '' };
    } catch (err) {
      await INSERT.into(EInvoiceErrorLog).entries({
        batch_ID: null,
        errorCode: 'CONSOLIDATED_SUBMIT_FAILED',
        errorMessage: err.message,
        occurredAt: new Date().toISOString(),
      });
      return req.error(500, `Submission failed: ${err.message}`);
    }
  });

  // ── ERROR LOGS ──────────────────────────────────────────────────────

  this.on('markResolved', 'ErrorLogs', async (req) => {
    const { ID } = req.params[0];
    const { notes } = req.data;

    const errorLog = await SELECT.one.from(EInvoiceErrorLog).where({ ID });
    if (!errorLog) return req.error(404, 'Error log not found');
    if (errorLog.resolved) {
      return req.error(409, 'Error log already resolved');
    }

    await UPDATE(EInvoiceErrorLog).set({
      resolved: true,
      resolvedBy: req.user.id,
      resolvedAt: new Date().toISOString(),
      resolutionNotes: notes,
    }).where({ ID });

    await logAction(req, 'EINVOICE_ERROR_RESOLVED', 'EInvoiceErrorLog', ID, { notes });

    logger.info(`E-invoice error log ${ID} marked resolved`);
    return true;
  });

  // ── UNBOUND ACTIONS — LHDN SUBMISSION ───────────────────────────────

  this.on('submitInvoiceToLHDN', async (req) => {
    const { invoiceID } = req.data;

    try {
      const result = await submitInvoiceToLHDN(invoiceID);
      return result;
    } catch (err) {
      logger.error(`submitInvoiceToLHDN failed for ${invoiceID}: ${err.message}`);
      await INSERT.into(EInvoiceErrorLog).entries({
        invoice_ID: invoiceID,
        errorCode: 'SUBMISSION_FAILED',
        errorMessage: err.message,
        occurredAt: new Date().toISOString(),
      });
      return {
        success: false,
        lhdnUUID: '',
        cancelDeadline: null,
        errorMessage: err.message,
      };
    }
  });

  this.on('cancelEInvoiceWithLHDN', async (req) => {
    const { invoiceID, reason } = req.data;

    try {
      const result = await cancelEInvoiceWithLHDN(invoiceID);
      return {
        success: result.success,
        errorMessage: result.errorMessage || '',
      };
    } catch (err) {
      logger.error(`cancelEInvoiceWithLHDN failed for ${invoiceID}: ${err.message}`);
      await INSERT.into(EInvoiceErrorLog).entries({
        invoice_ID: invoiceID,
        errorCode: 'CANCELLATION_FAILED',
        errorMessage: err.message,
        occurredAt: new Date().toISOString(),
      });
      return {
        success: false,
        errorMessage: err.message,
      };
    }
  });

  this.on('submitCreditNoteToLHDN', async (req) => {
    const { originalInvoiceID, creditNoteID, reason } = req.data;

    try {
      // Submit the credit note invoice to LHDN
      const result = await submitInvoiceToLHDN(creditNoteID);
      return {
        success: result.success,
        lhdnUUID: result.lhdnUUID || '',
        errorMessage: result.errorMessage || '',
      };
    } catch (err) {
      logger.error(`submitCreditNoteToLHDN failed for credit note ${creditNoteID}: ${err.message}`);
      await INSERT.into(EInvoiceErrorLog).entries({
        invoice_ID: creditNoteID,
        errorCode: 'CREDIT_NOTE_SUBMIT_FAILED',
        errorMessage: err.message,
        occurredAt: new Date().toISOString(),
      });
      return {
        success: false,
        lhdnUUID: '',
        errorMessage: err.message,
      };
    }
  });

  // ── JOB TRIGGER ACTIONS ─────────────────────────────────────────────

  this.on('triggerMonthlyConsolidatedB2C', async (req) => {
    const { year, month } = req.data;

    try {
      const result = await submitMonthlyConsolidatedB2C(year, month);

      logger.info(`Monthly consolidated B2C triggered for ${year}-${month}`);
      return {
        batchID: result.batchID || null,
        documentCount: result.documentCount || 0,
      };
    } catch (err) {
      logger.error(`Monthly consolidated B2C failed: ${err.message}`);
      await INSERT.into(EInvoiceErrorLog).entries({
        errorCode: 'MONTHLY_CONSOLIDATED_FAILED',
        errorMessage: err.message,
        occurredAt: new Date().toISOString(),
      });
      return req.error(500, `Trigger failed: ${err.message}`);
    }
  });

  this.on('triggerIndividualSubmissionQueue', async (req) => {
    try {
      const result = await submitPendingIndividualQueue();

      logger.info(`Individual submission queue processed: ${result.submitted} submitted, ${result.failed} failed`);
      return result;
    } catch (err) {
      logger.error(`Individual submission queue failed: ${err.message}`);
      return { submitted: 0, failed: 0 };
    }
  });

  this.on('triggerCancellationDeadlineAlert', async (req) => {
    let alertsSent = 0;

    try {
      // Find invoices where cancel deadline is within 4 hours
      const fourHoursFromNow = dayjs().add(4, 'hour').toISOString();
      const now = new Date().toISOString();

      const urgentLines = await SELECT.from(EInvoiceSubmissionLine)
        .where({
          status: 'ACCEPTED',
          cancelDeadline: { '>=': now, '<=': fourHoursFromNow },
        });

      for (const line of urgentLines) {
        try {
          const invoice = line.invoice_ID
            ? await SELECT.one.from(ar.Invoice).where({ ID: line.invoice_ID })
            : null;

          await sendEmail({
            to: process.env.EINVOICE_ADMIN_EMAIL || 'finance-admin@sains.com.my', // MOCK: confirm Finance Admin email distribution list
            subject: `URGENT: E-Invoice Cancellation Deadline Approaching - ${invoice?.invoiceNumber || line.invoice_ID}`,
            body: `The cancellation window for e-invoice ${invoice?.invoiceNumber || line.invoice_ID} ` +
              `(LHDN UUID: ${line.lhdnUUID}) expires at ${line.cancelDeadline}. ` +
              `If cancellation is required, it must be done immediately.`,
          });

          alertsSent++;
        } catch (err) {
          logger.error(`Failed to send cancellation deadline alert for line ${line.ID}: ${err.message}`);
        }
      }

      await logSystemAction('CANCELLATION_DEADLINE_ALERTS', 'EInvoiceSubmissionLine', null, {
        alertsSent, checked: urgentLines.length,
      });

      logger.info(`Cancellation deadline alerts: ${alertsSent} sent`);
    } catch (err) {
      logger.error(`Cancellation deadline alert scan failed: ${err.message}`);
    }

    return { alertsSent };
  });
});
