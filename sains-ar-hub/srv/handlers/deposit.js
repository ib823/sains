'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../lib/audit-logger');
const { DEPOSIT_STATUS, SAP_CORE } = require('../lib/constants');
const { buildDailySummaryBatch, buildJournalEntryPayload } = require('../lib/gl-builder');
const { postJournalEntry } = require('../external/sap-core-api');
const { sendSystemAlert } = require('../external/notification-service');

const logger = cds.log('deposit');

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

    // Phase 3: Post deposit refund to SAP GL (non-blocking — Scenario 1.3)
    try {
      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount')
          .columns('accountType_code', 'branchCode', 'accountNumber')
          .where({ ID: deposit.account_ID })
      );
      const glMappings = await db.run(
        SELECT.from('sains.ar.GLAccountMapping').where({ transactionType: 'DEPOSIT_REFUND', isActive: true })
      );
      const transactions = [{
        transactionType: 'DEPOSIT_REFUND', accountTypeCode: account?.accountType_code || 'ALL',
        chargeTypeCode: 'DEPOSIT', branchCode: account?.branchCode || 'COMMON',
        amount: deposit.refundAmount || deposit.amount,
        referenceDocType: 'DEPOSIT_REFUND', referenceDocID: ID,
        itemText: `Deposit refund for account ${account?.accountNumber}`,
      }];
      const postingDate = new Date().toISOString().substring(0, 10);
      const batch = buildDailySummaryBatch(transactions, glMappings, postingDate, SAP_CORE.COMPANY_CODE);
      const payload = buildJournalEntryPayload(batch, batch.lines || []);
      const result = await postJournalEntry(payload, ID);
      if (result.success) {
        await db.run(UPDATE('sains.ar.DepositRecord').set({
          refundAPPostingRef: result.documentNumber,
          glStatus: 'POSTED',
          glPostedAt: new Date().toISOString(),
        }).where({ ID }));
      }
    } catch (err) {
      logger.error(`Deposit refund GL posting failed for ${ID}: ${err.message}`);
      await db.run(UPDATE('sains.ar.DepositRecord').set({
        glStatus: 'FAILED',
        glPostingError: err.message.substring(0, 255),
      }).where({ ID }));
      await sendSystemAlert({
        type: 'GL_POSTING_FAILURE',
        subject: `Deposit refund GL posting failed — ${ID}`,
        body: `Deposit refund ${ID} approved but GL posting failed: ${err.message}`,
        recipients: 'FinanceManager',
      }).catch(e => logger.error(`GL failure notification failed: ${e.message}`));
    }

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

    // Update account balances atomically to avoid race conditions
    await db.run(
      UPDATE('sains.ar.CustomerAccount')
        .set({ balanceDeposit: { '-=': deposit.amount } })
        .where({ ID: deposit.account_ID })
    );
    if (appliedToOutstanding > 0) {
      await db.run(
        UPDATE('sains.ar.CustomerAccount')
          .set({ balanceOutstanding: { '-=': appliedToOutstanding } })
          .where({ ID: deposit.account_ID })
      );
    }
    if (creditSurplus > 0) {
      await db.run(
        UPDATE('sains.ar.CustomerAccount')
          .set({ balanceCreditOnAccount: { '+=': creditSurplus } })
          .where({ ID: deposit.account_ID })
      );
    }

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
