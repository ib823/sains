'use strict';
const { describe, test, expect } = require('@jest/globals');

jest.mock('@sap/cds', () => ({
  log: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  connect: { to: jest.fn().mockResolvedValue({ run: jest.fn() }) },
  utils: { uuid: () => 'fpx-test-uuid' },
}));

jest.mock('../../srv/lib/audit-logger', () => ({
  logSystemAction: jest.fn(),
}));

const fpx = require('../../srv/external/fpx-adapter');

describe('FPX Adapter — Unit Tests', () => {

  describe('Module exports', () => {
    test('exports validateIPNSignature', () => {
      expect(typeof fpx.validateIPNSignature).toBe('function');
    });

    test('exports processIPNNotification', () => {
      expect(typeof fpx.processIPNNotification).toBe('function');
    });

    test('exports buildPaymentInitiationURL', () => {
      expect(typeof fpx.buildPaymentInitiationURL).toBe('function');
    });

    test('exports FPX_CONFIG object', () => {
      expect(fpx.FPX_CONFIG).toBeDefined();
      expect(typeof fpx.FPX_CONFIG).toBe('object');
    });
  });

  describe('validateIPNSignature', () => {
    test('returns false when payload has no fpx_checkSum', () => {
      const result = fpx.validateIPNSignature({ fpx_txnStatus: '00' });
      expect(result).toBe(false);
    });

    test('returns false for null payload', () => {
      expect(fpx.validateIPNSignature(null)).toBe(false);
    });

    test('returns false for empty object', () => {
      expect(fpx.validateIPNSignature({})).toBe(false);
    });
  });

  describe('buildPaymentInitiationURL', () => {
    test('returns object with paymentURL and orderNo', () => {
      const result = fpx.buildPaymentInitiationURL('ACC001', 150.00, 'INV-001');
      expect(result).toHaveProperty('paymentURL');
      expect(result).toHaveProperty('orderNo');
      expect(result.orderNo).toContain('SAINS-FPX-ACC001');
    });

    test('orderNo contains account number', () => {
      const result = fpx.buildPaymentInitiationURL('TEST-12345', 50, 'INV-X');
      expect(result.orderNo).toContain('TEST-12345');
    });
  });

  describe('FPX_CONFIG', () => {
    test('has required configuration keys', () => {
      expect(fpx.FPX_CONFIG).toHaveProperty('SELLER_ORDER_PREFIX');
      expect(fpx.FPX_CONFIG.SELLER_ORDER_PREFIX).toBe('SAINS-FPX-');
      expect(fpx.FPX_CONFIG).toHaveProperty('CURRENCY');
      expect(fpx.FPX_CONFIG.CURRENCY).toBe('MYR');
    });
  });
});
