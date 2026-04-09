#!/usr/bin/env node
'use strict';

/**
 * Quick PostgreSQL connection test.
 * Verifies: env var set → CDS resolves URL → database reachable → tables exist.
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/test-pg-connection.js
 *   CDS_ENV=postgres-cloud DATABASE_URL=... node scripts/test-pg-connection.js
 */

require('./lib/ipv4-fix');
const { Client } = require('pg');

function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return url.replace(/:[^@/]*@/, ':****@');
  }
}

async function main() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error('═══════════════════════════════════════════════');
    console.error('  ERROR: DATABASE_URL is not set');
    console.error('═══════════════════════════════════════════════');
    console.error('');
    console.error('  Set the env var first, e.g.:');
    console.error('    export DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"');
    console.error('');
    console.error('  Or pass it inline:');
    console.error('    DATABASE_URL="postgresql://..." node scripts/test-pg-connection.js');
    console.error('');
    process.exit(1);
  }

  let host = '?', database = '?';
  try {
    const u = new URL(url);
    host = u.hostname + (u.port ? `:${u.port}` : '');
    database = (u.pathname || '/').replace(/^\//, '') || '?';
  } catch { /* leave defaults */ }

  console.log('═══════════════════════════════════════════════');
  console.log('  SAINS AR Hub — PostgreSQL Connection Test');
  console.log('═══════════════════════════════════════════════');
  console.log(`  URL:       ${maskUrl(url)}`);
  console.log(`  Host:      ${host}`);
  console.log(`  Database:  ${database}`);
  console.log('───────────────────────────────────────────────');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    statement_timeout: 15000,
  });

  let connected = false;
  let version = null;
  let tableCount = 0;
  let accountCount = null;
  let accountErr = null;

  try {
    await client.connect();
    connected = true;
    console.log('  ✅ Connected');

    const v = await client.query('SELECT version()');
    version = v.rows[0]?.version || '(unknown)';
    console.log(`  PG version: ${version.substring(0, 80)}`);

    const t = await client.query(
      "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public'"
    );
    tableCount = t.rows[0]?.c || 0;
    console.log(`  Tables in public schema: ${tableCount}`);

    try {
      const a = await client.query('SELECT count(*)::int AS c FROM "sains_ar_CustomerAccount"');
      accountCount = a.rows[0]?.c || 0;
      console.log(`  CustomerAccount rows: ${accountCount}`);
    } catch (err) {
      accountErr = err.message;
      console.log(`  CustomerAccount rows: (table missing or empty — ${err.message})`);
    }
  } catch (err) {
    console.error(`  ❌ Connection failed: ${err.message}`);
  } finally {
    try { await client.end(); } catch { /* swallow */ }
  }

  console.log('───────────────────────────────────────────────');
  console.log('  SUMMARY');
  console.log('───────────────────────────────────────────────');
  console.log(`  Status:        ${connected ? 'CONNECTED ✅' : 'FAILED ❌'}`);
  console.log(`  Tables:        ${tableCount}`);
  console.log(`  Accounts:      ${accountCount === null ? 'n/a' : accountCount}`);
  const ready = connected && tableCount > 0 && accountErr === null;
  console.log(`  Ready to seed: ${ready ? 'YES ✅' : 'NO ❌'}`);
  if (!connected) process.exit(1);
  if (tableCount === 0) {
    console.log('  Hint: schema not deployed — run `node scripts/deploy-pg.js` first');
  }
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
