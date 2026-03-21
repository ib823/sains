'use strict';

const cds = require('@sap/cds');
const { logAction } = require('../lib/audit-logger');
const { checkFraudPatterns } = require('./fraud-detection');
const { validateAdjustment, throwIfInvalid } = require('../lib/validation');
const { FRAUD_ALERT_PATTERN, FRAUD_THRESHOLDS } = require('../lib/constants');

module.exports = (srv) => {

  srv.before('CREATE', 'Adjustments', async (req) => {
    const adj = req.data;
    const result = validateAdjustment(adj);
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

  srv.on('postAdjustment', 'Adjustments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const adj = await db.run(SELECT.one.from('sains.ar.Adjustment').where({ ID }));
    if (!adj) return req.error(404, 'Adjustment not found');
    if (adj.status !== 'APPROVED') return req.error(400, 'Adjustment must be approved before posting');

    // Update the referenced invoice balance
    if (adj.originalInvoiceID) {
      const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: adj.originalInvoiceID }));
      if (invoice) {
        const amountChange = adj.direction === 'CREDIT' ? -adj.amount : adj.amount;
        const newOutstanding = invoice.amountOutstanding + amountChange;
        await db.run(UPDATE('sains.ar.Invoice').set({
          amountOutstanding: Math.max(0, newOutstanding),
          status: newOutstanding <= 0 ? 'CLEARED' : invoice.status,
        }).where({ ID: adj.originalInvoiceID }));
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
