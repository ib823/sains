'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../lib/audit-logger');
const { FRAUD_ALERT_PATTERN, FRAUD_THRESHOLDS } = require('../lib/constants');
const { sendSystemAlert } = require('../external/notification-service');

const logger = cds.log('fraud-detection');

/**
 * Get assignee for fraud alert based on severity.
 * MOCK: In production, queries XSUAA for actual users in role.
 * For POC, returns role name as placeholder identifier.
 */
function _getAssigneeByRole(severity) {
  // MOCK: production queries XSUAA user assignments
  if (severity === 'HIGH') return 'ROLE:FinanceManager';
  return 'ROLE:FinanceSupervisor';
}

async function checkFraudPatterns(pattern, data, req) {
  try {
    const db = await cds.connect.to('db');
    let severity = 'LOW';
    let description = '';

    switch (pattern) {
      case FRAUD_ALERT_PATTERN.LARGE_ADJUSTMENT:
        if (data.adjustmentAmount / data.invoiceAmount > FRAUD_THRESHOLDS.ADJUSTMENT_PERCENT_OF_INVOICE) {
          severity = 'MEDIUM';
          description = `Adjustment of RM${data.adjustmentAmount} exceeds ${FRAUD_THRESHOLDS.ADJUSTMENT_PERCENT_OF_INVOICE * 100}% of invoice RM${data.invoiceAmount}`;
        } else return;
        break;

      case FRAUD_ALERT_PATTERN.QUICK_REVERSAL:
        severity = 'MEDIUM';
        description = `Payment reversed within ${FRAUD_THRESHOLDS.QUICK_REVERSAL_DAYS} days of receipt`;
        break;

      case FRAUD_ALERT_PATTERN.DOUBLE_WRITEOFF:
        severity = 'HIGH';
        description = `Duplicate write-off attempt detected for account ${data.accountNumber}`;
        break;

      case FRAUD_ALERT_PATTERN.SELF_PAYMENT:
        severity = 'HIGH';
        description = `Third-party payment from ${data.thirdPartyName} to multiple accounts (${data.accountCount})`;
        break;

      case FRAUD_ALERT_PATTERN.BULK_WRITEOFF_SAME_USER:
        severity = 'HIGH';
        description = `User ${data.userID} has ${data.writeOffCount} write-offs — exceeds threshold of ${FRAUD_THRESHOLDS.BULK_WRITEOFF_SAME_USER_COUNT}`;
        break;

      case FRAUD_ALERT_PATTERN.REFUND_NO_BILLING:
        severity = 'MEDIUM';
        description = `Deposit refund requested but no billing activity in ${FRAUD_THRESHOLDS.REFUND_NO_BILLING_MONTHS} months`;
        break;

      case FRAUD_ALERT_PATTERN.AGENT_BATCH_ANOMALY:
        severity = 'MEDIUM';
        description = `Agent batch amount anomaly — ${data.anomalyDetail}`;
        break;

      default:
        severity = 'LOW';
        description = `Unclassified fraud pattern: ${pattern}`;
    }

    const assignedTo = _getAssigneeByRole(severity);

    await db.run(INSERT.into('sains.ar.FraudAlert').entries({
      ID: uuidv4(),
      account_ID: data.accountID,
      alertPattern: pattern,
      alertSeverity: severity,
      alertDescription: description,
      triggeredByAction: data.action || pattern,
      triggeredByUser: req?.user?.id || 'SYSTEM',
      transactionRef: data.transactionID || null,
      status: 'OPEN',
      assignedTo,
    }));

    if (severity === 'HIGH') {
      await sendSystemAlert({
        severity: 'ERROR',
        subject: `[SAINS AR] HIGH Fraud Alert — ${pattern}`,
        body: description,
        alertType: 'FRAUD',
      });
    }

    logger.warn(`Fraud alert created: ${pattern} (${severity})`, { account: data.accountID });
  } catch (error) {
    logger.error(`Fraud check failed for pattern ${pattern}: ${error.message}`);
  }
}

function _registerHandlers(srv) {
  srv.on('reviewAlert', 'FraudAlerts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { actionTaken, notes } = req.data;
    const db = await cds.connect.to('db');

    const alert = await db.run(SELECT.one.from('sains.ar.FraudAlert').where({ ID }));
    if (!alert) return req.error(404, 'Fraud alert not found');
    if (alert.status !== 'OPEN' && alert.status !== 'UNDER_REVIEW')
      return req.error(400, `Cannot review alert in status ${alert.status}`);

    const newStatus = actionTaken === 'CLEARED' ? 'CLEARED' : 'UNDER_REVIEW';
    await db.run(UPDATE('sains.ar.FraudAlert').set({
      status: newStatus,
      actionTaken,
      reviewNotes: notes,
      reviewedBy: req.user.id,
      reviewedAt: new Date().toISOString(),
    }).where({ ID }));

    await logAction(req, 'REVIEW_FRAUD_ALERT', 'FraudAlert', ID, alert,
      { ...alert, status: newStatus, actionTaken }, alert.account_ID);
    return true;
  });

  srv.on('escalateAlert', 'FraudAlerts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const alert = await db.run(SELECT.one.from('sains.ar.FraudAlert').where({ ID }));
    if (!alert) return req.error(404, 'Fraud alert not found');

    await db.run(UPDATE('sains.ar.FraudAlert').set({
      status: 'ESCALATED',
      alertSeverity: 'HIGH',
    }).where({ ID }));

    await sendSystemAlert({
      severity: 'ERROR',
      subject: `[SAINS AR] ESCALATED Fraud Alert — ${alert.alertPattern}`,
      body: `Alert ${ID} escalated by ${req.user.id}. ${alert.alertDescription}`,
      alertType: 'FRAUD_ESCALATION',
    });

    await logAction(req, 'ESCALATE_FRAUD_ALERT', 'FraudAlert', ID, alert,
      { ...alert, status: 'ESCALATED' }, alert.account_ID);
    return true;
  });
}

/**
 * Daily proactive scan for fraud patterns that require batch analysis.
 * Runs at 03:00 MYT daily.
 */
async function runProactiveFraudScan() {
  const db = await cds.connect.to('db');
  let alertsCreated = 0;

  // Pattern 1: REFUND_NO_BILLING — deposit refunded but no billing in 6+ months
  const refunds = await db.run(
    SELECT.from('sains.ar.DepositRecord')
      .columns('ID', 'account_ID', 'amount')
      .where({ status: 'REFUNDED' })
  );
  for (const ref of refunds) {
    const dayjs = require('dayjs');
    const sixMonthsAgo = dayjs().subtract(6, 'month').format('YYYY-MM-DD');
    const recentInvoice = await db.run(
      SELECT.one.from('sains.ar.Invoice')
        .where({ account_ID: ref.account_ID, invoiceDate: { '>=': sixMonthsAgo } })
    );
    if (!recentInvoice) {
      const existing = await db.run(
        SELECT.one.from('sains.ar.FraudAlert')
          .where({ account_ID: ref.account_ID, alertPattern: 'REFUND_NO_BILLING', status: { in: ['OPEN', 'UNDER_REVIEW'] } })
      );
      if (!existing) {
        await db.run(INSERT.into('sains.ar.FraudAlert').entries({
          ID: uuidv4(),
          account_ID: ref.account_ID,
          alertPattern: 'REFUND_NO_BILLING',
          alertSeverity: 'MEDIUM',
          alertDescription: `Deposit RM ${ref.amount} refunded but no billing activity in 6+ months`,
          triggeredByAction: 'PROACTIVE_SCAN',
          triggeredByUser: 'SYSTEM',
          status: 'OPEN',
          assignedTo: _getAssigneeByRole('MEDIUM'),
        }));
        alertsCreated++;
      }
    }
  }

  // Pattern 2: GHOST_ACCOUNT_PAYMENT — payment received for VOID/CLOSED account
  const ghostPayments = await db.run(
    SELECT.from('sains.ar.Payment')
      .columns('ID', 'account_ID', 'amount', 'paymentDate')
      .where({ status: { '!=': 'REVERSED' } })
      .limit(5000)
  );
  for (const pay of ghostPayments) {
    const acct = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns('accountStatus').where({ ID: pay.account_ID })
    );
    if (acct && (acct.accountStatus === 'VOID' || acct.accountStatus === 'CLOSED')) {
      const existing = await db.run(
        SELECT.one.from('sains.ar.FraudAlert')
          .where({ account_ID: pay.account_ID, alertPattern: 'GHOST_ACCOUNT_PAYMENT', status: { in: ['OPEN', 'UNDER_REVIEW'] } })
      );
      if (!existing) {
        await db.run(INSERT.into('sains.ar.FraudAlert').entries({
          ID: uuidv4(),
          account_ID: pay.account_ID,
          alertPattern: 'GHOST_ACCOUNT_PAYMENT',
          alertSeverity: 'HIGH',
          alertDescription: `Payment of RM ${pay.amount} received for ${acct.accountStatus} account`,
          triggeredByAction: 'PROACTIVE_SCAN',
          triggeredByUser: 'SYSTEM',
          status: 'OPEN',
          assignedTo: _getAssigneeByRole('HIGH'),
        }));
        alertsCreated++;
      }
    }
  }

  logger.info(`Proactive fraud scan: ${alertsCreated} new alerts created`);
  return { alertsCreated };
}

module.exports = { checkFraudPatterns, runProactiveFraudScan, _registerHandlers };
