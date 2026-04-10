'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const logger = cds.log('late-payment-engine');

// MOCK: late fee rate 1% per month pro-rated daily. Confirm SAINS-specific rate with Finance.
const LATE_FEE_RATE_MONTHLY = 0.01; // 1% per month
const LATE_FEE_DAILY = LATE_FEE_RATE_MONTHLY / 30;
const MAX_LATE_FEE_PCT = 0.25; // Cap at 25% of invoice amount per SPAN guidelines

/**
 * Calculate late payment fees for an account.
 * @param {string} accountID
 * @param {string} asOfDate - ISO date
 * @returns {Promise<{totalLateFee, feePerInvoice[]}>}
 */
async function calculateLateFee(accountID, asOfDate) {
  const db = await cds.connect.to('db');
  const evalDate = dayjs(asOfDate);

  const overdueInvoices = await db.run(
    SELECT.from('sains.ar.Invoice')
      .columns('ID', 'invoiceNumber', 'totalAmount', 'amountOutstanding', 'dueDate')
      .where({ account_ID: accountID, status: { in: ['OPEN', 'PARTIAL'] } })
  );

  let totalLateFee = 0;
  const feePerInvoice = [];

  for (const inv of overdueInvoices) {
    const dueDate = dayjs(inv.dueDate);
    if (evalDate.isBefore(dueDate) || evalDate.isSame(dueDate)) continue;

    const overdueDays = evalDate.diff(dueDate, 'day');
    const outstanding = Number(inv.amountOutstanding || inv.totalAmount || 0);

    let fee = Math.round(outstanding * LATE_FEE_DAILY * overdueDays * 100) / 100;
    const maxFee = Math.round(outstanding * MAX_LATE_FEE_PCT * 100) / 100;
    fee = Math.min(fee, maxFee); // Cap

    if (fee > 0) {
      totalLateFee += fee;
      feePerInvoice.push({
        invoiceID: inv.ID,
        invoiceNumber: inv.invoiceNumber,
        outstanding,
        overdueDays,
        lateFee: fee,
        capped: fee >= maxFee,
      });
    }
  }

  return { totalLateFee: Math.round(totalLateFee * 100) / 100, feePerInvoice };
}

/**
 * Apply late fees as DEBIT_NOTE invoices. Run monthly.
 * MOCK: creates DEBIT_NOTE invoices. Production may need approval workflow.
 */
async function applyLateFees(asOfDate) {
  const db = await cds.connect.to('db');
  const today = asOfDate || dayjs().format('YYYY-MM-DD');
  let applied = 0;

  // Get accounts with overdue invoices
  const accounts = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'accountStatus')
      .where({ accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } })
      .limit(5000)
  );

  for (const acct of accounts) {
    const { totalLateFee, feePerInvoice } = await calculateLateFee(acct.ID, today);
    if (totalLateFee <= 0 || feePerInvoice.length === 0) continue;

    // Create DEBIT_NOTE invoice for the late fees
    const invoiceID = cds.utils.uuid();
    await db.run(INSERT.into('sains.ar.Invoice').entries({
      ID: invoiceID,
      invoiceNumber: `LPC-${today.replace(/-/g, '')}-${acct.accountNumber}`,
      account_ID: acct.ID,
      invoiceDate: today,
      dueDate: dayjs(today).add(30, 'day').format('YYYY-MM-DD'),
      invoiceType: 'DEBIT_NOTE',
      status: 'OPEN',
      totalAmount: totalLateFee,
      taxAmount: 0, // Late fees typically not subject to SST
      taxRateApplied: 0,
      amountCleared: 0,
      amountOutstanding: totalLateFee,
      sourceSystem: 'AR_HUB',
      einvoiceRequired: false,
    }));

    // Update account balance
    await db.run(
      UPDATE('sains.ar.CustomerAccount').set({
        balanceOutstanding: { '+=': totalLateFee },
      }).where({ ID: acct.ID })
    );

    applied++;
    logger.info(`Late fee RM ${totalLateFee.toFixed(2)} applied to account ${acct.accountNumber} (${feePerInvoice.length} overdue invoices)`);
  }

  return { accountsProcessed: accounts.length, feesApplied: applied };
}

module.exports = { calculateLateFee, applyLateFees };
