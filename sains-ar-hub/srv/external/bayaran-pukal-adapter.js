'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const agencyFileParser = require('./agency-file-parser');

const logger = cds.log('bayaran-pukal-adapter');

const BP_AGENCY_PATTERNS = [
  { code: 'BP_AG',   regex: /^AG[_-]/i,   inlineId: 'AG'   },
  { code: 'BP_TNB',  regex: /^TNB[_-]/i,  inlineId: 'TNB'  },
  { code: 'BP_IWK',  regex: /^IWK[_-]/i,  inlineId: 'IWK'  },
  { code: 'BP_FAMA', regex: /^FAMA[_-]/i, inlineId: 'FAMA' },
];

const HIGH_VALUE_REVIEW_THRESHOLD = 50000;
const CROSS_BATCH_DUPLICATE_WINDOW_DAYS = 7;

/**
 * Detect which Bayaran Pukal agency a file belongs to.
 * Uses filename pattern first, then falls back to inspecting the first line.
 */
function _detectAgencyCode(fileName, fileContent) {
  const name = String(fileName || '');
  for (const pat of BP_AGENCY_PATTERNS) {
    if (pat.regex.test(name)) return pat.code;
  }
  const firstLine = String(fileContent || '').split('\n', 1)[0] || '';
  for (const pat of BP_AGENCY_PATTERNS) {
    if (firstLine.toUpperCase().includes(pat.inlineId)) return pat.code;
  }
  return null;
}

async function processBayaranPukalFile(fileContent, fileName, fileDate) {
  const agencyCode = _detectAgencyCode(fileName, fileContent);
  if (!agencyCode) {
    throw new Error(
      `Bayaran Pukal: cannot determine agency from fileName "${fileName}" or content header`
    );
  }

  logger.info(`Bayaran Pukal: detected agency ${agencyCode} for ${fileName}`);

  const parseResult = await agencyFileParser.parseAgencyFile(agencyCode, fileContent, fileName);

  // Bayaran Pukal-specific post-validation
  const db = await cds.connect.to('db');
  const lines = await db.run(
    SELECT.from('sains.ar.agency.AgencyFileLine')
      .where({ batch_ID: parseResult.batchID })
  );

  const totalAmount = lines
    .filter(l => l.status === 'PARSED' && typeof l.amount === 'number')
    .reduce((s, l) => s + Number(l.amount || 0), 0);

  // Duplicate detection within the batch
  const seen = new Map();
  const duplicates = [];
  for (const line of lines) {
    if (!line.paymentReference) continue;
    const key = line.paymentReference;
    if (seen.has(key)) {
      duplicates.push({ lineNumber: line.lineNumber, paymentReference: key });
    } else {
      seen.set(key, line.lineNumber);
    }
  }

  // Cross-check totalLines vs sum (parser already populates totalAmount on the batch row,
  // but we recompute here from the live data after any post-processing)
  const errors = parseResult.errors || [];

  return {
    batchID: parseResult.batchID,
    agencyCode,
    totalLines: parseResult.totalLines,
    totalAmount,
    parsedLines: parseResult.parsedLines,
    failedLines: parseResult.failedLines,
    duplicates,
    errors,
  };
}

async function validateBayaranPukalBatch(batchID) {
  const db = await cds.connect.to('db');

  const batch = await db.run(
    SELECT.one.from('sains.ar.agency.AgencyFileBatch').where({ ID: batchID })
  );
  if (!batch) {
    return { valid: false, warnings: [], errors: [`Batch ${batchID} not found`] };
  }

  const lines = await db.run(
    SELECT.from('sains.ar.agency.AgencyFileLine')
      .where({ batch_ID: batchID, status: { '!=': 'FAILED' } })
  );

  const warnings = [];
  const errors = [];

  // 1. High-value review flag
  for (const line of lines) {
    if (Number(line.amount || 0) > HIGH_VALUE_REVIEW_THRESHOLD) {
      warnings.push({
        type: 'HIGH_VALUE',
        lineNumber: line.lineNumber,
        amount: line.amount,
        accountReference: line.accountReference,
      });
    }
  }

  // 2. Cross-batch duplicate detection (same account+amount+date within 7 days)
  const cutoff = dayjs(batch.fileDate).subtract(CROSS_BATCH_DUPLICATE_WINDOW_DAYS, 'day').format('YYYY-MM-DD');
  for (const line of lines) {
    if (!line.accountReference || !line.amount || !line.paymentDate) continue;
    const prior = await db.run(
      SELECT.from('sains.ar.agency.AgencyFileLine')
        .where({
          accountReference: line.accountReference,
          amount: line.amount,
          paymentDate: { between: cutoff, and: batch.fileDate },
          ID: { '!=': line.ID },
        })
        .limit(1)
    );
    if (prior && prior.length > 0) {
      warnings.push({
        type: 'CROSS_BATCH_DUPLICATE',
        lineNumber: line.lineNumber,
        accountReference: line.accountReference,
        amount: line.amount,
        paymentDate: line.paymentDate,
      });
    }
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

module.exports = {
  processBayaranPukalFile,
  validateBayaranPukalBatch,
  _detectAgencyCode,
};
