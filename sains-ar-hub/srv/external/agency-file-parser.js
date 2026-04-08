'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(customParseFormat);

const logger = cds.log('agency-file-parser');

// ── PUBLIC ENTRY POINT ─────────────────────────────────────────────────────

async function parseAgencyFile(agencyCode, fileContent, fileName) {
  const db = await cds.connect.to('db');

  const config = await db.run(
    SELECT.one.from('sains.ar.agency.AgencyFileFormat')
      .where({ agencyCode, isActive: true })
  );
  if (!config) {
    throw new Error(`No file format configuration found for agency: ${agencyCode}`);
  }

  let parsed;
  if (config.fileType === 'FIXED_WIDTH') {
    parsed = _parseFixedWidthFile(config, fileContent);
  } else {
    parsed = _parseDelimitedFile(config, fileContent);
  }

  // Create batch
  const batchID = cds.utils.uuid();
  const totalAmount = parsed
    .filter(p => p.status !== 'FAILED' && typeof p.amount === 'number')
    .reduce((s, p) => s + Number(p.amount || 0), 0);
  const parsedLines = parsed.filter(p => p.status === 'PARSED').length;
  const failedLines = parsed.filter(p => p.status === 'FAILED').length;

  await db.run(INSERT.into('sains.ar.agency.AgencyFileBatch').entries({
    ID: batchID,
    agencyCode,
    fileName,
    fileDate: new Date().toISOString().substring(0, 10),
    uploadedBy: 'SYSTEM',
    uploadedAt: new Date().toISOString(),
    totalLines: parsed.length,
    totalAmount,
    parsedLines,
    failedLines,
    suspenseLines: 0,
    status: failedLines === parsed.length ? 'FAILED' : 'PARSED',
  }));

  // Insert lines
  const errors = [];
  for (const line of parsed) {
    await db.run(INSERT.into('sains.ar.agency.AgencyFileLine').entries({
      ID: cds.utils.uuid(),
      batch_ID: batchID,
      lineNumber: line.lineNumber,
      rawLine: line.rawLine ? line.rawLine.substring(0, 2000) : null,
      accountReference: line.accountReference || null,
      amount: line.amount || null,
      paymentDate: line.paymentDate || null,
      paymentReference: line.paymentReference || null,
      payerName: line.payerName || null,
      bankReference: line.bankReference || null,
      status: line.status,
      parseError: line.parseError || null,
    }));
    if (line.parseError) errors.push({ lineNumber: line.lineNumber, error: line.parseError });
  }

  logger.info(`parseAgencyFile(${agencyCode}, ${fileName}): total=${parsed.length} parsed=${parsedLines} failed=${failedLines}`);
  return { batchID, totalLines: parsed.length, parsedLines, failedLines, errors };
}

// ── DELIMITED PARSER ───────────────────────────────────────────────────────

function _parseDelimitedFile(config, content) {
  const delimiter = config.delimiter || ',';
  const totalRegex = config.totalLinePattern ? new RegExp(config.totalLinePattern) : null;

  let lines = String(content || '').replace(/\r\n/g, '\n').split('\n');

  // Trim trailing empty lines
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

  // skipRowsTop / skipRowsBottom
  const top = config.skipRowsTop || 0;
  const bottom = config.skipRowsBottom || 0;
  if (top > 0) lines = lines.slice(top);
  if (bottom > 0) lines = lines.slice(0, lines.length - bottom);

  // Header row → column-name → index map
  let headers = null;
  let dataStart = 0;
  if (config.hasHeaderRow && lines.length > 0) {
    headers = lines[0].split(delimiter).map(h => h.trim().replace(/^"|"$/g, ''));
    dataStart = 1;
  }

  const out = [];
  let lineNumber = 0;

  for (let i = dataStart; i < lines.length; i++) {
    const raw = lines[i];
    lineNumber++;

    if (raw.trim() === '') continue;
    if (totalRegex && totalRegex.test(raw)) continue;

    const cols = raw.split(delimiter).map(c => c.trim().replace(/^"|"$/g, ''));

    try {
      const accountReference = _extractField(cols, headers, config.accountRefColumn);
      const amountRaw        = _extractField(cols, headers, config.amountColumn);
      const dateRaw          = _extractField(cols, headers, config.paymentDateColumn);
      const paymentReference = _extractField(cols, headers, config.paymentRefColumn);
      const payerName        = _extractField(cols, headers, config.payerNameColumn);
      const bankReference    = _extractField(cols, headers, config.bankRefColumn);

      const amount = _parseAmount(amountRaw, config.amountFormat);
      const parsedDate = dateRaw ? dayjs(dateRaw, config.dateFormat || 'YYYY-MM-DD', true) : null;

      const missing = [];
      if (!accountReference) missing.push('accountReference');
      if (!Number.isFinite(amount)) missing.push('amount');
      if (!parsedDate || !parsedDate.isValid()) missing.push('paymentDate');

      if (missing.length > 0) {
        out.push({
          lineNumber, rawLine: raw,
          status: 'FAILED',
          parseError: `Missing/unparseable: ${missing.join(',')}`,
        });
        continue;
      }

      out.push({
        lineNumber, rawLine: raw,
        accountReference,
        amount,
        paymentDate: parsedDate.format('YYYY-MM-DD'),
        paymentReference: paymentReference || null,
        payerName: payerName || null,
        bankReference: bankReference || null,
        status: 'PARSED',
      });
    } catch (err) {
      out.push({
        lineNumber, rawLine: raw,
        status: 'FAILED',
        parseError: err.message.substring(0, 255),
      });
    }
  }

  return out;
}

// ── FIXED-WIDTH PARSER ─────────────────────────────────────────────────────

function _parseFixedWidthFile(config, content) {
  const totalRegex = config.totalLinePattern ? new RegExp(config.totalLinePattern) : null;

  let lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

  const top = config.skipRowsTop || 0;
  const bottom = config.skipRowsBottom || 0;
  if (top > 0) lines = lines.slice(top);
  if (bottom > 0) lines = lines.slice(0, lines.length - bottom);

  // hasHeaderRow on FW file means skip first data line
  const dataStart = config.hasHeaderRow ? 1 : 0;

  const sliceFW = (line, range) => {
    if (!range) return null;
    const [a, b] = String(range).split('-').map(Number);
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return line.substring(a, b + 1).trim();
  };

  const out = [];
  let lineNumber = 0;

  for (let i = dataStart; i < lines.length; i++) {
    const raw = lines[i];
    lineNumber++;

    if (raw.trim() === '') continue;
    if (totalRegex && totalRegex.test(raw)) continue;

    try {
      const accountReference = sliceFW(raw, config.accountRefColumn);
      const amountRaw        = sliceFW(raw, config.amountColumn);
      const dateRaw          = sliceFW(raw, config.paymentDateColumn);
      const paymentReference = sliceFW(raw, config.paymentRefColumn);
      const payerName        = sliceFW(raw, config.payerNameColumn);
      const bankReference    = sliceFW(raw, config.bankRefColumn);

      const amount = _parseAmount(amountRaw, config.amountFormat);
      const parsedDate = dateRaw ? dayjs(dateRaw, config.dateFormat || 'YYYY-MM-DD', true) : null;

      const missing = [];
      if (!accountReference) missing.push('accountReference');
      if (!Number.isFinite(amount)) missing.push('amount');
      if (!parsedDate || !parsedDate.isValid()) missing.push('paymentDate');

      if (missing.length > 0) {
        out.push({
          lineNumber, rawLine: raw,
          status: 'FAILED',
          parseError: `Missing/unparseable: ${missing.join(',')}`,
        });
        continue;
      }

      out.push({
        lineNumber, rawLine: raw,
        accountReference,
        amount,
        paymentDate: parsedDate.format('YYYY-MM-DD'),
        paymentReference: paymentReference || null,
        payerName: payerName || null,
        bankReference: bankReference || null,
        status: 'PARSED',
      });
    } catch (err) {
      out.push({
        lineNumber, rawLine: raw,
        status: 'FAILED',
        parseError: err.message.substring(0, 255),
      });
    }
  }

  return out;
}

// ── INTERNAL HELPERS ───────────────────────────────────────────────────────

function _extractField(cols, headers, columnSpec) {
  if (columnSpec === null || columnSpec === undefined || columnSpec === '') return null;
  // Try header lookup first
  if (headers) {
    const idx = headers.indexOf(columnSpec);
    if (idx >= 0) return cols[idx] !== undefined ? cols[idx] : null;
  }
  // Fallback: numeric position
  const pos = Number(columnSpec);
  if (!Number.isNaN(pos)) {
    return cols[pos] !== undefined ? cols[pos] : null;
  }
  return null;
}

function _parseAmount(value, format) {
  if (value === null || value === undefined || value === '') return NaN;
  const fmt = format || 'DECIMAL_DOT';
  const v = String(value);
  if (fmt === 'DECIMAL_COMMA') {
    const cleaned = v.replace(/[^0-9,-]/g, '').replace(',', '.');
    return parseFloat(cleaned);
  }
  if (fmt === 'CENTS') {
    const digits = v.replace(/[^0-9]/g, '');
    if (!digits) return NaN;
    return parseInt(digits, 10) / 100;
  }
  // DECIMAL_DOT (default)
  const cleaned = v.replace(/[^0-9.-]/g, '');
  return parseFloat(cleaned);
}

// ── RESOLVE BATCH ──────────────────────────────────────────────────────────

async function resolveAgencyBatch(batchID) {
  const db = await cds.connect.to('db');

  const lines = await db.run(
    SELECT.from('sains.ar.agency.AgencyFileLine')
      .where({ batch_ID: batchID, status: 'PARSED' })
  );

  let resolved = 0, suspense = 0, failed = 0;

  for (const line of lines) {
    try {
      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount')
          .columns('ID', 'accountStatus')
          .where({ accountNumber: line.accountReference })
      );

      if (account) {
        const eventID = cds.utils.uuid();
        await db.run(INSERT.into('sains.ar.payment.PaymentOrchestratorEvent').entries({
          ID: eventID,
          sourceChannel: 'AGENCY_FILE',
          rawReference: line.bankReference || line.paymentReference || `AGENCY-${batchID}-${line.lineNumber}`,
          payerReference: line.accountReference,
          resolvedAccountID: account.ID,
          amount: line.amount,
          currency: 'MYR',
          transactionDate: line.paymentDate,
          valueDate: line.paymentDate,
          status: 'RESOLVED',
        }));

        await db.run(UPDATE('sains.ar.agency.AgencyFileLine').set({
          status: 'RESOLVED',
          resolvedAccountID: account.ID,
          paymentEventID: eventID,
        }).where({ ID: line.ID }));

        resolved++;
      } else {
        await db.run(INSERT.into('sains.ar.SuspensePayment').entries({
          ID: cds.utils.uuid(),
          sourceChannel: 'AGENCY_FILE',
          rawReference: line.accountReference,
          amount: line.amount,
          receivedDate: line.paymentDate,
          status: 'UNRESOLVED',
          notes: `Agency file batch ${batchID}, line ${line.lineNumber}`,
        }));

        await db.run(UPDATE('sains.ar.agency.AgencyFileLine').set({
          status: 'SUSPENSE',
        }).where({ ID: line.ID }));

        suspense++;
      }
    } catch (err) {
      logger.error(`resolveAgencyBatch line ${line.lineNumber} failed: ${err.message}`);
      await db.run(UPDATE('sains.ar.agency.AgencyFileLine').set({
        status: 'FAILED',
        resolutionError: err.message.substring(0, 255),
      }).where({ ID: line.ID }));
      failed++;
    }
  }

  await db.run(UPDATE('sains.ar.agency.AgencyFileBatch').set({
    status: 'COMPLETED',
    suspenseLines: suspense,
  }).where({ ID: batchID }));

  return { resolved, suspense, failed };
}

module.exports = {
  parseAgencyFile,
  resolveAgencyBatch,
  _parseDelimitedFile,
  _parseFixedWidthFile,
  _parseAmount,
};
