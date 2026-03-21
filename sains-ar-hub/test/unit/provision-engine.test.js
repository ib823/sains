'use strict';
const { describe, test, expect } = require('@jest/globals');
const { calculateProvision, calculateProvisionMovement } = require('../../srv/lib/provision-engine');

function makeInvoice(daysOverdue, amount, accountType = 'DOM') {
  const d = new Date();
  d.setDate(d.getDate() - daysOverdue);
  return { ID: `inv-${Math.random()}`, status: 'OPEN',
           amountOutstanding: amount, dueDate: d.toISOString().substring(0, 10),
           accountTypeCode: accountType };
}

describe('ProvisionEngine — Unit Tests (BAD-7.1)', () => {

  test('applies zero rate for D0_30 DOM invoices', () => {
    const provisions = calculateProvision([makeInvoice(15, 1000)], {}, new Date(), 2026, 3);
    const d0_30 = provisions.find(p => p.agingBucket === 'D0_30');
    expect(d0_30?.provisionAmount || 0).toBe(0);
  });

  test('applies 2% for D31_60 DOM invoices', () => {
    const provisions = calculateProvision([makeInvoice(45, 10000)], {}, new Date(), 2026, 3);
    const bucket = provisions.find(p => p.agingBucket === 'D31_60');
    expect(bucket?.provisionAmount).toBeCloseTo(200, 1);
  });

  test('applies 100% for OVER_730 DOM invoices', () => {
    const provisions = calculateProvision([makeInvoice(800, 5000)], {}, new Date(), 2026, 3);
    const bucket = provisions.find(p => p.agingBucket === 'OVER_730');
    expect(bucket?.provisionAmount).toBeCloseTo(5000, 1);
  });

  test('applies zero rate for GOV invoices in D0_30 through D61_90', () => {
    const provisions = calculateProvision([makeInvoice(60, 5000, 'GOV')], {}, new Date(), 2026, 3);
    const bucket = provisions.find(p => p.accountType === 'GOV');
    expect(bucket?.provisionAmount || 0).toBe(0);
  });

  test('respects custom rate overrides', () => {
    const provisions = calculateProvision([makeInvoice(45, 10000)],
      { 'D31_60_DOM': 0.05 }, new Date(), 2026, 3);
    const bucket = provisions.find(p => p.agingBucket === 'D31_60');
    expect(bucket?.provisionAmount).toBeCloseTo(500, 1);
  });

  test('excludes REVERSED and CLEARED invoices', () => {
    const invoices = [
      { ...makeInvoice(45, 10000), status: 'REVERSED' },
      { ...makeInvoice(45, 10000), status: 'CLEARED' },
    ];
    const provisions = calculateProvision(invoices, {}, new Date(), 2026, 3);
    expect(provisions.length).toBe(0);
  });

  test('calculateProvisionMovement returns correct increase', () => {
    const prev = [{ provisionAmount: 10000 }];
    const curr = [{ provisionAmount: 12000 }];
    const mv = calculateProvisionMovement(prev, curr);
    expect(mv.netMovement).toBe(2000);
    expect(mv.direction).toBe('INCREASE');
  });

  test('calculateProvisionMovement returns correct decrease', () => {
    const prev = [{ provisionAmount: 10000 }];
    const curr = [{ provisionAmount: 8000 }];
    const mv = calculateProvisionMovement(prev, curr);
    expect(mv.netMovement).toBe(-2000);
    expect(mv.direction).toBe('DECREASE');
  });

  test('calculateProvisionMovement returns UNCHANGED when equal', () => {
    const prev = [{ provisionAmount: 5000 }];
    const curr = [{ provisionAmount: 5000 }];
    const mv = calculateProvisionMovement(prev, curr);
    expect(mv.direction).toBe('UNCHANGED');
  });
});
