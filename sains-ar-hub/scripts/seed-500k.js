#!/usr/bin/env node
'use strict';

/**
 * SAINS AR Hub — Bulk Data Seeder
 * Generates customer accounts with 12 months of invoices and payments.
 *
 * Usage:
 *   node scripts/seed-500k.js                                    # SQLite (dev)
 *   CDS_ENV=postgres node scripts/seed-500k.js                   # local PostgreSQL
 *   CDS_ENV=postgres-cloud DATABASE_URL=... node scripts/seed-500k.js  # cloud PG
 *
 * Options (env vars):
 *   SEED_ACCOUNTS=500000      Number of accounts to generate (default 500000)
 *   SEED_MONTHS=12            Months of invoice history (default 12)
 *   SEED_BATCH_SIZE=5000      Insert batch size (default 5000)
 *   SEED_SKIP_PAYMENTS=false  Skip payment generation
 *   SEED_SKIP_SUPPORT=false   Skip dunning/deposits/disputes/notes
 *   SEED_SEED=42              PRNG seed (default 42)
 *   SEED_CLEAN=false          Delete existing data first (requires confirmation)
 *   SEED_PROGRESS=true        Show progress lines
 */

require('./lib/ipv4-fix');

const path = require('path');
const fs = require('fs');
const readline = require('readline');

process.chdir(path.resolve(__dirname, '..'));
const cds = require('@sap/cds');

// ── DATABASE_URL OVERRIDE ─────────────────────────────────────────────────
// CAP does not natively substitute ${VAR} placeholders in .cdsrc.json strings.
// If DATABASE_URL is set, override cds.env.requires.db at runtime so the
// configured profile (postgres / postgres-cloud) actually connects there.
if (process.env.DATABASE_URL && (process.env.CDS_ENV || '').startsWith('postgres')) {
  cds.env.requires.db = {
    kind: 'postgres',
    impl: '@cap-js/postgres',
    credentials: {
      url: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    pool: { min: 2, max: 10, acquireTimeoutMillis: 30000 },
  };
}

const { createRNG } = require('./lib/seeded-rng');
const { generateName } = require('./lib/name-generator');
const { generateAddress } = require('./lib/address-generator');

// ── CONFIG ────────────────────────────────────────────────────────────────
const CFG = {
  ACCOUNTS:       parseInt(process.env.SEED_ACCOUNTS || '500000', 10),
  MONTHS:         parseInt(process.env.SEED_MONTHS || '12', 10),
  BATCH_SIZE:     parseInt(process.env.SEED_BATCH_SIZE || '5000', 10),
  SKIP_PAYMENTS:  process.env.SEED_SKIP_PAYMENTS === 'true',
  SKIP_SUPPORT:   process.env.SEED_SKIP_SUPPORT === 'true',
  SEED:           parseInt(process.env.SEED_SEED || '42', 10),
  CLEAN:          process.env.SEED_CLEAN === 'true',
  PROGRESS:       process.env.SEED_PROGRESS !== 'false',
};

// ── DISTRIBUTIONS ─────────────────────────────────────────────────────────
const ACCOUNT_TYPES = [
  { code: 'DOM',   weight: 0.85, balanceMean: 85,    balanceStd: 120,    balanceMax: 2500,    consumptionMin: 10,  consumptionMax: 35,  tariffBand: 'DOM_A' },
  { code: 'COM_S', weight: 0.05, balanceMean: 450,   balanceStd: 600,    balanceMax: 15000,   consumptionMin: 50,  consumptionMax: 200, tariffBand: 'COM_A' },
  { code: 'COM_L', weight: 0.03, balanceMean: 3500,  balanceStd: 5000,   balanceMax: 150000,  consumptionMin: 200, consumptionMax: 800, tariffBand: 'COM_B' },
  { code: 'IND',   weight: 0.03, balanceMean: 8000,  balanceStd: 12000,  balanceMax: 500000,  consumptionMin: 500, consumptionMax: 5000,tariffBand: 'IND_A' },
  { code: 'GOV',   weight: 0.025,balanceMean: 15000, balanceStd: 25000,  balanceMax: 1000000, consumptionMin: 300, consumptionMax: 3000,tariffBand: 'GOV_A' },
  { code: 'INST',  weight: 0.015,balanceMean: 2000,  balanceStd: 3000,   balanceMax: 50000,   consumptionMin: 100, consumptionMax: 600, tariffBand: 'INST_A' },
];

const ACCOUNT_STATUS = [
  { v: 'ACTIVE',            w: 0.88 },
  { v: 'RESTRICTED',        w: 0.04 },
  { v: 'TEMP_DISCONNECTED', w: 0.03 },
  { v: 'VOID',              w: 0.02 },
  { v: 'CLOSED',            w: 0.02 },
  { v: 'LEGAL',             w: 0.01 },
];

const DUNNING_LEVELS = [
  { v: 0, w: 0.68 },
  { v: 1, w: 0.15 },
  { v: 2, w: 0.09 },
  { v: 3, w: 0.05 },
  { v: 4, w: 0.03 },
];

const INVOICE_STATUSES = [
  { v: 'CLEARED',  w: 0.85 },
  { v: 'OPEN',     w: 0.10 },
  { v: 'PARTIAL',  w: 0.03 },
  { v: 'DISPUTED', w: 0.01 },
  { v: 'CANCELLED',w: 0.01 },
];

const PAYMENT_CHANNELS = [
  { v: 'COUNTER_CASH',     w: 0.30 },
  { v: 'COUNTER_CHEQUE',   w: 0.05 },
  { v: 'COUNTER_CARD',     w: 0.05 },
  { v: 'FPX',              w: 0.20 },
  { v: 'JOMPAY',           w: 0.15 },
  { v: 'DUITNOW_QR',       w: 0.08 },
  { v: 'AGENT_COLLECTION', w: 0.08 },
  { v: 'EMANDATE',         w: 0.05 },
  { v: 'BAYARAN_PUKAL',    w: 0.02 },
  { v: 'MANUAL_EFT',       w: 0.02 },
];

const EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com'];

// ── HELPERS ───────────────────────────────────────────────────────────────

function pickWeighted(rng, table) {
  return rng.weightedPick(table.map(t => t.v), table.map(t => t.w));
}

function fmtNum(n) {
  return n.toLocaleString('en-US');
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function clampGaussian(rng, mean, std, min, max) {
  const v = rng.gaussian(mean, std);
  return Math.max(min, Math.min(max, Math.round(v * 100) / 100));
}

function makeICNumber(rng) {
  const yy = rng.nextInt(50, 99) >= 50
    ? String(rng.nextInt(50, 99)).padStart(2, '0')
    : String(rng.nextInt(0, 5)).padStart(2, '0');
  const mm = String(rng.nextInt(1, 12)).padStart(2, '0');
  const dd = String(rng.nextInt(1, 28)).padStart(2, '0');
  const ss = '05'; // Negeri Sembilan
  const nnnn = String(rng.nextInt(0, 9999)).padStart(4, '0');
  return `${yy}${mm}${dd}-${ss}-${nnnn}`;
}

function makePhone(rng) {
  const prefixes = ['010', '011', '012', '013', '014', '016', '017', '018', '019'];
  const prefix = rng.pick(prefixes);
  const suffix = String(rng.nextInt(1000000, 99999999)).padStart(7, '0');
  return `+60${prefix.substring(1)}${suffix}`;
}

function makeEmail(rng, fullName) {
  const slug = fullName
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join('.');
  return `${slug}${rng.nextInt(1, 999)}@${rng.pick(EMAIL_DOMAINS)}`;
}

function maskIC(ic) {
  return ic ? `****${ic.substring(ic.length - 4)}` : null;
}

async function batchInsert(db, entity, rows, batchSize) {
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    await db.run(INSERT.into(entity).entries(chunk));
  }
}

// ── CLEAN MODE ────────────────────────────────────────────────────────────

async function confirmClean() {
  process.stdout.write('WARNING: This will delete all existing data. Type YES to confirm: ');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const answer = await new Promise(resolve => rl.once('line', resolve));
  rl.close();
  return String(answer).trim() === 'YES';
}

async function cleanDatabase(db) {
  const order = [
    'sains.ar.PaymentClearing',
    'sains.ar.Payment',
    'sains.ar.InvoiceLineItem',
    'sains.ar.Invoice',
    'sains.ar.AccountNote',
    'sains.ar.DunningHistory',
    'sains.ar.PaymentPlanInstalment',
    'sains.ar.PaymentPlan',
    'sains.ar.Dispute',
    'sains.ar.Adjustment',
    'sains.ar.DepositRecord',
    'sains.ar.PromiseToPay',
    'sains.ar.FraudAlert',
    'sains.ar.MeterReadHistory',
    'sains.ar.AccountChangeRequest',
    'sains.ar.CustomerAccount',
  ];
  for (const e of order) {
    try { await db.run(DELETE.from(e)); } catch (err) {
      console.warn(`  clean: ${e} skipped (${err.message})`);
    }
  }
}

// ── CODE LIST GUARD ───────────────────────────────────────────────────────

async function ensureCodeLists(db) {
  // Check if AccountType is populated; if not, the seed CSVs were never loaded.
  // Insert minimum required code list rows so FK constraints pass.
  const existing = await db.run(SELECT.from('sains.ar.AccountType').limit(1));
  if (existing && existing.length > 0) return;

  console.log('  [seed] Code lists empty — inserting minimum required rows');

  await db.run(INSERT.into('sains.ar.AccountType').entries([
    { code: 'DOM',   name: 'Domestic',         description: 'Residential domestic',  isActive: true },
    { code: 'COM_S', name: 'Commercial Small', description: 'Small commercial',      isActive: true },
    { code: 'COM_L', name: 'Commercial Large', description: 'Large commercial',      isActive: true },
    { code: 'IND',   name: 'Industrial',       description: 'Industrial process',    isActive: true },
    { code: 'GOV',   name: 'Government',       description: 'Government accounts',   isActive: true },
    { code: 'INST',  name: 'Institutional',    description: 'Schools and hospitals', isActive: true },
  ]));

  await db.run(INSERT.into('sains.ar.BillingBasis').entries([
    { code: 'MTR', name: 'Metered',  isActive: true },
    { code: 'EST', name: 'Estimate', isActive: true },
    { code: 'FLT', name: 'Flat',     isActive: true },
  ]));

  await db.run(INSERT.into('sains.ar.CollectionRiskCategory').entries([
    { code: 'STD',  name: 'Standard', description: 'Default risk' },
    { code: 'HIGH', name: 'High',     description: 'High collection risk' },
    { code: 'LOW',  name: 'Low',      description: 'Low collection risk' },
  ]));

  await db.run(INSERT.into('sains.ar.TariffBand').entries([
    { ID: 'tb-dom-a', code: 'DOM_A',  name: 'Domestic Band A',     accountTypeCode: 'DOM',   isActive: true },
    { ID: 'tb-com-a', code: 'COM_A',  name: 'Commercial Band A',   accountTypeCode: 'COM_S', isActive: true },
    { ID: 'tb-com-b', code: 'COM_B',  name: 'Commercial Band B',   accountTypeCode: 'COM_L', isActive: true },
    { ID: 'tb-ind-a', code: 'IND_A',  name: 'Industrial Band A',   accountTypeCode: 'IND',   isActive: true },
    { ID: 'tb-gov-a', code: 'GOV_A',  name: 'Government Band A',   accountTypeCode: 'GOV',   isActive: true },
    { ID: 'tb-inst-a',code: 'INST_A', name: 'Institutional Band A',accountTypeCode: 'INST',  isActive: true },
  ]));
}

async function loadTariffBandIDs(db) {
  const rows = await db.run(SELECT.from('sains.ar.TariffBand').columns('ID', 'code'));
  const map = {};
  for (const r of rows) map[r.code] = r.ID;
  return map;
}

// ── ACCOUNT GENERATOR ─────────────────────────────────────────────────────

function generateAccountRow(rng, idx, tariffBandIDs) {
  const acctType = rng.weightedPick(ACCOUNT_TYPES, ACCOUNT_TYPES.map(t => t.weight));
  const status = pickWeighted(rng, ACCOUNT_STATUS);
  const isActiveLike = ['ACTIVE', 'RESTRICTED', 'TEMP_DISCONNECTED'].includes(status);
  const dunning = isActiveLike ? pickWeighted(rng, DUNNING_LEVELS) : 0;

  const { fullName } = generateName(rng);
  const addr = generateAddress(rng);
  const ic = makeICNumber(rng);
  const phone = makePhone(rng);
  const email = makeEmail(rng, fullName);

  const accountNumber = String(1000000000 + idx + 1);
  const id = `acct-${String(idx + 1).padStart(9, '0')}`;

  let balance = 0;
  if (status === 'ACTIVE' && dunning > 0) {
    balance = clampGaussian(rng, acctType.balanceMean, acctType.balanceStd, 0, acctType.balanceMax);
  } else if (status === 'RESTRICTED' || status === 'TEMP_DISCONNECTED' || status === 'LEGAL') {
    balance = clampGaussian(rng, acctType.balanceMean * 3, acctType.balanceStd * 2, 50, acctType.balanceMax);
  }

  const deposit = acctType.code === 'DOM' ? 100
                : acctType.code === 'COM_S' ? 500
                : acctType.code === 'COM_L' ? 2000
                : acctType.code === 'IND' ? 5000
                : acctType.code === 'GOV' ? 10000
                : 1000;

  // Account open date: 1-15 years ago
  const yearsBack = rng.nextInt(1, 15);
  const openDate = new Date();
  openDate.setFullYear(openDate.getFullYear() - yearsBack);
  openDate.setMonth(rng.nextInt(0, 11));
  openDate.setDate(rng.nextInt(1, 28));

  return {
    ID: id,
    accountNumber,
    legalName: fullName,
    holderType: 'OWNER',
    accountType_code: acctType.code,
    accountStatus: status,
    branchCode: addr.branchCode,
    tariffBand_code: acctType.tariffBand,
    tariffBand_ID: tariffBandIDs[acctType.tariffBand] || null,
    billingBasis_code: 'MTR',
    riskCategory_code: dunning >= 3 ? 'HIGH' : (dunning >= 1 ? 'STD' : 'LOW'),
    meterReference: `MTR-${accountNumber}`,
    connectionSizeMM: acctType.code === 'DOM' ? 15 : (acctType.code === 'IND' ? 100 : 25),
    serviceAddress1: addr.address1,
    serviceAddress2: addr.address2,
    serviceCity: addr.city,
    serviceState: addr.state,
    servicePostcode: addr.postcode,
    primaryPhone: phone,
    emailAddress: email,
    balanceOutstanding: balance,
    balanceDeposit: deposit,
    balanceCreditOnAccount: 0,
    dunningLevel: dunning,
    dunningLevelDate: dunning > 0 ? new Date().toISOString().substring(0, 10) : null,
    lastPaymentDate: null,
    lastPaymentAmount: null,
    isHardship: false,
    isDisputed: false,
    isPaymentPlan: false,
    isWrittenOff: status === 'CLOSED' && rng.next() < 0.3,
    isLegalAction: status === 'LEGAL',
    isVoluntaryDisconnected: false,
    eBillingEnrolled: rng.next() < 0.6,
    portalRegistered: rng.next() < 0.4,
    accountOpenDate: openDate.toISOString().substring(0, 10),
    idNumberMasked: maskIC(ic),
    // Internal-only fields used by downstream generators
    _acctType: acctType,
    _status: status,
    _dunning: dunning,
  };
}

// ── INVOICE GENERATOR ─────────────────────────────────────────────────────

function generateInvoicesForAccount(rng, account, months) {
  const invoices = [];
  const now = new Date();

  for (let m = months - 1; m >= 0; m--) {
    const billingDate = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const dueDate = new Date(billingDate);
    dueDate.setDate(dueDate.getDate() + 30);

    const consumption = rng.nextInt(account._acctType.consumptionMin, account._acctType.consumptionMax);
    // Simple tariff: tiered for DOM, flat for others
    let amount;
    if (account._acctType.code === 'DOM') {
      const tier1 = Math.min(consumption, 20) * 0.57;
      const tier2 = Math.max(0, Math.min(consumption - 20, 15)) * 1.03;
      const tier3 = Math.max(0, consumption - 35) * 2.00;
      amount = tier1 + tier2 + tier3 + 6.0; // base charge
    } else if (account._acctType.code === 'COM_S' || account._acctType.code === 'COM_L') {
      amount = consumption * 2.07 + 30;
    } else if (account._acctType.code === 'IND') {
      amount = consumption * 2.28 + 100;
    } else if (account._acctType.code === 'GOV') {
      amount = consumption * 1.50 + 50;
    } else {
      amount = consumption * 1.20 + 20;
    }
    amount = Math.round(amount * 100) / 100;
    const taxAmount = Math.round(amount * 0.06 * 100) / 100;

    // Status: most recent month tends to be OPEN/PARTIAL; older ones CLEARED
    let status;
    if (m === 0) status = pickWeighted(rng, [
      { v: 'OPEN', w: 0.55 }, { v: 'CLEARED', w: 0.35 }, { v: 'PARTIAL', w: 0.08 }, { v: 'DISPUTED', w: 0.02 },
    ]);
    else status = pickWeighted(rng, INVOICE_STATUSES);

    const yyyymm = `${billingDate.getFullYear()}${String(billingDate.getMonth() + 1).padStart(2, '0')}`;
    const invID = `inv-${account.ID.substring(5)}-${yyyymm}`;
    const seq = String((parseInt(account.accountNumber, 10) % 1000000)).padStart(6, '0');

    const amountCleared = status === 'CLEARED' ? amount + taxAmount
                        : status === 'PARTIAL' ? Math.round((amount + taxAmount) * 0.4 * 100) / 100
                        : 0;
    const amountOutstanding = (amount + taxAmount) - amountCleared;

    invoices.push({
      ID: invID,
      invoiceNumber: `INV-${yyyymm}-${seq}`,
      account_ID: account.ID,
      invoiceDate: billingDate.toISOString().substring(0, 10),
      dueDate: dueDate.toISOString().substring(0, 10),
      billingPeriodFrom: billingDate.toISOString().substring(0, 10),
      billingPeriodTo: new Date(billingDate.getFullYear(), billingDate.getMonth() + 1, 0).toISOString().substring(0, 10),
      invoiceType: 'STANDARD',
      status,
      totalAmount: amount + taxAmount,
      taxAmount,
      taxRateApplied: 6.0,
      amountCleared,
      amountOutstanding,
      consumptionM3: consumption,
      meterReadType: 'ACTUAL',
      sourceSystem: 'SEEDER',
      einvoiceRequired: false,
      einvoiceStatus: 'NOT_REQUIRED',
    });
  }

  return invoices;
}

// ── PAYMENT GENERATOR ─────────────────────────────────────────────────────

function generatePaymentsForInvoices(rng, account, invoices) {
  const payments = [];
  for (const inv of invoices) {
    if (inv.status !== 'CLEARED' && inv.status !== 'PARTIAL') continue;
    const channel = pickWeighted(rng, PAYMENT_CHANNELS);
    const payAmount = inv.amountCleared;
    const dueDate = new Date(inv.dueDate);
    const offset = rng.nextInt(-5, 25); // some early, some late
    const payDate = new Date(dueDate);
    payDate.setDate(payDate.getDate() + offset);

    payments.push({
      ID: `pay-${inv.ID.substring(4)}`,
      account_ID: account.ID,
      paymentDate: payDate.toISOString().substring(0, 10),
      valueDate: payDate.toISOString().substring(0, 10),
      receivedDateTime: payDate.toISOString(),
      channel,
      status: 'ALLOCATED',
      amount: payAmount,
      amountAllocated: payAmount,
      amountUnallocated: 0,
      paymentReference: `PAY-${inv.invoiceNumber}`,
      bankReference: `BNK-${rng.nextInt(100000, 999999)}`,
      cashierID: channel.startsWith('COUNTER') ? `CSH-${rng.nextInt(1, 50)}` : null,
      counterCode: channel.startsWith('COUNTER') ? account.branchCode : null,
    });
  }
  return payments;
}

// ── SUPPORTING DATA GENERATOR ─────────────────────────────────────────────

function generateSupportingForAccount(rng, account) {
  const out = { dunning: [], deposits: [], plans: [], disputes: [], notes: [], fraud: [] };

  // Dunning history for accounts with dunning level > 0
  if (account._dunning > 0) {
    for (let lvl = 1; lvl <= account._dunning; lvl++) {
      const days = lvl * 15;
      const triggered = new Date();
      triggered.setDate(triggered.getDate() - (60 - lvl * 14));
      out.dunning.push({
        ID: `dun-${account.ID.substring(5)}-${lvl}`,
        account_ID: account.ID,
        dunningLevel: lvl,
        triggeredDate: triggered.toISOString().substring(0, 10),
        overdueDays: days,
        overdueAmount: account.balanceOutstanding,
        noticeType: lvl === 1 ? 'REMINDER' : lvl === 2 ? 'WARNING' : lvl === 3 ? 'FINAL' : 'DISCONNECTION',
        emailDelivered: rng.next() < 0.85,
        smsDelivered: rng.next() < 0.80,
      });
    }
  }

  // Deposits — 30% of accounts
  if (rng.next() < 0.30) {
    out.deposits.push({
      ID: `dep-${account.ID.substring(5)}`,
      account_ID: account.ID,
      depositType: 'STANDARD',
      amount: account.balanceDeposit,
      depositDate: account.accountOpenDate,
      status: 'HELD',
      receiptNumber: `DEP-${account.accountNumber}`,
    });
  }

  // Payment plans — 2% (only for accounts in arrears)
  if (account._dunning >= 2 && rng.next() < 0.20) {
    out.plans.push({
      ID: `plan-${account.ID.substring(5)}`,
      account_ID: account.ID,
      totalAmount: account.balanceOutstanding,
      monthlyAmount: Math.round((account.balanceOutstanding / 6) * 100) / 100,
      durationMonths: 6,
      startDate: new Date().toISOString().substring(0, 10),
      status: 'ACTIVE',
      outstandingAtStart: account.balanceOutstanding,
    });
  }

  // Disputes — 1%
  if (rng.next() < 0.01) {
    out.disputes.push({
      ID: `dsp-${account.ID.substring(5)}`,
      account_ID: account.ID,
      disputeType: 'BILLING',
      disputeAmount: account.balanceOutstanding > 0 ? account.balanceOutstanding : 100,
      status: rng.next() < 0.5 ? 'OPEN' : 'RESOLVED',
      raisedDate: new Date().toISOString().substring(0, 10),
      reason: 'Customer disputes meter reading',
    });
  }

  // Account notes — 10%
  if (rng.next() < 0.10) {
    out.notes.push({
      ID: `note-${account.ID.substring(5)}`,
      account_ID: account.ID,
      noteDate: new Date().toISOString().substring(0, 10),
      noteType: 'COLLECTION',
      noteText: 'System-generated note from bulk seeder',
      isInternal: true,
    });
  }

  // Fraud alerts — 0.1%
  if (rng.next() < 0.001) {
    out.fraud.push({
      ID: `frd-${account.ID.substring(5)}`,
      account_ID: account.ID,
      pattern: 'LARGE_ADJUSTMENT',
      severity: 'HIGH',
      detectedAt: new Date().toISOString(),
      status: 'OPEN',
      details: 'Anomaly detected by seeder',
    });
  }

  return out;
}

// ── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 25).join('\n'));
    process.exit(0);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  SAINS AR Hub — Bulk Data Seeder');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Profile:      ${process.env.CDS_ENV || 'development'}`);
  console.log(`  Accounts:     ${fmtNum(CFG.ACCOUNTS)}`);
  console.log(`  Months:       ${CFG.MONTHS}`);
  console.log(`  Batch size:   ${CFG.BATCH_SIZE}`);
  console.log(`  Skip payments:${CFG.SKIP_PAYMENTS}`);
  console.log(`  Skip support: ${CFG.SKIP_SUPPORT}`);
  console.log(`  Seed:         ${CFG.SEED}`);
  console.log('───────────────────────────────────────────────');

  const startMs = Date.now();
  const rng = createRNG(CFG.SEED);

  if (!process.env.CDS_ENV) process.env.CDS_ENV = 'development';
  const db = await cds.connect.to('db');
  // Auto-deploy schema for in-memory profiles so the seeder is self-sufficient.
  // Deploy to the *connected* db handle so we share the same SQLite instance.
  if (process.env.CDS_ENV === 'development') {
    const csn = await cds.load([path.resolve('db'), path.resolve('srv')]);
    await cds.deploy(csn).to(db);
  }

  if (CFG.CLEAN) {
    if (!await confirmClean()) {
      console.log('Clean cancelled.');
      process.exit(0);
    }
    console.log('Cleaning database...');
    await cleanDatabase(db);
  }

  await ensureCodeLists(db);
  const tariffBandIDs = await loadTariffBandIDs(db);

  // Counters
  let totalAccounts = 0, totalInvoices = 0, totalPayments = 0;
  let totalDunning = 0, totalDeposits = 0, totalPlans = 0;
  let totalDisputes = 0, totalNotes = 0, totalFraud = 0;

  // ── ACCOUNTS ────────────────────────────────────────────────────────────
  console.log(`\n[SEED] Generating ${fmtNum(CFG.ACCOUNTS)} accounts...`);
  for (let batchStart = 0; batchStart < CFG.ACCOUNTS; batchStart += CFG.BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + CFG.BATCH_SIZE, CFG.ACCOUNTS);
    const accounts = [];
    for (let i = batchStart; i < batchEnd; i++) {
      accounts.push(generateAccountRow(rng, i, tariffBandIDs));
    }

    // Strip internal-only fields before insert
    const cleaned = accounts.map(a => {
      const { _acctType, _status, _dunning, ...rest } = a;
      return rest;
    });
    await db.run(INSERT.into('sains.ar.CustomerAccount').entries(cleaned));
    totalAccounts += accounts.length;

    // Invoices for this batch
    const invoiceBuffer = [];
    const paymentBuffer = [];
    const dunningBuffer = [];
    const depositBuffer = [];
    const planBuffer = [];
    const disputeBuffer = [];
    const noteBuffer = [];
    const fraudBuffer = [];

    for (const acct of accounts) {
      // Skip invoices for VOID/CLOSED accounts
      if (acct._status !== 'VOID' && acct._status !== 'CLOSED') {
        const invs = generateInvoicesForAccount(rng, acct, CFG.MONTHS);
        invoiceBuffer.push(...invs);
        if (!CFG.SKIP_PAYMENTS) {
          const pays = generatePaymentsForInvoices(rng, acct, invs);
          paymentBuffer.push(...pays);
        }
      }
      if (!CFG.SKIP_SUPPORT) {
        const sup = generateSupportingForAccount(rng, acct);
        dunningBuffer.push(...sup.dunning);
        depositBuffer.push(...sup.deposits);
        planBuffer.push(...sup.plans);
        disputeBuffer.push(...sup.disputes);
        noteBuffer.push(...sup.notes);
        fraudBuffer.push(...sup.fraud);
      }
    }

    if (invoiceBuffer.length > 0) {
      await batchInsert(db, 'sains.ar.Invoice', invoiceBuffer, CFG.BATCH_SIZE);
      totalInvoices += invoiceBuffer.length;
    }
    if (paymentBuffer.length > 0) {
      await batchInsert(db, 'sains.ar.Payment', paymentBuffer, CFG.BATCH_SIZE);
      totalPayments += paymentBuffer.length;
    }
    if (dunningBuffer.length > 0) {
      await batchInsert(db, 'sains.ar.DunningHistory', dunningBuffer, CFG.BATCH_SIZE);
      totalDunning += dunningBuffer.length;
    }
    if (depositBuffer.length > 0) {
      await batchInsert(db, 'sains.ar.DepositRecord', depositBuffer, CFG.BATCH_SIZE);
      totalDeposits += depositBuffer.length;
    }
    if (planBuffer.length > 0) {
      try { await batchInsert(db, 'sains.ar.PaymentPlan', planBuffer, CFG.BATCH_SIZE); totalPlans += planBuffer.length; }
      catch { /* schema may differ — non-blocking */ }
    }
    if (disputeBuffer.length > 0) {
      try { await batchInsert(db, 'sains.ar.Dispute', disputeBuffer, CFG.BATCH_SIZE); totalDisputes += disputeBuffer.length; }
      catch { /* non-blocking */ }
    }
    if (noteBuffer.length > 0) {
      try { await batchInsert(db, 'sains.ar.AccountNote', noteBuffer, CFG.BATCH_SIZE); totalNotes += noteBuffer.length; }
      catch { /* non-blocking */ }
    }
    if (fraudBuffer.length > 0) {
      try { await batchInsert(db, 'sains.ar.FraudAlert', fraudBuffer, CFG.BATCH_SIZE); totalFraud += fraudBuffer.length; }
      catch { /* non-blocking */ }
    }

    if (CFG.PROGRESS && totalAccounts % 10000 === 0) {
      const elapsed = (Date.now() - startMs) / 1000;
      const rate = Math.round(totalAccounts / elapsed);
      const pct = ((totalAccounts / CFG.ACCOUNTS) * 100).toFixed(1);
      console.log(`  [SEED] Accounts: ${fmtNum(totalAccounts)} / ${fmtNum(CFG.ACCOUNTS)} (${pct}%) — ${elapsed.toFixed(1)}s elapsed — ${rate} accounts/sec`);
    }
  }

  const elapsed = Date.now() - startMs;
  const peakMem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);

  console.log('\n═══════════════════════════════════════════════');
  console.log('  SEED COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`  Accounts created:     ${fmtNum(totalAccounts)}`);
  console.log(`  Invoices created:     ${fmtNum(totalInvoices)}`);
  console.log(`  Payments created:     ${fmtNum(totalPayments)}`);
  console.log(`  Dunning records:      ${fmtNum(totalDunning)}`);
  console.log(`  Deposits:             ${fmtNum(totalDeposits)}`);
  console.log(`  Payment plans:        ${fmtNum(totalPlans)}`);
  console.log(`  Disputes:             ${fmtNum(totalDisputes)}`);
  console.log(`  Account notes:        ${fmtNum(totalNotes)}`);
  console.log(`  Fraud alerts:         ${fmtNum(totalFraud)}`);
  console.log('  ───────────────────────────────────────────');
  console.log(`  Total time:           ${fmtTime(elapsed)}`);
  console.log(`  Peak memory:          ${peakMem} MB`);
  console.log(`  Profile:              ${process.env.CDS_ENV}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Seed failed:', err);
  console.error(err.stack);
  process.exit(1);
});
