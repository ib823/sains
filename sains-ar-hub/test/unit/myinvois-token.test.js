'use strict';
const { describe, test, expect, jest: jestGlobal, beforeEach } = require('@jest/globals');

// Mock axios before requiring the adapter
jest.mock('axios', () => {
  let callCount = 0;
  return {
    post: jest.fn().mockImplementation(() => {
      callCount++;
      return new Promise(resolve => {
        setTimeout(() => {
          resolve({
            data: {
              access_token: `token-${callCount}`,
              expires_in: 3600,
            },
          });
        }, 50); // Simulate network delay
      });
    }),
    get: jest.fn(),
    put: jest.fn(),
  };
});

describe('MyInvois Token Cache — Unit Tests', () => {

  beforeEach(() => {
    // Reset module cache to get fresh token state
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('concurrent getAccessToken calls share a single token request', async () => {
    const axios = require('axios');
    const adapter = require('../../srv/external/myinvois-adapter');

    // Fire 5 concurrent token requests
    const promises = Array.from({ length: 5 }, () => adapter.getAccessToken());
    const tokens = await Promise.all(promises);

    // All should get the same token (only 1 HTTP call made)
    expect(axios.post).toHaveBeenCalledTimes(1);
    const firstToken = tokens[0];
    tokens.forEach(t => expect(t).toBe(firstToken));
  });

  test('cached token is reused without additional HTTP call', async () => {
    const axios = require('axios');
    const adapter = require('../../srv/external/myinvois-adapter');

    const token1 = await adapter.getAccessToken();
    const token2 = await adapter.getAccessToken();

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(token1).toBe(token2);
  });

  test('buildInvoiceDocument produces valid UBL 2.1 structure', () => {
    const adapter = require('../../srv/external/myinvois-adapter');

    const invoice = {
      invoiceNumber: 'INV-2026-001',
      invoiceDate: '2026-03-01',
      billingPeriodFrom: '2026-02-01',
      billingPeriodTo: '2026-02-28',
      invoiceType: 'STANDARD',
      totalAmount: 150.00,
      taxAmount: 0,
    };
    const account = {
      buyerTINVerified: false,
      accountType_code: 'DOM',
      legalName: 'Test Customer',
      holderType: 'OWNER',
      idNumberMasked: 'XXXXXX-XX-XXXX',
      serviceAddress1: '123 Jalan Test',
      servicePostcode: '70000',
      serviceCity: 'Seremban',
      primaryPhone: '0123456789',
      emailAddress: 'test@example.com',
    };
    const lineItems = [{
      description: 'Water Charges',
      quantity: 1,
      unitCode: 'C62',
      lineAmount: 150.00,
      taxAmount: 0,
      taxCategory: 'E',
      unitPrice: 150.00,
      discountAmount: 0,
    }];

    const doc = adapter.buildInvoiceDocument(invoice, account, lineItems, 'test-uuid-123');
    expect(doc.Invoice).toBeDefined();
    expect(doc.Invoice[0].ID[0]._).toBe('INV-2026-001');
    expect(doc.Invoice[0].UUID[0]._).toBe('test-uuid-123');
    expect(doc.Invoice[0].InvoiceTypeCode[0]._).toBe('01');
  });

  test('isWithinCancellationWindow returns true within 72 hours', () => {
    const adapter = require('../../srv/external/myinvois-adapter');
    const now = new Date();
    expect(adapter.isWithinCancellationWindow(now.toISOString())).toBe(true);
  });

  test('isWithinCancellationWindow returns false after 72 hours', () => {
    const adapter = require('../../srv/external/myinvois-adapter');
    const pastDate = new Date(Date.now() - 73 * 60 * 60 * 1000);
    expect(adapter.isWithinCancellationWindow(pastDate.toISOString())).toBe(false);
  });
});
