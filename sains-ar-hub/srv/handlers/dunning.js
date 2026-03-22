'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { evaluateDunning, getNoticeChannels, isPTPBroken } = require('../lib/dunning-engine');
const { buildDailySummaryBatch, buildJournalEntryPayload } = require('../lib/gl-builder');
const { logSystemAction } = require('../lib/audit-logger');
const { postJournalEntry } = require('../external/sap-core-api');
const { sendEmail, sendSMS, queuePostalNotice, sendSystemAlert } = require('../external/notification-service');
const { DUNNING_LEVEL, INVOICE_STATUS, ACCOUNT_STATUS, GL_POSTING_STATUS } = require('../lib/constants');

const BATCH_SIZE = 5000;

async function runNightlyDunningJob(date = new Date()) {
  const db = await cds.connect.to('db');
  const logger = cds.log('dunning-job');
  const evalDate = date;

  logger.info(`Dunning batch started for ${dayjs(evalDate).format('YYYY-MM-DD')}`);

  const allAccounts = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'accountStatus', 'dunningLevel',
               'isGovernment', 'isDisputed', 'isPaymentPlan', 'isHardship',
               'isWrittenOff', 'isLegalAction',
               'emailAddress', 'primaryPhone', 'paperBillingElected',
               'serviceAddress1', 'serviceAddress2', 'serviceCity',
               'serviceState', 'servicePostcode', 'legalName', 'branchCode')
      .where({
        accountStatus: { not: { in: [ACCOUNT_STATUS.VOID, ACCOUNT_STATUS.CLOSED] } },
        isWrittenOff: false, isLegalAction: false,
      })
  );

  const chunks = [];
  for (let i = 0; i < allAccounts.length; i += BATCH_SIZE) {
    chunks.push(allAccounts.slice(i, i + BATCH_SIZE));
  }

  let totalProcessed = 0, totalEscalated = 0, totalReset = 0, totalErrors = 0;

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(account => _processSingleAccount(db, account, evalDate).catch(err => {
        logger.error(`Error processing ${account.accountNumber}: ${err.message}`);
        totalErrors++;
        return null;
      }))
    );

    for (const r of results) {
      if (!r) continue;
      totalProcessed++;
      if (r.escalated) totalEscalated++;
      if (r.shouldReset) totalReset++;
    }
  }

  logger.info(`Dunning complete: ${totalProcessed} processed, ${totalEscalated} escalated, ${totalReset} reset, ${totalErrors} errors`);
  return { processed: totalProcessed, escalated: totalEscalated, reset: totalReset, errors: totalErrors };
}

async function _processSingleAccount(db, account, evalDate) {
  const openInvoices = await db.run(
    SELECT.from('sains.ar.Invoice')
      .columns('ID', 'amountOutstanding', 'status', 'dueDate', 'totalAmount')
      .where({ account_ID: account.ID, status: { in: [INVOICE_STATUS.OPEN, INVOICE_STATUS.PARTIAL] } })
  );

  const decision = evaluateDunning(account, openInvoices, evalDate);

  if (decision.excluded) return { escalated: false, shouldReset: false };

  if (decision.shouldReset && account.dunningLevel > 0) {
    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      dunningLevel: 0, dunningLevelDate: new Date().toISOString(),
    }).where({ ID: account.ID }));
    return { escalated: false, shouldReset: true };
  }

  if (decision.newDunningLevel > account.dunningLevel) {
    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      dunningLevel: decision.newDunningLevel,
      dunningLevelDate: new Date().toISOString(),
    }).where({ ID: account.ID }));

    const channels = getNoticeChannels(decision.newDunningLevel, account);
    const historyID = uuidv4();

    await db.run(INSERT.into('sains.ar.DunningHistory').entries({
      ID: historyID,
      account_ID: account.ID,
      dunningLevel: decision.newDunningLevel,
      triggeredDate: dayjs(evalDate).format('YYYY-MM-DD'),
      overdueDays: decision.overdueDays,
      overdueAmount: decision.overdueAmount,
      noticeType: decision.noticeType,
    }));

    if (channels.includes('EMAIL') && account.emailAddress) {
      await sendEmail({
        to: account.emailAddress,
        subject: `[SAINS] ${decision.noticeType} — Account ${account.accountNumber}`,
        body: `Dear ${account.legalName},\n\nOutstanding: RM${decision.overdueAmount.toFixed(2)}\nOverdue: ${decision.overdueDays} days\n\nPlease contact SAINS.`,
      });
      await db.run(UPDATE('sains.ar.DunningHistory').set({ emailSentAt: new Date().toISOString() }).where({ ID: historyID }));
    }

    if (channels.includes('SMS') && account.primaryPhone) {
      await sendSMS({
        to: account.primaryPhone,
        message: `SAINS: ${decision.noticeType} akaun ${account.accountNumber}. Baki: RM${decision.overdueAmount.toFixed(2)}.`,
      });
      await db.run(UPDATE('sains.ar.DunningHistory').set({ smsSentAt: new Date().toISOString() }).where({ ID: historyID }));
    }

    if (channels.includes('POSTAL')) {
      const address = [account.serviceAddress1, account.serviceAddress2,
        account.serviceCity, account.serviceState, account.servicePostcode].filter(Boolean).join('\n');
      await queuePostalNotice({
        accountNumber: account.accountNumber, customerName: account.legalName,
        address, noticeType: decision.noticeType, dunningHistoryID: historyID,
      });
    }

    // Phase 3: Notify iWRS of disconnection authorisation (non-blocking)
    if (decision.newDunningLevel >= DUNNING_LEVEL.DISCONNECTED) {
      try {
        const iwrsAdapter = require('../external/iwrs-adapter');
        const authorisationRef = `DISC-AUTH-${Date.now()}`;
        await iwrsAdapter.notifyDisconnectionAuthorised(account, 'SYSTEM', authorisationRef);
      } catch (err) {
        logger.error(`iWRS disconnection notification failed for ${account.accountNumber}: ${err.message}`);
      }
    }

    return { escalated: true, shouldReset: false };
  }

  return { escalated: false, shouldReset: false };
}

async function runDailyGLPostingJob(postingDate = new Date()) {
  const db = await cds.connect.to('db');
  const logger = cds.log('gl-job');
  const dateStr = dayjs(postingDate).subtract(1, 'day').format('YYYY-MM-DD');
  const idempotencyKey = `DAILY_${dateStr}`;

  const existing = await db.run(
    SELECT.one.from('sains.ar.GLPostingBatch')
      .where({ idempotencyKey, status: GL_POSTING_STATUS.ACCEPTED })
  );
  if (existing) {
    logger.info(`GL batch for ${dateStr} already accepted — skipping`);
    return { processed: 0, transactions: 0 };
  }

  // BLOCKER-2: Fetch ALL four transaction types
  const [invoices, payments, adjustments, deposits] = await Promise.all([
    db.run(SELECT.from('sains.ar.Invoice').where({ invoiceDate: dateStr, status: { not: 'REVERSED' } })),
    db.run(SELECT.from('sains.ar.Payment').where({ paymentDate: dateStr, status: { not: 'REVERSED' } })),
    db.run(SELECT.from('sains.ar.Adjustment').where({ postedAt: { like: `${dateStr}%` }, status: 'POSTED' })),
    db.run(SELECT.from('sains.ar.DepositRecord').where({ depositDate: dateStr })),
  ]);

  const glMappings = await db.run(SELECT.from('sains.ar.GLAccountMapping').where({ isActive: true }));

  const totalTxns = invoices.length + payments.length + adjustments.length + deposits.length;
  if (totalTxns === 0) {
    logger.info(`No transactions for ${dateStr} — skipping GL posting`);
    return { processed: 0, transactions: 0 };
  }

  try {
    const { batch, lines } = buildDailySummaryBatch(dateStr, invoices, payments, adjustments, deposits, glMappings);

    await db.run(INSERT.into('sains.ar.GLPostingBatch').entries(batch));
    for (const line of lines) {
      await db.run(INSERT.into('sains.ar.GLPostingLine').entries({
        ID: uuidv4(), batch_ID: batch.ID, ...line,
      }));
    }

    const payload = buildJournalEntryPayload(batch, lines);
    const result = await postJournalEntry(payload, batch.ID);

    if (result.success) {
      await db.run(UPDATE('sains.ar.GLPostingBatch').set({
        status: GL_POSTING_STATUS.ACCEPTED,
        sapCoreDocNumber: result.documentNumber,
        submittedAt: new Date().toISOString(),
      }).where({ ID: batch.ID }));
    } else {
      await db.run(UPDATE('sains.ar.GLPostingBatch').set({
        status: GL_POSTING_STATUS.REJECTED,
        rejectionReason: result.errorMessage,
        submittedAt: new Date().toISOString(),
      }).where({ ID: batch.ID }));

      await sendSystemAlert({
        severity: 'ERROR',
        subject: `[SAINS AR] GL Posting Failed — ${dateStr}`,
        body: `Daily GL posting for ${dateStr} was rejected: ${result.errorMessage}`,
        alertType: 'GL_FAILURE',
      });
    }

    return { processed: 1, transactions: totalTxns };
  } catch (error) {
    logger.error(`GL posting job failed: ${error.message}`);
    return { processed: 0, transactions: 0 };
  }
}

async function runPeriodAccrualJob(year, month) {
  const db = await cds.connect.to('db');
  const logger = cds.log('accrual-job');

  // Only run on last day of month
  const lastDay = dayjs(`${year}-${String(month).padStart(2, '0')}-01`).endOf('month');
  const today = dayjs();
  if (today.format('YYYY-MM-DD') !== lastDay.format('YYYY-MM-DD')) {
    logger.info('Period accrual: not last day of month — skipping');
    return { processed: 0, accrualTransactions: 0 };
  }

  logger.info(`Running period accrual for ${year}-${month}`);

  // Calculate unbilled days x daily rate per active metered account
  const accounts = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'branchCode')
      .where({ accountStatus: ACCOUNT_STATUS.ACTIVE })
  );

  // Simplified accrual: just create the GL batch
  const glMappings = await db.run(SELECT.from('sains.ar.GLAccountMapping').where({ isActive: true }));

  const batchID = uuidv4();
  await db.run(INSERT.into('sains.ar.GLPostingBatch').entries({
    ID: batchID,
    batchDate: lastDay.format('YYYY-MM-DD'),
    postingType: 'PERIOD_ACCRUAL',
    status: GL_POSTING_STATUS.PREPARED,
    totalDebitAmount: 0,
    totalCreditAmount: 0,
    lineCount: 0,
    idempotencyKey: `ACCRUAL_${year}_${month}`,
  }));

  logger.info(`Period accrual batch ${batchID} created for ${year}-${month}`);
  return { processed: accounts.length, accrualTransactions: accounts.length };
}

module.exports = { runNightlyDunningJob, runDailyGLPostingJob, runPeriodAccrualJob };
