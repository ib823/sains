'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../lib/audit-logger');
const { DEPOSIT_STATUS } = require('../lib/constants');

module.exports = (srv) => {

  srv.on('initiateRefund', 'DepositRecords', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { refundAmount, refundMethod, bankAccountNumber } = req.data;
    const db = await cds.connect.to('db');

    const deposit = await db.run(SELECT.one.from('sains.ar.DepositRecord').where({ ID }));
    if (!deposit) return req.error(404, 'Deposit not found');
    if (deposit.status !== DEPOSIT_STATUS.HELD)
      return req.error(400, `Cannot refund deposit in status ${deposit.status}`);
    if (refundAmount > deposit.amount)
      return req.error(400, 'Refund amount exceeds deposit amount');

    await db.run(UPDATE('sains.ar.DepositRecord').set({
      refundAmount,
      refundMethod,
      status: 'REFUND_PENDING',
    }).where({ ID }));

    await logAction(req, 'INITIATE_REFUND', 'DepositRecord', ID, deposit,
      { refundAmount, refundMethod, status: 'REFUND_PENDING' }, deposit.account_ID);
    return true;
  });

  srv.on('approveRefund', 'DepositRecords', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const deposit = await db.run(SELECT.one.from('sains.ar.DepositRecord').where({ ID }));
    if (!deposit) return req.error(404, 'Deposit not found');
    if (deposit.status !== 'REFUND_PENDING')
      return req.error(400, 'Deposit is not pending refund approval');

    await db.run(UPDATE('sains.ar.DepositRecord').set({
      status: DEPOSIT_STATUS.REFUNDED,
      refundDate: new Date().toISOString().split('T')[0],
      refundApprovedBy: req.user.id,
      refundApprovalDate: new Date().toISOString(),
    }).where({ ID }));

    // Update account deposit balance
    await db.run(
      UPDATE('sains.ar.CustomerAccount')
        .set({ balanceDeposit: { '-=': deposit.refundAmount } })
        .where({ ID: deposit.account_ID })
    );

    await logAction(req, 'APPROVE_REFUND', 'DepositRecord', ID, null,
      { status: 'REFUNDED' }, deposit.account_ID);
    return true;
  });

  srv.on('applyToBalance', 'DepositRecords', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const deposit = await db.run(SELECT.one.from('sains.ar.DepositRecord').where({ ID }));
    if (!deposit) return req.error(404, 'Deposit not found');
    if (deposit.status !== DEPOSIT_STATUS.HELD)
      return req.error(400, `Cannot apply deposit in status ${deposit.status}`);

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ ID: deposit.account_ID })
    );

    let appliedToOutstanding = 0;
    let creditSurplus = 0;

    if (account.balanceOutstanding > 0) {
      appliedToOutstanding = Math.min(deposit.amount, account.balanceOutstanding);
      creditSurplus = deposit.amount - appliedToOutstanding;
    } else {
      creditSurplus = deposit.amount;
    }

    await db.run(UPDATE('sains.ar.DepositRecord').set({
      status: DEPOSIT_STATUS.APPLIED_TO_BALANCE,
      appliedAmount: deposit.amount,
      appliedDate: new Date().toISOString().split('T')[0],
      appliedApprovedBy: req.user.id,
      notes: reason,
    }).where({ ID }));

    // Update account balances
    const updates = {
      balanceDeposit: account.balanceDeposit - deposit.amount,
    };
    if (appliedToOutstanding > 0) {
      updates.balanceOutstanding = account.balanceOutstanding - appliedToOutstanding;
    }
    if (creditSurplus > 0) {
      updates.balanceCreditOnAccount = (account.balanceCreditOnAccount || 0) + creditSurplus;
    }
    await db.run(UPDATE('sains.ar.CustomerAccount').set(updates).where({ ID: deposit.account_ID }));

    await logAction(req, 'APPLY_DEPOSIT_TO_BALANCE', 'DepositRecord', ID, null,
      { appliedToOutstanding, creditSurplus, reason }, deposit.account_ID);
    return true;
  });

  srv.on('markDormant', 'DepositRecords', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { noticeStage } = req.data;
    const db = await cds.connect.to('db');

    const deposit = await db.run(SELECT.one.from('sains.ar.DepositRecord').where({ ID }));
    if (!deposit) return req.error(404, 'Deposit not found');

    const updates = { status: DEPOSIT_STATUS.DORMANT };
    if (noticeStage === 1) updates.dormancyNotice1SentAt = new Date().toISOString();
    if (noticeStage === 2) updates.dormancyNotice2SentAt = new Date().toISOString();

    await db.run(UPDATE('sains.ar.DepositRecord').set(updates).where({ ID }));

    await logAction(req, 'MARK_DORMANT', 'DepositRecord', ID, null,
      { status: 'DORMANT', noticeStage }, deposit.account_ID);
    return true;
  });
};
