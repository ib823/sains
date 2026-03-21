'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { logAction, createStateSnapshot } = require('../lib/audit-logger');
const { submitInvoice, cancelInvoice } = require('../external/einvoice-adapter');
const { sendEmail } = require('../external/notification-service');
const {
  INVOICE_STATUS, INVOICE_TYPE, SOURCE_SYSTEM,
  EINVOICE_CANCEL_WINDOW_HOURS,
} = require('../lib/constants');

module.exports = (srv) => {

  const { Invoices } = srv.entities;

  // ── BEFORE CREATE: sequence number, TIN check, reasonableness ─────────
  srv.before('CREATE', 'Invoices', async (req) => {
    const invoice = req.data;
    const db = await cds.connect.to('db');

    // Assign e-invoice sequence number (REGULATORY-1)
    if (invoice.einvoiceRequired) {
      const yearMonth = dayjs(invoice.invoiceDate).format('YYYY-MM');
      const counter = await db.run(
        SELECT.one.from('sains.ar.InvoiceSequenceCounter')
          .where({ yearMonth })
          .forUpdate()
      );
      if (!counter) {
        await db.run(INSERT.into('sains.ar.InvoiceSequenceCounter')
          .entries({ yearMonth, lastSequenceNumber: 1 }));
        invoice.einvoiceSequenceNo = 1;
      } else {
        const nextSeq = counter.lastSequenceNumber + 1;
        await db.run(UPDATE('sains.ar.InvoiceSequenceCounter')
          .set({ lastSequenceNumber: nextSeq }).where({ yearMonth }));
        invoice.einvoiceSequenceNo = nextSeq;
      }
    }

    // CRITICAL-12: Non-Consumer without verified TIN → hold
    if (invoice.einvoiceRequired) {
      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount')
          .columns('buyerTINVerified', 'accountType_code')
          .where({ ID: invoice.account_ID })
      );
      if (account && !account.buyerTINVerified && account.accountType_code !== 'DOM') {
        invoice.einvoiceStatus = 'HELD_NO_TIN';
        invoice.status = INVOICE_STATUS.HELD_NO_TIN;
      }
    }

    // Set cancel deadline
    if (invoice.einvoiceRequired && invoice.status !== INVOICE_STATUS.HELD_NO_TIN) {
      invoice.einvoiceCancelDeadline = dayjs(invoice.invoiceDate)
        .add(EINVOICE_CANCEL_WINDOW_HOURS, 'hour').toISOString();
    }

    // Set defaults
    if (!invoice.status) invoice.status = INVOICE_STATUS.OPEN;
    if (!invoice.amountCleared) invoice.amountCleared = 0;
    if (!invoice.amountOutstanding) invoice.amountOutstanding = invoice.totalAmount;
    if (!invoice.sourceSystem) invoice.sourceSystem = SOURCE_SYSTEM.BTP_INTERNAL;
  });

  // ── AFTER CREATE: balance update, meter history ───────────────────────
  srv.after('CREATE', 'Invoices', async (invoice, req) => {
    const db = await cds.connect.to('db');

    // Update account balance
    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ ID: invoice.account_ID })
    );
    if (account) {
      const newBalance = (account.balanceOutstanding || 0) + invoice.totalAmount;
      await db.run(
        UPDATE('sains.ar.CustomerAccount')
          .set({ balanceOutstanding: newBalance })
          .where({ ID: invoice.account_ID })
      );
    }

    // Insert meter read history if metered
    if (invoice.meterReadCurrent && invoice.consumptionM3) {
      await db.run(INSERT.into('sains.ar.MeterReadHistory').entries({
        ID: uuidv4(),
        account_ID: invoice.account_ID,
        readDate: invoice.invoiceDate,
        readType: invoice.meterReadType || 'ACTUAL',
        readingM3: invoice.meterReadCurrent,
        consumptionM3: invoice.consumptionM3,
        sourceSystem: invoice.sourceSystem,
        invoiceID: invoice.ID,
      }));
    }

    await logAction(req, 'CREATE_INVOICE', 'Invoice', invoice.ID, null, invoice, invoice.account_ID);
  });

  // ── BEFORE DELETE: block ──────────────────────────────────────────────
  srv.before('DELETE', 'Invoices', (req) => {
    return req.error(405, 'Invoices cannot be deleted. Use reverseInvoice instead.');
  });

  // ── REVERSE INVOICE ───────────────────────────────────────────────────
  srv.on('reverseInvoice', 'Invoices', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID }));
    if (!invoice) return req.error(404, 'Invoice not found');
    if (invoice.status === INVOICE_STATUS.REVERSED)
      return req.error(400, 'Invoice is already reversed');
    if (invoice.status === INVOICE_STATUS.CLEARED)
      return req.error(400, 'Cannot reverse a fully cleared invoice — reverse payments first');

    const beforeState = createStateSnapshot(invoice);

    await db.run(UPDATE('sains.ar.Invoice').set({
      status: INVOICE_STATUS.REVERSED,
    }).where({ ID }));

    // Restore account balance
    await db.run(
      UPDATE('sains.ar.CustomerAccount')
        .set({ balanceOutstanding: { '-=': invoice.amountOutstanding } })
        .where({ ID: invoice.account_ID })
    );

    await logAction(req, 'REVERSE_INVOICE', 'Invoice', ID, beforeState,
      { status: INVOICE_STATUS.REVERSED, reason }, invoice.account_ID);
    return true;
  });

  // ── SUBMIT TO EINVOICE ────────────────────────────────────────────────
  srv.on('submitToEInvoice', 'Invoices', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const invoice = await db.run(
      SELECT.one.from('sains.ar.Invoice').where({ ID })
    );
    if (!invoice) return req.error(404, 'Invoice not found');
    if (!invoice.einvoiceRequired) return req.error(400, 'eInvoice not required for this invoice');

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ ID: invoice.account_ID })
    );

    const result = await submitInvoice(invoice, account);
    if (!result) return req.error(400, 'eInvoice submission skipped');

    if (result.success) {
      await db.run(UPDATE('sains.ar.Invoice').set({
        einvoiceStatus: 'ACCEPTED',
        einvoiceUUID: result.uuid,
        einvoiceSubmittedAt: new Date().toISOString(),
      }).where({ ID }));
      return result.uuid;
    } else {
      await db.run(UPDATE('sains.ar.Invoice').set({
        einvoiceStatus: 'REJECTED',
      }).where({ ID }));
      return req.error(400, `eInvoice rejected: ${result.errorMessage}`);
    }
  });

  // ── CANCEL EINVOICE ───────────────────────────────────────────────────
  srv.on('cancelEInvoice', 'Invoices', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID }));
    if (!invoice) return req.error(404, 'Invoice not found');

    const result = await cancelInvoice(invoice, reason);
    if (result.success) {
      await db.run(UPDATE('sains.ar.Invoice').set({
        einvoiceStatus: 'CANCELLED',
        einvoiceCancelledAt: new Date().toISOString(),
      }).where({ ID }));

      await logAction(req, 'CANCEL_EINVOICE', 'Invoice', ID, null,
        { einvoiceStatus: 'CANCELLED', reason }, invoice.account_ID);
      return true;
    } else {
      return req.error(400, result.errorMessage);
    }
  });

  // ── RAISE CREDIT NOTE ─────────────────────────────────────────────────
  srv.on('raiseCreditNote', 'Invoices', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason, amount } = req.data;
    const db = await cds.connect.to('db');

    const original = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID }));
    if (!original) return req.error(404, 'Original invoice not found');
    if (amount > original.amountOutstanding)
      return req.error(400, 'Credit note amount cannot exceed outstanding amount');

    const creditNoteID = uuidv4();
    const cnNumber = `CN-${original.invoiceNumber}`;

    await db.run(INSERT.into('sains.ar.Invoice').entries({
      ID: creditNoteID,
      account_ID: original.account_ID,
      invoiceNumber: cnNumber,
      invoiceDate: new Date().toISOString().split('T')[0],
      dueDate: new Date().toISOString().split('T')[0],
      billingPeriodFrom: original.billingPeriodFrom,
      billingPeriodTo: original.billingPeriodTo,
      invoiceType: INVOICE_TYPE.CREDIT_NOTE,
      status: INVOICE_STATUS.OPEN,
      sourceSystem: SOURCE_SYSTEM.BTP_INTERNAL,
      totalAmount: -amount,
      taxAmount: 0,
      amountCleared: 0,
      amountOutstanding: -amount,
      originalInvoiceID: ID,
      einvoiceRequired: original.einvoiceRequired,
    }));

    await logAction(req, 'RAISE_CREDIT_NOTE', 'Invoice', creditNoteID, null,
      { amount: -amount, reason, originalInvoiceID: ID }, original.account_ID);
    return creditNoteID;
  });
};
