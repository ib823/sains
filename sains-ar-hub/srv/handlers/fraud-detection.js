'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../lib/audit-logger');
const { FRAUD_ALERT_PATTERN, FRAUD_THRESHOLDS } = require('../lib/constants');
const { sendSystemAlert } = require('../external/notification-service');

const logger = cds.log('fraud-detection');

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

    const assignedTo = severity === 'HIGH'
      ? 'ROLE:FinanceManager' // MOCK: production uses XSUAA role-based assignment
      : 'ROLE:FinanceSupervisor'; // MOCK: production uses XSUAA role-based assignment

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

module.exports = { checkFraudPatterns, _registerHandlers };
