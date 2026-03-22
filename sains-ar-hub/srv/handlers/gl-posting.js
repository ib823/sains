'use strict';

const cds = require('@sap/cds');
const { logAction } = require('../lib/audit-logger');
const { buildJournalEntryPayload, _validateBatchBalance } = require('../lib/gl-builder');
const { postJournalEntry } = require('../external/sap-core-api');
const { GL_POSTING_STATUS, GL_POSTING_MAX_RETRIES, SAP_CORE } = require('../lib/constants');
const { sendSystemAlert } = require('../external/notification-service');

const logger = cds.log('gl-posting');

module.exports = (srv) => {

  srv.on('approveRetry', 'GLPostingBatches', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const batch = await db.run(SELECT.one.from('sains.ar.GLPostingBatch').where({ ID }));
    if (!batch) return req.error(404, 'GL batch not found');
    if (batch.retryCount >= GL_POSTING_MAX_RETRIES)
      return req.error(400, `Maximum retry count (${GL_POSTING_MAX_RETRIES}) reached`);

    await db.run(UPDATE('sains.ar.GLPostingBatch').set({
      status: GL_POSTING_STATUS.RETRY_PENDING,
      approvedBy: req.user.id,
    }).where({ ID }));

    await logAction(req, 'APPROVE_GL_RETRY', 'GLPostingBatch', ID, batch,
      { ...batch, status: GL_POSTING_STATUS.RETRY_PENDING }, null);
    return true;
  });

  srv.on('submitBatch', 'GLPostingBatches', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const batch = await db.run(SELECT.one.from('sains.ar.GLPostingBatch').where({ ID }));
    if (!batch) return req.error(404, 'GL batch not found');

    // Idempotency check: reject if a batch with same idempotencyKey was already accepted
    if (batch.idempotencyKey) {
      const duplicate = await db.run(
        SELECT.one.from('sains.ar.GLPostingBatch')
          .where({ idempotencyKey: batch.idempotencyKey, status: GL_POSTING_STATUS.ACCEPTED })
          .and('ID !=', ID)
      );
      if (duplicate) {
        return req.error(409, `Duplicate GL posting: batch with idempotencyKey '${batch.idempotencyKey}' already accepted (${duplicate.ID})`);
      }
    }

    const lines = await db.run(
      SELECT.from('sains.ar.GLPostingLine').where({ batch_ID: ID }).orderBy({ lineSequence: 'asc' })
    );

    // Validate batch is balanced before submitting
    _validateBatchBalance(batch, lines);

    const payload = buildJournalEntryPayload(batch, lines);
    const result = await postJournalEntry(payload, ID);

    if (result.success) {
      await db.run(UPDATE('sains.ar.GLPostingBatch').set({
        status: GL_POSTING_STATUS.ACCEPTED,
        sapCoreDocNumber: result.documentNumber,
        submittedAt: new Date().toISOString(),
      }).where({ ID }));

      return { success: true, sapDocNumber: result.documentNumber, errorMessage: null };
    } else {
      await db.run(UPDATE('sains.ar.GLPostingBatch').set({
        status: GL_POSTING_STATUS.REJECTED,
        rejectionReason: result.errorMessage,
        retryCount: (batch.retryCount || 0) + 1,
        submittedAt: new Date().toISOString(),
      }).where({ ID }));

      // Phase 3: GL failure notification (Scenario 11.4)
      await sendSystemAlert({
        type: 'GL_POSTING_FAILURE',
        subject: `GL posting batch FAILED — ${batch.idempotencyKey || ID}`,
        body: `GL posting batch ${ID} for ${batch.batchDate} failed: ${result.errorMessage}. Download CSV fallback and upload manually to SAP.`,
        recipients: 'FinanceManager',
      }).catch(err => logger.error(`GL failure notification failed: ${err.message}`));

      return { success: false, sapDocNumber: null, errorMessage: result.errorMessage };
    }
  });

  // ── Phase 3: downloadBatchCSV (Scenario 1.7 — manual upload fallback) ───

  srv.on('downloadBatchCSV', 'GLPostingBatches', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const batch = await db.run(SELECT.one.from('sains.ar.GLPostingBatch').where({ ID }));
    if (!batch) return req.error(404, 'GL batch not found');

    const lines = await db.run(
      SELECT.from('sains.ar.GLPostingLine').where({ batch_ID: ID }).orderBy({ lineSequence: 'asc' })
    );

    const docDate = (batch.batchDate || '').replace(/-/g, '');
    const companyCode = SAP_CORE.COMPANY_CODE;
    const docType = SAP_CORE.DOCUMENT_TYPE_AR || 'SA';
    const reference = (batch.idempotencyKey || ID).substring(0, 16);

    const csvHeaders = 'BUKRS,BLDAT,BUDAT,BLART,XBLNR,BKTXT,HKONT,SHKZG,WRBTR,KOSTL,SGTXT';
    const csvRows = lines.map(line => {
      const dc = Number(line.amount) >= 0 ? 'S' : 'H';
      const amt = Math.abs(Number(line.amount)).toFixed(2);
      const headerText = (batch.postingType || '').substring(0, 25).replace(/"/g, '""');
      const itemText = (line.text || '').substring(0, 50).replace(/"/g, '""');
      return `${companyCode},${docDate},${docDate},${docType},${reference},"${headerText}",${line.glAccount},${dc},${amt},${line.costCentre || ''},"${itemText}"`;
    });

    const csvContent = [csvHeaders, ...csvRows].join('\n');
    const fileName = `GL_BATCH_${reference}_${batch.batchDate}.csv`;

    logger.info(`GL batch ${ID} exported to CSV by ${req.user.id} — ${lines.length} lines`);
    return { csvContent, fileName, lineCount: lines.length };
  });

  // ── BEFORE DELETE: guard ──────────────────────────────────────────────
  srv.before('DELETE', 'GLPostingBatches', (req) => {
    return req.error(405, 'GL posting batches cannot be deleted.');
  });
};
