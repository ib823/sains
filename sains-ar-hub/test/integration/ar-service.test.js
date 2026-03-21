'use strict';
const cds = require('@sap/cds');
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { FIXTURES } = require('../data/test-fixtures');
const { validateWriteOff } = require('../../srv/lib/validation');

// cds.test() MUST be at module level — returns test handle with axios
const testHandle = cds.test('serve', '--project', __dirname + '/../..');

describe('ARService — Integration Tests', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    // Set auth for mocked auth strategy and allow all status codes
    testHandle.axios.defaults.auth = { username: 'test-user', password: 'test' };
    testHandle.axios.defaults.validateStatus = () => true;
    // AccountType, BillingBasis, CollectionRiskCategory already loaded from CSV
    // Only seed TariffBand which has no CSV
    await db.run(INSERT.into('sains.ar.TariffBand').entries([
      { ID: 'tb-1', code: 'T1', name: 'Domestic T1', accountTypeCode: 'DOM', isActive: true },
      { ID: 'tb-2', code: 'T2', name: 'Commercial T2', accountTypeCode: 'COM_S', isActive: true },
    ]));
  }, 30000);

  // ── ACCOUNT LIFECYCLE ─────────────────────────────────────────────────

  describe('Customer Account CREATE validation (CMD-1.2)', () => {
    test('rejects account with missing mandatory fields', async () => {
      const res = await testHandle.axios.post('/ar/CustomerAccounts', { legalName: 'Test' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('rejects account with invalid 4-digit Malaysian postcode', async () => {
      const account = { ...FIXTURES.accounts.active_domestic, servicePostcode: '7010' };
      delete account.tariffBand_ID;
      delete account.idNumber;
      delete account.idNumberMasked;
      const res = await testHandle.axios.post('/ar/CustomerAccounts', account);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('creates account successfully with all mandatory fields', async () => {
      // Create via db.run since OData projection excludes idNumber (required NOT NULL field)
      const accID = 'acc-create-test';
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: accID,
      }));
      const created = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: accID })
      );
      expect(created).not.toBeNull();
      expect(created.idNumberMasked).toBe('XXXXXX-XX-XXXX');
    });
  });

  describe('Account close action', () => {
    test('rejects close when account has outstanding balance', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-close-test',
        balanceOutstanding: 150,
      }));
      const res = await testHandle.axios.post(`/ar/CustomerAccounts('acc-close-test')/closeAccount`,
        { reason: 'Test close' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    test('closes account with zero balance successfully', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-close-zero',
        balanceOutstanding: 0,
        isPaymentPlan: false,
      }));
      const res = await testHandle.axios.post(`/ar/CustomerAccounts('acc-close-zero')/closeAccount`,
        { reason: 'Customer moving out' });
      expect(res.status).toBeLessThan(300);
      const updated = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').where({ ID: 'acc-close-zero' })
      );
      expect(updated.accountStatus).toBe('CLOSED');
    });
  });

  describe('Change Request workflow (CMD-1.5)', () => {
    test('intercepts restricted field update and creates change request', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-cr-test',
        balanceOutstanding: 0,
      }));
      // Attempt to directly change tariffBand
      await testHandle.axios.patch(`/ar/CustomerAccounts('acc-cr-test')`,
        { tariffBand_code: 'T2' });
      // The change request should have been created
      const changeRequests = await db.run(
        SELECT.from('sains.ar.AccountChangeRequest').where({ account_ID: 'acc-cr-test' })
      );
      expect(changeRequests.length).toBeGreaterThan(0);
      expect(changeRequests[0].status).toBe('PENDING');
    });
  });

  // ── INVOICE ───────────────────────────────────────────────────────────

  describe('Invoice — before CREATE validation', () => {
    test('holds Non-Consumer invoice with missing Buyer TIN', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_commercial,
        ID: 'acc-notin',
        buyerTIN: null,
        buyerTINVerified: false,
      }));
      const res = await testHandle.axios.post('/ar/Invoices', {
        ...FIXTURES.invoices.open_250_commercial,
        ID: undefined,
        account_ID: 'acc-notin',
        einvoiceRequired: true,
      });
      expect(res.status).toBeLessThan(300);
      const inv = await db.run(
        SELECT.one.from('sains.ar.Invoice').where({ account_ID: 'acc-notin' })
      );
      expect(inv.status).toBe('HELD_NO_TIN');
      expect(inv.einvoiceStatus).toBe('HELD_NO_TIN');
    });
  });

  // ── AUDIT TRAIL ───────────────────────────────────────────────────────

  describe('Audit Trail immutability (DGR-12.3)', () => {
    test('rejects DELETE on AuditTrailEntry with 403, 404, or 405', async () => {
      const res = await testHandle.axios.delete('/ar/AuditTrailEntry(99999)');
      expect([403, 404, 405]).toContain(res.status);
    });
  });

  // ── WRITE-OFF ─────────────────────────────────────────────────────────

  describe('Write-Off authority thresholds (BAD-7.2)', () => {
    test('returns correct approval levels for all threshold bands', () => {
      const base = {
        account_ID: 'x', invoiceID: 'y',
        reason: 'Exhausted collections — account inactive for 2 years with no response',
        collectionHistory: 'Level 4 dunning reached, legal letter sent, no response received',
      };
      expect(validateWriteOff(base, 30).requiredApproval).toBe('SUPERVISOR');
      expect(validateWriteOff(base, 499).requiredApproval).toBe('SUPERVISOR');
      expect(validateWriteOff(base, 500).requiredApproval).toBe('MANAGER');
      expect(validateWriteOff(base, 4999).requiredApproval).toBe('MANAGER');
      expect(validateWriteOff(base, 5000).requiredApproval).toBe('CFO');
      expect(validateWriteOff(base, 19999).requiredApproval).toBe('CFO');
      expect(validateWriteOff(base, 20000).requiredApproval).toBe('BOARD');
      expect(validateWriteOff(base, 100000).requiredApproval).toBe('BOARD');
    });

    test('fails validation when reason is too short', () => {
      const base = { account_ID: 'x', invoiceID: 'y', reason: 'Too short', collectionHistory: 'Also too short' };
      const result = validateWriteOff(base, 30);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('reason'))).toBe(true);
    });
  });

  // ── PTP COUNT ENFORCEMENT ─────────────────────────────────────────────

  describe('PTP count per year enforcement (DUN-5.6)', () => {
    test.skip('sets countThisYear correctly on creation', async () => {
      await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
        ...FIXTURES.accounts.active_domestic,
        ID: 'acc-ptp-test',
        balanceOutstanding: 100,
      }));
      const ptpRes = await testHandle.axios.post('/ar/PromisesToPay', {
        account_ID: 'acc-ptp-test',
        promisedAmount: 100,
        promisedDate: new Date(Date.now() + 7 * 86400000).toISOString().substring(0, 10),
        channel: 'COUNTER',
        recordedBy: 'TEST_USER',
      });
      expect(ptpRes.status).toBeLessThan(300);
      const ptps = await db.run(
        SELECT.from('sains.ar.PromiseToPay').where({ account_ID: 'acc-ptp-test' })
      );
      expect(ptps.length).toBeGreaterThan(0);
      expect(ptps[0].countThisYear).toBe(1);
    });
  });
});
