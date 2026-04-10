'use strict';

const Decimal = require('decimal.js');
const { v4: uuidv4 } = require('uuid');
const dayjs = require('dayjs');
const { SAP_CORE, BRANCH_COST_CENTRE } = require('./constants');

/**
 * Resolve GL mapping for a transaction.
 * @param {Object} tx         - { transactionType, accountTypeCode, chargeTypeCode }
 * @param {Array}  glMappings - GLAccountMapping records
 */
function resolveGLMapping(tx, glMappings) {
  const tt = tx.transactionType;
  const at = tx.accountTypeCode || tx.accountType || 'ALL';
  const ct = tx.chargeTypeCode || tx.chargeType || 'ALL';

  // Try exact match
  let mapping = glMappings.find(m =>
    m.transactionType === tt && m.accountType === at && m.chargeType === ct && m.isActive !== false
  );
  if (mapping) return mapping;

  // Try with ALL wildcards
  mapping = glMappings.find(m =>
    m.transactionType === tt && m.accountType === 'ALL' && m.chargeType === ct && m.isActive !== false
  );
  if (mapping) return mapping;

  mapping = glMappings.find(m =>
    m.transactionType === tt && m.accountType === at && m.chargeType === 'ALL' && m.isActive !== false
  );
  if (mapping) return mapping;

  mapping = glMappings.find(m =>
    m.transactionType === tt && m.accountType === 'ALL' && m.chargeType === 'ALL' && m.isActive !== false
  );
  return mapping || null;
}

/**
 * Build a daily summary GL posting batch from aggregated transactions.
 * Signature: buildDailySummaryBatch(transactions, glMappings, batchDate, companyCode)
 *
 * Transactions are objects with: { transactionType, accountTypeCode, chargeTypeCode, amount, branchCode, ... }
 * Lines of same transactionType and GL accounts are aggregated into single debit+credit lines.
 */
function buildDailySummaryBatch(transactions, glMappings, batchDate, companyCode) {
  // Handle legacy signature: (date, invoices, payments, adjustments, deposits, mappings)
  if (typeof transactions === 'string' || transactions instanceof Date) {
    return _buildDailySummaryBatchLegacy(transactions, glMappings, batchDate, companyCode, arguments[4], arguments[5]);
  }

  const aggregated = {};

  for (const tx of transactions) {
    const mapping = resolveGLMapping(tx, glMappings);
    if (!mapping) {
      throw new Error(`No GL mapping found for transactionType=${tx.transactionType} accountType=${tx.accountTypeCode} chargeType=${tx.chargeTypeCode}`);
    }

    const key = `${tx.transactionType}_${mapping.debitGL}_${mapping.creditGL}`;
    if (!aggregated[key]) {
      aggregated[key] = { mapping, totalAmount: new Decimal(0), txType: tx.transactionType };
    }
    aggregated[key].totalAmount = aggregated[key].totalAmount.plus(new Decimal(tx.amount));
  }

  const lines = [];
  let totalDebit = new Decimal(0);
  let totalCredit = new Decimal(0);

  for (const [, entry] of Object.entries(aggregated)) {
    const amt = entry.totalAmount.toDP(2).toNumber();
    lines.push({
      glAccount: entry.mapping.debitGL,
      debitCreditCode: 'D',
      amount: amt,
      profitCentre: entry.mapping.profitCentre || '',
      costCentre: '',
      text: entry.txType,
      assignment: '',
    });
    lines.push({
      glAccount: entry.mapping.creditGL,
      debitCreditCode: 'C',
      amount: amt,
      profitCentre: entry.mapping.profitCentre || '',
      costCentre: '',
      text: entry.txType,
      assignment: '',
    });
    totalDebit = totalDebit.plus(entry.totalAmount);
    totalCredit = totalCredit.plus(entry.totalAmount);
  }

  return {
    batchDate: batchDate || dayjs().format('YYYY-MM-DD'),
    postingType: 'DAILY_SUMMARY',
    status: 'PREPARED',
    totalDebitAmount: totalDebit.toDP(2).toNumber(),
    totalCreditAmount: totalCredit.toDP(2).toNumber(),
    lineCount: lines.length,
    lines,
    sapCoreCompanyCode: companyCode || SAP_CORE.COMPANY_CODE,
    idempotencyKey: `DAILY_${batchDate || dayjs().format('YYYY-MM-DD')}`,
  };
}

// Legacy signature used by dunning handler
function _buildDailySummaryBatchLegacy(batchDate, invoices, payments, adjustments, deposits, glMappings) {
  const transactions = [];
  for (const inv of (invoices || [])) {
    transactions.push({ transactionType: 'INVOICE', accountTypeCode: 'ALL', chargeTypeCode: 'ALL', amount: inv.totalAmount, ID: inv.ID });
  }
  for (const pay of (payments || [])) {
    transactions.push({ transactionType: 'PAYMENT', accountTypeCode: 'ALL', chargeTypeCode: 'ALL', amount: pay.amount, ID: pay.ID });
  }
  for (const adj of (adjustments || [])) {
    const tt = adj.direction === 'CREDIT' ? 'ADJUSTMENT_CREDIT' : 'ADJUSTMENT_DEBIT';
    transactions.push({ transactionType: tt, accountTypeCode: 'ALL', chargeTypeCode: 'ALL', amount: adj.amount, ID: adj.ID });
  }
  for (const dep of (deposits || [])) {
    const tt = dep.refundAmount ? 'DEPOSIT_REFUND' : 'DEPOSIT';
    transactions.push({ transactionType: tt, accountTypeCode: 'ALL', chargeTypeCode: 'ALL', amount: dep.refundAmount || dep.amount, ID: dep.ID });
  }

  const result = buildDailySummaryBatch(transactions, glMappings, dayjs(batchDate).format('YYYY-MM-DD'));
  return { batch: { ID: uuidv4(), ...result }, lines: result.lines };
}

/**
 * Build a Journal Entry payload for SAP Core API posting.
 * Can be called as buildJournalEntryPayload(batch) where batch.lines contains the lines,
 * or as buildJournalEntryPayload(batch, lines).
 */
function buildJournalEntryPayload(batch, lines) {
  const batchLines = lines || batch.lines || [];
  const payload = {
    CompanyCode: batch.sapCoreCompanyCode || SAP_CORE.COMPANY_CODE,
    CompanyCodeCurrency: SAP_CORE.CURRENCY,
    DocumentDate: batch.batchDate,
    PostingDate: batch.batchDate,
    DocumentType: SAP_CORE.DOCUMENT_TYPE_AR,
    DocumentHeaderText: `SAINS AR ${batch.postingType} ${batch.batchDate}`,
    ReferencedDocument: batch.idempotencyKey || '',
    to_JournalEntryItem: {
      results: batchLines.map(line => ({
        GLAccount: line.glAccount,
        DebitCreditCode: line.debitCreditCode,
        AmountInTransactionCurrency: String(line.amount),
        TransactionCurrency: SAP_CORE.CURRENCY,
        ProfitCenter: line.profitCentre || '',
        CostCenter: line.costCentre || '',
        AssignmentReference: line.assignment || '',
        DocumentItemText: line.text || '',
      })),
    },
  };

  if (batch.postingType === 'PERIOD_ACCRUAL') {
    payload.IsReversalDocument = false;  // This is the original accrual, not the reversal
    // SAP will auto-reverse on the 1st of the following month
    const postDate = dayjs(batch.batchDate || batch.postingDate);
    payload.ReversalPostingDate = postDate.add(1, 'month').startOf('month').format('YYYY-MM-DD');
    payload.ReversalReason = '01'; // SAP standard reversal reason code for monthly accrual
  }

  return payload;
}

/**
 * Validate that total debits equal total credits in a batch.
 * Throws if the batch is unbalanced.
 * @param {Object} batch - batch with totalDebitAmount, totalCreditAmount
 * @param {Array}  lines - optional GL posting lines to cross-check
 */
function _validateBatchBalance(batch, lines) {
  const totalDebit = new Decimal(batch.totalDebitAmount || 0);
  const totalCredit = new Decimal(batch.totalCreditAmount || 0);

  if (!totalDebit.equals(totalCredit)) {
    throw new Error(
      `GL batch is unbalanced: debit=${totalDebit.toFixed(2)} credit=${totalCredit.toFixed(2)}`
    );
  }

  if (lines && lines.length > 0) {
    let lineDebit = new Decimal(0);
    let lineCredit = new Decimal(0);
    for (const line of lines) {
      if (line.debitCreditCode === 'D') {
        lineDebit = lineDebit.plus(new Decimal(line.amount));
      } else {
        lineCredit = lineCredit.plus(new Decimal(line.amount));
      }
    }
    if (!lineDebit.equals(lineCredit)) {
      throw new Error(
        `GL batch lines unbalanced: debit=${lineDebit.toFixed(2)} credit=${lineCredit.toFixed(2)}`
      );
    }
  }
}

module.exports = { buildDailySummaryBatch, buildJournalEntryPayload, resolveGLMapping, _validateBatchBalance };
