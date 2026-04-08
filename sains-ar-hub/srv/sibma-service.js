'use strict';

const cds = require('@sap/cds');

const logger = cds.log('sibma-service');

module.exports = cds.service.impl(async function () {

  this.on('getAccountBalance', async (req) => {
    const { accountNumber } = req.data;
    const db = await cds.connect.to('db');
    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns(
          'accountNumber', 'balanceOutstanding', 'balanceDeposit',
          'balanceCreditOnAccount', 'lastPaymentDate', 'lastPaymentAmount',
          'dunningLevel', 'accountStatus'
        )
        .where({ accountNumber })
    );
    if (!account) {
      return req.error(404, `Account ${accountNumber} not found`);
    }
    return account;
  });

  this.on('getTransactionHistory', async (req) => {
    const { accountNumber, fromDate, toDate } = req.data;
    const db = await cds.connect.to('db');

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ accountNumber })
    );
    if (!account) {
      return req.error(404, `Account ${accountNumber} not found`);
    }

    const [invoices, payments, adjustments] = await Promise.all([
      db.run(SELECT.from('sains.ar.Invoice')
        .where({ account_ID: account.ID, invoiceDate: { between: fromDate, and: toDate } })),
      db.run(SELECT.from('sains.ar.Payment')
        .where({ account_ID: account.ID, paymentDate: { between: fromDate, and: toDate } })),
      db.run(SELECT.from('sains.ar.Adjustment')
        .where({ account_ID: account.ID })),
    ]);

    const rows = [
      ...invoices.map(i => ({
        date: i.invoiceDate, type: 'INVOICE',
        reference: i.invoiceNumber,
        description: `Invoice ${i.invoiceType || ''}`.trim(),
        debitAmount: Number(i.totalAmount || 0),
        creditAmount: 0,
      })),
      ...payments.map(p => ({
        date: p.paymentDate, type: 'PAYMENT',
        reference: p.paymentReference || p.bankReference || '',
        description: `Payment via ${p.channel || ''}`.trim(),
        debitAmount: 0,
        creditAmount: Number(p.amount || 0),
      })),
      ...adjustments.map(a => ({
        date: a.createdAt && String(a.createdAt).substring(0, 10),
        type: 'ADJUSTMENT',
        reference: String(a.ID || ''),
        description: a.reason || a.adjustmentType || '',
        debitAmount: a.adjustmentType === 'DEBIT' ? Number(a.amount || 0) : 0,
        creditAmount: a.adjustmentType === 'CREDIT' ? Number(a.amount || 0) : 0,
      })),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    let runningBalance = 0;
    for (const r of rows) {
      runningBalance = runningBalance + Number(r.debitAmount || 0) - Number(r.creditAmount || 0);
      r.balance = runningBalance;
    }

    return rows;
  });

  this.on('getPaymentsByInvoice', async (req) => {
    const { invoiceNumber } = req.data;
    const db = await cds.connect.to('db');

    const invoice = await db.run(
      SELECT.one.from('sains.ar.Invoice').where({ invoiceNumber })
    );
    if (!invoice) {
      return [];
    }

    const clearings = await db.run(
      SELECT.from('sains.ar.PaymentClearing').where({ invoice_ID: invoice.ID })
    );

    const out = [];
    for (const c of clearings) {
      const payment = await db.run(
        SELECT.one.from('sains.ar.Payment').where({ ID: c.payment_ID })
      );
      if (payment) {
        out.push({
          paymentDate: payment.paymentDate,
          amount: Number(c.clearedAmount || 0),
          channel: payment.channel || '',
          reference: payment.paymentReference || payment.bankReference || '',
          status: payment.status || '',
        });
      }
    }
    return out;
  });

  this.on('getAccountStatement', async (req) => {
    const { accountNumber, asAtDate } = req.data;
    const db = await cds.connect.to('db');

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ accountNumber })
    );
    if (!account) {
      return req.error(404, `Account ${accountNumber} not found`);
    }

    // Statement covers a 12-month window ending at asAtDate
    const dayjs = require('dayjs');
    const toDate = asAtDate;
    const fromDate = dayjs(asAtDate).subtract(12, 'month').format('YYYY-MM-DD');

    const txReq = { data: { accountNumber, fromDate, toDate } };
    const transactions = await this.getTransactionHistory ? null : null;

    // Reuse the same query logic inline to avoid circular handler invocation
    const [invoices, payments] = await Promise.all([
      db.run(SELECT.from('sains.ar.Invoice')
        .where({ account_ID: account.ID, invoiceDate: { between: fromDate, and: toDate } })),
      db.run(SELECT.from('sains.ar.Payment')
        .where({ account_ID: account.ID, paymentDate: { between: fromDate, and: toDate } })),
    ]);

    const rows = [
      ...invoices.map(i => ({
        date: i.invoiceDate, type: 'INVOICE',
        reference: i.invoiceNumber, description: 'Invoice',
        debitAmount: Number(i.totalAmount || 0), creditAmount: 0,
      })),
      ...payments.map(p => ({
        date: p.paymentDate, type: 'PAYMENT',
        reference: p.paymentReference || '', description: `Payment via ${p.channel || ''}`,
        debitAmount: 0, creditAmount: Number(p.amount || 0),
      })),
    ].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    const openingBalance = 0;
    let running = openingBalance;
    for (const r of rows) {
      running = running + Number(r.debitAmount || 0) - Number(r.creditAmount || 0);
      r.balance = running;
    }

    return {
      accountNumber: account.accountNumber,
      legalName: account.legalName,
      statementDate: asAtDate,
      openingBalance,
      transactions: rows,
      closingBalance: running,
    };
  });
});
