'use strict';
const { describe, test, expect } = require('@jest/globals');
const { evaluateDunning, getNoticeChannels, isPTPBroken } = require('../../srv/lib/dunning-engine');
const { FIXTURES } = require('../data/test-fixtures');
const { DUNNING_THRESHOLDS } = require('../../srv/lib/constants');

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().substring(0, 10);
}

describe('DunningEngine — Unit Tests', () => {

  describe('Exclusions (DUN-5.2)', () => {
    test('does not escalate government account regardless of overdue amount', () => {
      const inv = [{ ID: 'i', status: 'OPEN', dueDate: daysAgo(60), amountOutstanding: 5000 }];
      const result = evaluateDunning(FIXTURES.accounts.government_account, inv, new Date());
      expect(result.exclusionReason).toBe('GOVERNMENT_ACCOUNT');
      expect(result.shouldUpdate).toBe(false);
    });

    test('caps dunning at Level 2 for hardship account', () => {
      const inv = [{ ID: 'i', status: 'OPEN', dueDate: daysAgo(60), amountOutstanding: 300 }];
      const result = evaluateDunning(FIXTURES.accounts.hardship_account, inv, new Date());
      expect(result.proposedLevel).toBeLessThanOrEqual(2);
    });

    test('suspends all dunning for active payment plan account', () => {
      const account = { ...FIXTURES.accounts.active_domestic, isPaymentPlan: true, dunningLevel: 2 };
      const inv = [{ ID: 'i', status: 'OPEN', dueDate: daysAgo(45), amountOutstanding: 200 }];
      const result = evaluateDunning(account, inv, new Date());
      expect(result.exclusionReason).toBe('ACTIVE_PAYMENT_PLAN');
      expect(result.shouldUpdate).toBe(false);
    });

    test('suspends Level 3 and 4 escalation for disputed account', () => {
      const account = { ...FIXTURES.accounts.active_domestic, isDisputed: true, dunningLevel: 2 };
      const inv = [{ ID: 'i', status: 'OPEN', dueDate: daysAgo(46), amountOutstanding: 200 }];
      const result = evaluateDunning(account, inv, new Date());
      expect(result.proposedLevel).toBeLessThanOrEqual(2);
    });
  });

  describe('Threshold evaluation (DUN-5.1)', () => {
    const cases = [
      [DUNNING_THRESHOLDS.LEVEL_1, 1],
      [DUNNING_THRESHOLDS.LEVEL_2, 2],
      [DUNNING_THRESHOLDS.LEVEL_3, 3],
      [DUNNING_THRESHOLDS.LEVEL_4, 4],
    ];

    cases.forEach(([days, expectedLevel]) => {
      test(`proposes Level ${expectedLevel} when overdue by exactly ${days} days`, () => {
        const account = { ...FIXTURES.accounts.active_domestic, dunningLevel: 0 };
        const inv = [{ ID: 'i', status: 'OPEN', dueDate: daysAgo(days), amountOutstanding: 100 }];
        const result = evaluateDunning(account, inv, new Date());
        expect(result.proposedLevel).toBe(expectedLevel);
      });
    });

    test('uses oldest invoice due date when multiple invoices exist', () => {
      const account = { ...FIXTURES.accounts.active_domestic, dunningLevel: 0 };
      const invoices = [
        { ID: 'i1', status: 'OPEN', dueDate: daysAgo(10), amountOutstanding: 50 },
        { ID: 'i2', status: 'OPEN', dueDate: daysAgo(50), amountOutstanding: 100 }, // drives level 3
      ];
      const result = evaluateDunning(account, invoices, new Date());
      expect(result.proposedLevel).toBe(3);
    });

    test('resets to Level 0 when all invoices are cleared', () => {
      const account = { ...FIXTURES.accounts.active_domestic, dunningLevel: 3 };
      const result = evaluateDunning(account, [], new Date());
      expect(result.proposedLevel).toBe(0);
      expect(result.action).toBe('RESET');
    });

    test('does not escalate when payment is recent enough', () => {
      const account = { ...FIXTURES.accounts.active_domestic, dunningLevel: 0 };
      const inv = [{ ID: 'i', status: 'OPEN', dueDate: daysAgo(5), amountOutstanding: 100 }];
      const result = evaluateDunning(account, inv, new Date());
      expect(result.proposedLevel).toBe(0);
    });
  });

  describe('Notice channels (DUN-5.1)', () => {
    test('requires postal at Level 3', () => {
      const ch = getNoticeChannels(3, FIXTURES.accounts.active_domestic);
      expect(ch.postal).toBe(true);
    });

    test('requires postal at Level 4', () => {
      const ch = getNoticeChannels(4, FIXTURES.accounts.active_domestic);
      expect(ch.postal).toBe(true);
    });

    test('does NOT require postal at Level 1 or 2', () => {
      expect(getNoticeChannels(1, FIXTURES.accounts.active_domestic).postal).toBe(false);
      expect(getNoticeChannels(2, FIXTURES.accounts.active_domestic).postal).toBe(false);
    });

    test('always uses postal for paper-billing accounts regardless of level', () => {
      const account = { ...FIXTURES.accounts.active_domestic, paperBillingElected: true };
      const ch = getNoticeChannels(1, account);
      expect(ch.postal).toBe(true);
      expect(ch.email).toBe(false);
    });

    test('includes email channel when emailAddress is present', () => {
      const ch = getNoticeChannels(1, FIXTURES.accounts.active_domestic);
      expect(ch.email).toBe(true);
    });

    test('excludes email channel when emailAddress is absent', () => {
      const account = { ...FIXTURES.accounts.active_domestic, emailAddress: null };
      const ch = getNoticeChannels(1, account);
      expect(ch.email).toBe(false);
    });
  });

  describe('PTP breach detection (DUN-5.6)', () => {
    test('detects broken PTP when promised date has passed with no qualifying payment', () => {
      const ptp = { status: 'ACTIVE', promisedDate: daysAgo(2), promisedAmount: 100 };
      expect(isPTPBroken(ptp, [], new Date())).toBe(true);
    });

    test('does not detect breach when qualifying payment was received before promised date', () => {
      const ptp = { status: 'ACTIVE', promisedDate: daysAgo(1), promisedAmount: 100 };
      const payment = { paymentDate: daysAgo(2), amount: 100, status: 'ALLOCATED' };
      expect(isPTPBroken(ptp, [payment], new Date())).toBe(false);
    });

    test('does not evaluate inactive PTP', () => {
      const ptp = { status: 'HONOURED', promisedDate: daysAgo(2), promisedAmount: 100 };
      expect(isPTPBroken(ptp, [], new Date())).toBe(false);
    });

    test('detects breach when payment amount is less than promised amount', () => {
      const ptp = { status: 'ACTIVE', promisedDate: daysAgo(1), promisedAmount: 200 };
      const payment = { paymentDate: daysAgo(2), amount: 50, status: 'ALLOCATED' }; // too small
      expect(isPTPBroken(ptp, [payment], new Date())).toBe(true);
    });
  });
});
