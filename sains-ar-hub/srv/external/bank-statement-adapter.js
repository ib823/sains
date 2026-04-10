'use strict';

const cds = require('@sap/cds');
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const mt940 = require('mt940-js');

const logger = cds.log('bank-statement-adapter');

// Module-scope cache so we don't re-read keys / re-call Credential Store
// for every SFTP connection within the same process lifecycle.
const _sshKeyCache = new Map();

async function importBankStatement(fileBuffer, format, bankCode, uploadedBy) {
  const db = await cds.connect.to('db');
  let parsedLines = [];
  let openingBalance = 0;
  let closingBalance = 0;
  let statementDate = null;
  let accountNumber = 'XXXX';

  if (format === 'MT940') {
    const result = _parseMT940(fileBuffer.toString('utf8'));
    parsedLines = result.lines;
    openingBalance = result.openingBalance;
    closingBalance = result.closingBalance;
    statementDate = result.statementDate;
    accountNumber = result.accountNumber;
  } else if (format === 'CAMT053') {
    const result = _parseCAMT053(fileBuffer.toString('utf8'));
    parsedLines = result.lines;
    openingBalance = result.openingBalance;
    closingBalance = result.closingBalance;
    statementDate = result.statementDate;
    accountNumber = result.accountNumber;
  } else {
    throw new Error(`Unsupported bank statement format: ${format}`);
  }

  // Validate statement balance
  let statementStatus = 'IMPORTED';
  const calculatedClosing = openingBalance
    + parsedLines.filter(l => l.debitCreditCode === 'C').reduce((s, l) => s + Number(l.amount || 0), 0)
    - parsedLines.filter(l => l.debitCreditCode === 'D').reduce((s, l) => s + Number(l.amount || 0), 0);

  const diff = Math.abs(calculatedClosing - closingBalance);
  if (diff > 0.01) {
    logger.warn(`Bank statement ${bankCode}: balance mismatch! Opening ${openingBalance} + txns = ${calculatedClosing.toFixed(2)}, stated closing = ${closingBalance}`);
    statementStatus = 'UNBALANCED';
  }

  const statementID = cds.utils.uuid();
  const maskedAccount = accountNumber.length > 4
    ? 'XXXX' + accountNumber.substring(accountNumber.length - 4)
    : accountNumber;

  await db.run(INSERT.into('sains.ar.BankStatementImport').entries({
    ID: statementID,
    statementDate,
    bankCode,
    accountNumberMasked: maskedAccount,
    format,
    openingBalance,
    closingBalance,
    status: statementStatus,
    totalCredits: parsedLines.filter(l => l.debitCreditCode === 'C')
      .reduce((s, l) => s + l.amount, 0),
    totalDebits: parsedLines.filter(l => l.debitCreditCode === 'D')
      .reduce((s, l) => s + l.amount, 0),
  }));

  for (let i = 0; i < parsedLines.length; i++) {
    await db.run(INSERT.into('sains.ar.BankStatementLine').entries({
      statement_ID: statementID,
      lineSequence: i + 1,
      ...parsedLines[i],
      status: 'UNMATCHED',
    }));
  }

  const { matchedCount, unmatchedCount } = await _autoMatch(db, statementID, parsedLines);

  await db.run(
    UPDATE('sains.ar.BankStatementImport').set({
      matchedCount,
      unmatchedCount: parsedLines.length - matchedCount,
      status: statementStatus === 'UNBALANCED' ? 'UNBALANCED' : (unmatchedCount === 0 ? 'MATCHED' : 'MATCHING'),
    }).where({ ID: statementID })
  );

  logger.info(`Bank statement imported: ${statementDate} ${bankCode} — ${matchedCount}/${parsedLines.length} matched`);
  return { statementID, matchedCount, unmatchedCount: parsedLines.length - matchedCount };
}

function _parseMT940(content) {
  let statements;
  try {
    statements = mt940.parse(content);
  } catch (e) {
    throw new Error(`MT940 parse error: ${e.message}`);
  }

  if (!statements || statements.length === 0) throw new Error('No statements found in MT940 file');
  const stmt = statements[0];

  const lines = (stmt.transactions || []).map(tx => ({
    valueDate: tx.valueDate ? _parseMT940Date(tx.valueDate) : tx.bookingDate,
    bookingDate: tx.bookingDate ? _parseMT940Date(tx.bookingDate) : null,
    amount: Math.abs(Number(tx.amount?.amount || 0)),
    debitCreditCode: (tx.amount?.amount || 0) >= 0 ? 'C' : 'D',
    bankReference: tx.reference || tx.extraDetails || '',
    transactionCode: tx.transactionCode || '',
    description: tx.info || tx.additionalInfo || '',
  }));

  return {
    lines,
    openingBalance: Number(stmt.openingBalance?.amount?.amount || 0),
    closingBalance: Number(stmt.closingBalance?.amount?.amount || 0),
    statementDate: _parseMT940Date(stmt.statementDate || stmt.closingBalance?.date),
    accountNumber: stmt.accountIdentification || '',
  };
}

function _parseCAMT053(content) {
  let XMLParser;
  try {
    XMLParser = require('fast-xml-parser').XMLParser;
  } catch (err) {
    // Fail loudly — silent empty return causes zero reconciliation matches
    // with no alert, discovered only at month-end when balances don't match
    throw new Error(
      'fast-xml-parser is not installed. Run: npm install fast-xml-parser\n' +
      'CAMT.053 bank statement parsing requires this dependency.\n' +
      `Original error: ${err.message}`
    );
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['Ntry', 'TxDtls'].includes(name),
  });

  const doc = parser.parse(content);
  const stmt = doc?.Document?.BkToCstmrStmt?.Stmt;
  if (!stmt) throw new Error('CAMT.053: No Stmt element found in document');

  const accountNumber = stmt.Acct?.Id?.IBAN || stmt.Acct?.Id?.Othr?.Id || '';
  const entries = Array.isArray(stmt.Ntry) ? stmt.Ntry : (stmt.Ntry ? [stmt.Ntry] : []);

  const lines = [];
  for (const entry of entries) {
    try {
      const amount = Number(entry.Amt?.['#text'] || entry.Amt || 0);
      const isCredit = entry.CdtDbtInd === 'CRDT';
      const bookingDate = entry.BookgDt?.Dt || entry.BookgDt || '';
      const valueDate = entry.ValDt?.Dt || entry.ValDt || bookingDate;
      const bankRef = entry.NtryRef || entry.AcctSvcrRef || '';
      const entryStatus = entry.Sts || 'BOOK';

      if (entryStatus !== 'BOOK' && entryStatus !== 'PDNG') continue;
      if (amount <= 0) continue;

      // Extract remittance info
      let description = '';
      const txDetails = entry.NtryDtls?.TxDtls;
      if (txDetails) {
        const txArr = Array.isArray(txDetails) ? txDetails : [txDetails];
        const parts = txArr.map(tx => tx.RmtInf?.Ustrd || tx.RmtInf?.Strd?.CdtrRefInf?.Ref || '').filter(Boolean);
        description = parts.join(' | ').substring(0, 255);
      }

      lines.push({
        valueDate, bookingDate, amount: isCredit ? amount : -amount,
        debitCreditCode: isCredit ? 'C' : 'D', bankReference: bankRef,
        transactionCode: entry.BkTxCd?.Domn?.Cd || '', description,
        status: 'UNMATCHED',
      });
    } catch (err) {
      logger.warn(`CAMT.053: Error parsing entry: ${err.message}`);
    }
  }

  // Extract balances
  const balances = Array.isArray(stmt.Bal) ? stmt.Bal : (stmt.Bal ? [stmt.Bal] : []);
  let openingBalance = 0, closingBalance = 0;
  for (const bal of balances) {
    const amt = Number(bal.Amt?.['#text'] || bal.Amt || 0);
    const tp = bal.Tp?.CdOrPrtry?.Cd;
    if (tp === 'OPBD') openingBalance = amt;
    if (tp === 'CLBD') closingBalance = amt;
  }

  const statementDate = stmt.FrToDt?.ToDtTm?.substring(0, 10) || stmt.CreDtTm?.substring(0, 10) || new Date().toISOString().substring(0, 10);

  logger.info(`CAMT.053 parsed: ${lines.length} entries for account ${accountNumber}`);
  return { lines, openingBalance, closingBalance, statementDate, accountNumber };
}

async function _autoMatch(db, statementID, parsedLines) {
  let matchedCount = 0;

  for (let i = 0; i < parsedLines.length; i++) {
    const line = parsedLines[i];
    if (!line.bankReference || line.debitCreditCode !== 'C') continue;

    const payment = await db.run(
      SELECT.one.from('sains.ar.Payment')
        .columns('ID', 'amount', 'status')
        .where({
          bankReference: line.bankReference,
          status: { '!=': 'REVERSED' },
        })
    );

    if (payment && Math.abs(Number(payment.amount) - line.amount) < 0.01) {
      await db.run(
        UPDATE('sains.ar.BankStatementLine').set({
          status: 'MATCHED',
          matchedPaymentID: payment.ID,
          matchedAt: new Date().toISOString(),
          matchedBy: 'SYSTEM',
          matchConfidence: 'AUTO_HIGH',
        }).where({ statement_ID: statementID, lineSequence: i + 1 })
      );
      matchedCount++;
      continue;
    }

    if (payment) {
      await db.run(
        UPDATE('sains.ar.BankStatementLine').set({
          status: 'MATCHED',
          matchedPaymentID: payment.ID,
          matchedAt: new Date().toISOString(),
          matchedBy: 'SYSTEM',
          matchConfidence: 'AUTO_LOW',
        }).where({ statement_ID: statementID, lineSequence: i + 1 })
      );
      matchedCount++;
    }
  }

  return { matchedCount, unmatchedCount: parsedLines.length - matchedCount };
}

function _parseMT940Date(dateStr) {
  if (!dateStr) return null;
  if (dateStr.length === 6) {
    const yy = dateStr.substring(0, 2);
    const mm = dateStr.substring(2, 4);
    const dd = dateStr.substring(4, 6);
    const fullYear = parseInt(yy) > 50 ? `19${yy}` : `20${yy}`;
    return `${fullYear}-${mm}-${dd}`;
  }
  return dateStr;
}

/**
 * Download bank statements from all active bank SFTP configurations.
 * Called 3x daily (08:00, 12:00, 18:00 MYT).
 */
async function downloadBankStatements(targetDate) {
  const SFTPClient = require('ssh2-sftp-client');
  const db = await cds.connect.to('db');

  targetDate = targetDate || new Date().toISOString().substring(0, 10);
  const dateStr = targetDate.replace(/-/g, '');

  const bankConfigs = await db.run(
    SELECT.from('sains.ar.integration.BankSFTPConfig').where({ isActive: true })
  );

  if (bankConfigs.length === 0) {
    logger.warn('No active BankSFTPConfig records — configure banks in admin app');
    return { downloaded: 0, failed: 0, totalLines: 0 };
  }

  let downloaded = 0, failed = 0, totalLines = 0;

  for (const config of bankConfigs) {
    const sftp = new SFTPClient();
    try {
      const privateKey = await _loadBankSSHKey(config.sftpKeyRef, config.bankCode);

      logger.info(`Bank statement: connecting ${config.bankCode} @ ${config.sftpHost}:${config.sftpPort || 22}`);

      await sftp.connect({
        host: config.sftpHost,
        port: config.sftpPort || 22,
        username: config.sftpUsername,
        privateKey,
        readyTimeout: 20000,
        retries: 2,
      });

      const fileList = await sftp.list(config.sftpRemotePath || '/');
      const matchingFiles = fileList.filter(f => f.name.includes(dateStr));

      for (const file of matchingFiles) {
        const remotePath = `${config.sftpRemotePath}/${file.name}`.replace('//', '/');
        logger.info(`Bank statement: downloading ${remotePath} from ${config.bankCode}`);

        const buffer = await sftp.get(remotePath);
        const content = buffer.toString(config.fileFormat === 'CAMT053' ? 'utf8' : 'ascii');

        await importBankStatement(Buffer.from(content), config.fileFormat, config.bankCode, 'SYSTEM');
        downloaded++;
        totalLines++;
      }

      await db.run(UPDATE('sains.ar.integration.BankSFTPConfig').set({
        lastDownloadAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        consecutiveFailures: 0,
      }).where({ ID: config.ID }));

    } catch (err) {
      logger.error(`Bank statement SFTP failed for ${config.bankCode}: ${err.message}`);
      failed++;

      const newFailCount = (config.consecutiveFailures || 0) + 1;
      await db.run(UPDATE('sains.ar.integration.BankSFTPConfig').set({
        consecutiveFailures: newFailCount,
        lastDownloadAt: new Date().toISOString(),
      }).where({ ID: config.ID }));

      if (newFailCount >= 3) {
        const notif = require('./notification-service');
        await notif.sendSystemAlert({
          type: 'BANK_SFTP_FAILURE',
          subject: `Bank statement SFTP failure — ${config.bankCode} (${newFailCount} consecutive)`,
          body: `Failed to download from ${config.bankCode} for ${targetDate}: ${err.message}. Manual upload may be required.`,
          recipients: 'FinanceAdmin',
        }).catch(n => logger.error(`Alert send failed: ${n.message}`));
      }
    } finally {
      await sftp.end().catch(() => {});
    }
  }

  return { downloaded, failed, totalLines };
}

/**
 * Load bank SSH private key with two-tier resolution:
 *   1. BTP Credential Store (if VCAP_SERVICES.credstore is bound) — production
 *   2. BANK_SSH_KEY_<BANKCODE> environment variable — dev / staging
 *   3. ~/.ssh/sains_bank_<bankcode> file — local dev convenience
 *
 * The key value itself is never logged — only the source.
 * Loaded keys are cached per bankCode for the process lifetime.
 */
async function _loadBankSSHKey(keyRef, bankCode) {
  const code = String(bankCode || '').toUpperCase();
  if (!code) throw new Error('_loadBankSSHKey: bankCode is required');

  if (_sshKeyCache.has(code)) {
    return _sshKeyCache.get(code);
  }

  // Tier 1 — BTP Credential Store
  if (keyRef && !keyRef.startsWith('/*') && _hasCredstoreBinding()) {
    try {
      const cred = await _fetchCredstoreKey(keyRef);
      const key = cred.value || cred.privateKey || cred;
      _sshKeyCache.set(code, key);
      logger.info(`SSH key for bank ${code}: loaded from BTP Credential Store (key ref ${keyRef})`);
      return key;
    } catch (err) {
      logger.error(`Credential Store fetch failed for bank ${code} (key ${keyRef}): ${err.message}`);
      // Fall through to env / file fallbacks
    }
  }

  // Tier 2 — environment variable
  const envKey = process.env[`BANK_SSH_KEY_${code}`];
  if (envKey) {
    // Accept either raw PEM or base64-wrapped PEM
    const decoded = envKey.includes('-----BEGIN')
      ? envKey
      : Buffer.from(envKey, 'base64').toString('utf8');
    _sshKeyCache.set(code, decoded);
    logger.info(`SSH key for bank ${code}: loaded from BANK_SSH_KEY_${code} env var`);
    return decoded;
  }

  // Tier 3 — local dev convenience file
  const localPath = path.join(os.homedir(), '.ssh', `sains_bank_${code.toLowerCase()}`);
  if (fs.existsSync(localPath)) {
    const fileKey = fs.readFileSync(localPath, 'utf8');
    _sshKeyCache.set(code, fileKey);
    logger.info(`SSH key for bank ${code}: loaded from local file ${localPath}`);
    return fileKey;
  }

  throw new Error(
    `SSH key for bank ${code} not configured. ` +
    `Set BANK_SSH_KEY_${code} env var or configure BTP Credential Store.`
  );
}

function _hasCredstoreBinding() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    return Array.isArray(vcap.credstore) && vcap.credstore.length > 0;
  } catch {
    return false;
  }
}

async function _fetchCredstoreKey(keyName) {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const binding = vcap.credstore[0].credentials;
  const tokenResp = await axios.post(`${binding.url}/oauth/token`, 'grant_type=client_credentials', {
    auth: { username: binding.username, password: binding.password },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const resp = await axios.get(
    `${binding.url}/api/v1/credentials/sains-ar-hub/${keyName}`,
    { headers: { Authorization: `Bearer ${tokenResp.data.access_token}` } }
  );
  return resp.data;
}

module.exports = { importBankStatement, downloadBankStatements, _loadBankSSHKey };
