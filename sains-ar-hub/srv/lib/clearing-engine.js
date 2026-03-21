'use strict';

const Decimal = require('decimal.js');
const { CLEARING_TYPE, INVOICE_STATUS, PAYMENT_STATUS, OVERPAYMENT_NOTIFY_THRESHOLD } = require('./constants');

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
  const results = [];

  for (const cl of clearings) {
    // Skip overpayment credit records (no invoiceID)
    if (!cl.invoiceID && !cl.invoice_ID) continue;

    const invID = cl.invoiceID || cl.invoice_ID;
    const inv = (invoiceStates || []).find(i => i.ID === invID);
    if (inv) {
      const newAmountCleared = (inv.amountCleared || 0) - cl.clearedAmount;
      const newAmountOutstanding = (inv.amountOutstanding || 0) + cl.clearedAmount;
      const newStatus = newAmountCleared <= 0 ? INVOICE_STATUS.OPEN : INVOICE_STATUS.PARTIAL;
      results.push({
        invoiceID: cl.invoiceID,
        newStatus,
        newAmountOutstanding,
        newAmountCleared: Math.max(0, newAmountCleared),
      });
    } else {
      results.push({
        invoiceID: cl.invoiceID || cl.invoice_ID,
        amountToRestore: cl.clearedAmount,
      });
    }
  }

  return results;
}

module.exports = { allocatePayment, reverseAllocation };
