'use strict';
const cds = require('@sap/cds');
const { describe, test, expect, beforeAll } = require('@jest/globals');
const { FIXTURES } = require('../data/test-fixtures');

const testHandle = cds.test('serve', '--project', __dirname + '/../..');

describe('Phase 2 — Intelligent Collections & Segmentation Integration Tests', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    testHandle.axios.defaults.auth = { username: 'test-user', password: 'test' };
    testHandle.axios.defaults.validateStatus = () => true;

    // ── Seed accounts ────────────────────────────────────────────────────

    // Account with 12 months of on-time payments (LOW_RISK candidate)
    await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
      ...FIXTURES.accounts.active_domestic,
      ID: 'acc-seg-low-risk',
      accountNumber: 'SAINS-SEG-LOW',
      dunningLevel: 0,
      balanceOutstanding: 0,
      balanceDeposit: 200,
      isGovernment: false,
      isHardship: false,
      isWrittenOff: false,
    }));

    // Seed 12 months of on-time payments for LOW_RISK account
    const lowRiskPayments = [];
    const lowRiskInvoices = [];
    for (let m = 1; m <= 12; m++) {
      const month = String(m).padStart(2, '0');
      const invDate = `2025-${month}-15`;
      const dueDate = `2025-${month}-18`;
      const payDate = `2025-${month}-20`; // Pays 2 days after due date — prompt payer
      lowRiskInvoices.push({
        ID: `inv-seg-low-${m}`,
        account_ID: 'acc-seg-low-risk',
        invoiceNumber: `INV-SEG-LOW-${m}`,
        invoiceDate: invDate,
        dueDate: dueDate,
        billingPeriodFrom: `2025-${month}-01`,
        billingPeriodTo: `2025-${month}-18`,
        invoiceType: 'STANDARD',
        status: 'CLEARED',
        sourceSystem: 'SIBMA',
        totalAmount: 80.00,
        taxAmount: 0,
        amountCleared: 80.00,
        amountOutstanding: 0,
      });
      lowRiskPayments.push({
        ID: `pay-seg-low-${m}`,
        account_ID: 'acc-seg-low-risk',
        paymentReference: `PAY-SEG-LOW-${m}`,
        paymentDate: payDate,
        valueDate: payDate,
        channel: 'FPX',
        status: 'ALLOCATED',
        amount: 80.00,
        amountAllocated: 80.00,
        amountUnallocated: 0,
        receivedDateTime: `${payDate}T09:00:00Z`,
      });
    }
    await db.run(INSERT.into('sains.ar.Invoice').entries(lowRiskInvoices));
    await db.run(INSERT.into('sains.ar.Payment').entries(lowRiskPayments));

    // Account with dunning level 3 (HIGH_RISK candidate)
    await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
      ...FIXTURES.accounts.overdue_dunning3,
      ID: 'acc-seg-high-risk',
      accountNumber: 'SAINS-SEG-HIGH',
      dunningLevel: 3,
      balanceOutstanding: 1500,
      isGovernment: false,
      isHardship: false,
      isWrittenOff: false,
      isLegalAction: true,
    }));

    // Hardship account
    await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
      ...FIXTURES.accounts.hardship_account,
      ID: 'acc-seg-hardship',
      accountNumber: 'SAINS-SEG-HRD',
      isHardship: true,
      hardshipCriteriaCode: 'B40',
    }));

    // Government account
    await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
      ...FIXTURES.accounts.government_account,
      ID: 'acc-seg-govt',
      accountNumber: 'SAINS-SEG-GOV',
      isGovernment: true,
    }));

    // Account for early intervention: partial payment pattern
    await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
      ...FIXTURES.accounts.active_domestic,
      ID: 'acc-seg-partial',
      accountNumber: 'SAINS-SEG-PART',
      dunningLevel: 0,
      balanceOutstanding: 60,
      isGovernment: false,
      isHardship: false,
      isWrittenOff: false,
    }));

    // Seed invoices and partial payments for early intervention
    const partialInvoices = [];
    const partialPayments = [];
    for (let m = 1; m <= 3; m++) {
      const month = String(m).padStart(2, '0');
      partialInvoices.push({
        ID: `inv-seg-part-${m}`,
        account_ID: 'acc-seg-partial',
        invoiceNumber: `INV-SEG-PART-${m}`,
        invoiceDate: `2026-${month}-01`,
        dueDate: `2026-${month}-28`,
        billingPeriodFrom: `2026-${month}-01`,
        billingPeriodTo: `2026-${month}-28`,
        invoiceType: 'STANDARD',
        status: 'PARTIAL',
        sourceSystem: 'SIBMA',
        totalAmount: 100.00,
        taxAmount: 0,
        amountCleared: 40.00,
        amountOutstanding: 60.00,
      });
      partialPayments.push({
        ID: `pay-seg-part-${m}`,
        account_ID: 'acc-seg-partial',
        paymentReference: `PAY-SEG-PART-${m}`,
        paymentDate: `2026-${month}-15`,
        valueDate: `2026-${month}-15`,
        channel: 'COUNTER_CASH',
        status: 'ALLOCATED',
        amount: 40.00,
        amountAllocated: 40.00,
        amountUnallocated: 0,
        receivedDateTime: `2026-${month}-15T09:00:00Z`,
      });
    }
    await db.run(INSERT.into('sains.ar.Invoice').entries(partialInvoices));
    await db.run(INSERT.into('sains.ar.Payment').entries(partialPayments));

  }, 30000);

  // ── RULE-BASED SCORING ─────────────────────────────────────────────────────

  describe('Rule-based segmentation scoring', () => {
    test('account with 12 months of on-time payments = LOW_RISK', async () => {
      const { runSegmentationBatch } = require('../../srv/handlers/segmentation');
      await runSegmentationBatch(new Date('2026-03-15'));

      const segment = await db.run(
        SELECT.one.from('sains.ar.collections.CustomerSegment')
          .where({ account_ID: 'acc-seg-low-risk' })
      );
      expect(segment).not.toBeNull();
      expect(segment.segmentCode).toBe('LOW_RISK');
      expect(Number(segment.propensityScore)).toBeGreaterThanOrEqual(0.75);
    });

    test('account with dunning L3 = HIGH_RISK', async () => {
      const { runSegmentationBatch } = require('../../srv/handlers/segmentation');
      await runSegmentationBatch(new Date('2026-03-15'));

      const segment = await db.run(
        SELECT.one.from('sains.ar.collections.CustomerSegment')
          .where({ account_ID: 'acc-seg-high-risk' })
      );
      expect(segment).not.toBeNull();
      expect(segment.segmentCode).toBe('HIGH_RISK');
      expect(Number(segment.riskScore)).toBeGreaterThan(0.5);
      expect(segment.dunningPathCode).toBe('PATH_INTENSIVE');
    });
  });

  // ── HARDSHIP & GOVERNMENT ROUTING ──────────────────────────────────────────

  describe('Segment routing overrides', () => {
    test('hardship account routes to PATH_EMPATHY regardless of score', async () => {
      const { runSegmentationBatch } = require('../../srv/handlers/segmentation');
      await runSegmentationBatch(new Date('2026-03-15'));

      const segment = await db.run(
        SELECT.one.from('sains.ar.collections.CustomerSegment')
          .where({ account_ID: 'acc-seg-hardship' })
      );
      expect(segment).not.toBeNull();
      expect(segment.dunningPathCode).toBe('PATH_EMPATHY');
      expect(segment.vulnerabilityFlag).toBe(true);
    });

    test('government account routes to PATH_EXEMPT', async () => {
      const { runSegmentationBatch } = require('../../srv/handlers/segmentation');
      await runSegmentationBatch(new Date('2026-03-15'));

      const segment = await db.run(
        SELECT.one.from('sains.ar.collections.CustomerSegment')
          .where({ account_ID: 'acc-seg-govt' })
      );
      expect(segment).not.toBeNull();
      expect(segment.dunningPathCode).toBe('PATH_EXEMPT');
      expect(segment.segmentCode).toBe('GOVT_EXEMPT');
    });
  });

  // ── EARLY INTERVENTION ─────────────────────────────────────────────────────

  describe('Early intervention alerts', () => {
    test('partial payment pattern of 3 consecutive months creates alert', async () => {
      const { detectEarlyInterventionSignals } = require('../../srv/lib/intelligent-dunning-engine');

      const account = {
        ID: 'acc-seg-partial',
        accountNumber: 'SAINS-SEG-PART',
        dunningLevel: 0,
        eMandateCancelledRecently: false,
      };

      // Simulate 3 partial payments (amount < 95% of invoice total)
      const recentPayments = [
        { amount: 40, paymentDate: '2026-03-15', channel: 'COUNTER_CASH', status: 'ALLOCATED' },
        { amount: 40, paymentDate: '2026-02-15', channel: 'COUNTER_CASH', status: 'ALLOCATED' },
        { amount: 40, paymentDate: '2026-01-15', channel: 'COUNTER_CASH', status: 'ALLOCATED' },
      ];
      const recentInvoices = [
        { totalAmount: 100, dueDate: '2026-03-28', billingPeriodTo: '2026-03', status: 'PARTIAL' },
        { totalAmount: 100, dueDate: '2026-02-28', billingPeriodTo: '2026-02', status: 'PARTIAL' },
        { totalAmount: 100, dueDate: '2026-01-28', billingPeriodTo: '2026-01', status: 'PARTIAL' },
      ];

      const signals = detectEarlyInterventionSignals(account, recentPayments, recentInvoices);
      const partialAlert = signals.find(s => s.alertType === 'PARTIAL_PATTERN');

      expect(partialAlert).toBeDefined();
      expect(partialAlert.riskLevel).toBe('HIGH');
      expect(partialAlert.signalDescription).toContain('partial');
    });

    test('no duplicate OPEN alerts for same account + same type', async () => {
      // Seed an existing OPEN alert
      await db.run(INSERT.into('sains.ar.collections.EarlyInterventionAlert').entries({
        ID: 'alert-dup-check-001',
        account_ID: 'acc-seg-partial',
        alertDate: '2026-03-01',
        alertType: 'PARTIAL_PATTERN',
        signalDescription: 'Existing alert for partial pattern',
        riskLevel: 'HIGH',
        status: 'OPEN',
      }));

      const { runEarlyInterventionScan } = require('../../srv/handlers/segmentation');
      await runEarlyInterventionScan(new Date('2026-03-15'));

      // Count OPEN alerts for the PARTIAL_PATTERN type on this account
      const alerts = await db.run(
        SELECT.from('sains.ar.collections.EarlyInterventionAlert')
          .where({
            account_ID: 'acc-seg-partial',
            alertType: 'PARTIAL_PATTERN',
            status: 'OPEN',
          })
      );

      // Should have at most 1 open alert (no duplicates)
      expect(alerts.length).toBeLessThanOrEqual(1);
    });
  });
});
