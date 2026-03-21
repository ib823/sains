'use strict';

const cds = require('@sap/cds');
const mt940 = require('mt940-js');

const logger = cds.log('bank-statement-adapter');

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
    status: 'IMPORTED',
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
      status: unmatchedCount === 0 ? 'MATCHED' : 'MATCHING',
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
  // CAMT.053 is a stub — TBC: implement with xml2js library
  logger.warn('CAMT.053 parser is a stub — TBC: implement with xml2js library');

  return {
    lines: [],
    openingBalance: 0,
    closingBalance: 0,
    statementDate: new Date().toISOString().substring(0, 10),
    accountNumber: 'TBC',
  };
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
          status: { not: 'REVERSED' },
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

module.exports = { importBankStatement };
