'use strict';
const { describe, test, expect } = require('@jest/globals');
const { buildDailySummaryBatch, buildJournalEntryPayload, resolveGLMapping }
  = require('../../srv/lib/gl-builder');
const { FIXTURES } = require('../data/test-fixtures');

describe('GLBuilder — Unit Tests', () => {

  describe('resolveGLMapping', () => {
    test('returns exact match when both account and charge type match', () => {
      const tx = { transactionType: 'INVOICE', accountTypeCode: 'ALL', chargeTypeCode: 'ALL' };
      const mapping = resolveGLMapping(tx, FIXTURES.glMappings);
      expect(mapping).not.toBeNull();
      expect(mapping.debitGL).toBe('120000');
      expect(mapping.creditGL).toBe('400000');
    });

    test('returns null for unknown transaction type', () => {
      const tx = { transactionType: 'UNKNOWN_TYPE', accountTypeCode: 'DOM', chargeTypeCode: 'WATER' };
      expect(resolveGLMapping(tx, FIXTURES.glMappings)).toBeNull();
    });

    test('returns null when isActive is false', () => {
      const inactiveMappings = FIXTURES.glMappings.map(m => ({ ...m, isActive: false }));
      const tx = { transactionType: 'INVOICE', accountTypeCode: 'ALL', chargeTypeCode: 'ALL' };
      expect(resolveGLMapping(tx, inactiveMappings)).toBeNull();
    });
  });

  describe('buildDailySummaryBatch — BLOCKER-2 regression', () => {
    test('produces debit and credit lines for each transaction type', () => {
      const txs = [
        { transactionType: 'INVOICE',  accountTypeCode: 'ALL', chargeTypeCode: 'ALL', chargeType: 'ALL',
          branchCode: 'SEREMBAN', amount: 100, referenceDocType: 'AR_INVOICE', referenceDocID: 'inv-1' },
        { transactionType: 'PAYMENT',  accountTypeCode: 'ALL', chargeTypeCode: 'ALL', chargeType: 'ALL',
          branchCode: 'SEREMBAN', amount: 80,  referenceDocType: 'AR_PAYMENT', referenceDocID: 'pay-1' },
        { transactionType: 'DEPOSIT',  accountTypeCode: 'ALL', chargeTypeCode: 'ALL', chargeType: 'ALL',
          branchCode: 'SEREMBAN', amount: 200, referenceDocType: 'AR_DEPOSIT', referenceDocID: 'dep-1' },
      ];
      const batch = buildDailySummaryBatch(txs, FIXTURES.glMappings, '2026-03-01', '9001');
      expect(batch.lines.length).toBe(6); // 3 types × 2 sides
      expect(batch.totalDebitAmount).toBe(batch.totalCreditAmount);
    });

    test('batch is balanced — total debits equal total credits', () => {
      const txs = [
        { transactionType: 'INVOICE', accountTypeCode: 'ALL', chargeTypeCode: 'ALL', chargeType: 'ALL',
          branchCode: 'SEREMBAN', amount: 500, referenceDocType: 'AR_INVOICE', referenceDocID: 'inv-x' },
      ];
      const batch = buildDailySummaryBatch(txs, FIXTURES.glMappings, '2026-03-01', '9001');
      expect(batch.totalDebitAmount).toBeCloseTo(batch.totalCreditAmount, 2);
    });

    test('throws when GL mapping is missing for transaction type', () => {
      const txs = [
        { transactionType: 'ORPHAN_TYPE', accountTypeCode: 'DOM', chargeTypeCode: 'WATER',
          chargeType: 'WATER', branchCode: 'SEREMBAN', amount: 100,
          referenceDocType: 'X', referenceDocID: 'x' },
      ];
      expect(() => buildDailySummaryBatch(txs, FIXTURES.glMappings, '2026-03-01', '9001'))
        .toThrow('No GL mapping found');
    });

    test('aggregates multiple transactions of same type into single GL lines', () => {
      const txs = [
        { transactionType: 'PAYMENT', accountTypeCode: 'ALL', chargeTypeCode: 'ALL', chargeType: 'ALL',
          branchCode: 'SEREMBAN', amount: 50, referenceDocType: 'AR_PAYMENT', referenceDocID: 'p1' },
        { transactionType: 'PAYMENT', accountTypeCode: 'ALL', chargeTypeCode: 'ALL', chargeType: 'ALL',
          branchCode: 'SEREMBAN', amount: 75, referenceDocType: 'AR_PAYMENT', referenceDocID: 'p2' },
      ];
      const batch = buildDailySummaryBatch(txs, FIXTURES.glMappings, '2026-03-01', '9001');
      // Two payments same GL and cost centre = 2 lines (D+C aggregated)
      expect(batch.lines.length).toBe(2);
      expect(batch.totalDebitAmount).toBe(125);
    });
  });

  describe('buildJournalEntryPayload', () => {
    test('produces SAP OData V2 Journal Entry structure', () => {
      const batch = {
        batchDate: '2026-03-01',
        sapCoreCompanyCode: '9001',
        postingType: 'DAILY_SUMMARY',
        lines: [
          { glAccount: '120000', debitCreditCode: 'D', amount: 100,
            profitCentre: '', costCentre: '', text: 'INVOICE', assignment: '' },
          { glAccount: '400000', debitCreditCode: 'C', amount: 100,
            profitCentre: '', costCentre: '', text: 'INVOICE', assignment: '' },
        ],
      };
      const payload = buildJournalEntryPayload(batch);
      expect(payload.CompanyCode).toBe('9001');
      expect(payload.CompanyCodeCurrency).toBe('MYR');
      expect(payload.to_JournalEntryItem.results).toHaveLength(2);
      expect(payload.to_JournalEntryItem.results[0].GLAccount).toBe('120000');
      expect(payload.to_JournalEntryItem.results[0].DebitCreditCode).toBe('D');
    });
  });
});
