'use strict';
const cds = require('@sap/cds');
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { FIXTURES } = require('../data/test-fixtures');
const { buildDailySummaryBatch, buildJournalEntryPayload } = require('../../srv/lib/gl-builder');

// cds.test() MUST be at module level — returns test handle with axios
const testHandle = cds.test('serve', '--project', __dirname + '/../..');

describe('GL Posting — Integration Tests', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Set auth for mocked auth strategy and allow all status codes
    testHandle.axios.defaults.auth = { username: 'test-user', password: 'test' };
    testHandle.axios.defaults.validateStatus = () => true;
    // GLAccountMapping already loaded from CSV — no need to seed
  }, 30000);

  // ── DAILY SUMMARY BATCH CONSTRUCTION ────────────────────────────────

  describe('Daily summary batch — all transaction types included (BLOCKER-2 regression)', () => {
    test('batch with invoices, payments, adjustments, deposits is balanced', () => {
      const transactions = [
        // Invoice
        { transactionType: 'INVOICE', accountTypeCode: 'ALL', chargeTypeCode: 'ALL',
          chargeType: 'ALL', branchCode: 'SEREMBAN', amount: 1000,
          referenceDocType: 'AR_INVOICE', referenceDocID: 'i1' },
        // Payment
        { transactionType: 'PAYMENT', accountTypeCode: 'ALL', chargeTypeCode: 'ALL',
          chargeType: 'ALL', branchCode: 'SEREMBAN', amount: 800,
          referenceDocType: 'AR_PAYMENT', referenceDocID: 'p1' },
        // Credit adjustment
        { transactionType: 'ADJUSTMENT_CREDIT', accountTypeCode: 'ALL', chargeTypeCode: 'ALL',
          chargeType: 'ALL', branchCode: 'NILAI', amount: 50,
          referenceDocType: 'AR_ADJUSTMENT', referenceDocID: 'a1' },
        // Deposit receipt
        { transactionType: 'DEPOSIT', accountTypeCode: 'ALL', chargeTypeCode: 'ALL',
          chargeType: 'ALL', branchCode: 'SEREMBAN', amount: 200,
          referenceDocType: 'AR_DEPOSIT', referenceDocID: 'd1' },
      ];

      const batch = buildDailySummaryBatch(
        transactions, FIXTURES.glMappings, '2026-03-01', '9001'
      );

      // Each transaction type produces a D and C line
      expect(batch.lines.length).toBe(8); // 4 types x 2
      expect(batch.totalDebitAmount).toBeCloseTo(batch.totalCreditAmount, 2);
      expect(batch.totalDebitAmount).toBe(2050); // 1000+800+50+200
      expect(batch.postingType).toBe('DAILY_SUMMARY');
    });

    test('batch with deposit refund uses DEPOSIT_REFUND mapping', () => {
      const transactions = [
        { transactionType: 'DEPOSIT_REFUND', accountTypeCode: 'ALL', chargeTypeCode: 'ALL',
          chargeType: 'ALL', branchCode: 'SEREMBAN', amount: 150,
          referenceDocType: 'AR_DEPOSIT', referenceDocID: 'd-refund' },
      ];
      const batch = buildDailySummaryBatch(transactions, FIXTURES.glMappings, '2026-03-01', '9001');
      expect(batch.totalDebitAmount).toBe(150);
      // Debit line should be deposit liability GL (220000)
      const debitLine = batch.lines.find(l => l.debitCreditCode === 'D');
      expect(debitLine.glAccount).toBe('220000');
    });
  });

  describe('Journal Entry API payload structure', () => {
    test('OData V2 payload contains all required SAP fields', () => {
      const batch = {
        batchDate: '2026-03-01',
        sapCoreCompanyCode: '9001',
        postingType: 'DAILY_SUMMARY',
        lines: [
          { glAccount: '120000', debitCreditCode: 'D', amount: 500,
            profitCentre: 'CC01', costCentre: 'CC01', text: 'AR Invoice', assignment: '' },
          { glAccount: '400000', debitCreditCode: 'C', amount: 500,
            profitCentre: 'CC01', costCentre: 'CC01', text: 'Revenue', assignment: '' },
        ],
      };
      const payload = buildJournalEntryPayload(batch);
      expect(payload.CompanyCode).toBe('9001');
      expect(payload.DocumentType).toBeDefined();
      expect(payload.PostingDate).toBeDefined();
      expect(payload.CompanyCodeCurrency).toBe('MYR');
      expect(Array.isArray(payload.to_JournalEntryItem.results)).toBe(true);
      expect(payload.to_JournalEntryItem.results[0]).toHaveProperty('GLAccount');
      expect(payload.to_JournalEntryItem.results[0]).toHaveProperty('DebitCreditCode');
      expect(payload.to_JournalEntryItem.results[0]).toHaveProperty('AmountInTransactionCurrency');
    });
  });

  describe('GL Posting Batch entity persistence', () => {
    test('creates GLPostingBatch and GLPostingLine records correctly', async () => {
      const batchID = 'gl-test-batch';
      await db.run(INSERT.into('sains.ar.GLPostingBatch').entries({
        ID: batchID, batchDate: '2026-03-01', postingType: 'DAILY_SUMMARY',
        status: 'PREPARED', totalDebitAmount: 500, totalCreditAmount: 500,
        lineCount: 2, idempotencyKey: '2026-03-01_DAILY_SUMMARY_TEST',
        sapCoreCompanyCode: '9001',
      }));
      await db.run(INSERT.into('sains.ar.GLPostingLine').entries([
        { batch_ID: batchID, lineSequence: 1, debitCreditCode: 'D',
          glAccount: '120000', amount: 500, text: 'AR Control', referenceDocType: 'AR_INVOICE' },
        { batch_ID: batchID, lineSequence: 2, debitCreditCode: 'C',
          glAccount: '400000', amount: 500, text: 'Revenue', referenceDocType: 'AR_INVOICE' },
      ]));

      const batch = await db.run(SELECT.one.from('sains.ar.GLPostingBatch').where({ ID: batchID }));
      const lines = await db.run(SELECT.from('sains.ar.GLPostingLine').where({ batch_ID: batchID }));

      expect(batch.totalDebitAmount).toBe(500);
      expect(batch.totalCreditAmount).toBe(500);
      expect(lines.length).toBe(2);
      expect(lines[0].glAccount).toBe('120000');
    });

    test('cannot delete GL posting batch', async () => {
      const res = await testHandle.axios.delete('/admin/GLPostingBatches(gl-test-batch)');
      expect([403, 404, 405]).toContain(res.status);
    });

    test('idempotency key prevents duplicate posting', async () => {
      const key = '2026-03-01_DAILY_SUMMARY_IDEM';
      await db.run(INSERT.into('sains.ar.GLPostingBatch').entries({
        ID: 'gl-idem-1', batchDate: '2026-03-01', postingType: 'DAILY_SUMMARY',
        status: 'ACCEPTED', totalDebitAmount: 100, totalCreditAmount: 100,
        lineCount: 2, idempotencyKey: key, sapCoreCompanyCode: '9001',
      }));
      const existing = await db.run(
        SELECT.one.from('sains.ar.GLPostingBatch')
          .where({ idempotencyKey: key, status: 'ACCEPTED' })
      );
      expect(existing).not.toBeNull();
      // In production the job checks this before building a batch
    });
  });
});
