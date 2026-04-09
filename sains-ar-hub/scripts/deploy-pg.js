#!/usr/bin/env node
'use strict';

/**
 * Deploy CDS schema to PostgreSQL.
 * Compiles the CDS model to PostgreSQL DDL and executes each statement.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/deploy-pg.js
 *   CDS_ENV=postgres-cloud node scripts/deploy-pg.js
 *
 * Flags:
 *   --seed-csv     After DDL, also load all CSVs in db/data/
 *   --drop         DROP existing tables first (DANGEROUS — requires SEED_CLEAN=true)
 */

require('./lib/ipv4-fix');

const path = require('path');
const fs = require('fs');
const { Client } = require('pg');

process.chdir(path.resolve(__dirname, '..'));
const cds = require('@sap/cds');

const FLAGS = {
  SEED_CSV: process.argv.includes('--seed-csv'),
  DROP:     process.argv.includes('--drop'),
};

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return url.replace(/:[^@/]*@/, ':****@');
  }
}

async function compileDdl() {
  const csn = await cds.load(['db', 'srv']);
  const ddl = cds.compile.to.sql(csn, { dialect: 'postgres' });
  // cds.compile.to.sql returns either a string or an array of statements
  const statements = Array.isArray(ddl)
    ? ddl
    : String(ddl).split(/;\s*\n/).map(s => s.trim()).filter(Boolean);
  return statements;
}

function isAlreadyExists(err) {
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('already exists') || err.code === '42P07' || err.code === '42710';
}

async function executeDdl(client, statements) {
  let created = 0, skipped = 0, failed = 0;
  for (const stmt of statements) {
    try {
      await client.query(stmt);
      created++;
    } catch (err) {
      if (isAlreadyExists(err)) {
        skipped++;
      } else {
        failed++;
        console.error(`  FAIL: ${err.message}`);
        console.error(`        ${stmt.substring(0, 120)}...`);
      }
    }
  }
  return { created, skipped, failed };
}

function parseCsvLine(line) {
  // Minimal CSV parser supporting quoted fields with embedded commas
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

async function loadCsvSeed(client) {
  const dataDir = path.resolve('db/data');
  if (!fs.existsSync(dataDir)) return { files: 0, rows: 0 };
  const csvs = fs.readdirSync(dataDir).filter(f => f.endsWith('.csv'));

  let totalRows = 0;
  for (const f of csvs) {
    // Filename: sains.ar.AccountType.csv  →  table sains_ar_AccountType
    //           sains.ar-Invoice.csv      →  table sains_ar_Invoice
    const baseName = f.replace(/\.csv$/, '');
    const tableName = baseName.replace(/[.\-]/g, '_').replace(/^sains_/, 'sains_');

    const content = fs.readFileSync(path.join(dataDir, f), 'utf8').trim();
    if (!content) continue;
    const lines = content.split(/\r?\n/);
    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map(parseCsvLine).filter(r => r.length > 1 || (r.length === 1 && r[0]));
    if (rows.length === 0) continue;

    const cols = headers.map(h => `"${h}"`).join(', ');
    let inserted = 0;
    for (const row of rows) {
      const placeholders = row.map((_, i) => `$${i + 1}`).join(', ');
      const values = row.map(v => v === '' ? null : v);
      try {
        await client.query(
          `INSERT INTO "${tableName}" (${cols}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
        inserted++;
      } catch (err) {
        // Skip rows that fail (FK violation, type mismatch, etc.) — log and continue
        console.error(`  CSV ${f} row skipped: ${err.message.substring(0, 100)}`);
      }
    }
    totalRows += inserted;
    console.log(`  Seeded ${inserted}/${rows.length} rows from ${f} → ${tableName}`);
  }

  return { files: csvs.length, rows: totalRows };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('ERROR: DATABASE_URL is not set');
    console.error('Set it via: export DATABASE_URL="postgresql://..."');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  SAINS AR Hub — PostgreSQL Schema Deploy');
  console.log('═══════════════════════════════════════════════');
  console.log(`  URL:       ${maskUrl(url)}`);
  console.log(`  --seed-csv: ${FLAGS.SEED_CSV}`);
  console.log(`  --drop:     ${FLAGS.DROP}`);
  console.log('───────────────────────────────────────────────');

  console.log('  Compiling CDS model to PostgreSQL DDL...');
  const statements = await compileDdl();
  console.log(`  Compiled ${statements.length} DDL statements`);

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    console.log('  Connected to PostgreSQL');

    if (FLAGS.DROP && process.env.SEED_CLEAN === 'true') {
      console.log('  Dropping all sains_* tables...');
      const tbls = await client.query(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'sains_%' ORDER BY tablename DESC"
      );
      for (const r of tbls.rows) {
        try { await client.query(`DROP TABLE IF EXISTS "${r.tablename}" CASCADE`); } catch { /* swallow */ }
      }
      console.log(`  Dropped ${tbls.rows.length} tables`);
    }

    console.log('  Executing DDL...');
    const ddlResult = await executeDdl(client, statements);
    console.log(`  DDL: ${ddlResult.created} created, ${ddlResult.skipped} skipped, ${ddlResult.failed} failed`);

    if (FLAGS.SEED_CSV) {
      console.log('  Loading CSV seed data from db/data/...');
      const csvResult = await loadCsvSeed(client);
      console.log(`  CSV: ${csvResult.files} files, ${csvResult.rows} rows inserted`);
    }
  } catch (err) {
    console.error(`  FATAL: ${err.message}`);
    process.exit(1);
  } finally {
    try { await client.end(); } catch { /* swallow */ }
  }

  console.log('───────────────────────────────────────────────');
  console.log('  Deploy complete ✅');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
