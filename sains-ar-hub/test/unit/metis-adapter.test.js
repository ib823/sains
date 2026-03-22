'use strict';
const { describe, test, expect } = require('@jest/globals');

// Create chainable mock for CDS query API (SELECT, INSERT, UPDATE)
const chainable = () => {
  const chain = new Proxy({}, {
    get: () => (...args) => chain,
  });
  return chain;
};

jest.mock('@sap/cds', () => {
  const mockRun = jest.fn().mockResolvedValue(null);
  return {
    log: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
    connect: { to: jest.fn().mockResolvedValue({ run: mockRun }) },
    utils: { uuid: () => 'metis-test-uuid' },
  };
});

// Must mock the CDS global query builders
const cds = require('@sap/cds');
global.SELECT = { one: { from: () => ({ columns: () => ({ where: () => null }) }) }, from: () => ({ where: () => [] }) };
global.INSERT = { into: () => ({ entries: () => ({}) }) };
global.UPDATE = (entity) => ({ set: () => ({ where: () => ({}) }) });

jest.mock('axios');
jest.mock('../../srv/lib/audit-logger', () => ({
  logSystemAction: jest.fn(),
}));
jest.mock('../../srv/external/notification-service', () => ({
  sendSystemAlert: jest.fn().mockResolvedValue(true),
}));

const metis = require('../../srv/external/metis-adapter');

describe('Metis Adapter — Unit Tests', () => {

  describe('Module exports', () => {
    test('exports createDisconnectionWorkOrder', () => {
      expect(typeof metis.createDisconnectionWorkOrder).toBe('function');
    });

    test('exports createReconnectionWorkOrder', () => {
      expect(typeof metis.createReconnectionWorkOrder).toBe('function');
    });
  });

  describe('createDisconnectionWorkOrder — TBC guard', () => {
    test('returns object with success field when Metis API is TBC', async () => {
      const account = {
        ID: 'acc-1', accountNumber: 'TEST-001', legalName: 'Test Customer',
        serviceAddress1: '1 Jalan Test', serviceCity: 'Seremban',
        servicePostcode: '70100', meterReference: 'MTR-001',
        balanceOutstanding: 500, dunningLevel: 4,
      };
      const result = await metis.createDisconnectionWorkOrder(account, 'admin', 'wo-001');
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });
  });

  describe('createReconnectionWorkOrder — TBC guard', () => {
    test('returns object with success field when Metis API is TBC', async () => {
      const account = {
        ID: 'acc-1', accountNumber: 'TEST-001', legalName: 'Test Customer',
        serviceAddress1: '1 Jalan Test', serviceCity: 'Seremban',
        meterReference: 'MTR-001',
      };
      const result = await metis.createReconnectionWorkOrder(account, 'PAY-001');
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(false);
    });
  });
});
