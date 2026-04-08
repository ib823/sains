#!/usr/bin/env node
'use strict';

/**
 * SAINS AR Hub — Performance Load Test Suite
 *
 * Prerequisites:
 *   1. App running with 500K seeded data:
 *        CDS_ENV=postgres-cloud cds-serve
 *   2. Set env vars:
 *        PERF_TEST_URL=http://localhost:4004
 *        PERF_TEST_USER=test-user
 *        PERF_TEST_PASS=test
 *
 * Usage:
 *   node test/performance/load-scenarios.js [scenario]
 *
 * Scenarios:
 *   all                   Run every scenario
 *   account-lookup        #1
 *   invoice-list          #2
 *   payment-post          #3
 *   dunning-batch         #4
 *   batch-import          #5
 *   gl-posting            #6
 *   concurrent-counter    #7
 *   portal-api            #8
 *   report                #9
 */

const autocannon = require('autocannon');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const BASE_URL = process.env.PERF_TEST_URL || 'http://localhost:4004';
const USER = process.env.PERF_TEST_USER || 'test-user';
const PASS = process.env.PERF_TEST_PASS || 'test';
const BASIC = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const CUSTOMER_BASIC = 'Basic ' + Buffer.from('customer-alice:customer-test-password').toString('base64');

const SLA = {
  ACCOUNT_LOOKUP_P99: 300,
  INVOICE_LIST_P99:   500,
  PAYMENT_POST_P99:   1000,
  DUNNING_BATCH_HOURS:4,
  BATCH_IMPORT_MIN:   30,
  GL_POSTING_MIN:     5,
  PORTAL_P99:         200,
  REPORT_P99:         2000,
};

const results = [];

function pad(s, len) { s = String(s); return s + ' '.repeat(Math.max(0, len - s.length)); }

function recordResult(name, sla, p50, p95, p99, pass, extra) {
  results.push({ name, sla, p50, p95, p99, pass, extra });
}

function printScenarioHeader(num, name, slaText) {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log(`SCENARIO ${num}: ${name} — SLA: ${slaText}`);
  console.log('═══════════════════════════════════════════════');
}

function printScenarioFooter(result, slaMs) {
  const p50 = result.latency?.p50 ?? 0;
  const p95 = result.latency?.p95 ?? 0;
  const p99 = result.latency?.p99 ?? 0;
  const reqs = result.requests?.total ?? 0;
  const tps = result.requests?.average ?? 0;
  const errors = (result.errors || 0) + (result.timeouts || 0);
  const errPct = reqs > 0 ? ((errors / reqs) * 100).toFixed(2) : '0.00';
  const pass = p99 < slaMs;

  console.log(`Connections: ${result.connections} | Duration: ${result.duration}s`);
  console.log(`Requests completed: ${reqs.toLocaleString()}`);
  console.log(`Throughput: ${tps.toFixed(1)} req/s`);
  console.log(`Latency P50: ${p50}ms | P95: ${p95}ms | P99: ${p99}ms`);
  console.log(`Errors: ${errors} (${errPct}%)`);
  console.log(`SLA: ${pass ? 'PASS ✅' : 'FAIL ❌'} (P99 ${p99}ms ${pass ? '<' : '>='} ${slaMs}ms threshold)`);

  return { p50, p95, p99, pass };
}

// ── HTTP helper for non-autocannon scenarios ──────────────────────────────

function httpRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: { 'Authorization': BASIC, ...headers },
    };
    const req = lib.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── SCENARIO 1: Account Lookup by Number ──────────────────────────────────

async function scenarioAccountLookup() {
  printScenarioHeader(1, 'Account Lookup', `P99 < ${SLA.ACCOUNT_LOOKUP_P99}ms`);
  const result = await autocannon({
    url: `${BASE_URL}/ar/CustomerAccounts?$filter=accountNumber eq '1000000001'&$select=accountNumber,legalName,balanceOutstanding,dunningLevel`,
    connections: 50, duration: 60,
    headers: { Authorization: BASIC },
  });
  const m = printScenarioFooter(result, SLA.ACCOUNT_LOOKUP_P99);
  recordResult('Account Lookup', `${SLA.ACCOUNT_LOOKUP_P99}ms`, m.p50, m.p95, m.p99, m.pass);
}

// ── SCENARIO 2: Invoice List ──────────────────────────────────────────────

async function scenarioInvoiceList() {
  printScenarioHeader(2, 'Invoice List', `P99 < ${SLA.INVOICE_LIST_P99}ms`);
  const result = await autocannon({
    url: `${BASE_URL}/ar/Invoices?$orderby=invoiceDate desc&$top=24`,
    connections: 20, duration: 60,
    headers: { Authorization: BASIC },
  });
  const m = printScenarioFooter(result, SLA.INVOICE_LIST_P99);
  recordResult('Invoice List', `${SLA.INVOICE_LIST_P99}ms`, m.p50, m.p95, m.p99, m.pass);
}

// ── SCENARIO 3: Payment POST ──────────────────────────────────────────────

async function scenarioPaymentPost() {
  printScenarioHeader(3, 'Payment POST', `P99 < ${SLA.PAYMENT_POST_P99}ms`);
  const body = JSON.stringify({
    account_ID: 'acct-000000001',
    paymentReference: `PERF-${Date.now()}`,
    paymentDate: new Date().toISOString().substring(0, 10),
    channel: 'FPX',
    amount: 100.00,
  });
  const result = await autocannon({
    url: `${BASE_URL}/ar/Payments`,
    method: 'POST',
    connections: 50, duration: 60,
    headers: { Authorization: BASIC, 'Content-Type': 'application/json' },
    body,
  });
  const m = printScenarioFooter(result, SLA.PAYMENT_POST_P99);
  recordResult('Payment POST', `${SLA.PAYMENT_POST_P99}ms`, m.p50, m.p95, m.p99, m.pass);
}

// ── SCENARIO 4: Dunning Batch ─────────────────────────────────────────────

async function scenarioDunningBatch() {
  printScenarioHeader(4, 'Dunning Batch Trigger', `< ${SLA.DUNNING_BATCH_HOURS}h for 490K accounts`);
  const start = Date.now();
  const resp = await httpRequest('POST', `${BASE_URL}/ar/triggerDunningBatch`, {
    'Content-Type': 'application/json',
  }, { date: new Date().toISOString().substring(0, 10) });
  const elapsedMs = Date.now() - start;
  const elapsedMin = elapsedMs / 60000;
  const elapsedHours = elapsedMin / 60;

  let processed = 0;
  try { processed = JSON.parse(resp.body)?.processed || 0; } catch {}
  const per1k = processed > 0 ? (elapsedMs / (processed / 1000)).toFixed(0) : 'N/A';
  const pass = elapsedHours < SLA.DUNNING_BATCH_HOURS && resp.status >= 200 && resp.status < 300;

  console.log(`HTTP status: ${resp.status}`);
  console.log(`Total elapsed: ${elapsedMin.toFixed(1)} min (${elapsedHours.toFixed(2)} hours)`);
  console.log(`Accounts processed: ${processed.toLocaleString()}`);
  console.log(`Time per 1000 accounts: ${per1k}ms`);
  console.log(`SLA: ${pass ? 'PASS ✅' : 'FAIL ❌'} (${elapsedHours.toFixed(2)}h ${pass ? '<' : '>='} ${SLA.DUNNING_BATCH_HOURS}h)`);
  recordResult('Dunning Batch', `${SLA.DUNNING_BATCH_HOURS}h`, '-', '-', `${elapsedMin.toFixed(0)}min`, pass);
}

// ── SCENARIO 5: Batch Import (50K lines) ──────────────────────────────────

async function scenarioBatchImport() {
  printScenarioHeader(5, 'Batch Import (50K lines)', `< ${SLA.BATCH_IMPORT_MIN}m`);

  // Build a 50K-line CSV in memory matching CIMB AgencyFileFormat (header + positional)
  const lines = ['accountRef|amount|paymentDate|paymentRef|payerName|bankRef'];
  for (let i = 0; i < 50000; i++) {
    const acct = String(1000000000 + (i % 500000) + 1);
    const amt = (10 + (i % 500)).toFixed(2);
    const date = new Date().toISOString().substring(0, 10);
    lines.push(`${acct}|${amt}|${date}|REF${i}|PAYER${i}|BNK${i}`);
  }
  const csv = lines.join('\n');

  console.log(`Generated 50,000-line CSV (${(csv.length / 1024 / 1024).toFixed(2)} MB)`);

  const parseStart = Date.now();
  const resp = await httpRequest('POST', `${BASE_URL}/ar/AgencyFileBatches/uploadAgencyFile`, {
    'Content-Type': 'application/json',
  }, {
    agencyCode: 'CIMB',
    fileContent: csv,
    fileName: 'PERF_50K.csv',
    fileDate: new Date().toISOString().substring(0, 10),
  });
  const parseMs = Date.now() - parseStart;

  let batchID = null;
  try { batchID = JSON.parse(resp.body)?.batchID; } catch {}
  console.log(`Parse: ${(parseMs / 1000).toFixed(1)}s — HTTP ${resp.status} — batchID ${batchID || 'n/a'}`);

  let resolveMs = 0;
  if (batchID) {
    const resolveStart = Date.now();
    await httpRequest('POST', `${BASE_URL}/ar/AgencyFileBatches/resolveAgencyBatch`, {
      'Content-Type': 'application/json',
    }, { batchID });
    resolveMs = Date.now() - resolveStart;
    console.log(`Resolve: ${(resolveMs / 1000).toFixed(1)}s`);
  }

  const totalMin = (parseMs + resolveMs) / 60000;
  const pass = totalMin < SLA.BATCH_IMPORT_MIN;
  console.log(`Total: ${totalMin.toFixed(1)} min`);
  console.log(`SLA: ${pass ? 'PASS ✅' : 'FAIL ❌'} (${totalMin.toFixed(1)}m ${pass ? '<' : '>='} ${SLA.BATCH_IMPORT_MIN}m)`);
  recordResult('Batch Import 50K', `${SLA.BATCH_IMPORT_MIN}m`, '-', '-', `${totalMin.toFixed(0)}m`, pass);
}

// ── SCENARIO 6: GL Posting ────────────────────────────────────────────────

async function scenarioGlPosting() {
  printScenarioHeader(6, 'GL Posting Batch', `< ${SLA.GL_POSTING_MIN}m`);
  const start = Date.now();
  const resp = await httpRequest('POST', `${BASE_URL}/ar/triggerGLPosting`, {
    'Content-Type': 'application/json',
  }, { date: new Date().toISOString().substring(0, 10) });
  const elapsedMs = Date.now() - start;
  const elapsedMin = elapsedMs / 60000;
  const pass = elapsedMin < SLA.GL_POSTING_MIN && resp.status >= 200 && resp.status < 300;

  let processed = 0, transactions = 0;
  try {
    const data = JSON.parse(resp.body);
    processed = data?.processed || 0;
    transactions = data?.transactions || 0;
  } catch {}

  console.log(`HTTP status: ${resp.status}`);
  console.log(`Elapsed: ${elapsedMin.toFixed(1)} min`);
  console.log(`Batches processed: ${processed} | transactions: ${transactions}`);
  console.log(`SLA: ${pass ? 'PASS ✅' : 'FAIL ❌'} (${elapsedMin.toFixed(1)}m ${pass ? '<' : '>='} ${SLA.GL_POSTING_MIN}m)`);
  recordResult('GL Posting', `${SLA.GL_POSTING_MIN}m`, '-', '-', `${elapsedMin.toFixed(0)}m`, pass);
}

// ── SCENARIO 7: Concurrent Counter Simulation ─────────────────────────────

async function scenarioConcurrentCounter() {
  printScenarioHeader(7, 'Concurrent Counter Simulation', '50 users × 5 min mixed');

  // Use autocannon with a custom request stream selecting one of four operations
  const requests = [
    {
      method: 'GET',
      path: '/ar/CustomerAccounts?$top=1&$select=accountNumber,balanceOutstanding',
    },
    {
      method: 'POST',
      path: '/ar/Payments',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        account_ID: 'acct-000000001',
        paymentReference: `MIX-${Date.now()}`,
        paymentDate: new Date().toISOString().substring(0, 10),
        channel: 'COUNTER_CASH',
        amount: 50.00,
      }),
    },
    {
      method: 'GET',
      path: '/ar/Invoices?$top=10&$orderby=invoiceDate desc',
    },
    {
      method: 'GET',
      path: '/ar/Payments?$top=5&$orderby=paymentDate desc',
    },
  ];

  const result = await autocannon({
    url: BASE_URL,
    connections: 50,
    duration: 300,
    headers: { Authorization: BASIC },
    requests,
  });
  const reqs = result.requests?.total ?? 0;
  const tps = result.requests?.average ?? 0;
  const errors = (result.errors || 0) + (result.timeouts || 0);
  const errPct = reqs > 0 ? ((errors / reqs) * 100).toFixed(2) : '0.00';
  const pass = errPct < 1.0;
  console.log(`Total requests: ${reqs.toLocaleString()} | Throughput: ${tps.toFixed(1)} req/s`);
  console.log(`Errors: ${errors} (${errPct}%)`);
  console.log(`P50: ${result.latency?.p50}ms | P95: ${result.latency?.p95}ms | P99: ${result.latency?.p99}ms`);
  console.log(`Result: ${pass ? 'PASS ✅' : 'FAIL ❌'} (error rate < 1%)`);
  recordResult('Counter Mixed', '<1% err', result.latency?.p50, result.latency?.p95, result.latency?.p99, pass);
}

// ── SCENARIO 8: Customer Portal API ───────────────────────────────────────

async function scenarioPortalApi() {
  printScenarioHeader(8, 'Customer Portal API', `P99 < ${SLA.PORTAL_P99}ms`);
  const result = await autocannon({
    url: `${BASE_URL}/portal/MyAccount`,
    connections: 100,
    duration: 60,
    headers: { Authorization: CUSTOMER_BASIC },
  });
  const m = printScenarioFooter(result, SLA.PORTAL_P99);
  recordResult('Portal MyAccount', `${SLA.PORTAL_P99}ms`, m.p50, m.p95, m.p99, m.pass);
}

// ── SCENARIO 9: Reporting/Analytics ───────────────────────────────────────

async function scenarioReport() {
  printScenarioHeader(9, 'Reporting/Analytics', `P99 < ${SLA.REPORT_P99}ms`);
  const result = await autocannon({
    url: `${BASE_URL}/reporting/getARAgingReport(asOfDate='2026-04-08')`,
    connections: 5,
    duration: 30,
    headers: { Authorization: BASIC },
  });
  const m = printScenarioFooter(result, SLA.REPORT_P99);
  recordResult('Reporting', `${SLA.REPORT_P99}ms`, m.p50, m.p95, m.p99, m.pass);
}

// ── SUMMARY ───────────────────────────────────────────────────────────────

function printSummary() {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('LOAD TEST SUMMARY');
  console.log('═══════════════════════════════════════════════');
  console.log('┌─────────────────────┬────────┬───────┬───────┬───────┬────────┐');
  console.log('│ ' + pad('Scenario', 19) + ' │ ' + pad('SLA', 6) + ' │ ' + pad('P50', 5) + ' │ ' + pad('P95', 5) + ' │ ' + pad('P99', 5) + ' │ ' + pad('Result', 6) + ' │');
  console.log('├─────────────────────┼────────┼───────┼───────┼───────┼────────┤');
  let passed = 0;
  for (const r of results) {
    if (r.pass) passed++;
    console.log('│ ' + pad(r.name, 19) + ' │ ' + pad(r.sla, 6) + ' │ ' + pad(`${r.p50}ms`, 5) + ' │ ' + pad(`${r.p95}ms`, 5) + ' │ ' + pad(`${r.p99}ms`, 5) + ' │ ' + pad(r.pass ? 'PASS ✅' : 'FAIL ❌', 6) + ' │');
  }
  console.log('└─────────────────────┴────────┴───────┴───────┴───────┴────────┘');
  console.log(`Overall: ${passed}/${results.length} scenarios passed`);
  return passed === results.length;
}

// ── MAIN ──────────────────────────────────────────────────────────────────

const SCENARIOS = {
  'account-lookup':     scenarioAccountLookup,
  'invoice-list':       scenarioInvoiceList,
  'payment-post':       scenarioPaymentPost,
  'dunning-batch':      scenarioDunningBatch,
  'batch-import':       scenarioBatchImport,
  'gl-posting':         scenarioGlPosting,
  'concurrent-counter': scenarioConcurrentCounter,
  'portal-api':         scenarioPortalApi,
  'report':             scenarioReport,
};

async function main() {
  const which = process.argv[2] || 'all';
  console.log('═══════════════════════════════════════════════');
  console.log('  SAINS AR Hub — Performance Load Test Suite');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  User:   ${USER}`);
  console.log(`  Suite:  ${which}`);
  console.log('═══════════════════════════════════════════════');

  if (which === 'all') {
    for (const fn of Object.values(SCENARIOS)) {
      try { await fn(); } catch (err) { console.error(`Scenario error: ${err.message}`); }
    }
  } else if (SCENARIOS[which]) {
    await SCENARIOS[which]();
  } else {
    console.error(`Unknown scenario: ${which}`);
    console.error('Available:', Object.keys(SCENARIOS).join(', '), 'all');
    process.exit(1);
  }

  const allPassed = printSummary();
  process.exit(allPassed ? 0 : 1);
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}

module.exports = { SCENARIOS, SLA };
