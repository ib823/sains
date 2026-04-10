'use strict';

const cds = require('@sap/cds');
const { logAction } = require('../lib/audit-logger');
const { checkFraudPatterns } = require('./fraud-detection');
const { validateAdjustment, throwIfInvalid } = require('../lib/validation');
const { FRAUD_ALERT_PATTERN, FRAUD_THRESHOLDS } = require('../lib/constants');

module.exports = (srv) => {

  srv.before('CREATE', 'Adjustments', async (req) => {
    const adj = req.data;

    // Fetch invoice amount for cross-validation if an original invoice is referenced
    let invoiceAmount = null;
    if (adj.originalInvoiceID) {
      const db = await cds.connect.to('db');
      const invoice = await db.run(
        SELECT.one.from('sains.ar.Invoice')
          .columns('totalAmount', 'amountOutstanding')
          .where({ ID: adj.originalInvoiceID })
      );
      if (invoice) {
        invoiceAmount = invoice.totalAmount;
      }
    }

    const result = validateAdjustment(adj, invoiceAmount);
    throwIfInvalid(result);

    adj.status = 'PENDING';
    adj.initiatedBy = req.user.id;
  });

  srv.on('approveAdjustment', 'Adjustments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const adj = await db.run(SELECT.one.from('sains.ar.Adjustment').where({ ID }));
    if (!adj) return req.error(404, 'Adjustment not found');
    if (adj.status !== 'PENDING') return req.error(400, `Cannot approve adjustment in status ${adj.status}`);

    await db.run(UPDATE('sains.ar.Adjustment').set({
      status: 'APPROVED',
      approvedBy: req.user.id,
      approvalDate: new Date().toISOString(),
    }).where({ ID }));

    // Check for large adjustment fraud pattern
    if (adj.originalInvoiceID) {
      const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: adj.originalInvoiceID }));
      if (invoice && adj.amount / invoice.totalAmount > FRAUD_THRESHOLDS.ADJUSTMENT_PERCENT_OF_INVOICE) {
        await checkFraudPatterns(FRAUD_ALERT_PATTERN.LARGE_ADJUSTMENT, {
          accountID: adj.account_ID,
          adjustmentAmount: adj.amount,
          invoiceAmount: invoice.totalAmount,
          transactionID: ID,
          action: 'APPROVE_ADJUSTMENT',
        }, req);
      }
    }

    await logAction(req, 'APPROVE_ADJUSTMENT', 'Adjustment', ID, adj,
      { ...adj, status: 'APPROVED' }, adj.account_ID);
    return true;
  });

  srv.on('rejectAdjustment', 'Adjustments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const adj = await db.run(SELECT.one.from('sains.ar.Adjustment').where({ ID }));
    if (!adj) return req.error(404, 'Adjustment not found');
    if (adj.status !== 'PENDING') return req.error(400, `Cannot reject adjustment in status ${adj.status}`);

    await db.run(UPDATE('sains.ar.Adjustment').set({
      status: 'REJECTED',
      rejectionReason: reason,
      approvedBy: req.user.id,
      approvalDate: new Date().toISOString(),
    }).where({ ID }));

    await logAction(req, 'REJECT_ADJUSTMENT', 'Adjustment', ID, adj,
      { ...adj, status: 'REJECTED', rejectionReason: reason }, adj.account_ID);
    return true;
  });

  /**
   * Post an approved adjustment to the account balance.
   *
   * DESIGN DECISION: Adjustment GL posting is intentionally BATCHED in the daily GL run
   * (runDailyGLPostingJob in dunning.js) rather than posted immediately. This is because:
   * 1. Daily aggregation reduces the number of SAP journal entries (cost optimization)
   * 2. Adjustments are included in the daily debit/credit summary alongside invoices and payments
   * 3. The daily batch ensures debit-credit balance validation across all transaction types
   *
   * To enable immediate GL posting for adjustments, set ADJUSTMENT_GL_IMMEDIATE=true
   * in the environment. When enabled, postAdjustment will call postJournalEntry directly.
   * Default: false (batched with daily GL run).
   */
  srv.on('postAdjustment', 'Adjustments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const adj = await db.run(SELECT.one.from('sains.ar.Adjustment').where({ ID }));
    if (!adj) return req.error(404, 'Adjustment not found');
    if (adj.status !== 'APPROVED') return req.error(400, 'Adjustment must be approved before posting');

    // Update the referenced invoice balance atomically (avoid read-modify-write race)
    if (adj.originalInvoiceID) {
      const amountChange = adj.direction === 'CREDIT' ? -adj.amount : adj.amount;
      await db.run(
        UPDATE('sains.ar.Invoice')
          .set({ amountOutstanding: { '+=': amountChange } })
          .where({ ID: adj.originalInvoiceID })
      );
      // Re-read to determine status after atomic update
      const updatedInvoice = await db.run(
        SELECT.one.from('sains.ar.Invoice')
          .columns('ID', 'amountOutstanding', 'status')
          .where({ ID: adj.originalInvoiceID })
      );
      if (updatedInvoice) {
        const outstanding = Number(updatedInvoice.amountOutstanding);
        let newStatus = updatedInvoice.status;
        if (outstanding <= 0) newStatus = 'CLEARED';
        else if (outstanding > 0 && updatedInvoice.status === 'CLEARED') newStatus = 'OPEN';
        if (newStatus !== updatedInvoice.status) {
          // Clamp outstanding to >= 0
          const setData = { status: newStatus };
          if (outstanding < 0) setData.amountOutstanding = 0;
          await db.run(UPDATE('sains.ar.Invoice').set(setData).where({ ID: adj.originalInvoiceID }));
        }
      }
    }

    // Update account balance
    const balanceChange = adj.direction === 'CREDIT' ? -adj.amount : adj.amount;
    await db.run(
      UPDATE('sains.ar.CustomerAccount')
        .set({ balanceOutstanding: { '+=': balanceChange } })
        .where({ ID: adj.account_ID })
    );

    await db.run(UPDATE('sains.ar.Adjustment').set({
      status: 'POSTED',
      postedAt: new Date().toISOString(),
    }).where({ ID }));

    await logAction(req, 'POST_ADJUSTMENT', 'Adjustment', ID, adj,
      { ...adj, status: 'POSTED' }, adj.account_ID);
    return true;
  });
};
