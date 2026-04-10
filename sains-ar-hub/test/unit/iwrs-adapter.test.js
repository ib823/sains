'use strict';
const { describe, test, expect, beforeEach } = require('@jest/globals');

// Mock CDS and external dependencies before requiring the adapter
const mockDb = {
  run: jest.fn(),
};

jest.mock('@sap/cds', () => ({
  log: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  connect: { to: jest.fn().mockResolvedValue(mockDb) },
  utils: { uuid: () => 'test-uuid-' + Date.now() },
}));

jest.mock('axios');
jest.mock('../../srv/lib/audit-logger', () => ({
  logSystemAction: jest.fn(),
}));
jest.mock('../../srv/lib/crypto-helper', () => ({
  encryptICNumber: jest.fn((x) => `ENC_${x}`),
}));

const iwrs = require('../../srv/external/iwrs-adapter');

describe('iWRS Adapter — Unit Tests', () => {

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb.run.mockReset();
  });

  describe('Module exports', () => {
    test('exports all required Pattern A functions', () => {
      expect(typeof iwrs.processAccountEvent).toBe('function');
      expect(typeof iwrs.processInvoiceEvent).toBe('function');
      expect(typeof iwrs.processPaymentEvent).toBe('function');
    });

    test('exports outbound notification functions', () => {
      expect(typeof iwrs.notifyDisconnectionAuthorised).toBe('function');
      expect(typeof iwrs.notifyReconnection).toBe('function');
    });

    test('exports Pattern B mock implementations', () => {
      expect(typeof iwrs.processPatternBDeltaFile).toBe('function');
      expect(typeof iwrs.parsePatternBAccountFile).toBe('function');
      expect(typeof iwrs.parsePatternBInvoiceFile).toBe('function');
    });

    test('exports Pattern C mock implementation', () => {
      expect(typeof iwrs.pollPatternCAccounts).toBe('function');
    });
  });

  describe('Mock implementations — Pattern B', () => {
    test('processPatternBDeltaFile returns MOCK result', async () => {
      const result = await iwrs.processPatternBDeltaFile(new Date());
      expect(result).toHaveProperty('source', 'MOCK');
      expect(result).toHaveProperty('processed', 0);
    });

    test('parsePatternBAccountFile returns empty array', () => {
      const result = iwrs.parsePatternBAccountFile('csv content');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    test('parsePatternBInvoiceFile returns empty array', () => {
      const result = iwrs.parsePatternBInvoiceFile('csv content');
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('Mock implementations — Pattern C', () => {
    test('pollPatternCAccounts returns MOCK result', async () => {
      const result = await iwrs.pollPatternCAccounts(new Date());
      expect(result).toHaveProperty('source', 'MOCK');
      expect(result).toHaveProperty('accounts', 0);
    });

    test('Pattern C mock returns payments property', async () => {
      const result = await iwrs.pollPatternCAccounts(new Date());
      expect(result).toHaveProperty('payments', 0);
    });
  });

  describe('Outbound notifications — TBC guard', () => {
    test('notifyDisconnectionAuthorised returns false when endpoint is TBC', async () => {
      const account = { accountNumber: 'TEST-001', balanceOutstanding: 500, dunningLevel: 4, ID: 'test-id' };
      const result = await iwrs.notifyDisconnectionAuthorised(account, 'admin', 'AUTH-001');
      expect(result).toBe(false);
    });

    test('notifyReconnection returns false when endpoint is TBC', async () => {
      const account = { accountNumber: 'TEST-001', ID: 'test-id' };
      const result = await iwrs.notifyReconnection(account, 'PAY-001', new Date().toISOString());
      expect(result).toBe(false);
    });
  });
});
