'use strict';

const cds = require('@sap/cds');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('staging-db-adapter');

// ── HELPERS ────────────────────────────────────────────────────────────────

async function _getActiveConfig() {
  const db = await cds.connect.to('db');
  return await db.run(
    SELECT.one.from('sains.ar.staging.StagingDBConfig').where({ isActive: true })
  );
}

function _isPlaceholder(v) {
  return !v || (typeof v === 'string' && v.startsWith('/*'));
}

function _isConfigured(cfg) {
  return cfg && cfg.isActive && !_isPlaceholder(cfg.dbHost) && !_isPlaceholder(cfg.dbName);
}

// ── 1. POLL STAGING DB ─────────────────────────────────────────────────────

async function pollStagingDB(sinceTimestamp) {
  const start = Date.now();
  const cfg = await _getActiveConfig();

  if (!_isConfigured(cfg)) {
    logger.info('Staging DB not configured or inactive — skipping poll');
    return { polled: false, reason: 'Staging DB not configured or inactive' };
  }

  // Only MSSQL fully implemented in Phase 1C; other engines stubbed.
  if (cfg.dbType !== 'MSSQL') {
    logger.warn(`Staging DB type ${cfg.dbType} not yet implemented`);
    return { polled: false, reason: `DB type ${cfg.dbType} not yet implemented` };
  }

  const db = await cds.connect.to('db');
  let recordCount = 0;

  try {
    const mssql = require('mssql');
    const pool = await mssql.connect({
      server: cfg.dbHost,
      port: cfg.dbPort || 1433,
      database: cfg.dbName,
      user: process.env.STAGING_DB_USER,
      password: process.env.STAGING_DB_PASSWORD,
      options: { encrypt: true, trustServerCertificate: true },
      requestTimeout: 60000,
    });

    const tableName = process.env.STAGING_DB_TABLE || 'staging_payments';
    const result = await pool.request()
      .input('since', mssql.DateTime, sinceTimestamp || new Date(0))
      .query(
        `SELECT * FROM [${tableName}]
         WHERE created_at > @since AND processed_flag = 0
         ORDER BY created_at ASC`
      );

    for (const row of result.recordset || []) {
      try {
        await db.run(INSERT.into('sains.ar.staging.StagingPaymentRecord').entries({
          ID: cds.utils.uuid(),
          stagingID: String(row.id || row.staging_id),
          channelCode: row.channel_code || 'UNKNOWN',
          accountReference: String(row.account_ref || row.bill_ref || ''),
          amount: Number(row.amount || 0),
          paymentDate: row.payment_date ? new Date(row.payment_date).toISOString().substring(0, 10) : null,
          paymentTime: row.payment_time || null,
          bankReference: row.bank_ref || null,
          payerName: row.payer_name || null,
          payerReference: row.payer_ref || null,
          rawData: JSON.stringify(row),
          processingStatus: 'RECEIVED',
        }));
        recordCount++;
      } catch (insErr) {
        // Likely a unique-constraint clash on stagingID — duplicate, safe to skip
        logger.debug(`Staging row ${row.id} skipped: ${insErr.message}`);
      }
    }

    await pool.close();

    await db.run(UPDATE('sains.ar.staging.StagingDBConfig').set({
      lastPollAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      lastPollRecordCount: recordCount,
      failCount: 0,
    }).where({ ID: cfg.ID }));

    logger.info(`Staging DB poll: ingested ${recordCount} records in ${Date.now() - start}ms`);
    return { polled: true, recordCount, sinceTimestamp, elapsed_ms: Date.now() - start };
  } catch (err) {
    logger.error(`Staging DB poll failed: ${err.message}`);
    await db.run(UPDATE('sains.ar.staging.StagingDBConfig').set({
      lastPollAt: new Date().toISOString(),
      failCount: { '+=': 1 },
    }).where({ ID: cfg.ID }));
    return { polled: false, reason: `Staging DB poll error: ${err.message}` };
  }
}

// ── 2. PROCESS STAGING RECORDS ─────────────────────────────────────────────

async function processStagingRecords() {
  const db = await cds.connect.to('db');

  const records = await db.run(
    SELECT.from('sains.ar.staging.StagingPaymentRecord')
      .where({ processingStatus: 'RECEIVED' })
      .orderBy('paymentDate')
      .limit(1000)
  );

  let processed = 0, resolved = 0, suspense = 0, failed = 0;

  for (const rec of records) {
    processed++;
    try {
      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount')
          .columns('ID', 'accountStatus')
          .where({ accountNumber: rec.accountReference })
      );

      if (account) {
        const eventID = cds.utils.uuid();
        await db.run(INSERT.into('sains.ar.payment.PaymentOrchestratorEvent').entries({
          ID: eventID,
          sourceChannel: `STAGING_${rec.channelCode}`,
          rawReference: rec.bankReference || rec.payerReference || `STAGING-${rec.stagingID}`,
          payerReference: rec.accountReference,
          resolvedAccountID: account.ID,
          amount: rec.amount,
          currency: 'MYR',
          transactionDate: rec.paymentDate,
          valueDate: rec.paymentDate,
          status: 'RESOLVED',
          sourceMetadata: rec.rawData,
        }));

        await db.run(UPDATE('sains.ar.staging.StagingPaymentRecord').set({
          processingStatus: 'RESOLVED',
          resolvedAccountID: account.ID,
          paymentEventID: eventID,
          processedAt: new Date().toISOString(),
        }).where({ ID: rec.ID }));

        resolved++;
      } else {
        // No matching account → SuspensePayment
        const suspenseID = cds.utils.uuid();
        await db.run(INSERT.into('sains.ar.SuspensePayment').entries({
          ID: suspenseID,
          sourceChannel: `STAGING_${rec.channelCode}`,
          rawReference: rec.accountReference,
          amount: rec.amount,
          receivedDate: rec.paymentDate,
          status: 'UNRESOLVED',
          notes: `Auto-routed from Staging DB; stagingID=${rec.stagingID}`,
        }));

        await db.run(UPDATE('sains.ar.staging.StagingPaymentRecord').set({
          processingStatus: 'SUSPENSE',
          processedAt: new Date().toISOString(),
        }).where({ ID: rec.ID }));

        suspense++;
      }
    } catch (err) {
      logger.error(`Staging record ${rec.stagingID} processing failed: ${err.message}`);
      await db.run(UPDATE('sains.ar.staging.StagingPaymentRecord').set({
        processingStatus: 'FAILED',
        processingError: err.message.substring(0, 500),
        processedAt: new Date().toISOString(),
      }).where({ ID: rec.ID }));
      failed++;
    }
  }

  logger.info(`Staging processing: processed=${processed} resolved=${resolved} suspense=${suspense} failed=${failed}`);
  try {
    await logSystemAction('STAGING_PROCESS_BATCH', 'StagingPaymentRecord', null,
      { processed, resolved, suspense, failed }, null);
  } catch { /* non-blocking */ }

  return { processed, resolved, suspense, failed };
}

// ── 3. HEALTH STATUS ───────────────────────────────────────────────────────

async function getStagingHealthStatus() {
  const db = await cds.connect.to('db');
  const cfg = await _getActiveConfig();

  const counts = await db.run(
    SELECT.from('sains.ar.staging.StagingPaymentRecord')
      .columns(['processingStatus', 'COUNT(*) as count'])
      .groupBy('processingStatus')
  );

  const byStatus = {};
  for (const row of counts) {
    byStatus[row.processingStatus] = Number(row.count || 0);
  }

  return {
    isActive: !!cfg?.isActive,
    configured: _isConfigured(cfg),
    dbType: cfg?.dbType || null,
    lastPollAt: cfg?.lastPollAt || null,
    lastSuccessAt: cfg?.lastSuccessAt || null,
    lastPollRecordCount: cfg?.lastPollRecordCount || 0,
    failCount: cfg?.failCount || 0,
    countsByStatus: byStatus,
  };
}

module.exports = { pollStagingDB, processStagingRecords, getStagingHealthStatus };
