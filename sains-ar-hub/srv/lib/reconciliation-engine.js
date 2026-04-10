'use strict';

const cds = require('@sap/cds');
const logger = cds.log('reconciliation-engine');

/**
 * Compute AR subledger to GL reconciliation for a given date.
 * Compares the sum of all account balances (AR subledger total)
 * against the sum of all accepted GL posting batches (GL posted total).
 *
 * MOCK: In production, GL total should be read from SAP via API_GLACCOUNTBALANCE.
 * For POC, computed from GLPostingBatch records.
 *
 * @param {string} asOfDate - ISO date string
 * @returns {{ arTotal, glTotal, variance, withinTolerance, tolerance }}
 */
async function computeARToGLReconciliation(asOfDate) {
  const db = await cds.connect.to('db');

  // AR subledger total: sum of all active account balanceOutstanding
  const arResult = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('SUM(balanceOutstanding) as total')
      .where({ accountStatus: { in: ['ACTIVE', 'RESTRICTED', 'TEMP_DISCONNECTED', 'LEGAL'] } })
  );
  const arTotal = Number(arResult?.[0]?.total || 0);

  // GL posted total: sum of all ACCEPTED GL batches up to asOfDate
  // MOCK: production reads from SAP API_GLACCOUNTBALANCE for the AR control account
  const glResult = await db.run(
    SELECT.from('sains.ar.GLPostingBatch')
      .columns('SUM(totalDebitAmount) as totalDebit', 'SUM(totalCreditAmount) as totalCredit')
      .where({ status: 'ACCEPTED', batchDate: { '<=': asOfDate } })
  );
  const glDebit = Number(glResult?.[0]?.totalDebit || 0);
  const glCredit = Number(glResult?.[0]?.totalCredit || 0);
  const glTotal = glDebit - glCredit; // Net AR balance from GL perspective

  const variance = Math.round((arTotal - glTotal) * 100) / 100;
  const tolerance = 0.01; // RM 0.01 tolerance
  const withinTolerance = Math.abs(variance) <= tolerance;

  // Persist reconciliation record (field names match sains.ar.ReconciliationRecord entity)
  const id = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.ReconciliationRecord').entries({
    ID: id,
    reconciliationType: 'AR_TO_GL',
    reconciliationDate: asOfDate,
    performedBy: 'SYSTEM',
    sourceSystem: 'AR_HUB',
    targetSystem: 'SAP_GL',
    systemBalance: arTotal,
    externalBalance: glTotal,
    difference: variance,
    status: withinTolerance ? 'MATCHED' : 'VARIANCE',
    toleranceAmount: tolerance,
  }));

  logger.info(`Reconciliation ${asOfDate}: AR=${arTotal.toFixed(2)} GL=${glTotal.toFixed(2)} variance=${variance.toFixed(2)} ${withinTolerance ? 'OK' : 'MISMATCH'}`);

  return { arTotal, glTotal, variance, withinTolerance, tolerance, reconciliationID: id };
}

module.exports = { computeARToGLReconciliation };
