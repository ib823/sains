#!/usr/bin/env node
'use strict';

/**
 * Quick smoke test — verifies all 12 services respond and basic CRUD works.
 * Usage: node scripts/smoke-test.js [base-url]
 * Default: http://localhost:4004
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE_URL = process.argv[2] || process.env.SMOKE_URL || 'http://localhost:4004';
const USER = process.env.SMOKE_USER || 'test-user';
const PASS = process.env.SMOKE_PASS || 'test';
const BASIC = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const CUSTOMER_BASIC = 'Basic ' + Buffer.from('customer-alice:customer-test-password').toString('base64');

function request(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { Authorization: BASIC, ...headers },
      timeout: 10000,
    };
    const start = Date.now();
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, ms: Date.now() - start }));
    });
    req.on('error', err => reject(err));
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const checks = [
  { name: 'Health',                 fn: () => request('GET',  `${BASE_URL}/health`) },
  { name: 'AR.CustomerAccounts',    fn: () => request('GET',  `${BASE_URL}/ar/CustomerAccounts?$top=1`) },
  { name: 'AR.Invoices',            fn: () => request('GET',  `${BASE_URL}/ar/Invoices?$top=1`) },
  { name: 'AR.Payments',            fn: () => request('GET',  `${BASE_URL}/ar/Payments?$top=1`) },
  { name: 'Sim.simulateAccount',    fn: () => request('POST', `${BASE_URL}/simulator/simulateAccountCreated`, { 'Content-Type': 'application/json' }, { accountNumber: `SMOKE-${Date.now()}`, legalName: 'Smoke Test' }) },
  { name: 'Sim.simulateInvoice',    fn: () => request('POST', `${BASE_URL}/simulator/simulateInvoiceGenerated`, { 'Content-Type': 'application/json' }, { accountNumber: '1000000001', amount: 100, billingMonth: '2026-04' }) },
  { name: 'Sim.simulateCounter',    fn: () => request('POST', `${BASE_URL}/simulator/simulateCounterPayment`, { 'Content-Type': 'application/json' }, { accountNumber: '1000000001', amount: 50, channel: 'COUNTER_CASH' }) },
  { name: 'Portal.MyAccount',       fn: () => request('GET',  `${BASE_URL}/portal/MyAccount`, { Authorization: CUSTOMER_BASIC }) },
  { name: 'SiBMA.getAccountBalance',fn: () => request('GET',  `${BASE_URL}/sibma/getAccountBalance(accountNumber='1000000001')`) },
  { name: 'Reporting.ARAging',      fn: () => request('GET',  `${BASE_URL}/reporting/getARAgingReport(asOfDate='2026-04-08')`) },
  { name: 'Analytics.KPI',          fn: () => request('GET',  `${BASE_URL}/analytics/ARKPISnapshots?$top=1`) },
  { name: 'Integration.iWRSEvents', fn: () => request('GET',  `${BASE_URL}/integration/iWRSEventLogs?$top=1`) },
];

(async () => {
  console.log('═══════════════════════════════════════════════');
  console.log(`  SAINS AR Hub — Smoke Test`);
  console.log(`  Target: ${BASE_URL}`);
  console.log('═══════════════════════════════════════════════');

  let passed = 0, failed = 0;
  for (const c of checks) {
    try {
      const r = await c.fn();
      const ok = r.status >= 200 && r.status < 400;
      if (ok) passed++; else failed++;
      console.log(`  ${ok ? 'PASS ✅' : 'FAIL ❌'}  ${c.name.padEnd(28)} — HTTP ${r.status} (${r.ms}ms)`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ❌  ${c.name.padEnd(28)} — ${err.message}`);
    }
  }

  console.log('───────────────────────────────────────────────');
  console.log(`  Result: ${passed} passed, ${failed} failed (of ${checks.length})`);
  process.exit(failed === 0 ? 0 : 1);
})();
