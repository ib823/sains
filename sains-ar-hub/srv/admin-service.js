'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const { logAction, logSystemAction } = require('./lib/audit-logger');
const { buildJournalEntryPayload } = require('./lib/gl-builder');
const { postJournalEntry } = require('./external/sap-core-api');
const { calculateProvision } = require('./lib/provision-engine');
const { GL_POSTING_STATUS, GL_POSTING_MAX_RETRIES, DEFAULT_PROVISION_RATES, AGING_BUCKETS, PAAB_LIABILITY_GL, PAAB_PAYABLE_GL } = require('./lib/constants');

module.exports = cds.service.impl(async function() {
  const srv = this;

  // ── GL POSTING BATCH ACTIONS ──────────────────────────────────────────
  srv.on('approveRetry', 'GLPostingBatches', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');
    const batch = await db.run(SELECT.one.from('sains.ar.GLPostingBatch').where({ ID }));
    if (!batch) return req.error(404, 'GL batch not found');
    if (batch.retryCount >= GL_POSTING_MAX_RETRIES)
      return req.error(400, `Maximum retry count (${GL_POSTING_MAX_RETRIES}) reached`);

    await db.run(UPDATE('sains.ar.GLPostingBatch').set({
      status: GL_POSTING_STATUS.RETRY_PENDING, approvedBy: req.user.id,
    }).where({ ID }));
    return true;
  });

  srv.on('submitBatch', 'GLPostingBatches', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');
    const batch = await db.run(SELECT.one.from('sains.ar.GLPostingBatch').where({ ID }));
    if (!batch) return req.error(404, 'GL batch not found');
    const lines = await db.run(SELECT.from('sains.ar.GLPostingLine').where({ batch_ID: ID }).orderBy({ lineSequence: 'asc' }));
    const payload = buildJournalEntryPayload(batch, lines);
    const result = await postJournalEntry(payload, ID);
    if (result.success) {
      await db.run(UPDATE('sains.ar.GLPostingBatch').set({
        status: GL_POSTING_STATUS.ACCEPTED, sapCoreDocNumber: result.documentNumber, submittedAt: new Date().toISOString(),
      }).where({ ID }));
      return { success: true, sapDocNumber: result.documentNumber, errorMessage: null };
    } else {
      await db.run(UPDATE('sains.ar.GLPostingBatch').set({
        status: GL_POSTING_STATUS.REJECTED, rejectionReason: result.errorMessage,
        retryCount: (batch.retryCount || 0) + 1, submittedAt: new Date().toISOString(),
      }).where({ ID }));
      return { success: false, sapDocNumber: null, errorMessage: result.errorMessage };
    }
  });

  // ── DOWNLOAD BATCH CSV ─────────────────────────────────────────────────
  const { SAP_CORE } = require('./lib/constants');
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
    return { csvContent, fileName, lineCount: lines.length };
  });

  // ── PROVISION MATRIX ──────────────────────────────────────────────────
  srv.on('getProvisionMatrix', async (req) => {
    const matrix = [];
    for (const bucket of AGING_BUCKETS) {
      for (const acctType of ['DOM', 'COM_S', 'COM_L', 'IND', 'GOV']) {
        const key = `${bucket.code}_${acctType}`;
        matrix.push({
          agingBucket: bucket.code, accountType: acctType,
          rate: DEFAULT_PROVISION_RATES[key] || 0, source: 'DEFAULT',
        });
      }
    }
    return matrix;
  });

  srv.on('updateProvisionRate', async (req) => {
    const { agingBucket, accountType, newRate, reason } = req.data;
    await logAction(req, 'UPDATE_PROVISION_RATE', 'AdminConfig', null, null,
      { agingBucket, accountType, newRate, reason }, null);
    return true;
  });

  // ── EMERGENCY ACCESS ──────────────────────────────────────────────────
  srv.on('grantEmergencyAccess', async (req) => {
    const { userID, reason, durationHours } = req.data;
    await logAction(req, 'GRANT_EMERGENCY_ACCESS', 'AdminConfig', null, null,
      { userID, reason, durationHours, grantedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + durationHours * 3600000).toISOString() }, null);
    return true;
  });

  srv.on('getEmergencyAccessLog', async (req) => {
    const db = await cds.connect.to('db');
    const entries = await db.run(
      SELECT.from('sains.ar.AuditTrailEntry')
        .where({ actionType: 'GRANT_EMERGENCY_ACCESS' })
        .orderBy({ timestamp: 'desc' })
    );
    return entries.map(e => {
      const state = e.afterState ? JSON.parse(e.afterState) : {};
      return {
        userID: state.userID || e.userID,
        grantedAt: state.grantedAt || e.timestamp,
        expiresAt: state.expiresAt,
        reason: state.reason,
        actionsPerformed: 0,
      };
    });
  });

  // ── PAAB REMITTANCE (Phase 3: wired to SAP GL — Scenario 1.6) ────────
  srv.on('initiatePaymentProcedure', async (req) => {
    const { remittancePeriod, totalAmount, notes } = req.data;
    const db = await cds.connect.to('db');
    const glPostingRef = `PAAB-${remittancePeriod}-${Date.now()}`;

    await logAction(req, 'INITIATE_PAAB_REMITTANCE', 'AdminConfig', null, null,
      { remittancePeriod, totalAmount, notes, glPostingRef }, null);

    // Build and post GL entry for PAAB remittance
    try {
      const glMappings = await db.run(
        SELECT.from('sains.ar.GLAccountMapping').where({ transactionType: 'PAAB_REMITTANCE', isActive: true })
      );
      const { buildDailySummaryBatch } = require('./lib/gl-builder');
      const { SAP_CORE } = require('./lib/constants');
      const transactions = [{
        transactionType: 'PAAB_REMITTANCE', accountTypeCode: 'ALL',
        chargeTypeCode: 'PAAB', branchCode: 'COMMON',
        amount: totalAmount, referenceDocType: 'PAAB_REMITTANCE',
        referenceDocID: glPostingRef,
        itemText: `PAAB remittance ${remittancePeriod}`,
      }];
      const postingDate = new Date().toISOString().substring(0, 10);
      const batch = buildDailySummaryBatch(transactions, glMappings, postingDate, SAP_CORE.COMPANY_CODE);
      const payload = buildJournalEntryPayload(batch, batch.lines || []);
      const result = await postJournalEntry(payload, glPostingRef);
      return { glPostingRef, apDocNumber: result.success ? result.documentNumber : null };
    } catch (err) {
      cds.log('admin-service').error(`PAAB GL posting failed: ${err.message}`);
      return { glPostingRef, apDocNumber: null };
    }
  });

  // ── TARIFF CHANGE ─────────────────────────────────────────────────────
  srv.on('activateTariffChange', async (req) => {
    const { tariffBandCode, newBlockIDs, spanApprovalRef, effectiveFrom } = req.data;
    const db = await cds.connect.to('db');

    // Set effectiveTo on current blocks
    await db.run(
      UPDATE('sains.ar.TariffBlock')
        .set({ effectiveTo: effectiveFrom })
        .where({ tariffBand_code: tariffBandCode, effectiveTo: null })
    );

    // Set effectiveFrom and SPAN ref on new blocks
    for (const blockID of newBlockIDs) {
      await db.run(
        UPDATE('sains.ar.TariffBlock')
          .set({ effectiveFrom, spanApprovalRef })
          .where({ ID: blockID })
      );
    }

    await logAction(req, 'ACTIVATE_TARIFF_CHANGE', 'TariffBand', null, null,
      { tariffBandCode, spanApprovalRef, effectiveFrom }, null);
    return true;
  });

  // ── VERIFY BUYER TIN ──────────────────────────────────────────────────
  srv.on('verifyBuyerTIN', async (req) => {
    const { tin } = req.data;
    if (!tin || tin.length < 10) {
      return { valid: false, registeredName: null, message: 'Invalid TIN format' };
    }
    return { valid: true, registeredName: null, message: 'TIN format valid' };
  });

  // ── PERIOD CLOSE SIGN-OFF ─────────────────────────────────────────────────
  const { lockPeriod } = require('./lib/period-lock');

  srv.on('signOffPeriodClose', async (req) => {
    const { periodYear, periodMonth } = req.data;
    const db = await cds.connect.to('db');

    // Verify all checklist steps are COMPLETED
    const checklist = await db.run(
      SELECT.one.from('sains.ar.PeriodCloseChecklist')
        .where({ periodYear, periodMonth })
    );
    if (!checklist) return req.error(404, `No checklist found for ${periodYear}-${periodMonth}`);

    const steps = await db.run(
      SELECT.from('sains.ar.PeriodCloseStep')
        .where({ checklist_ID: checklist.ID })
    );

    const incomplete = steps.filter(s => s.status !== 'COMPLETED');
    if (incomplete.length > 0) {
      return req.error(400, `Cannot sign off: ${incomplete.length} step(s) not completed: ${incomplete.map(s => s.stepName).join(', ')}`);
    }

    // Lock the period
    await lockPeriod(periodYear, periodMonth, req.user.id);

    // Update checklist status
    await db.run(
      UPDATE('sains.ar.PeriodCloseChecklist').set({
        status: 'SIGNED_OFF',
      }).where({ ID: checklist.ID })
    );

    await logAction(req, 'SIGN_OFF_PERIOD', 'PeriodCloseChecklist', checklist.ID,
      { status: checklist.status }, { status: 'SIGNED_OFF' });

    return true;
  });

  // ── Phase 3: Period close step notification (Scenario 11.6) ─────────────
  srv.after('UPDATE', 'PeriodCloseSteps', async (data, req) => {
    if (data.status === 'DUE' || data.status === 'PENDING') {
      try {
        const { sendEmail } = require('./external/notification-service');
        await sendEmail({
          to: data.assignedRole || 'FinanceAdmin',
          subject: `Period close step due: ${data.stepName} — ${data.periodYear || ''}-${String(data.periodMonth || '').padStart(2, '0')}`,
          body: `Period close step "${data.stepName}" is now due.\n\n` +
                `Please complete this step in the AR Hub admin app and mark it done.\n` +
                `Sign-off required before the period close checklist can be completed.`,
        });
      } catch (err) {
        cds.log('admin-service').error(`Period close notification failed: ${err.message}`);
      }
    }
  });
});
