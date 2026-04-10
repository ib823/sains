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
const { validateInvoiceTransition } = require('../lib/invoice-state-machine');

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

    // Flag partial period billing
    if (invoice.account_ID) {
      const acctForPartial = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount').columns('accountOpenDate').where({ ID: invoice.account_ID })
      );
      if (acctForPartial?.accountOpenDate && invoice.billingPeriodFrom && invoice.billingPeriodTo) {
        const openDate = new Date(acctForPartial.accountOpenDate);
        const periodFrom = new Date(invoice.billingPeriodFrom);
        const periodTo = new Date(invoice.billingPeriodTo);
        if (openDate > periodFrom && openDate <= periodTo) {
          invoice.isPartialPeriod = true;
          // MOCK: partial period flag is set but pro-rata calculation requires tariff engine
        }
      }
    }
  });

  // ── AFTER CREATE: balance update, meter history ───────────────────────
  srv.after('CREATE', 'Invoices', async (invoice, req) => {
    const invoiceLogger = cds.log('invoice-handler');
    const db = await cds.connect.to('db');

    // Update account balance atomically
    try {
      await db.run(
        UPDATE('sains.ar.CustomerAccount')
          .set({ balanceOutstanding: { '+=': invoice.totalAmount } })
          .where({ ID: invoice.account_ID })
      );
    } catch (err) {
      invoiceLogger.error(`Failed to update account balance for invoice ${invoice.ID}: ${err.message}`);
    }

    // Insert meter read history if metered
    if (invoice.meterReadCurrent && invoice.consumptionM3) {
      try {
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
      } catch (err) {
        invoiceLogger.error(`Failed to insert meter read history for invoice ${invoice.ID}: ${err.message}`);
      }
    }

    await logAction(req, 'CREATE_INVOICE', 'Invoice', invoice.ID, null, invoice, invoice.account_ID)
      .catch(err => invoiceLogger.error(`Audit log failed for invoice ${invoice.ID}: ${err.message}`));

    // Alert on estimated bills
    if (invoice.meterReadType === 'ESTIMATED') {
      try {
        const { sendSystemAlert } = require('../external/notification-service');
        await sendSystemAlert({
          severity: 'LOW',
          subject: `Estimated bill for account ${invoice.account_ID}`,
          body: `Invoice ${invoice.invoiceNumber} uses estimated meter reading for period ${invoice.billingPeriodFrom} to ${invoice.billingPeriodTo}. Manual read recommended.`,
        });
        // Create account note
        await db.run(INSERT.into('sains.ar.AccountNote').entries({
          ID: cds.utils.uuid(),
          account_ID: invoice.account_ID,
          noteDate: new Date().toISOString().substring(0, 10),
          noteType: 'SYSTEM',
          noteText: `Estimated bill ${invoice.invoiceNumber} generated for period ${invoice.billingPeriodFrom}–${invoice.billingPeriodTo}. Manual meter read recommended.`,
          isInternal: true,
        }));
      } catch (err) {
        invoiceLogger.warn(`Estimated bill alert failed: ${err.message}`);
      }
    }
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

    try {
      validateInvoiceTransition(invoice.status, INVOICE_STATUS.REVERSED);
    } catch (err) {
      return req.error(400, err.message);
    }

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

    // Enforce 72-hour cancellation window
    if (invoice.einvoiceCancelDeadline) {
      const deadline = new Date(invoice.einvoiceCancelDeadline);
      if (new Date() > deadline) {
        return req.error(400,
          `Cancellation window expired on ${deadline.toISOString()}. ` +
          `Use raiseCreditNote instead (per LHDN MyInvois regulation).`);
      }
    }

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
