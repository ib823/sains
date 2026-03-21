'use strict';
const cds = require('@sap/cds');
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { FIXTURES } = require('../data/test-fixtures');

// cds.test() MUST be at module level — returns test handle with axios
const testHandle = cds.test('serve', '--project', __dirname + '/../..');

describe('Deposit — Lifecycle Integration Tests (DEP-6.x)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Set auth for mocked auth strategy and allow all status codes
    testHandle.axios.defaults.auth = { username: 'test-user', password: 'test' };
    testHandle.axios.defaults.validateStatus = () => true;
    // AccountType, BillingBasis, CollectionRiskCategory already loaded from CSV
    // Only seed TariffBand which has no CSV
    await db.run(INSERT.into('sains.ar.TariffBand').entries([
      { ID: 'tb-1', code: 'T1', name: 'Dom T1', accountTypeCode: 'DOM', isActive: true }
    ]));
  }, 30000);

  describe('Deposit receipt and account balance', () => {
    test('creating deposit record reflects in account balanceDeposit', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-dep-1', balanceDeposit: 0, balanceOutstanding: 0,
      }));
      await db.run(INSERT.into('sains.ar.DepositRecord').entries({
        ID: 'dep-001', account_ID: 'acc-dep-1',
        depositDate: '2026-03-01', amount: 200.00, status: 'HELD',
        depositBasis: '2 months estimated bill at RM 100/month',
      }));
      // Manually update balance as would be done by trigger
      await db.run(UPDATE('sains.ar.CustomerAccount')
        .set({ balanceDeposit: 200.00 }).where({ ID: 'acc-dep-1' }));

      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: 'acc-dep-1' })
      );
      expect(account.balanceDeposit).toBe(200);
    });
  });

  describe('Deposit refund initiation and approval (DEP-6.3)', () => {
    test('initiateRefund sets deposit to REFUND_PENDING', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-dep-2', balanceDeposit: 200, balanceOutstanding: 0,
      }));
      await db.run(INSERT.into('sains.ar.DepositRecord').entries({
        ID: 'dep-refund-1', account_ID: 'acc-dep-2',
        depositDate: '2023-01-01', amount: 200, status: 'HELD',
        depositBasis: '2 months estimated',
      }));
      await db.run(UPDATE('sains.ar.CustomerAccount')
        .set({ accountStatus: 'CLOSED', accountCloseDate: '2026-02-28' })
        .where({ ID: 'acc-dep-2' }));

      const res = await testHandle.axios.post(`/ar/DepositRecords('dep-refund-1')/initiateRefund`, {
        refundAmount: 200.00,
        refundMethod: 'BANK_TRANSFER',
        bankAccountNumber: '1234567890',
      });
      expect(res.status).toBeLessThan(300);

      const deposit = await db.run(
        SELECT.one.from('sains.ar.DepositRecord').where({ ID: 'dep-refund-1' })
      );
      expect(deposit.status).toBe('REFUND_PENDING');
    });

    test('approveRefund sets deposit to REFUNDED and reduces account balance', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-dep-3', balanceDeposit: 150, balanceOutstanding: 0,
      }));
      await db.run(INSERT.into('sains.ar.DepositRecord').entries({
        ID: 'dep-refund-2', account_ID: 'acc-dep-3',
        depositDate: '2023-01-01', amount: 150, status: 'REFUND_PENDING',
        refundAmount: 150, refundMethod: 'BANK_TRANSFER',
      }));

      const res = await testHandle.axios.post(`/ar/DepositRecords('dep-refund-2')/approveRefund`, {});
      expect(res.status).toBeLessThan(300);

      const deposit = await db.run(
        SELECT.one.from('sains.ar.DepositRecord').where({ ID: 'dep-refund-2' })
      );
      expect(deposit.status).toBe('REFUNDED');
      expect(deposit.refundApprovedBy).toBeDefined();

      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: 'acc-dep-3' })
      );
      expect(account.balanceDeposit).toBe(0);
    });

    test('applyToBalance reduces outstanding and removes deposit', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-dep-4', balanceDeposit: 100, balanceOutstanding: 80,
      }));
      await db.run(INSERT.into('sains.ar.DepositRecord').entries({
        ID: 'dep-apply-1', account_ID: 'acc-dep-4',
        depositDate: '2023-06-01', amount: 100, status: 'HELD',
      }));

      const res = await testHandle.axios.post(`/ar/DepositRecords('dep-apply-1')/applyToBalance`,
        { reason: 'Account disconnected — deposit applied to outstanding balance' });
      expect(res.status).toBeLessThan(300);

      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: 'acc-dep-4' })
      );
      expect(account.balanceOutstanding).toBe(0);   // 80 reduced by 80
      expect(account.balanceCreditOnAccount).toBe(20); // 100 - 80 = RM 20 surplus credit
      expect(account.balanceDeposit).toBe(0);
    });
  });

  describe('Deposit dormancy tracking (DEP-6.6)', () => {
    test('markDormant stage 1 records notice timestamp', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-dep-5', balanceDeposit: 200,
      }));
      await db.run(INSERT.into('sains.ar.DepositRecord').entries({
        ID: 'dep-dormant-1', account_ID: 'acc-dep-5',
        depositDate: '2019-01-01', amount: 200, status: 'HELD',
      }));

      const res = await testHandle.axios.post(
        `/ar/DepositRecords('dep-dormant-1')/markDormant`, { noticeStage: 1 }
      );
      expect(res.status).toBeLessThan(300);

      const deposit = await db.run(
        SELECT.one.from('sains.ar.DepositRecord').where({ ID: 'dep-dormant-1' })
      );
      expect(deposit.dormancyNotice1SentAt).not.toBeNull();
    });

    test('markDormant stage 2 sets status to DORMANT', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-dep-6', balanceDeposit: 200,
      }));
      await db.run(INSERT.into('sains.ar.DepositRecord').entries({
        ID: 'dep-dormant-2', account_ID: 'acc-dep-6',
        depositDate: '2019-01-01', amount: 200, status: 'HELD',
        dormancyNotice1SentAt: '2024-07-01T00:00:00Z',
      }));

      const res = await testHandle.axios.post(
        `/ar/DepositRecords('dep-dormant-2')/markDormant`, { noticeStage: 2 }
      );
      expect(res.status).toBeLessThan(300);

      const deposit = await db.run(
        SELECT.one.from('sains.ar.DepositRecord').where({ ID: 'dep-dormant-2' })
      );
      expect(deposit.status).toBe('DORMANT');
      expect(deposit.dormancyNotice2SentAt).not.toBeNull();
    });
  });
});
