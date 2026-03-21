'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { processResolvedEvents } = require('./handlers/payment-orchestrator');
const { downloadReconciliationFile, parseReconciliationFile, processBatch } = require('./external/jompay-adapter');
const { generateQRPayload, processWebhookNotification: processDuitNowWebhook } = require('./external/duitnow-adapter');
const { initiateRegistration, checkMandateStatus, submitDebitInstruction, cancelMandateWithPayNet } = require('./external/emandate-adapter');
const { sendPaymentReminder } = require('./external/whatsapp-adapter');
const { logAction, logSystemAction } = require('./lib/audit-logger');

const logger = cds.log('payment-innovation-service');

module.exports = cds.service.impl(async function () {
  const db = await cds.connect.to('db');
  const {
    PaymentOrchestratorEvent,
    JomPAYBatch, JomPAYLine,
    DuitNowQRCode,
    eMandate, eMandateDebitRun,
    PaymentChannelConfig,
    WhatsAppMessage,
  } = db.entities('sains.ar.payment');
  const ar = db.entities('sains.ar');

  // ── PAYMENT EVENTS ──────────────────────────────────────────────────

  this.on('resolveManually', 'PaymentEvents', async (req) => {
    const { ID } = req.params[0];
    const { targetAccountID, notes } = req.data;

    const event = await SELECT.one.from(PaymentOrchestratorEvent).where({ ID });
    if (!event) return req.error(404, 'Payment event not found');
    if (event.status !== 'SUSPENSE' && event.status !== 'PROCESSING_ERROR') {
      return req.error(409, `Event status "${event.status}" cannot be manually resolved`);
    }

    await UPDATE(PaymentOrchestratorEvent).set({
      status: 'RESOLVED',
      resolvedAccountID: targetAccountID,
      resolvedBy: req.user.id,
      resolvedAt: new Date().toISOString(),
      resolutionNotes: notes,
    }).where({ ID });

    await logAction(req, 'PAYMENT_EVENT_RESOLVED', 'PaymentOrchestratorEvent', ID, {
      targetAccountID, notes,
    });

    logger.info(`Payment event ${ID} manually resolved to account ${targetAccountID}`);
    return true;
  });

  this.on('rejectEvent', 'PaymentEvents', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const event = await SELECT.one.from(PaymentOrchestratorEvent).where({ ID });
    if (!event) return req.error(404, 'Payment event not found');
    if (event.status === 'CONVERTED' || event.status === 'REJECTED') {
      return req.error(409, `Event status "${event.status}" cannot be rejected`);
    }

    await UPDATE(PaymentOrchestratorEvent).set({
      status: 'REJECTED',
      resolutionNotes: reason,
      resolvedBy: req.user.id,
      resolvedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'PAYMENT_EVENT_REJECTED', 'PaymentOrchestratorEvent', ID, { reason });

    logger.info(`Payment event ${ID} rejected: ${reason}`);
    return true;
  });

  // ── JOMPAY BATCHES ──────────────────────────────────────────────────

  this.on('processFile', 'JomPAYBatches', async (req) => {
    const { ID } = req.params[0];

    const batch = await SELECT.one.from(JomPAYBatch).where({ ID });
    if (!batch) return req.error(404, 'JomPAY batch not found');
    if (batch.status === 'RECONCILED') {
      return req.error(409, 'Batch already reconciled');
    }

    const result = await processBatch(ID);

    await logSystemAction('JOMPAY_BATCH_PROCESSED', 'JomPAYBatch', ID, {
      processed: result.processed,
      matched: result.matched,
      suspense: result.suspense,
      failed: result.failed,
    });

    logger.info(`JomPAY batch ${ID} processed: ${result.processed} total, ${result.matched} matched`);
    return result;
  });

  this.on('approveReconciliation', 'JomPAYBatches', async (req) => {
    const { ID } = req.params[0];

    const batch = await SELECT.one.from(JomPAYBatch).where({ ID });
    if (!batch) return req.error(404, 'JomPAY batch not found');
    if (batch.status !== 'PROCESSED') {
      return req.error(409, `Batch status "${batch.status}" cannot be reconciled`);
    }

    await UPDATE(JomPAYBatch).set({
      status: 'RECONCILED',
      reconciledBy: req.user.id,
      reconciledAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'JOMPAY_BATCH_RECONCILED', 'JomPAYBatch', ID, {});

    logger.info(`JomPAY batch ${ID} reconciliation approved`);
    return true;
  });

  // ── EMANDATE ────────────────────────────────────────────────────────

  this.on('initiateRegistration', 'eMandates', async (req) => {
    const { ID } = req.params[0];
    const { registrationMethod } = req.data;

    const mandate = await SELECT.one.from(eMandate).where({ ID });
    if (!mandate) return req.error(404, 'eMandate not found');

    const result = await initiateRegistration(mandate, registrationMethod);

    await UPDATE(eMandate).set({
      status: 'PENDING_REGISTRATION',
      registrationMethod,
    }).where({ ID });

    await logAction(req, 'EMANDATE_REGISTRATION_INITIATED', 'eMandate', ID, { registrationMethod });

    logger.info(`eMandate ${ID} registration initiated via ${registrationMethod}`);
    return { registrationURL: result.registrationURL || '' };
  });

  this.on('suspendMandate', 'eMandates', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const mandate = await SELECT.one.from(eMandate).where({ ID });
    if (!mandate) return req.error(404, 'eMandate not found');
    if (mandate.status !== 'ACTIVE') {
      return req.error(409, `Mandate status "${mandate.status}" cannot be suspended`);
    }

    await UPDATE(eMandate).set({
      status: 'SUSPENDED',
      suspensionReason: reason,
      suspendedBy: req.user.id,
      suspendedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'EMANDATE_SUSPENDED', 'eMandate', ID, { reason });

    logger.info(`eMandate ${ID} suspended: ${reason}`);
    return true;
  });

  this.on('cancelMandate', 'eMandates', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const mandate = await SELECT.one.from(eMandate).where({ ID });
    if (!mandate) return req.error(404, 'eMandate not found');
    if (mandate.status === 'CANCELLED' || mandate.status === 'EXPIRED') {
      return req.error(409, `Mandate status "${mandate.status}" cannot be cancelled`);
    }

    // Cancel with PayNet if mandate was active
    if (mandate.status === 'ACTIVE' && mandate.paynetMandateRef) {
      await cancelMandateWithPayNet(mandate.paynetMandateRef);
    }

    await UPDATE(eMandate).set({
      status: 'CANCELLED',
      cancellationReason: reason,
      cancelledBy: req.user.id,
      cancelledAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'EMANDATE_CANCELLED', 'eMandate', ID, { reason });

    logger.info(`eMandate ${ID} cancelled: ${reason}`);
    return true;
  });

  this.on('confirmMandateActive', 'eMandates', async (req) => {
    const { ID } = req.params[0];
    const { mandateID } = req.data;

    const mandate = await SELECT.one.from(eMandate).where({ ID });
    if (!mandate) return req.error(404, 'eMandate not found');

    const statusResult = await checkMandateStatus(mandateID || mandate.paynetMandateRef);

    if (statusResult.status === 'ACTIVE') {
      await UPDATE(eMandate).set({
        status: 'ACTIVE',
        paynetMandateRef: mandateID || mandate.paynetMandateRef,
        activatedAt: new Date().toISOString(),
      }).where({ ID });

      await logSystemAction('EMANDATE_CONFIRMED_ACTIVE', 'eMandate', ID, { mandateID });
    }

    logger.info(`eMandate ${ID} status check: ${statusResult.status}`);
    return statusResult.status === 'ACTIVE';
  });

  // ── DUITNOW QR — UNBOUND ACTIONS ───────────────────────────────────

  this.on('generateQRForInvoice', async (req) => {
    const { invoiceID } = req.data;

    const invoice = await SELECT.one.from(ar.Invoice).where({ ID: invoiceID });
    if (!invoice) return req.error(404, 'Invoice not found');

    const qrResult = generateQRPayload({
      billRef: invoice.invoiceNumber,
      amount: invoice.totalAmount,
      accountNumber: invoice.accountNumber,
    });

    const expiryDate = dayjs().add(30, 'day').format('YYYY-MM-DD');

    const qrCode = {
      invoice_ID: invoiceID,
      accountNumber: invoice.accountNumber,
      qrPayload: qrResult.payload,
      amount: invoice.totalAmount,
      expiryDate,
      status: 'ACTIVE',
      generatedAt: new Date().toISOString(),
    };

    const inserted = await INSERT.into(DuitNowQRCode).entries(qrCode);

    logger.info(`DuitNow QR generated for invoice ${invoice.invoiceNumber}`);
    return {
      qrCodeID: qrCode.ID,
      qrPayload: qrResult.payload,
      expiryDate,
    };
  });

  this.on('processWebhookNotification', async (req) => {
    const { merchantID, billRef, amount, payerRef, transDateTime } = req.data;

    const result = await processDuitNowWebhook({
      merchantID, billRef, amount, payerRef, transDateTime,
    });

    logger.info(`DuitNow webhook processed for billRef ${billRef}`);
    return result;
  });

  // ── JOB TRIGGER ACTIONS ─────────────────────────────────────────────

  this.on('triggerJomPAYFileDownload', async (req) => {
    const { fileDate } = req.data;

    try {
      const result = await downloadReconciliationFile(fileDate);

      if (result.filePath) {
        const batch = {
          fileName: result.fileName,
          fileDate,
          status: 'DOWNLOADED',
          downloadedAt: new Date().toISOString(),
        };
        await INSERT.into(JomPAYBatch).entries(batch);

        // Parse and process the downloaded file
        const parsed = await parseReconciliationFile(result.filePath);
        if (parsed && parsed.lines) {
          for (const line of parsed.lines) {
            await INSERT.into(JomPAYLine).entries({
              batch_ID: batch.ID,
              ...line,
            });
          }
          await UPDATE(JomPAYBatch).set({
            status: 'PARSED',
            totalRecords: parsed.lines.length,
          }).where({ ID: batch.ID });
        }
      }

      await logSystemAction('JOMPAY_FILE_DOWNLOADED', 'JomPAYBatch', null, { fileDate });
      logger.info(`JomPAY file download triggered for date ${fileDate}`);
      return { success: true, fileName: result.fileName || '' };
    } catch (err) {
      logger.error(`JomPAY file download failed: ${err.message}`);
      return { success: false, fileName: '' };
    }
  });

  this.on('triggerEmandateDebitRun', async (req) => {
    const { runDate } = req.data;
    let submitted = 0, skipped = 0, failed = 0;

    const activeMandates = await SELECT.from(eMandate)
      .where({ status: 'ACTIVE' });

    const run = {
      runDate,
      status: 'PROCESSING',
      totalMandates: activeMandates.length,
      startedAt: new Date().toISOString(),
    };
    await INSERT.into(eMandateDebitRun).entries(run);

    for (const mandate of activeMandates) {
      try {
        if (!mandate.debitAmount || mandate.debitAmount <= 0) {
          skipped++;
          continue;
        }

        const result = await submitDebitInstruction({
          mandateRef: mandate.paynetMandateRef,
          amount: mandate.debitAmount,
          accountNumber: mandate.accountNumber,
          runDate,
        });

        if (result.success) {
          submitted++;
        } else {
          failed++;
        }
      } catch (err) {
        logger.error(`Debit instruction failed for mandate ${mandate.ID}: ${err.message}`);
        failed++;
      }
    }

    await UPDATE(eMandateDebitRun).set({
      status: 'COMPLETED',
      submitted,
      skipped,
      failed,
      completedAt: new Date().toISOString(),
    }).where({ ID: run.ID });

    await logSystemAction('EMANDATE_DEBIT_RUN_COMPLETED', 'eMandateDebitRun', run.ID, {
      submitted, skipped, failed,
    });

    logger.info(`eMandate debit run completed: ${submitted} submitted, ${skipped} skipped, ${failed} failed`);
    return { submitted, skipped, failed };
  });

  this.on('triggerQRExpiry', async (req) => {
    const { asOfDate } = req.data;

    const result = await UPDATE(DuitNowQRCode)
      .set({ status: 'EXPIRED' })
      .where({ status: 'ACTIVE', expiryDate: { '<': asOfDate } });

    const expired = result || 0;

    await logSystemAction('QR_EXPIRY_RUN', 'DuitNowQRCode', null, { asOfDate, expired });
    logger.info(`QR expiry run: ${expired} codes expired`);
    return { expired };
  });

  this.on('triggerWhatsAppReminders', async (req) => {
    const { dunningLevel, asOfDate } = req.data;
    let queued = 0;

    const accounts = await SELECT.from(ar.CustomerAccount)
      .where({
        status: 'ACTIVE',
        dunningLevel,
        balanceOutstanding: { '>': 0 },
      });

    for (const account of accounts) {
      try {
        if (!account.mobilePhone) continue;

        await sendPaymentReminder({
          phoneNumber: account.mobilePhone,
          accountNumber: account.accountNumber,
          customerName: account.customerName,
          amountDue: account.balanceOutstanding,
          dunningLevel,
        });

        await INSERT.into(WhatsAppMessage).entries({
          account_ID: account.ID,
          accountNumber: account.accountNumber,
          phoneNumber: account.mobilePhone,
          templateName: `payment_reminder_level_${dunningLevel}`,
          status: 'SENT',
          sentAt: new Date().toISOString(),
          dunningLevel,
        });

        queued++;
      } catch (err) {
        logger.error(`WhatsApp reminder failed for account ${account.accountNumber}: ${err.message}`);

        await INSERT.into(WhatsAppMessage).entries({
          account_ID: account.ID,
          accountNumber: account.accountNumber,
          phoneNumber: account.mobilePhone || '',
          templateName: `payment_reminder_level_${dunningLevel}`,
          status: 'FAILED',
          errorMessage: err.message,
          dunningLevel,
        });
      }
    }

    await logSystemAction('WHATSAPP_REMINDERS_SENT', 'WhatsAppMessage', null, {
      dunningLevel, asOfDate, queued,
    });

    logger.info(`WhatsApp reminders sent: ${queued} for dunning level ${dunningLevel}`);
    return { queued };
  });

  this.on('processResolvedPaymentEvents', async (req) => {
    const { asOfDate } = req.data;

    const result = await processResolvedEvents(asOfDate);

    logger.info(`Resolved payment events processed: ${result.converted} converted, ${result.failed} failed`);
    return result;
  });
});
