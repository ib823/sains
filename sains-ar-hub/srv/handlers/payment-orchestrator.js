'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { allocatePayment } = require('../lib/clearing-engine');
const { logAction, logSystemAction } = require('../lib/audit-logger');
const { PAYMENT_STATUS, INVOICE_STATUS, CLEARING_TYPE } = require('../lib/constants');

const logger = cds.log('payment-orchestrator');

/**
 * Process all RESOLVED PaymentOrchestratorEvents that have not yet
 * been converted to Payment records. This is the final step of the
 * unified payment ingestion pipeline:
 *
 * Channel → PaymentOrchestratorEvent → (this function) → ar.Payment + clearings
 *
 * Runs every hour via BTP Job Scheduling Service.
 * Also called directly after batch processing (JomPAY, agent batch).
 *
 * @param {Date} asOfDate - Process events up to this timestamp
 */
async function processResolvedEvents(asOfDate = new Date()) {
  const db = await cds.connect.to('db');

  const events = await db.run(
    SELECT.from('sains.ar.payment.PaymentOrchestratorEvent')
      .where({
        status: 'RESOLVED',
        paymentID: null, // Not yet converted to a Payment
        transactionDate: { '<=': asOfDate.toISOString().substring(0, 10) },
      })
      .limit(1000) // Process in batches of 1000
      .orderBy({ transactionDate: 'asc', createdAt: 'asc' })
  );

  let converted = 0, failed = 0;

  for (const event of events) {
    try {
      const result = await _createPaymentFromEvent(db, event);
      // If duplicate was detected, _createPaymentFromEvent already set DUPLICATE status
      const updatedEvent = await db.run(
        SELECT.one.from('sains.ar.payment.PaymentOrchestratorEvent').where({ ID: event.ID })
      );
      if (updatedEvent.status !== 'DUPLICATE') {
        await db.run(
          UPDATE('sains.ar.payment.PaymentOrchestratorEvent')
            .set({ status: 'PROCESSED', paymentID: result })
            .where({ ID: event.ID })
        );
      }
      converted++;
    } catch (err) {
      logger.error(`Orchestrator: failed to process event ${event.ID}: ${err.message}`);
      await db.run(
        UPDATE('sains.ar.payment.PaymentOrchestratorEvent')
          .set({ status: 'PROCESSING_ERROR', processingError: err.message.substring(0, 500) })
          .where({ ID: event.ID })
      );
      failed++;
    }
  }

  logger.info(`Payment orchestrator: ${converted} converted, ${failed} failed from ${events.length} events`);
  return { converted, failed, total: events.length };
}

async function _createPaymentFromEvent(db, event) {
  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'accountStatus', 'balanceOutstanding')
      .where({ ID: event.resolvedAccountID })
  );
  if (!account) throw new Error(`Account ${event.resolvedAccountID} not found`);
  if (account.accountStatus === 'CLOSED') throw new Error(`Account ${account.accountNumber} is CLOSED`);

  // Check for duplicate: same channel + same raw reference + same amount + same date
  const duplicate = await db.run(
    SELECT.one.from('sains.ar.Payment')
      .columns('ID')
      .where({
        account_ID: account.ID,
        paymentReference: event.rawReference,
        amount: event.amount,
        paymentDate: event.transactionDate,
        channel: event.sourceChannel,
      })
  );
  if (duplicate) {
    logger.warn(`Orchestrator: duplicate detected for event ${event.ID} — payment ${duplicate.ID} already exists`);
    // Mark event as duplicate
    await db.run(
      UPDATE('sains.ar.payment.PaymentOrchestratorEvent')
        .set({ status: 'DUPLICATE', duplicateOfID: duplicate.ID })
        .where({ ID: event.ID })
    );
    return duplicate.ID;
  }

  const paymentID = cds.utils.uuid();

  // Create the Payment record
  await db.run(INSERT.into('sains.ar.Payment').entries({
    ID: paymentID,
    account_ID: account.ID,
    paymentReference: event.rawReference,
    paymentDate: event.transactionDate,
    valueDate: event.valueDate || event.transactionDate,
    channel: event.sourceChannel,
    status: PAYMENT_STATUS.RECEIVED,
    amount: event.amount,
    amountAllocated: 0,
    amountUnallocated: event.amount,
    receivedDateTime: new Date().toISOString(),
    batchReference: event.batchID,
    bankReference: event.rawReference,
  }));

  // Run clearing engine
  const openInvoices = await db.run(
    SELECT.from('sains.ar.Invoice')
      .columns('ID', 'amountOutstanding', 'amountCleared', 'totalAmount', 'status', 'dueDate')
      .where({
        account_ID: account.ID,
        status: { in: [INVOICE_STATUS.OPEN, INVOICE_STATUS.PARTIAL] },
      })
      .orderBy({ dueDate: 'asc' })
  );

  const paymentRecord = { ID: paymentID, account_ID: account.ID, amount: event.amount };
  const result = allocatePayment(paymentRecord, openInvoices);

  // Persist clearings
  for (const clearing of result.clearings) {
    if (!clearing.invoiceID) continue;
    await db.run(INSERT.into('sains.ar.PaymentClearing').entries({
      payment_ID: paymentID,
      invoice_ID: clearing.invoiceID,
      clearedAmount: clearing.clearedAmount,
      clearingDate: event.transactionDate,
      clearingType: clearing.clearingType,
      isPartial: clearing.isPartial,
    }));
  }

  // Update invoices
  for (const upd of result.invoiceStatusUpdates) {
    await db.run(UPDATE('sains.ar.Invoice').set({
      status: upd.newStatus,
      amountCleared: upd.newAmountCleared,
      amountOutstanding: upd.newAmountOutstanding,
    }).where({ ID: upd.invoiceID }));
  }

  // Update account balance
  const totalCleared = result.clearings
    .filter(c => c.clearingType !== CLEARING_TYPE.OVERPAYMENT_CREDIT)
    .reduce((s, c) => s + c.clearedAmount, 0);

  if (totalCleared > 0) {
    await db.run(UPDATE('sains.ar.CustomerAccount')
      .set({
        balanceOutstanding: { '-=': totalCleared },
        lastPaymentDate: event.transactionDate,
        lastPaymentAmount: event.amount,
      })
      .where({ ID: account.ID }));
  }
  if (result.overpaymentAmount > 0) {
    await db.run(UPDATE('sains.ar.CustomerAccount')
      .set({ balanceCreditOnAccount: { '+=': result.overpaymentAmount } })
      .where({ ID: account.ID }));
  }

  // Update payment status
  await db.run(UPDATE('sains.ar.Payment').set({
    status: result.paymentStatusFinal,
    amountAllocated: event.amount - (result.unallocatedAmount || 0),
    amountUnallocated: result.unallocatedAmount || 0,
  }).where({ ID: paymentID }));

  await logSystemAction('POST', 'Payment', paymentID, {
    sourceChannel: event.sourceChannel,
    amount: event.amount,
    status: result.paymentStatusFinal,
    totalCleared,
    orchestratorEventID: event.ID,
  }, account.ID);

  // CHANGE 3: Instalment matching for active payment plans
  if (totalCleared > 0) {
    try {
      const activePlan = await db.run(
        SELECT.one.from('sains.ar.PaymentPlan')
          .where({ account_ID: account.ID, planStatus: 'ACTIVE' })
      );
      if (activePlan) {
        const nextInstalment = await db.run(
          SELECT.one.from('sains.ar.PaymentPlanInstalment')
            .where({ plan_ID: activePlan.ID, status: 'PENDING' })
            .orderBy({ dueDate: 'asc' })
        );
        if (nextInstalment && event.amount >= Number(nextInstalment.amount)) {
          await db.run(UPDATE('sains.ar.PaymentPlanInstalment').set({
            status: 'PAID',
            paidDate: event.transactionDate,
            paidAmount: event.amount,
            paymentID: paymentID,
          }).where({ ID: nextInstalment.ID }));

          // Check if all instalments are now paid → complete the plan
          const remaining = await db.run(
            SELECT.from('sains.ar.PaymentPlanInstalment')
              .where({ plan_ID: activePlan.ID, status: 'PENDING' })
          );
          if (remaining.length === 0) {
            await db.run(UPDATE('sains.ar.PaymentPlan').set({
              planStatus: 'COMPLETED',
              completedAt: new Date().toISOString(),
            }).where({ ID: activePlan.ID }));
          }
        }
      }
    } catch (err) {
      logger.warn(`Instalment matching failed for account ${account.ID}: ${err.message}`);
    }

    // CHANGE 7: Resolve the latest open dunning history entry
    try {
      const latestDunning = await db.run(
        SELECT.one.from('sains.ar.DunningHistory')
          .where({ account_ID: account.ID, resolutionType: null })
          .orderBy({ triggeredDate: 'desc' })
      );
      if (latestDunning) {
        await db.run(UPDATE('sains.ar.DunningHistory').set({
          resolvedByPaymentID: paymentID,
          resolutionType: 'PAYMENT',
          resolvedAt: new Date().toISOString(),
        }).where({ ID: latestDunning.ID }));
      }
    } catch (err) {
      logger.warn(`Dunning resolution recording failed for account ${account.ID}: ${err.message}`);
    }
  }

  // Check if this payment clears a TEMP_DISCONNECTED account
  const { checkAndTriggerReconnection } = require('../lib/clearing-engine');
  await checkAndTriggerReconnection(db, account.ID, event.rawReference);

  return paymentID;
}

module.exports = { processResolvedEvents };
