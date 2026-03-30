'use strict';
const { describe, test, expect } = require('@jest/globals');
const { allocatePayment, reverseAllocation } = require('../../srv/lib/clearing-engine');
const { FIXTURES } = require('../data/test-fixtures');

describe('ClearingEngine — Unit Tests', () => {

  describe('Exact match (PAY-4.1 Step 1)', () => {
    test('clears invoice when payment exactly matches outstanding', () => {
      const result = allocatePayment(FIXTURES.payments.exact_100, [FIXTURES.invoices.open_100]);
      expect(result.clearings[0].clearingType).toBe('EXACT_MATCH');
      expect(result.clearings[0].clearedAmount).toBe(100.00);
      expect(result.paymentStatusFinal).toBe('ALLOCATED');
      expect(result.invoiceStatusUpdates[0].newStatus).toBe('CLEARED');
      expect(result.invoiceStatusUpdates[0].newAmountOutstanding).toBe(0);
    });
  });

  describe('Overpayment (PAY-4.3)', () => {
    test('produces overpayment credit when payment exceeds all open invoices', () => {
      const result = allocatePayment(FIXTURES.payments.over_payment, [FIXTURES.invoices.open_100]);
      expect(result.overpaymentAmount).toBe(100.00);
      expect(result.requiresOvpayNotification).toBe(true);
      expect(result.paymentStatusFinal).toBe('ALLOCATED');
    });

    test('does NOT notify for overpayment below RM 50', () => {
      const small = { ...FIXTURES.payments.exact_100, amount: 110.00, amountUnallocated: 110.00 };
      const result = allocatePayment(small, [FIXTURES.invoices.open_100]);
      expect(result.overpaymentAmount).toBe(10.00);
      expect(result.requiresOvpayNotification).toBe(false);
    });
  });

  describe('FIFO clearing (PAY-4.1 Step 3)', () => {
    test('clears oldest invoice first', () => {
      const invoices = [
        FIXTURES.invoices.partial_80,  // dueDate: 2026-01-15 — older
        FIXTURES.invoices.open_100,    // dueDate: 2026-02-15
      ].sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
      const payment = { ...FIXTURES.payments.over_payment, amount: 90.00, amountUnallocated: 90.00 };
      const result = allocatePayment(payment, invoices);
      expect(result.clearings[0].invoiceID).toBe('inv-003');
      expect(result.clearings[0].clearedAmount).toBe(80.00);
    });

    test('cascades across multiple invoices when payment exceeds first', () => {
      const inv1 = { ...FIXTURES.invoices.partial_80, dueDate: '2026-01-01' };
      const inv2 = { ...FIXTURES.invoices.open_100, dueDate: '2026-02-01' };
      const payment = { ...FIXTURES.payments.exact_100, amount: 180.00, amountUnallocated: 180.00 };
      const result = allocatePayment(payment, [inv1, inv2]);
      expect(result.clearings.length).toBeGreaterThanOrEqual(2);
      const inv1Cleared = result.clearings.find(c => c.invoiceID === inv1.ID);
      const inv2Cleared = result.clearings.find(c => c.invoiceID === inv2.ID);
      expect(inv1Cleared.clearedAmount).toBe(80.00);
      expect(inv2Cleared.clearedAmount).toBe(100.00);
    });
  });

  describe('Partial payment (PAY-4.2)', () => {
    test('creates partial clearing when payment is less than outstanding', () => {
      const payment = { ...FIXTURES.payments.exact_100, amount: 60.00, amountUnallocated: 60.00 };
      const result = allocatePayment(payment, [FIXTURES.invoices.open_100]);
      expect(result.clearings[0].isPartial).toBe(true);
      expect(result.clearings[0].clearedAmount).toBe(60.00);
      expect(result.invoiceStatusUpdates[0].newStatus).toBe('PARTIAL');
      expect(result.invoiceStatusUpdates[0].newAmountOutstanding).toBe(40.00);
    });
  });

  describe('Unallocated (no open invoices)', () => {
    test('marks payment UNALLOCATED when no open invoices exist', () => {
      const result = allocatePayment(FIXTURES.payments.exact_100, []);
      expect(result.paymentStatusFinal).toBe('UNALLOCATED');
      expect(result.unallocatedAmount).toBe(100.00);
    });
  });

  describe('Reversal (PAY-4.8)', () => {
    test('restores invoice to OPEN after full clearing is reversed', () => {
      const clearing = [{ invoiceID: 'inv-001', clearedAmount: 100.00, clearingType: 'EXACT_MATCH' }];
      const invoiceState = [{ ID: 'inv-001', totalAmount: 100.00, amountCleared: 100.00, amountOutstanding: 0 }];
      const { invoiceRollbacks, totalReversed } = reverseAllocation(clearing, invoiceState);
      expect(invoiceRollbacks[0].newStatus).toBe('OPEN');
      expect(invoiceRollbacks[0].newAmountOutstanding).toBe(100.00);
      expect(invoiceRollbacks[0].newAmountCleared).toBe(0);
      expect(invoiceRollbacks[0].amountToRestore).toBe(100.00);
      expect(totalReversed).toBe(100.00);
    });

    test('restores invoice to PARTIAL after partial clearing is reversed', () => {
      const clearing = [{ invoiceID: 'inv-003', clearedAmount: 50.00, clearingType: 'FIFO' }];
      const invoiceState = [{ ID: 'inv-003', totalAmount: 150.00, amountCleared: 120.00, amountOutstanding: 30.00 }];
      const { invoiceRollbacks, totalReversed } = reverseAllocation(clearing, invoiceState);
      expect(invoiceRollbacks[0].newStatus).toBe('PARTIAL');
      expect(invoiceRollbacks[0].newAmountCleared).toBe(70.00);
      expect(invoiceRollbacks[0].newAmountOutstanding).toBe(80.00);
      expect(totalReversed).toBe(50.00);
    });

    test('skips overpayment credit clearing records (no invoiceID)', () => {
      const clearings = [
        { invoiceID: 'inv-001', clearedAmount: 100.00, clearingType: 'EXACT_MATCH' },
        { invoiceID: null, clearedAmount: 50.00, clearingType: 'OVERPAYMENT_CREDIT' },
      ];
      const invoiceState = [{ ID: 'inv-001', totalAmount: 100.00, amountCleared: 100.00, amountOutstanding: 0 }];
      const { invoiceRollbacks } = reverseAllocation(clearings, invoiceState);
      expect(invoiceRollbacks.length).toBe(1);
      expect(invoiceRollbacks[0].invoiceID).toBe('inv-001');
    });

    test('returns amountToRestore when invoiceStates not provided (fallback path)', () => {
      const clearings = [
        { invoiceID: 'inv-001', clearedAmount: 100.00, clearingType: 'EXACT_MATCH' },
        { invoice_ID: 'inv-002', clearedAmount: 50.00, clearingType: 'FIFO' },
      ];
      const { invoiceRollbacks, totalReversed } = reverseAllocation(clearings);
      expect(invoiceRollbacks.length).toBe(2);
      expect(invoiceRollbacks[0].amountToRestore).toBe(100.00);
      expect(invoiceRollbacks[1].amountToRestore).toBe(50.00);
      expect(totalReversed).toBe(150.00);
    });

    test('totalReversed sums all cleared amounts across multiple clearings', () => {
      const clearings = [
        { invoiceID: 'inv-001', clearedAmount: 100.00 },
        { invoiceID: 'inv-002', clearedAmount: 75.50 },
        { invoiceID: 'inv-003', clearedAmount: 24.50 },
      ];
      const invoiceState = [
        { ID: 'inv-001', amountCleared: 100.00, amountOutstanding: 0 },
        { ID: 'inv-002', amountCleared: 75.50, amountOutstanding: 0 },
        { ID: 'inv-003', amountCleared: 24.50, amountOutstanding: 0 },
      ];
      const { invoiceRollbacks, totalReversed } = reverseAllocation(clearings, invoiceState);
      expect(totalReversed).toBe(200.00);
      expect(invoiceRollbacks.length).toBe(3);
      invoiceRollbacks.forEach(rb => expect(rb.newStatus).toBe('OPEN'));
    });
  });
});
