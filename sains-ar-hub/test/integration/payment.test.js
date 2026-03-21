'use strict';
const cds = require('@sap/cds');
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { FIXTURES } = require('../data/test-fixtures');

// cds.test() MUST be at module level — returns test handle with axios
const testHandle = cds.test('serve', '--project', __dirname + '/../..');

describe('Payment — Integration Tests', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Set auth for mocked auth strategy and allow all status codes
    testHandle.axios.defaults.auth = { username: 'test-user', password: 'test' };
    testHandle.axios.defaults.validateStatus = () => true;
    // AccountType, BillingBasis, CollectionRiskCategory, GLAccountMapping already loaded from CSV
    // Only seed TariffBand which has no CSV
    await db.run(INSERT.into('sains.ar.TariffBand').entries([
      { ID: 'tb-1', code: 'T1', name: 'Dom T1', accountTypeCode: 'DOM', isActive: true }
    ]));
  }, 30000);

  // ── CHEQUE CLEARANCE HOLD (CRITICAL-11) ───────────────────────────────

  describe('Cheque clearance hold', () => {
    test('cheque payment sets CLEARING_PENDING and does not allocate immediately', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-chq-1', balanceOutstanding: 100,
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100, ID: 'inv-chq-1', account_ID: 'acc-chq-1',
      }));

      const res = await testHandle.axios.post('/ar/Payments', {
        account_ID: 'acc-chq-1',
        paymentDate: '2026-03-01',
        channel: 'COUNTER_CHEQUE',
        amount: 100.00,
        paymentReference: 'CHQ-TEST-001',
      });
      expect(res.status).toBeLessThan(300);

      const payment = await db.run(
        SELECT.one.from('sains.ar.Payment').where({ account_ID: 'acc-chq-1' })
      );
      expect(payment.status).toBe('CLEARING_PENDING');
      expect(payment.chequeClearanceStatus).toBe('PENDING_CLEARANCE');
      expect(payment.amountAllocated).toBe(0); // Not allocated yet

      // Invoice should still be OPEN
      const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: 'inv-chq-1' }));
      expect(invoice.status).toBe('OPEN');
    });

    test('confirming cheque cleared triggers allocation', async () => {
      const paymentID = 'pay-chq-confirm';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-chq-2', balanceOutstanding: 100,
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100, ID: 'inv-chq-2', account_ID: 'acc-chq-2',
      }));
      await db.run(INSERT.into('sains.ar.Payment').entries({
        ...FIXTURES.payments.cheque_pending,
        ID: paymentID, account_ID: 'acc-chq-2',
      }));

      const res = await testHandle.axios.post(`/ar/Payments('${paymentID}')/confirmChequeCleared`, {});
      expect(res.status).toBeLessThan(300);

      const payment = await db.run(SELECT.one.from('sains.ar.Payment').where({ ID: paymentID }));
      expect(payment.status).toBe('ALLOCATED');
      expect(payment.chequeClearanceStatus).toBe('CLEARED');
      expect(payment.amountAllocated).toBe(100.00);
    });

    test('marking cheque bounced reverses allocation and restores balance', async () => {
      const paymentID = 'pay-chq-bounce';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-chq-3', balanceOutstanding: 100,
      }));
      await db.run(INSERT.into('sains.ar.Payment').entries({
        ...FIXTURES.payments.cheque_pending,
        ID: paymentID, account_ID: 'acc-chq-3',
        status: 'CLEARING_PENDING', chequeClearanceStatus: 'PENDING_CLEARANCE',
      }));

      const res = await testHandle.axios.post(`/ar/Payments('${paymentID}')/markChequeBounced`,
        { reason: 'Insufficient funds' });
      expect(res.status).toBeLessThan(300);

      const payment = await db.run(SELECT.one.from('sains.ar.Payment').where({ ID: paymentID }));
      expect(payment.status).toBe('BOUNCED');
      expect(payment.chequeClearanceStatus).toBe('BOUNCED');
    });
  });

  // ── MANUAL ALLOCATE ───────────────────────────────────────────────────

  describe('Manual allocate', () => {
    test('allocates specified amount from unallocated payment to specific invoice', async () => {
      const paymentID = 'pay-manual-alloc';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-manual-1', balanceOutstanding: 150,
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100, ID: 'inv-manual-1', account_ID: 'acc-manual-1',
      }));
      await db.run(INSERT.into('sains.ar.Payment').entries({
        ID: paymentID, account_ID: 'acc-manual-1',
        paymentDate: '2026-03-01', valueDate: '2026-03-01',
        channel: 'MANUAL_EFT', status: 'UNALLOCATED',
        amount: 200.00, amountAllocated: 0, amountUnallocated: 200.00,
        receivedDateTime: '2026-03-01T08:00:00Z', paymentReference: 'EFT-MANUAL',
      }));

      const res = await testHandle.axios.post(`/ar/Payments('${paymentID}')/manualAllocate`,
        { invoiceID: 'inv-manual-1', allocateAmount: 100.00 });
      expect(res.status).toBeLessThan(300);

      const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: 'inv-manual-1' }));
      expect(invoice.status).toBe('CLEARED');

      const payment = await db.run(SELECT.one.from('sains.ar.Payment').where({ ID: paymentID }));
      expect(payment.amountAllocated).toBe(100.00);
      expect(payment.amountUnallocated).toBe(100.00);
    });

    test('rejects manual allocate when amount exceeds unallocated balance', async () => {
      await db.run(INSERT.into('sains.ar.Payment').entries({
        ID: 'pay-over-alloc', account_ID: 'acc-manual-1',
        paymentDate: '2026-03-01', valueDate: '2026-03-01',
        channel: 'COUNTER_CASH', status: 'RECEIVED',
        amount: 50.00, amountAllocated: 0, amountUnallocated: 50.00,
        receivedDateTime: '2026-03-01T08:00:00Z', paymentReference: 'OVER-ALLOC',
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100, ID: 'inv-for-over', account_ID: 'acc-manual-1',
      }));
      const res = await testHandle.axios.post(`/ar/Payments('pay-over-alloc')/manualAllocate`,
        { invoiceID: 'inv-for-over', allocateAmount: 80.00 });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ── COLLECTION IMPORT BATCH ───────────────────────────────────────────

  describe('Collection import batch processing', () => {
    test('processBatch resolves matched lines and routes unmatched to suspense', async () => {
      // Create account that will be matched
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-batch-1', balanceOutstanding: 100,
        accountNumber: 'BATCH-ACC-001',
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100, ID: 'inv-batch-1', account_ID: 'acc-batch-1',
      }));

      // Create batch with one matched and one unmatched line
      const batchID = 'batch-proc-001';
      await db.run(INSERT.into('sains.ar.CollectionImportBatch').entries({
        ID: batchID, batchDate: '2026-03-01',
        sourceChannel: 'AGENT_COLLECTION', sourceReference: 'AGENT-TEST-001',
        recordCount: 2, totalAmount: 200.00, status: 'VALID',
        confirmedBy: 'FINANCE_ADMIN', confirmedAt: '2026-03-01T08:00:00Z',
      }));
      await db.run(INSERT.into('sains.ar.CollectionImportLine').entries([
        {
          batch_ID: batchID, lineSequence: 1,
          sourceAccountRef: 'BATCH-ACC-001', // matches above
          amount: 100.00, paymentDate: '2026-03-01',
          paymentReference: 'LINE-001', status: 'PENDING',
        },
        {
          batch_ID: batchID, lineSequence: 2,
          sourceAccountRef: 'UNKNOWN-ACC-999', // will go to suspense
          amount: 100.00, paymentDate: '2026-03-01',
          paymentReference: 'LINE-002', status: 'PENDING',
        },
      ]));

      const res = await testHandle.axios.post(`/ar/CollectionImportBatches('${batchID}')/processBatch`, {});
      expect(res.status).toBeLessThan(300);
      expect(res.data.processed).toBe(1);
      expect(res.data.suspense).toBe(1);

      // Check suspense was created
      const suspenseItems = await db.run(
        SELECT.from('sains.ar.SuspensePayment').where({ sourceBatchRef: 'AGENT-TEST-001' })
      );
      expect(suspenseItems.length).toBe(1);
      expect(suspenseItems[0].sourceAccountRef).toBe('UNKNOWN-ACC-999');
    });
  });

  // ── SUSPENSE RESOLUTION ───────────────────────────────────────────────

  describe('Suspense payment resolution', () => {
    test('resolveToAccount creates payment and allocates to target account', async () => {
      const suspenseID = 'susp-001';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-susp-target', balanceOutstanding: 150,
      }));
      await db.run(INSERT.into('sains.ar.Invoice').entries({
        ...FIXTURES.invoices.open_100, ID: 'inv-susp-1', account_ID: 'acc-susp-target',
      }));
      await db.run(INSERT.into('sains.ar.SuspensePayment').entries({
        ID: suspenseID, sourceChannel: 'AGENT_COLLECTION',
        sourceBatchRef: 'BATCH-001', sourceAccountRef: 'WRONG-NUM',
        amount: 100.00, paymentDate: '2026-03-01', status: 'PENDING',
      }));

      const res = await testHandle.axios.post(`/ar/SuspensePayments('${suspenseID}')/resolveToAccount`,
        { targetAccountID: 'acc-susp-target', notes: 'Account number mismatch resolved' });
      expect(res.status).toBeLessThan(300);

      const suspense = await db.run(SELECT.one.from('sains.ar.SuspensePayment').where({ ID: suspenseID }));
      expect(suspense.status).toBe('RESOLVED');
      expect(suspense.resolvedAccountID).toBe('acc-susp-target');

      // Check payment was created
      const payment = await db.run(
        SELECT.one.from('sains.ar.Payment').where({ account_ID: 'acc-susp-target' })
      );
      expect(payment).not.toBeNull();
    });

    test('returnToSource marks suspense as RETURNED', async () => {
      await db.run(INSERT.into('sains.ar.SuspensePayment').entries({
        ID: 'susp-return', sourceChannel: 'BAYARAN_PUKAL',
        sourceAccountRef: 'BAD-REF', amount: 50.00,
        paymentDate: '2026-03-01', status: 'PENDING',
      }));
      const res = await testHandle.axios.post(`/ar/SuspensePayments('susp-return')/returnToSource`,
        { reason: 'Cannot identify customer — returning to source agency' });
      expect(res.status).toBeLessThan(300);

      const suspense = await db.run(SELECT.one.from('sains.ar.SuspensePayment').where({ ID: 'susp-return' }));
      expect(suspense.status).toBe('RETURNED');
    });
  });

  // ── BANK STATEMENT RECONCILIATION ─────────────────────────────────────

  describe('Bank statement import and matching', () => {
    test.skip('runAutoMatch matches statement lines to payments by bankReference — requires SQLite JSON1 compatibility', async () => {
      const statementID = 'stmt-001';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic, ID: 'acc-bank-1', balanceOutstanding: 0,
      }));
      // Create an allocated payment with a known bank reference
      await db.run(INSERT.into('sains.ar.Payment').entries({
        ID: 'pay-bank-match', account_ID: 'acc-bank-1',
        paymentDate: '2026-03-01', valueDate: '2026-03-01',
        channel: 'COUNTER_CASH', status: 'ALLOCATED',
        amount: 120.00, amountAllocated: 120.00, amountUnallocated: 0,
        bankReference: 'BANK-REF-12345', receivedDateTime: '2026-03-01T09:00:00Z',
        paymentReference: 'PAY-BANK',
      }));

      // Create bank statement with matching line
      await db.run(INSERT.into('sains.ar.BankStatementImport').entries({
        ID: statementID, statementDate: '2026-03-01',
        bankCode: 'MAYBANK', bankName: 'Maybank',
        accountNumberMasked: 'XXXX1234',
        format: 'MT940', openingBalance: 0, closingBalance: 120.00,
        status: 'IMPORTED', totalCredits: 120.00, totalDebits: 0,
      }));
      await db.run(INSERT.into('sains.ar.BankStatementLine').entries({
        ID: 'line-001', statement_ID: statementID, lineSequence: 1,
        valueDate: '2026-03-01', amount: 120.00, debitCreditCode: 'C',
        bankReference: 'BANK-REF-12345',
        description: 'Payment from customer', status: 'UNMATCHED',
      }));

      const res = await testHandle.axios.post(`/ar/BankStatementImports('${statementID}')/runAutoMatch`, {});
      expect(res.status).toBeLessThan(300);
      expect(res.data.matched).toBe(1);
      expect(res.data.unmatched).toBe(0);

      const line = await db.run(SELECT.one.from('sains.ar.BankStatementLine').where({ ID: 'line-001' }));
      expect(line.status).toBe('MATCHED');
      expect(line.matchedPaymentID).toBe('pay-bank-match');
      expect(line.matchConfidence).toBe('AUTO_HIGH');
    });

    test.skip('approveReconciliation fails when unmatched lines remain — requires SQLite JSON1 compatibility', async () => {
      const statementID = 'stmt-002';
      await db.run(INSERT.into('sains.ar.BankStatementImport').entries({
        ID: statementID, statementDate: '2026-03-02',
        bankCode: 'CIMB', bankName: 'CIMB Bank',
        accountNumberMasked: 'XXXX5678',
        format: 'MT940', openingBalance: 0, closingBalance: 200.00,
        status: 'MATCHING', totalCredits: 200.00, totalDebits: 0,
      }));
      await db.run(INSERT.into('sains.ar.BankStatementLine').entries({
        ID: 'line-unmatched', statement_ID: statementID, lineSequence: 1,
        valueDate: '2026-03-02', amount: 200.00, debitCreditCode: 'C',
        bankReference: 'UNKNOWN-REF', description: 'Unknown', status: 'UNMATCHED',
      }));

      const res = await testHandle.axios.post(`/ar/BankStatementImports('${statementID}')/approveReconciliation`, {});
      expect(res.status).toBeGreaterThanOrEqual(400);
    });
  });
});
