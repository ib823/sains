'use strict';

const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { Decimal } = require('decimal.js');
const { logSystemAction } = require('../lib/audit-logger');
const { PAYMENT_CHANNEL } = require('../lib/constants');

const logger = cds.log('jompay-adapter');

const JOMPAY_CONFIG = {
  BILLER_CODE: process.env.JOMPAY_BILLER_CODE
    || '/* TBC: SAINS JomPAY Biller Code registered with PayNet Malaysia */',
  ACQUIRER_SFTP_HOST:
    '/* TBC: Acquiring bank SFTP hostname */',
  ACQUIRER_SFTP_USER:
    '/* TBC: Acquiring bank SFTP username */',
  ACQUIRER_SFTP_KEY_REF:
    '/* TBC: BTP Credential Store key name for SFTP private key */',
  ACQUIRER_SFTP_PATH:
    '/* TBC: Path on bank SFTP server where reconciliation files are deposited */',
  FILE_FORMAT: 'CSV',   // CSV or FIXED_WIDTH — depends on acquiring bank
  ENCODING: 'UTF-8',
};

/**
 * Download today's JomPAY reconciliation file from acquiring bank SFTP.
 * File is deposited by the bank by 08:00 MYT covering T-1 transactions.
 *
 * @param {Date} fileDate  - Date of transactions (typically yesterday)
 * @returns {{ success, fileName, rawContent }}
 */
async function downloadReconciliationFile(fileDate) {
  const date = fileDate instanceof Date ? fileDate : new Date(fileDate);
  const dateStr = date.toISOString().substring(0, 10).replace(/-/g, '');

  // Resolve SFTP config: env vars take precedence, then PaymentChannelConfig DB row.
  const cfg = await _resolveSftpConfig();
  const remotePath = process.env.JOMPAY_SFTP_REMOTE_PATH || cfg.remotePath || '/inbound';
  const fileName = `SAINS_JOMPAY_${dateStr}.csv`;
  const remoteFile = `${remotePath.replace(/\/$/, '')}/${fileName}`;

  // ── Dev / mock mode ──────────────────────────────────────────────────────
  if (!cfg.host) {
    const localSample = path.resolve(process.cwd(), 'test/data', `jompay-sample-${dateStr}.csv`);
    if (fs.existsSync(localSample)) {
      logger.info(`JomPAY: SFTP not configured — using local sample ${localSample}`);
      const content = fs.readFileSync(localSample, 'utf8');
      const parsed = parseReconciliationFile(content);
      return { found: true, fileDate: date, fileName, source: 'local-sample', lines: parsed };
    }
    logger.warn('JomPAY SFTP not configured and no local sample file found — graceful no-op');
    return {
      found: false,
      fileDate: date,
      reason: 'JomPAY SFTP not configured and no local sample file found',
    };
  }

  // ── Production / staging SFTP path ───────────────────────────────────────
  const SFTPClient = require('ssh2-sftp-client');
  const sftp = new SFTPClient();

  try {
    let privateKey;
    try {
      privateKey = await _loadJomPaySSHKey();
    } catch (keyErr) {
      logger.error(`JomPAY SSH key load failed: ${keyErr.message}`);
      return { found: false, fileDate: date, reason: `SSH key load failed: ${keyErr.message}` };
    }

    logger.info(`JomPAY: connecting to SFTP ${cfg.host}:${cfg.port} as ${cfg.username}`);
    await sftp.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      privateKey,
    });

    const exists = await sftp.exists(remoteFile);
    if (!exists) {
      logger.warn(`JomPAY: file ${remoteFile} not found on SFTP server for ${dateStr}`);
      return { found: false, fileDate: date, fileName, reason: 'File not found on SFTP server' };
    }

    const buffer = await sftp.get(remoteFile);
    const content = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
    logger.info(`JomPAY: downloaded ${fileName} (${content.length} bytes)`);

    const parsed = parseReconciliationFile(content);
    return { found: true, fileDate: date, fileName, source: 'sftp', lines: parsed };
  } catch (err) {
    logger.error(`JomPAY SFTP download failed: ${err.message}`);
    return { found: false, fileDate: date, reason: `SFTP connection failed: ${err.message}` };
  } finally {
    try { await sftp.end(); } catch { /* swallow */ }
  }
}

/**
 * Resolve JomPAY SFTP connection config. Env vars first, then DB-backed
 * PaymentChannelConfig row (channelCode = 'JOMPAY'), else null host.
 */
async function _resolveSftpConfig() {
  const envHost = process.env.JOMPAY_SFTP_HOST;
  if (envHost) {
    return {
      host: envHost,
      port: Number(process.env.JOMPAY_SFTP_PORT || 22),
      username: process.env.JOMPAY_SFTP_USER || '',
      remotePath: process.env.JOMPAY_SFTP_REMOTE_PATH || '',
    };
  }
  try {
    const db = await cds.connect.to('db');
    const row = await db.run(
      SELECT.one.from('sains.ar.payment.PaymentChannelConfig').where({ channelCode: 'JOMPAY' })
    );
    if (row && row.apiEndpoint) {
      // apiEndpoint expected as host[:port]
      const [host, port] = String(row.apiEndpoint).split(':');
      return {
        host,
        port: Number(port || 22),
        username: row.username || '',
        remotePath: row.remotePath || '',
      };
    }
  } catch (err) {
    logger.warn(`PaymentChannelConfig lookup failed for JOMPAY: ${err.message}`);
  }
  return { host: null, port: 22, username: '', remotePath: '' };
}

async function _loadJomPaySSHKey() {
  const envKey = process.env.JOMPAY_SFTP_KEY;
  if (envKey) {
    return envKey.includes('-----BEGIN')
      ? envKey
      : Buffer.from(envKey, 'base64').toString('utf8');
  }
  // Allow reusing the bank-statement adapter's credstore loader for parity.
  if (process.env.VCAP_SERVICES && process.env.VCAP_SERVICES.includes('credstore')) {
    const { _loadBankSSHKey } = require('./bank-statement-adapter');
    return _loadBankSSHKey('JOMPAY_SFTP_KEY', 'JOMPAY');
  }
  throw new Error('JOMPAY_SFTP_KEY env var not set and no Credential Store binding available');
}

/**
 * Parse JomPAY CSV reconciliation file into structured line items.
 * JomPAY file format (standard PayNet specification):
 * Column 1: Date (YYYYMMDD)
 * Column 2: Time (HHMMSS)
 * Column 3: Bill Reference Number (customer account number)
 * Column 4: Payer Name
 * Column 5: Payer Bank FI Code
 * Column 6: Transaction Amount
 * Column 7: JomPAY Transaction Reference
 * Column 8: FPX Transaction ID
 *
 * @param {String} csvContent - Raw CSV file content
 * @returns {Array} Parsed line objects
 */
function parseReconciliationFile(csvContent) {
  const lines = csvContent.trim().split('\n');
  const parsed = [];
  let lineSeq = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    // Skip header row (starts with "DATE" or "#")
    if (line.startsWith('DATE') || line.startsWith('#') || line.startsWith('"DATE"')) {
      continue;
    }

    // Remove BOM if present
    const cleanLine = line.replace(/^\uFEFF/, '').trim();
    const cols = cleanLine.split(',').map(c => c.replace(/^"/, '').replace(/"$/, '').trim());

    if (cols.length < 6) {
      logger.warn(`JomPAY: skipping malformed line ${lineSeq + 1}: ${line.substring(0, 80)}`);
      continue;
    }

    lineSeq++;
    const rawDate = cols[0]; // YYYYMMDD
    const rawTime = cols[1]; // HHMMSS
    const billRef = cols[2];
    const payerName = cols[3];
    const payerBank = cols[4];
    const rawAmount = cols[5];
    const jomPayRef = cols[6] || '';
    const fpxToken = cols[7] || '';

    // Parse date
    const year = rawDate.substring(0, 4);
    const month = rawDate.substring(4, 6);
    const day = rawDate.substring(6, 8);
    const transactionDate = `${year}-${month}-${day}`;

    // Parse time
    const hh = rawTime.substring(0, 2);
    const mm = rawTime.substring(2, 4);
    const ss = rawTime.substring(4, 6);
    const transactionTime = `${hh}:${mm}:${ss}`;

    // Parse amount — remove commas, convert to Decimal
    const amount = new Decimal(rawAmount.replace(/,/g, '')).toNumber();

    if (isNaN(amount) || amount <= 0) {
      logger.warn(`JomPAY: skipping line ${lineSeq} — invalid amount: ${rawAmount}`);
      continue;
    }

    if (!billRef || billRef.length < 3) {
      logger.warn(`JomPAY: skipping line ${lineSeq} — missing bill reference`);
      continue;
    }

    parsed.push({
      lineSequence: lineSeq,
      transactionDate,
      transactionTime,
      billRefNo: billRef,
      payerName: payerName.substring(0, 100),
      payerBank: payerBank.substring(0, 10),
      amount,
      jomPayRef: jomPayRef.substring(0, 30),
      fpxMsgToken: fpxToken.substring(0, 50),
    });
  }

  logger.info(`JomPAY: parsed ${parsed.length} transactions from file`);
  return parsed;
}

/**
 * Process a JomPAY batch: match each line to a CustomerAccount and
 * create PaymentOrchestratorEvents for the payment orchestrator to handle.
 *
 * @param {String} batchID  - JomPAYBatch.ID
 * @param {Array}  lines    - Parsed line objects from parseReconciliationFile
 * @returns {{ matched, suspense, failed }}
 */
async function processBatch(batchID, lines) {
  const db = await cds.connect.to('db');
  let matched = 0, suspense = 0, failed = 0;

  for (const line of lines) {
    try {
      // Resolve account number to CustomerAccount.ID
      // JomPAY bill reference is configured as the SAINS account number
      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount')
          .columns('ID', 'accountStatus', 'balanceOutstanding')
          .where({
            or: [
              { accountNumber: line.billRefNo },
              { accountNumber: line.billRefNo.padStart(12, '0') }, // Zero-padded variant
            ]
          })
      );

      const eventID = cds.utils.uuid();
      const status = account ? 'RESOLVED' : 'SUSPENSE';

      await db.run(INSERT.into('sains.ar.payment.PaymentOrchestratorEvent').entries({
        ID: eventID,
        sourceChannel: PAYMENT_CHANNEL.JOMPAY,
        rawReference: line.jomPayRef || `JOMPAY-${batchID}-${line.lineSequence}`,
        payerReference: line.billRefNo,
        resolvedAccountID: account?.ID || null,
        amount: line.amount,
        currency: 'MYR',
        transactionDate: line.transactionDate,
        transactionTime: line.transactionTime,
        valueDate: line.transactionDate, // JomPAY settles same day
        batchID: batchID,
        status,
        sourceMetadata: JSON.stringify({
          billRefNo: line.billRefNo,
          payerName: line.payerName,
          payerBank: line.payerBank,
          jomPayRef: line.jomPayRef,
          fpxMsgToken: line.fpxMsgToken,
          lineSequence: line.lineSequence,
        }),
      }));

      // Update JomPAY line status
      await db.run(
        UPDATE('sains.ar.payment.JomPAYLine').set({
          status: account ? 'MATCHED' : 'SUSPENSE',
          resolvedAccountID: account?.ID || null,
          paymentEventID: eventID,
          rejectionReason: account ? null
            : `Account number ${line.billRefNo} not found in SAINS system`,
        }).where({ batch_ID: batchID, lineSequence: line.lineSequence })
      );

      if (account) matched++;
      else suspense++;

    } catch (err) {
      logger.error(`JomPAY batch ${batchID} line ${line.lineSequence} error: ${err.message}`);
      await db.run(
        UPDATE('sains.ar.payment.JomPAYLine').set({
          status: 'REJECTED',
          rejectionReason: err.message.substring(0, 255),
        }).where({ batch_ID: batchID, lineSequence: line.lineSequence })
      );
      failed++;
    }
  }

  logger.info(`JomPAY batch ${batchID}: matched=${matched} suspense=${suspense} failed=${failed}`);
  return { matched, suspense, failed };
}

module.exports = { downloadReconciliationFile, parseReconciliationFile, processBatch };
