'use strict';
const cds = require('@sap/cds');
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { FIXTURES } = require('../data/test-fixtures');

const testHandle = cds.test('serve', '--project', __dirname + '/../..');

describe('Phase 2 — LHDN MyInvois e-Invoice Integration Tests', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    testHandle.axios.defaults.auth = { username: 'test-user', password: 'test' };
    testHandle.axios.defaults.validateStatus = () => true;

    // Seed accounts and invoices for e-invoice tests
    await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
      ...FIXTURES.accounts.active_commercial,
      ID: 'acc-ei-com',
      accountNumber: 'SAINS-EI-COM',
      buyerTIN: '200601000001',
      buyerTINVerified: true,
      holderType: 'COMPANY',
      legalName: 'Syarikat Ujian Sdn Bhd',
    }));

    await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
      ...FIXTURES.accounts.active_domestic,
      ID: 'acc-ei-dom',
      accountNumber: 'SAINS-EI-DOM',
      buyerTIN: null,
      buyerTINVerified: false,
    }));

    await db.run(INSERT.into('sains.ar.Invoice').entries({
      ID: 'inv-ei-001',
      account_ID: 'acc-ei-com',
      invoiceNumber: 'INV-EI-001',
      invoiceDate: '2026-03-01',
      dueDate: '2026-03-31',
      billingPeriodFrom: '2026-02-01',
      billingPeriodTo: '2026-02-28',
      invoiceType: 'STANDARD',
      status: 'OPEN',
      sourceSystem: 'SIBMA',
      totalAmount: 1060.00,
      taxAmount: 60.00,
      taxRateApplied: 6,
      amountCleared: 0,
      amountOutstanding: 1060.00,
      einvoiceRequired: true,
    }));
  }, 30000);

  // ── UBL JSON STRUCTURE ─────────────────────────────────────────────────────

  describe('UBL JSON document structure', () => {
    test('mandatory fields all present for domestic invoice', () => {
      const { buildInvoiceDocument } = require('../../srv/external/myinvois-adapter');

      const invoice = {
        invoiceNumber: 'INV-EI-001',
        invoiceDate: '2026-03-01',
        billingPeriodFrom: '2026-02-01',
        billingPeriodTo: '2026-02-28',
        invoiceType: 'STANDARD',
        totalAmount: 1060.00,
        taxAmount: 60.00,
      };
      const account = {
        buyerTIN: '200601000001',
        buyerTINVerified: true,
        accountType_code: 'COM_S',
        holderType: 'COMPANY',
        legalName: 'Syarikat Ujian Sdn Bhd',
        idNumberMasked: 'XXXXXX-XX-XXXX',
        serviceAddress1: '25 Jalan Industri',
        serviceCity: 'Nilai',
        servicePostcode: '71800',
        primaryPhone: '0321234567',
        emailAddress: 'ujian@example.com',
      };
      const lineItems = [
        {
          lineAmount: 1000.00,
          taxAmount: 60.00,
          description: 'Water consumption',
          quantity: 1,
          unitPrice: 1000.00,
          unitCode: 'C62',
          taxCategory: 'S',
          discountAmount: 0,
        },
      ];
      const documentUUID = '550e8400-e29b-41d4-a716-446655440000';

      const doc = buildInvoiceDocument(invoice, account, lineItems, documentUUID);

      // Verify top-level UBL namespace declarations
      expect(doc._D).toBe('urn:oasis:names:specification:ubl:schema:xsd:Invoice-2');
      expect(doc._A).toBe('urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2');
      expect(doc._B).toBe('urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2');

      // Verify Invoice root element
      const inv = doc.Invoice[0];
      expect(inv).toBeDefined();

      // Mandatory fields per LHDN specification
      expect(inv.ID).toBeDefined(); // Invoice number
      expect(inv.IssueDate).toBeDefined();
      expect(inv.InvoiceTypeCode).toBeDefined();
      expect(inv.DocumentCurrencyCode).toBeDefined();
      expect(inv.UUID).toBeDefined();
      expect(inv.UUID[0]._).toBe(documentUUID);

      // Supplier party (SAINS)
      expect(inv.AccountingSupplierParty).toBeDefined();
      const supplier = inv.AccountingSupplierParty[0].Party[0];
      expect(supplier.PartyIdentification).toBeDefined();
      expect(supplier.PartyName).toBeDefined();
      expect(supplier.PostalAddress).toBeDefined();

      // Customer party (buyer)
      expect(inv.AccountingCustomerParty).toBeDefined();
      const buyer = inv.AccountingCustomerParty[0].Party[0];
      expect(buyer.PartyIdentification).toBeDefined();
      expect(buyer.PartyName[0].Name[0]._).toBe('Syarikat Ujian Sdn Bhd');

      // Tax total
      expect(inv.TaxTotal).toBeDefined();
      expect(inv.TaxTotal[0].TaxAmount).toBeDefined();

      // Legal monetary total
      expect(inv.LegalMonetaryTotal).toBeDefined();
      expect(inv.LegalMonetaryTotal[0].PayableAmount).toBeDefined();

      // Invoice lines
      expect(inv.InvoiceLine).toBeDefined();
      expect(inv.InvoiceLine.length).toBeGreaterThan(0);

      // Billing period
      expect(inv.InvoicePeriod).toBeDefined();
    });
  });

  // ── CONSOLIDATED B2C ───────────────────────────────────────────────────────

  describe('Consolidated B2C e-invoice', () => {
    test('uses EI00000000010 as buyer TIN', () => {
      const { buildConsolidatedB2CDocument, MYINVOIS_CONFIG } = require('../../srv/external/myinvois-adapter');

      const invoices = [
        { totalAmount: 80, taxAmount: 0, invoiceNumber: 'INV-B2C-001' },
        { totalAmount: 120, taxAmount: 0, invoiceNumber: 'INV-B2C-002' },
      ];
      const docUUID = '660e8400-e29b-41d4-a716-446655440001';

      const doc = buildConsolidatedB2CDocument(2026, 3, invoices, docUUID);

      // Verify the document uses the B2C placeholder TIN
      const inv = doc.Invoice[0];
      const buyerParty = inv.AccountingCustomerParty[0].Party[0];
      const buyerTINField = buyerParty.PartyIdentification.find(
        p => p.ID[0].schemeID === 'TIN'
      );
      expect(buyerTINField).toBeDefined();
      expect(buyerTINField.ID[0]._).toBe('EI00000000010');

      // Verify buyer name is 'General Public'
      expect(buyerParty.PartyName[0].Name[0]._).toBe('General Public');

      // Verify the config constant
      expect(MYINVOIS_CONFIG.B2C_PLACEHOLDER_TIN).toBe('EI00000000010');
    });
  });

  // ── CANCELLATION WINDOW ────────────────────────────────────────────────────

  describe('Cancellation window enforcement', () => {
    test('isWithinCancellationWindow returns true within 72h', () => {
      const { isWithinCancellationWindow } = require('../../srv/external/myinvois-adapter');

      // Set validation date to 1 hour ago — well within 72h window
      const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000);
      expect(isWithinCancellationWindow(oneHourAgo.toISOString())).toBe(true);

      // Set validation date to 71 hours ago — still within window
      const seventyOneHoursAgo = new Date(Date.now() - 71 * 60 * 60 * 1000);
      expect(isWithinCancellationWindow(seventyOneHoursAgo.toISOString())).toBe(true);
    });

    test('isWithinCancellationWindow returns false after 73h', () => {
      const { isWithinCancellationWindow } = require('../../srv/external/myinvois-adapter');

      // Set validation date to 73 hours ago — past the 72h window
      const seventyThreeHoursAgo = new Date(Date.now() - 73 * 60 * 60 * 1000);
      expect(isWithinCancellationWindow(seventyThreeHoursAgo.toISOString())).toBe(false);

      // Set validation date to 100 hours ago — well past window
      const hundredHoursAgo = new Date(Date.now() - 100 * 60 * 60 * 1000);
      expect(isWithinCancellationWindow(hundredHoursAgo.toISOString())).toBe(false);
    });
  });

  // ── RATE LIMIT RETRY LOGIC ─────────────────────────────────────────────────

  describe('Rate limit retry logic', () => {
    test('retries on HTTP 429 (mocked)', async () => {
      const { submitDocuments } = require('../../srv/external/myinvois-adapter');
      const nock = (() => {
        try { return require('nock'); } catch { return null; }
      })();

      if (nock) {
        // Clear any cached tokens
        const adapter = require('../../srv/external/myinvois-adapter');

        // Mock token endpoint
        nock(/myinvois|hasil/)
          .post('/connect/token')
          .times(5)
          .reply(200, { access_token: 'mock-token-ei', expires_in: 3600 });

        // First call returns 429 (rate limit), second succeeds
        nock(/myinvois|hasil/)
          .post('/api/v1.0/documentsubmissions/')
          .reply(429, { error: { message: 'Rate limit exceeded' } });
        nock(/myinvois|hasil/)
          .post('/api/v1.0/documentsubmissions/')
          .reply(200, {
            submissionUid: 'sub-mock-001',
            acceptedDocuments: [{ uuid: 'doc-001', invoiceCodeNumber: 'INV-001' }],
            rejectedDocuments: [],
          });

        const docs = [{
          uuid: 'doc-001',
          document: { Invoice: [{ ID: [{ _: 'INV-001' }] }] },
        }];

        const result = await submitDocuments(docs);
        expect(result.submissionUID).toBe('sub-mock-001');
        expect(result.acceptedDocuments.length).toBe(1);

        nock.cleanAll();
      } else {
        // Without nock, verify the function exists and handles empty input correctly
        expect(typeof submitDocuments).toBe('function');
        await expect(submitDocuments([])).rejects.toThrow('No documents to submit');
      }
    });
  });
});
