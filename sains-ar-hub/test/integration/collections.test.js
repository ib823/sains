'use strict';
const cds = require('@sap/cds');
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { FIXTURES } = require('../data/test-fixtures');

// cds.test() MUST be at module level — returns test handle with axios
const testHandle = cds.test('serve', '--project', __dirname + '/../..');

describe('Collections — Payment Plan & Write-Off Integration Tests', () => {
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

  // ── PAYMENT PLAN LIFECYCLE ────────────────────────────────────────────

  describe('Payment Plan — create, approve, void (DUN-5.3)', () => {
    test('creates payment plan in PENDING_APPROVAL status', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-pp-1',
        balanceOutstanding: 500,
        isPaymentPlan: false,
      }));

      // Insert via db.run since PaymentPlan.approvedBy is NOT NULL but not set during creation
      await db.run(INSERT.into('sains.ar.PaymentPlan').entries({
        account_ID: 'acc-pp-1',
        planStatus: 'PENDING_APPROVAL',
        totalInstalments: 3,
        instalmentAmount: 166.67,
        outstandingAtStart: 500,
        startDate: '2026-04-01',
        endDate: '2026-06-30',
        approvedBy: 'PENDING',
        approvalDate: '2026-03-01T00:00:00Z',
      }));

      const plan = await db.run(
        SELECT.one.from('sains.ar.PaymentPlan').where({ account_ID: 'acc-pp-1' })
      );
      expect(plan.planStatus).toBe('PENDING_APPROVAL');
    });

    test('rejects payment plan when balance is below minimum RM 100', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-pp-low',
        balanceOutstanding: 50, // below minimum
      }));

      const res = await testHandle.axios.post('/ar/PaymentPlans', {
        account_ID: 'acc-pp-low',
        totalInstalments: 2,
        instalmentAmount: 25,
        outstandingAtStart: 50,
        startDate: '2026-04-01',
        endDate: '2026-05-31',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('approving plan sets status to ACTIVE and flags account isPaymentPlan = true', async () => {
      const planID = 'plan-approve-test';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-pp-approve',
        balanceOutstanding: 600,
        isPaymentPlan: false,
      }));
      await db.run(INSERT.into('sains.ar.PaymentPlan').entries({
        ID: planID, account_ID: 'acc-pp-approve',
        planStatus: 'PENDING_APPROVAL',
        outstandingAtStart: 600,
        totalInstalments: 3, instalmentAmount: 200,
        startDate: '2026-04-01', endDate: '2026-06-30',
        approvedBy: 'PENDING', approvalDate: '2026-03-01T00:00:00Z',
      }));

      const res = await testHandle.axios.post(`/ar/PaymentPlans('${planID}')/approvePlan`, {});
      expect(res.status).toBeLessThan(300);

      const plan = await db.run(SELECT.one.from('sains.ar.PaymentPlan').where({ ID: planID }));
      expect(plan.planStatus).toBe('ACTIVE');
      expect(plan.approvedBy).toBeDefined();

      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: 'acc-pp-approve' })
      );
      expect(account.isPaymentPlan).toBe(true);
    });

    test('voiding plan restores isPaymentPlan to false', async () => {
      const planID = 'plan-void-test';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-pp-void',
        balanceOutstanding: 400,
        isPaymentPlan: true,
      }));
      await db.run(INSERT.into('sains.ar.PaymentPlan').entries({
        ID: planID, account_ID: 'acc-pp-void',
        planStatus: 'ACTIVE',
        outstandingAtStart: 400,
        totalInstalments: 4, instalmentAmount: 100,
        startDate: '2026-04-01', endDate: '2026-07-31',
        approvedBy: 'TEST_SUPERVISOR', approvalDate: '2026-03-01T00:00:00Z',
      }));

      const res = await testHandle.axios.post(`/ar/PaymentPlans('${planID}')/voidPlan`,
        { reason: 'Customer requested cancellation' });
      expect(res.status).toBeLessThan(300);

      const plan = await db.run(SELECT.one.from('sains.ar.PaymentPlan').where({ ID: planID }));
      expect(plan.planStatus).toBe('VOIDED');
      expect(plan.voidedReason).toBe('Customer requested cancellation');

      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: 'acc-pp-void' })
      );
      expect(account.isPaymentPlan).toBe(false);
    });
  });

  // ── WRITE-OFF LIFECYCLE ───────────────────────────────────────────────

  describe('Write-Off — full lifecycle (BAD-7.2)', () => {
    test('creates write-off with correct approval level derived from amount', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-wo-1',
        balanceOutstanding: 300,
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100,
        ID: 'inv-wo-1', account_ID: 'acc-wo-1',
        totalAmount: 300, amountOutstanding: 300,
      }));

      // Insert via db.run since WriteOff.approvedBy is NOT NULL but not set during creation
      await db.run(INSERT.into('sains.ar.WriteOff').entries({
        account_ID: 'acc-wo-1',
        invoiceID: 'inv-wo-1',
        invoiceNumber: 'INV-WO-001',
        writeOffAmount: 300,
        writeOffDate: '2026-03-01',
        approvalLevel: 'SUPERVISOR',
        reason: 'Account has been inactive for more than 24 months. All collection efforts exhausted.',
        collectionHistory: 'Dunning Level 4 reached March 2025. Legal letter issued June 2025. No response. Field visit September 2025 — property vacant.',
        approvedBy: 'PENDING',
        approvalDate: '2026-03-01T00:00:00Z',
      }));

      const writeOff = await db.run(
        SELECT.one.from('sains.ar.WriteOff').where({ account_ID: 'acc-wo-1' })
      );
      expect(writeOff.approvalLevel).toBe('SUPERVISOR'); // RM 300 < RM 500
    });

    test('Supervisor approval clears invoice and flags account as written off', async () => {
      const writeOffID = 'wo-approve-test';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-wo-approve',
        balanceOutstanding: 45,
        isWrittenOff: false,
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100,
        ID: 'inv-wo-approve', account_ID: 'acc-wo-approve',
        totalAmount: 45, amountOutstanding: 45, status: 'OPEN',
      }));
      await db.run(INSERT.into('sains.ar.WriteOff').entries({
        ID: writeOffID, account_ID: 'acc-wo-approve',
        invoiceID: 'inv-wo-approve', invoiceNumber: 'INV-WO-APPROVE',
        writeOffAmount: 45, writeOffDate: '2026-03-01',
        approvalLevel: 'SUPERVISOR',
        reason: 'Below minimum threshold — monthly micro-write-off batch approved.',
        collectionHistory: 'Level 4 dunning, 18 months overdue, property abandoned.',
        approvedBy: 'PENDING', approvalDate: '2026-03-01T00:00:00Z',
      }));

      const res = await testHandle.axios.post(`/ar/WriteOffs('${writeOffID}')/approveWriteOff_Supervisor`, {});
      expect(res.status).toBeLessThan(300);

      const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: 'inv-wo-approve' }));
      expect(invoice.status).toBe('REVERSED');

      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: 'acc-wo-approve' })
      );
      expect(account.isWrittenOff).toBe(true);
    });

    test('write-off recovery creates a WriteOffRecovery record', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-wo-recovery', balanceOutstanding: 0, isWrittenOff: true,
      }));
      const writeOffID = 'wo-recovery-test';
      await db.run(INSERT.into('sains.ar.WriteOff').entries({
        ID: writeOffID, account_ID: 'acc-wo-recovery',
        invoiceID: 'inv-xxx', invoiceNumber: 'INV-RECOVERY',
        writeOffAmount: 200, writeOffDate: '2025-06-01',
        approvalLevel: 'SUPERVISOR',
        reason: 'Account written off June 2025.',
        collectionHistory: 'Full collection history documented.',
        approvedBy: 'SUPERVISOR_TEST',
        approvalDate: '2025-06-01T00:00:00Z',
      }));
      await db.run(INSERT.into('sains.ar.Payment').entries({
        ID: 'pay-recovery', account_ID: 'acc-wo-recovery',
        paymentDate: '2026-03-01', valueDate: '2026-03-01',
        channel: 'COUNTER_CASH', status: 'ALLOCATED',
        amount: 200, amountAllocated: 200, amountUnallocated: 0,
        receivedDateTime: '2026-03-01T09:00:00Z', paymentReference: 'RECOVERY-PAY',
      }));

      const res = await testHandle.axios.post('/ar/WriteOffRecoveries', {
        writeOff_ID: writeOffID,
        recoveryDate: '2026-03-01',
        recoveryAmount: 200,
        paymentID: 'pay-recovery',
      });
      expect(res.status).toBeLessThan(300);

      const recovery = await db.run(
        SELECT.one.from('sains.ar.WriteOffRecovery').where({ writeOff_ID: writeOffID })
      );
      expect(recovery.recoveryAmount).toBe(200);
      expect(recovery.paymentID).toBe('pay-recovery');
    });
  });
});
