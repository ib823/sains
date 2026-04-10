'use strict';

const Decimal = require('decimal.js');
const { CLEARING_TYPE, INVOICE_STATUS, PAYMENT_STATUS, OVERPAYMENT_NOTIFY_THRESHOLD } = require('./constants');
const { validateTransition } = require('./account-state-machine');

function allocatePayment(payment, invoices) {
  const clearings = [];
  const invoiceStatusUpdates = [];
  let remaining = new Decimal(payment.amountUnallocated || payment.amount);

  for (const inv of invoices) {
    if (remaining.lte(0)) break;
    const outstanding = new Decimal(inv.amountOutstanding);
    if (outstanding.lte(0)) continue;

    const clearAmount = Decimal.min(remaining, outstanding);
    const newOutstanding = outstanding.minus(clearAmount);
    const isExact = clearAmount.eq(outstanding) && remaining.eq(outstanding);
    const isPartial = clearAmount.lt(outstanding);

    clearings.push({
      paymentID: payment.ID,
      invoiceID: inv.ID,
      payment_ID: payment.ID,
      invoice_ID: inv.ID,
      clearedAmount: clearAmount.toNumber(),
      clearingDate: new Date().toISOString().split('T')[0],
      clearingType: isExact ? CLEARING_TYPE.EXACT_MATCH : CLEARING_TYPE.FIFO,
      isPartial,
    });

    const newStatus = newOutstanding.eq(0) ? INVOICE_STATUS.CLEARED : INVOICE_STATUS.PARTIAL;
    const newAmountCleared = new Decimal(inv.amountCleared || 0).plus(clearAmount);

    invoiceStatusUpdates.push({
      invoiceID: inv.ID,
      newStatus,
      newAmountOutstanding: newOutstanding.toNumber(),
      newAmountCleared: newAmountCleared.toNumber(),
    });

    remaining = remaining.minus(clearAmount);
  }

  const totalAllocated = new Decimal(payment.amountUnallocated || payment.amount).minus(remaining);
  const overpaymentAmount = remaining.toNumber();
  const requiresOvpayNotification = remaining.gte(OVERPAYMENT_NOTIFY_THRESHOLD);

  let paymentStatusFinal;
  if (remaining.gt(0) && clearings.length > 0) {
    paymentStatusFinal = PAYMENT_STATUS.ALLOCATED;
  } else if (remaining.eq(0) && clearings.length > 0) {
    paymentStatusFinal = PAYMENT_STATUS.ALLOCATED;
  } else {
    paymentStatusFinal = PAYMENT_STATUS.UNALLOCATED;
  }

  return {
    clearings,
    paymentStatusFinal,
    invoiceStatusUpdates,
    overpaymentAmount,
    unallocatedAmount: remaining.toNumber(),
    requiresOvpayNotification,
    notifyOverpayment: requiresOvpayNotification,
    totalAllocated: totalAllocated.toNumber(),
    totalUnallocated: remaining.toNumber(),
  };
}

function reverseAllocation(clearings, invoiceStates) {
  const invoiceRollbacks = [];
  let totalReversed = 0;

  for (const cl of clearings) {
    // Skip overpayment credit records (no invoiceID)
    if (!cl.invoiceID && !cl.invoice_ID) continue;

    const invID = cl.invoiceID || cl.invoice_ID;
    const clearedAmount = Number(cl.clearedAmount || 0);
    totalReversed += clearedAmount;

    const inv = (invoiceStates || []).find(i => i.ID === invID);
    if (inv) {
      const newAmountCleared = (inv.amountCleared || 0) - clearedAmount;
      const newAmountOutstanding = (inv.amountOutstanding || 0) + clearedAmount;
      const newStatus = newAmountCleared <= 0 ? INVOICE_STATUS.OPEN : INVOICE_STATUS.PARTIAL;
      invoiceRollbacks.push({
        invoiceID: invID,
        amountToRestore: clearedAmount,
        newStatus,
        newAmountOutstanding,
        newAmountCleared: Math.max(0, newAmountCleared),
      });
    } else {
      invoiceRollbacks.push({
        invoiceID: invID,
        amountToRestore: clearedAmount,
      });
    }
  }

  return { invoiceRollbacks, totalReversed };
}

/**
 * Check if an account was TEMP_DISCONNECTED and has now reached zero balance.
 * If so, trigger iWRS reconnection notification and update account status.
 * Called by payment-orchestrator.js after every successful payment allocation.
 */
async function checkAndTriggerReconnection(db, accountID, paymentReference) {
  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'accountStatus', 'balanceOutstanding', 'balanceDeposit')
      .where({ ID: accountID })
  );
  if (!account) return;
  if (account.accountStatus !== 'TEMP_DISCONNECTED') return;
  if (Number(account.balanceOutstanding) > 0) return;

  const logger = cds.log('clearing-engine');

  // Validate transition before attempting update
  try {
    validateTransition(account.accountStatus, 'ACTIVE');
  } catch (err) {
    logger.warn(`Reconnection state machine rejected for ${account.accountNumber}: ${err.message}`);
    return;
  }

  // ── ATOMIC STATUS TRANSITION ─────────────────────────────────────────────
  // Attempt to move from TEMP_DISCONNECTED → ACTIVE atomically in a single UPDATE.
  // Only one concurrent call wins. The other finds status != TEMP_DISCONNECTED
  // and exits. This prevents duplicate reconnection work orders and notifications.
  const updateResult = await db.run(
    UPDATE('sains.ar.CustomerAccount')
      .set({ accountStatus: 'ACTIVE', dunningLevel: 0 })
      .where({
        ID: accountID,
        accountStatus: 'TEMP_DISCONNECTED',
      })
  );

  if (!updateResult || updateResult === 0) {
    logger.info(`Reconnection for ${account.accountNumber} already triggered — skipping duplicate`);
    return;
  }
  // ── END ATOMIC STATUS TRANSITION ─────────────────────────────────────────

  // Notify iWRS (non-blocking)
  try {
    const iwrsAdapter = require('../external/iwrs-adapter');
    await iwrsAdapter.notifyReconnection(account, paymentReference, new Date().toISOString());
  } catch (err) {
    logger.error(`iWRS reconnection notification failed for ${account.accountNumber}: ${err.message}`);
  }

  // Create Metis reconnection work order (non-blocking)
  try {
    const metisAdapter = require('../external/metis-adapter');
    await metisAdapter.createReconnectionWorkOrder(account, paymentReference);
  } catch (err) {
    logger.error(`Metis reconnection work order failed for ${account.accountNumber}: ${err.message}`);
  }

  // Audit log
  try {
    const { logSystemAction } = require('./audit-logger');
    await logSystemAction('RECONNECT', 'CustomerAccount', accountID,
      { status: 'ACTIVE', dunningLevel: 0, trigger: paymentReference, source: 'CLEARING_ENGINE' },
      accountID);
  } catch (err) {
    logger.error(`Reconnection audit log failed: ${err.message}`);
  }

  logger.info(`Account ${account.accountNumber} reconnected — payment ${paymentReference} cleared balance`);
}

module.exports = { allocatePayment, reverseAllocation, checkAndTriggerReconnection };
