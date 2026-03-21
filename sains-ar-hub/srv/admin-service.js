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

  // ── PAAB REMITTANCE ───────────────────────────────────────────────────
  srv.on('initiatePaymentProcedure', async (req) => {
    const { remittancePeriod, totalAmount, notes } = req.data;
    const glPostingRef = `PAAB-${remittancePeriod}-${Date.now()}`;
    await logAction(req, 'INITIATE_PAAB_REMITTANCE', 'AdminConfig', null, null,
      { remittancePeriod, totalAmount, notes, glPostingRef }, null);
    return { glPostingRef, apDocNumber: null };
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
});
