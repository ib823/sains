'use strict';
const { describe, test, expect } = require('@jest/globals');
const {
  validateAdjustment, validatePayment, validateWriteOff,
  validatePaymentPlan, validateCustomerAccount, throwIfInvalid,
} = require('../../srv/lib/validation');

describe('Validation — Unit Tests', () => {

  describe('validateAdjustment', () => {
    const validAdj = {
      account_ID: 'acc-001',
      adjustmentType: 'BILLING_ERROR',
      direction: 'CREDIT',
      amount: 50.00,
      reason: 'Correction for overcharged meter read',
    };

    test('passes for valid adjustment', () => {
      const result = validateAdjustment(validAdj);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    test('fails when account_ID is missing', () => {
      const result = validateAdjustment({ ...validAdj, account_ID: null });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Account ID is required.');
    });

    test('fails when direction is invalid', () => {
      const result = validateAdjustment({ ...validAdj, direction: 'UP' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Direction must be CREDIT or DEBIT');
    });

    test('fails when reason is too short', () => {
      const result = validateAdjustment({ ...validAdj, reason: 'short' });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Reason must be at least 10 characters');
    });

    test('fails when amount exceeds invoice total', () => {
      const result = validateAdjustment({ ...validAdj, amount: 200 }, 100);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('exceeds invoice total');
    });

    test('passes when amount is within invoice total', () => {
      const result = validateAdjustment({ ...validAdj, amount: 50 }, 100);
      expect(result.valid).toBe(true);
    });

    test('passes when invoiceAmount is null (no invoice referenced)', () => {
      const result = validateAdjustment(validAdj, null);
      expect(result.valid).toBe(true);
    });
  });

  describe('validatePayment', () => {
    const validPayment = {
      account_ID: 'acc-001',
      amount: 100.00,
      paymentDate: new Date().toISOString().split('T')[0],
      channel: 'COUNTER_CASH',
    };

    test('passes for valid payment', () => {
      const result = validatePayment(validPayment);
      expect(result.valid).toBe(true);
    });

    test('fails for zero amount', () => {
      const result = validatePayment({ ...validPayment, amount: 0 });
      expect(result.valid).toBe(false);
    });

    test('fails when amount exceeds RM limit', () => {
      const result = validatePayment({ ...validPayment, amount: 1000000.00 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('RM 999,999.99');
    });

    test('fails for future payment date', () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 5);
      const result = validatePayment({ ...validPayment, paymentDate: futureDate.toISOString().split('T')[0] });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateWriteOff', () => {
    const validWO = {
      account_ID: 'acc-001',
      invoiceID: 'inv-001',
      reason: 'Customer is unreachable and debt is aged beyond recovery',
      collectionHistory: 'Multiple attempts over 12 months including field visits and legal notices',
    };

    test('returns SUPERVISOR approval for small amounts', () => {
      const result = validateWriteOff(validWO, 30.00);
      expect(result.valid).toBe(true);
      expect(result.requiredApproval).toBe('SUPERVISOR');
    });

    test('returns MANAGER approval for amounts >= RM500', () => {
      const result = validateWriteOff(validWO, 500.00);
      expect(result.requiredApproval).toBe('MANAGER');
    });

    test('returns CFO approval for amounts >= RM5000', () => {
      const result = validateWriteOff(validWO, 5000.00);
      expect(result.requiredApproval).toBe('CFO');
    });

    test('returns BOARD approval for very large amounts', () => {
      const result = validateWriteOff(validWO, 25000.00);
      expect(result.requiredApproval).toBe('BOARD');
    });

    test('fails when reason is too short', () => {
      const result = validateWriteOff({ ...validWO, reason: 'too short' }, 100);
      expect(result.valid).toBe(false);
    });
  });

  describe('throwIfInvalid', () => {
    test('does not throw for valid result', () => {
      expect(() => throwIfInvalid({ valid: true, errors: [] })).not.toThrow();
    });

    test('throws with concatenated errors for invalid result', () => {
      expect(() => throwIfInvalid({ valid: false, errors: ['Error 1', 'Error 2'] }))
        .toThrow('Error 1; Error 2');
    });

    test('thrown error has statusCode 400', () => {
      try {
        throwIfInvalid({ valid: false, errors: ['test'] });
      } catch (e) {
        expect(e.statusCode).toBe(400);
      }
    });
  });
});
