'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const { sendSystemAlert } = require('./notification-service');

const logger = cds.log('sibma-adapter');

const SIBMA_CONFIG = {
  API_URL: process.env.SIBMA_API_URL || null,
  API_KEY: process.env.SIBMA_API_KEY || null,
  TIMEOUT_MS: 30000,
  MAX_RETRIES: 5,
};

function _isConfigured() {
  return !!SIBMA_CONFIG.API_URL;
}

async function _logToSimulatorInbox(eventType, accountNumber, payload) {
  try {
    const db = await cds.connect.to('db');
    await db.run(INSERT.into('sains.simulator.NotificationInbox').entries({
      ID: cds.utils.uuid(),
      channel: 'SIBMA_OUTBOUND',
      recipient: accountNumber,
      subject: eventType,
      body: JSON.stringify(payload),
      status: 'SENT',
      accountNumber,
    }));
  } catch (err) {
    logger.debug(`Simulator inbox log skipped: ${err.message}`);
  }
}

async function _enqueueRetry(eventType, accountNumber, payload, error) {
  try {
    const db = await cds.connect.to('db');
    await db.run(INSERT.into('sains.ar.sibma.SiBMAOutboundQueue').entries({
      ID: cds.utils.uuid(),
      eventType,
      accountNumber,
      payload: JSON.stringify(payload),
      status: 'PENDING',
      retryCount: 0,
      lastError: error ? String(error).substring(0, 500) : null,
    }));
  } catch (err) {
    logger.error(`Failed to enqueue SiBMA retry: ${err.message}`);
  }
}

async function _doHttpPost(endpoint, payload) {
  const url = `${SIBMA_CONFIG.API_URL.replace(/\/$/, '')}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  if (SIBMA_CONFIG.API_KEY) headers['X-API-Key'] = SIBMA_CONFIG.API_KEY;
  const resp = await axios.post(url, payload, { headers, timeout: SIBMA_CONFIG.TIMEOUT_MS });
  return resp.data || {};
}

// ── 1. PUSH PAYMENT CONFIRMATION ───────────────────────────────────────────

async function pushPaymentConfirmation(accountNumber, payment) {
  const payload = {
    accountNumber,
    paymentDate: payment.paymentDate,
    amount: Number(payment.amount || 0),
    channel: payment.channel,
    reference: payment.paymentReference || payment.bankReference,
    allocations: Array.isArray(payment.allocations) ? payment.allocations : [],
  };

  if (!_isConfigured()) {
    await _logToSimulatorInbox('PAYMENT_CONFIRMATION', accountNumber, payload);
    return { sent: true, dev: true };
  }

  try {
    const data = await _doHttpPost('/payment-confirmation', payload);
    return { sent: true, sibmaRef: data.sibmaRef || null, queuedForRetry: false };
  } catch (err) {
    logger.error(`SiBMA pushPaymentConfirmation failed for ${accountNumber}: ${err.message}`);
    await _enqueueRetry('PAYMENT_CONFIRMATION', accountNumber, payload, err.message);
    return { sent: false, queuedForRetry: true };
  }
}

// ── 2. PUSH BALANCE UPDATE ─────────────────────────────────────────────────

async function pushBalanceUpdate(accountNumber, newBalance, trigger) {
  const payload = {
    accountNumber,
    balanceOutstanding: Number(newBalance?.balanceOutstanding ?? 0),
    balanceDeposit: Number(newBalance?.balanceDeposit ?? 0),
    lastPaymentDate: newBalance?.lastPaymentDate || null,
    lastPaymentAmount: Number(newBalance?.lastPaymentAmount ?? 0),
    trigger: trigger || 'UNKNOWN',
  };

  if (!_isConfigured()) {
    await _logToSimulatorInbox('BALANCE_UPDATE', accountNumber, payload);
    return { sent: true, dev: true };
  }

  try {
    await _doHttpPost('/balance-update', payload);
    return { sent: true, queuedForRetry: false };
  } catch (err) {
    logger.error(`SiBMA pushBalanceUpdate failed for ${accountNumber}: ${err.message}`);
    await _enqueueRetry('BALANCE_UPDATE', accountNumber, payload, err.message);
    return { sent: false, queuedForRetry: true };
  }
}

// ── 3. PUSH TRANSACTION HISTORY ────────────────────────────────────────────

async function pushTransactionHistory(accountNumber, fromDate, toDate) {
  const db = await cds.connect.to('db');

  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount').where({ accountNumber })
  );
  if (!account) {
    return { sent: false, transactionCount: 0, reason: 'Account not found' };
  }

  const [invoices, payments, adjustments] = await Promise.all([
    db.run(SELECT.from('sains.ar.Invoice')
      .where({ account_ID: account.ID, invoiceDate: { between: fromDate, and: toDate } })),
    db.run(SELECT.from('sains.ar.Payment')
      .where({ account_ID: account.ID, paymentDate: { between: fromDate, and: toDate } })),
    db.run(SELECT.from('sains.ar.Adjustment')
      .where({ account_ID: account.ID, createdAt: { between: fromDate, and: toDate } })),
  ]);

  const transactions = [
    ...invoices.map(i => ({
      date: i.invoiceDate, type: 'INVOICE', reference: i.invoiceNumber,
      debit: Number(i.totalAmount || 0), credit: 0,
    })),
    ...payments.map(p => ({
      date: p.paymentDate, type: 'PAYMENT', reference: p.paymentReference,
      debit: 0, credit: Number(p.amount || 0),
    })),
    ...adjustments.map(a => ({
      date: a.createdAt && String(a.createdAt).substring(0, 10), type: 'ADJUSTMENT',
      reference: a.ID,
      debit: a.adjustmentType === 'DEBIT' ? Number(a.amount || 0) : 0,
      credit: a.adjustmentType === 'CREDIT' ? Number(a.amount || 0) : 0,
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  const payload = { accountNumber, fromDate, toDate, transactions };

  if (!_isConfigured()) {
    await _logToSimulatorInbox('TRANSACTION_HISTORY', accountNumber, payload);
    return { sent: true, dev: true, transactionCount: transactions.length };
  }

  try {
    await _doHttpPost('/transaction-history', payload);
    return { sent: true, transactionCount: transactions.length };
  } catch (err) {
    logger.error(`SiBMA pushTransactionHistory failed for ${accountNumber}: ${err.message}`);
    await _enqueueRetry('TRANSACTION_HISTORY', accountNumber, payload, err.message);
    return { sent: false, queuedForRetry: true, transactionCount: transactions.length };
  }
}

// ── 4. RETRY QUEUE ─────────────────────────────────────────────────────────

async function processRetryQueue() {
  const db = await cds.connect.to('db');

  const queued = await db.run(
    SELECT.from('sains.ar.sibma.SiBMAOutboundQueue')
      .where({ status: 'PENDING', retryCount: { '<': SIBMA_CONFIG.MAX_RETRIES } })
      .orderBy('createdAt')
      .limit(200)
  );

  let retried = 0, succeeded = 0, deadLettered = 0;

  for (const row of queued) {
    retried++;
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }

    let endpoint = '/payment-confirmation';
    if (row.eventType === 'BALANCE_UPDATE') endpoint = '/balance-update';
    else if (row.eventType === 'TRANSACTION_HISTORY') endpoint = '/transaction-history';

    if (!_isConfigured()) {
      // No config — cannot retry; leave as PENDING
      continue;
    }

    try {
      const data = await _doHttpPost(endpoint, payload);
      await db.run(UPDATE('sains.ar.sibma.SiBMAOutboundQueue').set({
        status: 'SENT',
        sentAt: new Date().toISOString(),
        sibmaRef: data.sibmaRef || null,
      }).where({ ID: row.ID }));
      succeeded++;
    } catch (err) {
      const newRetryCount = (row.retryCount || 0) + 1;
      const isDead = newRetryCount >= SIBMA_CONFIG.MAX_RETRIES;
      await db.run(UPDATE('sains.ar.sibma.SiBMAOutboundQueue').set({
        retryCount: newRetryCount,
        lastRetryAt: new Date().toISOString(),
        lastError: String(err.message).substring(0, 500),
        status: isDead ? 'DEAD_LETTER' : 'PENDING',
      }).where({ ID: row.ID }));

      if (isDead) {
        deadLettered++;
        try {
          await sendSystemAlert({
            severity: 'HIGH',
            subject: `SiBMA outbound dead-lettered: ${row.eventType}`,
            body: `Account ${row.accountNumber} — last error: ${err.message}`,
          });
        } catch { /* non-blocking */ }
      }
    }
  }

  return { retried, succeeded, deadLettered };
}

module.exports = {
  pushPaymentConfirmation,
  pushBalanceUpdate,
  pushTransactionHistory,
  processRetryQueue,
};
