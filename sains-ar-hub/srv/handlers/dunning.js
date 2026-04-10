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

// MOCK: section references are illustrative. Confirm exact Act 655 sections with SAINS Legal.
const REGULATORY_REFS = {
  1: 'Act655.S43.1',  // reminder notice
  2: 'Act655.S43.2',  // formal notice
  3: 'Act655.S44.1',  // disconnection warning
  4: 'Act655.S44.2',  // disconnection order
  5: 'Act655.S45',    // legal proceedings
};

const logger = cds.log('dunning-job');
const BATCH_SIZE = 5000;

async function runNightlyDunningJob(date = new Date()) {
  const db = await cds.connect.to('db');
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
      regulatoryRef: REGULATORY_REFS[decision.newDunningLevel] || null,
    }));

    // Level 5: set isLegalAction flag on account
    if (decision.newDunningLevel >= DUNNING_LEVEL.LEGAL_ACTION) {
      await db.run(UPDATE('sains.ar.CustomerAccount').set({
        isLegalAction: true,
      }).where({ ID: account.ID }));
    }

    if (channels.includes('EMAIL') && account.emailAddress) {
      try {
        await sendEmail({
          to: account.emailAddress,
          subject: `[SAINS] ${decision.noticeType} — Account ${account.accountNumber}`,
          body: `Dear ${account.legalName},\n\nOutstanding: RM${decision.overdueAmount.toFixed(2)}\nOverdue: ${decision.overdueDays} days\n\nPlease contact SAINS.`,
        });
        await db.run(UPDATE('sains.ar.DunningHistory').set({ emailSentAt: new Date().toISOString() }).where({ ID: historyID }));
      } catch (err) {
        logger.error(`Email notification failed for ${account.accountNumber}: ${err.message}`);
        await db.run(UPDATE('sains.ar.DunningHistory').set({ emailBounced: true }).where({ ID: historyID }))
          .catch(e => logger.error(`Failed to update dunning history emailBounced: ${e.message}`));
      }
    }

    if (channels.includes('SMS') && account.primaryPhone) {
      try {
        await sendSMS({
          to: account.primaryPhone,
          message: `SAINS: ${decision.noticeType} akaun ${account.accountNumber}. Baki: RM${decision.overdueAmount.toFixed(2)}.`,
        });
        await db.run(UPDATE('sains.ar.DunningHistory').set({ smsSentAt: new Date().toISOString() }).where({ ID: historyID }));
      } catch (err) {
        logger.error(`SMS notification failed for ${account.accountNumber}: ${err.message}`);
      }
    }

    if (channels.includes('POSTAL')) {
      try {
        const address = [account.serviceAddress1, account.serviceAddress2,
          account.serviceCity, account.serviceState, account.servicePostcode].filter(Boolean).join('\n');
        await queuePostalNotice({
          accountNumber: account.accountNumber, customerName: account.legalName,
          address, noticeType: decision.noticeType, dunningHistoryID: historyID,
        });
      } catch (err) {
        logger.error(`Postal notice queueing failed for ${account.accountNumber}: ${err.message}`);
      }
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
    db.run(SELECT.from('sains.ar.Invoice').where({ invoiceDate: dateStr, status: { '!=': 'REVERSED' } })),
    db.run(SELECT.from('sains.ar.Payment').where({ paymentDate: dateStr, status: { '!=': 'REVERSED' } })),
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
  const logger = cds.log('dunning');
  const { SAP_CORE } = require('../lib/constants');

  const periodEnd = dayjs(`${year}-${String(month).padStart(2,'0')}-01`).endOf('month').format('YYYY-MM-DD');

  // Check if already run for this period (idempotency)
  const existing = await db.run(
    SELECT.one.from('sains.ar.GLPostingBatch')
      .where({ idempotencyKey: `ACCRUAL_${year}_${month}`, status: { '!=': 'FAILED' } })
  );
  if (existing) {
    logger.info(`Period accrual for ${year}-${month} already exists (${existing.ID}) — skipping`);
    return { processed: 0, accrualTransactions: 0 };
  }

  const BATCH_SIZE = 5000;
  let totalAccrual = 0;
  let accountsProcessed = 0;
  let offset = 0;

  // Process accounts in batches of 5000
  while (true) {
    const accounts = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('ID', 'accountNumber', 'accountType_code', 'billingBasis_code')
        .where({ accountStatus: { in: ['ACTIVE', 'RESTRICTED'] }, billingBasis_code: 'MTR' })
        .limit(BATCH_SIZE, offset)
    );
    if (accounts.length === 0) break;

    for (const acct of accounts) {
      // Find last 3 invoices to estimate average monthly consumption
      const recentInvoices = await db.run(
        SELECT.from('sains.ar.Invoice')
          .columns('totalAmount', 'taxAmount', 'invoiceDate', 'billingPeriodFrom', 'billingPeriodTo')
          .where({ account_ID: acct.ID, status: { in: ['OPEN', 'CLEARED', 'PARTIAL'] } })
          .orderBy('invoiceDate desc')
          .limit(3)
      );

      if (recentInvoices.length === 0) continue;

      // Average monthly revenue (excluding tax)
      const avgMonthlyRevenue = recentInvoices.reduce((sum, inv) =>
        sum + Number(inv.totalAmount || 0) - Number(inv.taxAmount || 0), 0
      ) / recentInvoices.length;

      // Days since last invoice to period end
      const lastInvoiceDate = recentInvoices[0]?.invoiceDate;
      if (!lastInvoiceDate) continue;

      const daysSinceLastInvoice = dayjs(periodEnd).diff(dayjs(lastInvoiceDate), 'day');
      if (daysSinceLastInvoice <= 0) continue;

      // Pro-rate: (avg daily revenue) × days unbilled
      const dailyRevenue = avgMonthlyRevenue / 30;
      const unbilledRevenue = Math.round(dailyRevenue * Math.min(daysSinceLastInvoice, 30) * 100) / 100;

      if (unbilledRevenue > 0) {
        totalAccrual += unbilledRevenue;
        accountsProcessed++;
      }
    }

    offset += BATCH_SIZE;
    logger.info(`Period accrual: processed ${offset} accounts so far, accrual RM ${totalAccrual.toFixed(2)}`);
  }

  if (totalAccrual <= 0) {
    logger.info(`Period accrual for ${year}-${month}: no unbilled revenue to accrue`);
    return { processed: accountsProcessed, accrualTransactions: 0 };
  }

  // Build GL batch
  const glMappings = await db.run(SELECT.from('sains.ar.GLAccountMapping').where({ isActive: true }));
  const transactions = [{
    transactionType: 'PERIOD_ACCRUAL',
    accountTypeCode: 'ALL',
    chargeTypeCode: 'ALL',
    chargeType: 'ALL',
    branchCode: 'COMMON',
    amount: totalAccrual,
    referenceDocType: 'PERIOD_ACCRUAL',
    referenceDocID: `ACCRUAL_${year}_${month}`,
  }];

  const batch = buildDailySummaryBatch(transactions, glMappings, periodEnd, SAP_CORE.COMPANY_CODE);
  batch.idempotencyKey = `ACCRUAL_${year}_${month}`;
  batch.headerText = `Period accrual ${year}-${String(month).padStart(2,'0')}`;
  batch.postingType = 'PERIOD_ACCRUAL';

  const payload = buildJournalEntryPayload(batch);
  const result = await postJournalEntry(payload, batch.ID);

  // Persist batch
  await db.run(INSERT.into('sains.ar.GLPostingBatch').entries({
    ID: batch.ID || uuidv4(),
    idempotencyKey: batch.idempotencyKey,
    batchDate: periodEnd,
    postingType: 'PERIOD_ACCRUAL',
    status: result.success ? GL_POSTING_STATUS.ACCEPTED : GL_POSTING_STATUS.REJECTED,
    totalDebitAmount: totalAccrual,
    totalCreditAmount: totalAccrual,
    lineCount: 2,
    sapCoreDocNumber: result.documentNumber,
    rejectionReason: result.errorMessage,
    submittedAt: new Date().toISOString(),
  }));

  // MOCK: uses average consumption estimation. Production may use meter read interpolation.
  logger.info(`Period accrual ${year}-${month}: RM ${totalAccrual.toFixed(2)} from ${accountsProcessed} accounts`);
  return { processed: accountsProcessed, accrualTransactions: totalAccrual > 0 ? 1 : 0 };
}

/**
 * CHANGE 1: PTP automatic compliance check — runs daily at 04:00
 * Evaluates all ACTIVE PTPs: marks them HONOURED, BROKEN, or EXPIRED.
 */
async function runPTPComplianceCheck() {
  const db = await cds.connect.to('db');
  const today = dayjs();
  const todayStr = today.format('YYYY-MM-DD');

  const activePTPs = await db.run(
    SELECT.from('sains.ar.PromiseToPay').where({ status: 'ACTIVE' })
  );

  let checked = 0, honoured = 0, broken = 0, expired = 0;

  for (const ptp of activePTPs) {
    checked++;
    const promisedDate = dayjs(ptp.promisedDate);

    if (!promisedDate.isBefore(today, 'day')) continue; // not yet due

    // More than 30 days past promisedDate with no resolution → EXPIRED
    if (today.diff(promisedDate, 'day') > 30) {
      await db.run(UPDATE('sains.ar.PromiseToPay').set({
        status: 'EXPIRED',
        resolvedAt: new Date().toISOString(),
      }).where({ ID: ptp.ID }));
      expired++;
      continue;
    }

    // Check for qualifying payments received between PTP creation date and today
    const ptpCreatedStr = (ptp.createdAt || ptp.promisedDate).substring(0, 10);
    const payments = await db.run(
      SELECT.from('sains.ar.Payment')
        .columns('ID', 'amount', 'paymentDate', 'status')
        .where({
          account_ID: ptp.account_ID,
          paymentDate: { '>=': ptpCreatedStr, '<=': todayStr },
          status: { not: { in: ['REVERSED', 'BOUNCED'] } },
        })
    );

    const totalPaid = payments.reduce((s, p) => s + Number(p.amount || 0), 0);

    if (totalPaid >= Number(ptp.promisedAmount)) {
      // Find the earliest payment on or before promisedDate
      const onTime = payments
        .filter(p => !dayjs(p.paymentDate).isAfter(promisedDate))
        .sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));
      const paymentDate = (onTime[0]?.paymentDate || todayStr);
      await db.run(UPDATE('sains.ar.PromiseToPay').set({
        status: 'HONOURED',
        resolvedAt: paymentDate + 'T00:00:00.000Z',
      }).where({ ID: ptp.ID }));
      honoured++;
    } else {
      await db.run(UPDATE('sains.ar.PromiseToPay').set({
        status: 'BROKEN',
        resolvedAt: new Date().toISOString(),
      }).where({ ID: ptp.ID }));
      broken++;
    }
  }

  // Also run payment plan breach detection as part of the daily collections health check
  const planResult = await runPaymentPlanBreachCheck();

  logger.info(`PTP compliance: ${checked} checked, ${honoured} honoured, ${broken} broken, ${expired} expired`);
  return { checked, honoured, broken, expired, ...planResult };
}

/**
 * CHANGE 4: Payment plan breach detection
 * Finds ACTIVE plans with 2+ missed instalments and marks them BREACHED.
 */
async function runPaymentPlanBreachCheck() {
  const db = await cds.connect.to('db');
  const today = dayjs().format('YYYY-MM-DD');

  const activePlans = await db.run(
    SELECT.from('sains.ar.PaymentPlan').where({ planStatus: 'ACTIVE' })
  );

  let plansChecked = 0, plansBreach = 0;

  for (const plan of activePlans) {
    plansChecked++;

    const missedInstalments = await db.run(
      SELECT.from('sains.ar.PaymentPlanInstalment')
        .where({ plan_ID: plan.ID, status: 'PENDING', dueDate: { '<': today } })
    );

    if (missedInstalments.length >= 2) {
      await db.run(UPDATE('sains.ar.PaymentPlan').set({
        planStatus: 'BREACHED',
        breachCount: missedInstalments.length,
      }).where({ ID: plan.ID }));

      // Resume dunning on the account
      await db.run(UPDATE('sains.ar.CustomerAccount').set({
        isPaymentPlan: false,
      }).where({ ID: plan.account_ID }));

      try {
        await logSystemAction('BREACH', 'PaymentPlan', plan.ID, {
          missedInstalments: missedInstalments.length,
          planID: plan.ID,
          accountID: plan.account_ID,
        }, plan.account_ID);
      } catch (err) {
        logger.error(`Breach audit log failed for plan ${plan.ID}: ${err.message}`);
      }

      plansBreach++;
    }
  }

  logger.info(`Plan breach check: ${plansChecked} checked, ${plansBreach} breached`);
  return { plansChecked, plansBreach };
}

module.exports = { runNightlyDunningJob, runDailyGLPostingJob, runPeriodAccrualJob, runPTPComplianceCheck, runPaymentPlanBreachCheck };
