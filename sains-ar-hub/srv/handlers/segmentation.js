'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { logSystemAction } = require('../lib/audit-logger');
const { detectEarlyInterventionSignals } = require('../lib/intelligent-dunning-engine');
const { PAYMENT_CHANNEL } = require('../lib/constants');

const logger = cds.log('segmentation');

/**
 * Run the monthly customer segmentation job.
 * Scores all active accounts and assigns dunning paths.
 *
 * Scoring methodology (without AI Core — rule-based fallback):
 * Uses 5 historical payment behaviour signals to derive propensity score.
 * When SAP AI Core model is deployed, replace _calculateRuleBasedScore
 * with AI Core endpoint call.
 *
 * @param {Date} asOfDate
 */
async function runSegmentationBatch(asOfDate = new Date()) {
  const db = await cds.connect.to('db');
  const today = dayjs(asOfDate).format('YYYY-MM-DD');
  const modelVersion = 'RULE_BASED_V1'; // Replace with AI Core model version when deployed

  const accounts = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'accountType_code', 'dunningLevel',
               'isGovernment', 'isHardship', 'isWrittenOff', 'isLegalAction',
               'accountStatus', 'hardshipCriteriaCode',
               'balanceOutstanding', 'balanceDeposit')
      .where({ accountStatus: { in: ['ACTIVE', 'RESTRICTED', 'TEMP_DISCONNECTED'] } })
  );

  let processed = 0, updated = 0;

  for (const account of accounts) {
    try {
      // Fetch historical data for scoring
      const [recentPayments, recentInvoices, ptpHistory] = await Promise.all([
        db.run(
          SELECT.from('sains.ar.Payment')
            .columns('amount', 'paymentDate', 'channel', 'status')
            .where({
              account_ID: account.ID,
              status: { '!=': 'REVERSED' },
              paymentDate: { '>=': dayjs(asOfDate).subtract(12, 'month').format('YYYY-MM-DD') },
            })
            .orderBy({ paymentDate: 'desc' })
            .limit(24)
        ),
        db.run(
          SELECT.from('sains.ar.Invoice')
            .columns('totalAmount', 'amountOutstanding', 'status', 'dueDate', 'invoiceDate')
            .where({
              account_ID: account.ID,
              invoiceDate: { '>=': dayjs(asOfDate).subtract(12, 'month').format('YYYY-MM-DD') },
              status: { '!=': 'REVERSED' },
            })
            .orderBy({ invoiceDate: 'desc' })
            .limit(24)
        ),
        db.run(
          SELECT.from('sains.ar.PromiseToPay')
            .columns('status', 'promisedDate', 'promisedAmount')
            .where({ account_ID: account.ID })
            .orderBy({ createdAt: 'desc' })
            .limit(12)
        ),
      ]);

      const scores = _calculateRuleBasedScore(account, recentPayments, recentInvoices, ptpHistory);
      const segment = _determineSegment(account, scores);
      const dunningPath = _determineDunningPath(account, segment, scores);

      // Upsert CustomerSegment
      const existing = await db.run(
        SELECT.one.from('sains.ar.collections.CustomerSegment')
          .where({ account_ID: account.ID })
      );

      const segmentData = {
        account_ID: account.ID,
        segmentCode: segment.code,
        segmentVersion: (existing?.segmentVersion || 0) + 1,
        scoreDate: today,
        propensityScore: scores.propensityScore,
        riskScore: scores.riskScore,
        vulnerabilityFlag: !!account.isHardship,
        vulnerabilityCategory: account.hardshipCriteriaCode || null,
        affordabilityRating: scores.affordabilityRating,
        paymentBehaviourCode: scores.behaviourCode,
        daysToPay_avg90: scores.daysToPay90,
        daysToPay_avg365: scores.daysToPay365,
        paymentChannelPref: scores.preferredChannel,
        ptpComplianceRate: scores.ptpComplianceRate,
        dunningPathCode: dunningPath,
        modelVersion,
        expiresAt: dayjs(asOfDate).add(30, 'day').format('YYYY-MM-DD'),
      };

      if (existing) {
        await db.run(UPDATE('sains.ar.collections.CustomerSegment').set(segmentData).where({ ID: existing.ID }));
        updated++;
      } else {
        await db.run(INSERT.into('sains.ar.collections.CustomerSegment').entries({
          ID: cds.utils.uuid(), ...segmentData,
        }));
        updated++;
      }

      // Save score history
      await db.run(INSERT.into('sains.ar.collections.PropensityScoreHistory').entries({
        ID: cds.utils.uuid(),
        account_ID: account.ID,
        scoreDate: today,
        modelVersion,
        modelRunID: `BATCH-${today}`,
        propensityScore: scores.propensityScore,
        riskScore: scores.riskScore,
        segmentAssigned: segment.code,
        dunningPathAssigned: dunningPath,
      }));

      processed++;
    } catch (err) {
      logger.error(`Segmentation failed for account ${account.accountNumber}: ${err.message}`);
    }
  }

  logger.info(`Segmentation batch: ${processed} processed, ${updated} updated`);
  return { processed, updated };
}

/**
 * Rule-based propensity scoring.
 * Produces a 0–1 propensity score using 5 signal categories.
 * Replace with SAP AI Core ML model call when model is trained and deployed.
 */
function _calculateRuleBasedScore(account, payments, invoices, ptpHistory) {
  let score = 0.5; // Base score
  let behaviourCode = 'UNKNOWN';
  let preferredChannel = 'UNKNOWN';

  // Signal 1: Current dunning level (negative signal)
  score -= account.dunningLevel * 0.08;

  // Signal 2: Payment frequency in last 12 months
  if (payments.length === 0) {
    score -= 0.3; // No payment history — high risk
    behaviourCode = 'NO_HISTORY';
  } else {
    const avgMonthsBetweenPayments = 12 / Math.max(payments.length, 1);
    if (avgMonthsBetweenPayments <= 1.2) score += 0.15; // Pays monthly
    else if (avgMonthsBetweenPayments <= 2) score += 0.05; // Slightly irregular
    else score -= 0.10; // Infrequent payer

    // Signal 3: Average days to pay (lower = better)
    const daysToPayValues = payments
      .map(p => {
        const inv = invoices.find(i => i.dueDate <= p.paymentDate);
        if (!inv) return null;
        return dayjs(p.paymentDate).diff(dayjs(inv.dueDate), 'day');
      })
      .filter(v => v !== null);

    const avg365 = daysToPayValues.length > 0
      ? daysToPayValues.reduce((s, v) => s + v, 0) / daysToPayValues.length
      : 30;
    const avg90 = daysToPayValues.slice(0, 3).length > 0
      ? daysToPayValues.slice(0, 3).reduce((s, v) => s + v, 0) / daysToPayValues.slice(0, 3).length
      : avg365;

    if (avg365 <= 5) { score += 0.20; behaviourCode = 'RELIABLE'; }
    else if (avg365 <= 15) { score += 0.10; behaviourCode = 'PROMPT'; }
    else if (avg365 <= 30) { score += 0.00; behaviourCode = 'STANDARD'; }
    else if (avg365 <= 60) { score -= 0.10; behaviourCode = 'SEASONAL_LATE'; }
    else { score -= 0.20; behaviourCode = 'CHRONIC_LATE'; }

    // Trend: improving or declining
    if (avg90 < avg365 * 0.8) { score += 0.05; behaviourCode = 'IMPROVING'; }
    if (avg90 > avg365 * 1.3) { score -= 0.05; behaviourCode = 'DECLINING'; }

    // Preferred channel
    const channelCounts = {};
    payments.forEach(p => { channelCounts[p.channel] = (channelCounts[p.channel] || 0) + 1; });
    preferredChannel = Object.keys(channelCounts).reduce((a, b) =>
      channelCounts[a] > channelCounts[b] ? a : b, payments[0]?.channel || 'UNKNOWN');

    // Signal 4: eMandate users = more reliable
    if (preferredChannel === PAYMENT_CHANNEL.EMANDATE) score += 0.15;

    // Signal 5: PTP compliance history
    const honouredPTPs = ptpHistory.filter(p => p.status === 'HONOURED').length;
    const totalPTPs = ptpHistory.length;
    const ptpRate = totalPTPs > 0 ? honouredPTPs / totalPTPs : 0.5;
    if (ptpRate > 0.8) score += 0.05;
    if (ptpRate < 0.3 && totalPTPs >= 3) score -= 0.10;

    // Outstanding balance vs deposit ratio
    const depositRatio = account.balanceDeposit > 0
      ? account.balanceOutstanding / account.balanceDeposit
      : 99;
    if (depositRatio > 3) score -= 0.10; // Significantly over deposit — risk signal

    const result = {
      propensityScore: Math.max(0.01, Math.min(0.99, score)),
      riskScore: Math.max(0.01, Math.min(0.99, 1 - score)),
      behaviourCode,
      preferredChannel,
      daysToPay90: Math.round(avg90 * 10) / 10,
      daysToPay365: Math.round(avg365 * 10) / 10,
      ptpComplianceRate: totalPTPs > 0 ? ptpRate : null,
      affordabilityRating: account.balanceOutstanding > account.balanceDeposit * 4
        ? 'AT_RISK' : 'AFFORDABLE',
    };

    return result;
  }

  return {
    propensityScore: Math.max(0.01, Math.min(0.99, score)),
    riskScore: Math.max(0.01, Math.min(0.99, 1 - score)),
    behaviourCode,
    preferredChannel,
    daysToPay90: 30,
    daysToPay365: 30,
    ptpComplianceRate: null,
    affordabilityRating: 'AFFORDABLE',
  };
}

function _determineSegment(account, scores) {
  if (account.isGovernment) return { code: 'GOVT_EXEMPT' };
  if (account.isHardship) return { code: 'VULNERABLE' };
  if (account.isWrittenOff || account.isLegalAction) return { code: 'HIGH_RISK' };

  if (scores.propensityScore >= 0.75) return { code: 'LOW_RISK' };
  if (scores.propensityScore >= 0.50) return { code: 'MEDIUM_RISK' };
  if (scores.propensityScore >= 0.25) return { code: 'HIGH_RISK' };
  return { code: 'HIGH_RISK' };
}

function _determineDunningPath(account, segment, scores) {
  if (segment.code === 'GOVT_EXEMPT') return 'PATH_EXEMPT';
  if (segment.code === 'VULNERABLE') return 'PATH_EMPATHY';
  if (segment.code === 'HIGH_RISK') return 'PATH_INTENSIVE';
  if (segment.code === 'MEDIUM_RISK') return 'PATH_STANDARD';
  return 'PATH_STANDARD'; // LOW_RISK also gets standard path (fewer touchpoints needed)
}

/**
 * Scan all active accounts for early intervention signals.
 */
async function runEarlyInterventionScan(asOfDate = new Date()) {
  const db = await cds.connect.to('db');
  let alertsCreated = 0;

  const accounts = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'dunningLevel', 'isHardship',
               'isGovernment', 'isWrittenOff', 'primaryPhone', 'emailAddress')
      .where({
        accountStatus: 'ACTIVE',
        dunningLevel: 0,    // Only accounts NOT yet in dunning
        isWrittenOff: false,
        isGovernment: false,
      })
  );

  const sixMonthsAgo = dayjs(asOfDate).subtract(6, 'month').format('YYYY-MM-DD');

  for (const account of accounts) {
    try {
      const [payments, invoices] = await Promise.all([
        db.run(
          SELECT.from('sains.ar.Payment')
            .columns('amount', 'paymentDate', 'channel', 'status')
            .where({ account_ID: account.ID, paymentDate: { '>=': sixMonthsAgo }, status: { '!=': 'REVERSED' } })
            .orderBy({ paymentDate: 'desc' })
            .limit(12)
        ),
        db.run(
          SELECT.from('sains.ar.Invoice')
            .columns('totalAmount', 'dueDate', 'billingPeriodTo', 'status')
            .where({ account_ID: account.ID, invoiceDate: { '>=': sixMonthsAgo }, status: { '!=': 'REVERSED' } })
            .orderBy({ invoiceDate: 'desc' })
            .limit(12)
        ),
      ]);

      const signals = detectEarlyInterventionSignals(account, payments, invoices);

      for (const signal of signals) {
        // Check if same alert type already open for this account
        const existing = await db.run(
          SELECT.one.from('sains.ar.collections.EarlyInterventionAlert')
            .where({
              account_ID: account.ID,
              alertType: signal.alertType,
              status: 'OPEN',
            })
        );
        if (existing) continue; // Don't duplicate open alerts

        await db.run(INSERT.into('sains.ar.collections.EarlyInterventionAlert').entries({
          ID: cds.utils.uuid(),
          account_ID: account.ID,
          alertDate: asOfDate.toISOString().substring(0, 10),
          alertType: signal.alertType,
          signalDescription: signal.signalDescription,
          riskLevel: signal.riskLevel,
          status: 'OPEN',
        }));
        alertsCreated++;
      }
    } catch (err) {
      logger.error(`Early intervention scan failed for ${account.accountNumber}: ${err.message}`);
    }
  }

  logger.info(`Early intervention scan: ${alertsCreated} alerts created`);
  return { alertsCreated };
}

module.exports = { runSegmentationBatch, runEarlyInterventionScan };
