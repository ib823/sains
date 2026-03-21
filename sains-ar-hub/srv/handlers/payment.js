'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../lib/audit-logger');
const { allocatePayment, reverseAllocation } = require('../lib/clearing-engine');
const { checkFraudPatterns } = require('./fraud-detection');
const { sendEmail } = require('../external/notification-service');
const {
  PAYMENT_STATUS, INVOICE_STATUS, PAYMENT_CHANNEL,
  CHEQUE_CLEARANCE_BUSINESS_DAYS, OVERPAYMENT_NOTIFY_THRESHOLD,
} = require('../lib/constants');

module.exports = (srv) => {

  // ── BEFORE CREATE ─────────────────────────────────────────────────────
  srv.before('CREATE', 'Payments', async (req) => {
    const payment = req.data;
    if (!payment.amount || payment.amount <= 0)
      return req.error(400, 'Payment amount must be greater than zero');

    payment.receivedDateTime = payment.receivedDateTime || new Date().toISOString();
    payment.amountAllocated = 0;
    payment.amountUnallocated = payment.amount;

    // Cheque clearance hold (CRITICAL-11)
    if (payment.channel === PAYMENT_CHANNEL.COUNTER_CHEQUE) {
      payment.status = PAYMENT_STATUS.CLEARING_PENDING;
      payment.chequeClearanceStatus = 'PENDING_CLEARANCE';
      payment.valueDate = _addBusinessDays(payment.paymentDate, CHEQUE_CLEARANCE_BUSINESS_DAYS);
      payment.chequeClearanceDueDate = payment.valueDate;
    } else {
      payment.status = PAYMENT_STATUS.RECEIVED;
      if (!payment.valueDate) payment.valueDate = payment.paymentDate;
    }

    // Third-party fraud check
    if (payment.isThirdParty && payment.thirdPartyName) {
      await checkFraudPatterns('SELF_PAYMENT', {
        accountID: payment.account_ID,
        thirdPartyName: payment.thirdPartyName,
        accountCount: 1,
        action: 'CREATE_PAYMENT',
      }, req);
    }
  });

  // ── AFTER CREATE ──────────────────────────────────────────────────────
  srv.after('CREATE', 'Payments', async (payment, req) => {
    if (payment.status === PAYMENT_STATUS.CLEARING_PENDING) return;
    await _allocateAndPersist(payment, req);
  });

  // ── CONFIRM CHEQUE CLEARED ────────────────────────────────────────────
  srv.on('confirmChequeCleared', 'Payments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const payment = await db.run(SELECT.one.from('sains.ar.Payment').where({ ID }));
    if (!payment) return req.error(404, 'Payment not found');
    if (payment.chequeClearanceStatus !== 'PENDING_CLEARANCE')
      return req.error(400, 'Payment is not pending cheque clearance');

    await db.run(UPDATE('sains.ar.Payment').set({
      chequeClearanceStatus: 'CLEARED',
      status: PAYMENT_STATUS.RECEIVED,
    }).where({ ID }));

    payment.status = PAYMENT_STATUS.RECEIVED;
    await _allocateAndPersist(payment, req);

    await logAction(req, 'CONFIRM_CHEQUE_CLEARED', 'Payment', ID, null, { chequeClearanceStatus: 'CLEARED' }, payment.account_ID);
    return true;
  });

  // ── MARK CHEQUE BOUNCED ───────────────────────────────────────────────
  srv.on('markChequeBounced', 'Payments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const payment = await db.run(SELECT.one.from('sains.ar.Payment').where({ ID }));
    if (!payment) return req.error(404, 'Payment not found');

    await db.run(UPDATE('sains.ar.Payment').set({
      status: PAYMENT_STATUS.BOUNCED,
      chequeClearanceStatus: 'BOUNCED',
      reversalReason: reason,
      reversedAt: new Date().toISOString(),
      reversedBy: req.user.id,
    }).where({ ID }));

    await logAction(req, 'MARK_CHEQUE_BOUNCED', 'Payment', ID, null, { status: 'BOUNCED', reason }, payment.account_ID);
    return true;
  });

  // ── MANUAL ALLOCATE ───────────────────────────────────────────────────
  srv.on('manualAllocate', 'Payments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { invoiceID, allocateAmount } = req.data;
    const db = await cds.connect.to('db');

    const payment = await db.run(SELECT.one.from('sains.ar.Payment').where({ ID }));
    if (!payment) return req.error(404, 'Payment not found');
    if (allocateAmount > payment.amountUnallocated)
      return req.error(400, 'Allocation amount exceeds unallocated balance');

    const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: invoiceID }));
    if (!invoice) return req.error(404, 'Invoice not found');
    if (allocateAmount > invoice.amountOutstanding)
      return req.error(400, 'Allocation amount exceeds invoice outstanding');

    await db.run(INSERT.into('sains.ar.PaymentClearing').entries({
      ID: uuidv4(),
      payment_ID: ID,
      invoice_ID: invoiceID,
      clearedAmount: allocateAmount,
      clearingDate: new Date().toISOString().split('T')[0],
      clearingType: 'MANUAL',
      isPartial: allocateAmount < invoice.amountOutstanding,
    }));

    const newInvOutstanding = invoice.amountOutstanding - allocateAmount;
    await db.run(UPDATE('sains.ar.Invoice').set({
      amountCleared: invoice.amountCleared + allocateAmount,
      amountOutstanding: newInvOutstanding,
      status: newInvOutstanding === 0 ? INVOICE_STATUS.CLEARED : INVOICE_STATUS.PARTIAL,
    }).where({ ID: invoiceID }));

    const newPayUnallocated = payment.amountUnallocated - allocateAmount;
    await db.run(UPDATE('sains.ar.Payment').set({
      amountAllocated: payment.amountAllocated + allocateAmount,
      amountUnallocated: newPayUnallocated,
      status: newPayUnallocated === 0 ? PAYMENT_STATUS.ALLOCATED : PAYMENT_STATUS.PARTIALLY_ALLOCATED,
    }).where({ ID }));

    await logAction(req, 'MANUAL_ALLOCATE', 'Payment', ID, null,
      { invoiceID, allocateAmount }, payment.account_ID);
    return true;
  });

  // ── REVERSE PAYMENT ───────────────────────────────────────────────────
  srv.on('reversePayment', 'Payments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reversalType, reason } = req.data;
    const db = await cds.connect.to('db');

    const payment = await db.run(SELECT.one.from('sains.ar.Payment').where({ ID }));
    if (!payment) return req.error(404, 'Payment not found');
    if (payment.status === PAYMENT_STATUS.REVERSED)
      return req.error(400, 'Payment already reversed');

    // Reverse allocations
    const clearings = await db.run(
      SELECT.from('sains.ar.PaymentClearing').where({ payment_ID: ID })
    );
    const { invoiceRollbacks, totalReversed } = reverseAllocation(clearings);

    for (const rb of invoiceRollbacks) {
      const inv = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: rb.invoiceID }));
      if (inv) {
        await db.run(UPDATE('sains.ar.Invoice').set({
          amountCleared: inv.amountCleared - rb.amountToRestore,
          amountOutstanding: inv.amountOutstanding + rb.amountToRestore,
          status: INVOICE_STATUS.OPEN,
        }).where({ ID: rb.invoiceID }));
      }
    }

    // Delete clearings
    await db.run(DELETE.from('sains.ar.PaymentClearing').where({ payment_ID: ID }));

    // Update payment
    await db.run(UPDATE('sains.ar.Payment').set({
      status: PAYMENT_STATUS.REVERSED,
      reversalType,
      reversalReason: reason,
      reversedAt: new Date().toISOString(),
      reversedBy: req.user.id,
      amountAllocated: 0,
      amountUnallocated: payment.amount,
    }).where({ ID }));

    // Update account balance
    await db.run(
      UPDATE('sains.ar.CustomerAccount')
        .set({ balanceOutstanding: { '+=': totalReversed } })
        .where({ ID: payment.account_ID })
    );

    // Fraud check for quick reversal
    const daysSincePayment = dayjs().diff(dayjs(payment.paymentDate), 'day');
    if (daysSincePayment <= 3) {
      await checkFraudPatterns('QUICK_REVERSAL', {
        accountID: payment.account_ID,
        transactionID: ID,
        action: 'REVERSE_PAYMENT',
      }, req);
    }

    await logAction(req, 'REVERSE_PAYMENT', 'Payment', ID, payment,
      { status: 'REVERSED', reversalType, reason }, payment.account_ID);
    return true;
  });

  // ── BATCH PROCESSING ──────────────────────────────────────────────────
  srv.on('confirmBatch', 'CollectionImportBatches', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.CollectionImportBatch').set({
      status: 'CONFIRMED',
      confirmedBy: req.user.id,
      confirmedAt: new Date().toISOString(),
    }).where({ ID }));

    return true;
  });

  srv.on('processBatch', 'CollectionImportBatches', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const batch = await db.run(SELECT.one.from('sains.ar.CollectionImportBatch').where({ ID }));
    if (!batch) return req.error(404, 'Batch not found');

    const lines = await db.run(
      SELECT.from('sains.ar.CollectionImportLine').where({ batch_ID: ID, status: 'PENDING' })
    );

    let processed = 0, failed = 0, suspense = 0;

    for (const line of lines) {
      const account = await db.run(
        SELECT.one.from('sains.ar.CustomerAccount')
          .where({ accountNumber: line.sourceAccountRef })
      );

      if (!account) {
        // Route to suspense
        const suspenseID = uuidv4();
        await db.run(INSERT.into('sains.ar.SuspensePayment').entries({
          ID: suspenseID,
          sourceChannel: batch.sourceChannel,
          sourceBatchRef: batch.sourceReference,
          sourceLineRef: String(line.lineSequence),
          sourceAccountRef: line.sourceAccountRef,
          amount: line.amount,
          paymentDate: line.paymentDate,
          paymentReference: line.paymentReference,
          status: 'PENDING',
        }));
        await db.run(UPDATE('sains.ar.CollectionImportLine').set({
          status: 'SUSPENSE', suspensePaymentID: suspenseID,
        }).where({ ID: line.ID }));
        suspense++;
        continue;
      }

      try {
        const paymentID = uuidv4();
        await db.run(INSERT.into('sains.ar.Payment').entries({
          ID: paymentID,
          account_ID: account.ID,
          paymentReference: line.paymentReference || `BATCH-${batch.sourceReference}-${line.lineSequence}`,
          paymentDate: line.paymentDate,
          valueDate: line.paymentDate,
          receivedDateTime: new Date().toISOString(),
          channel: line.channel || batch.sourceChannel,
          status: PAYMENT_STATUS.RECEIVED,
          amount: line.amount,
          amountAllocated: 0,
          amountUnallocated: line.amount,
          batchReference: batch.sourceReference,
        }));

        await db.run(UPDATE('sains.ar.CollectionImportLine').set({
          status: 'PROCESSED', resolvedAccountID: account.ID, processedPaymentID: paymentID,
        }).where({ ID: line.ID }));
        processed++;
      } catch (err) {
        await db.run(UPDATE('sains.ar.CollectionImportLine').set({
          status: 'FAILED', rejectionReason: err.message,
        }).where({ ID: line.ID }));
        failed++;
      }
    }

    await db.run(UPDATE('sains.ar.CollectionImportBatch').set({
      status: 'PROCESSED',
      processedCount: processed,
      processedAmount: lines.filter((_, i) => i < processed).reduce((s, l) => s + l.amount, 0),
      failedCount: failed,
      suspenseCount: suspense,
    }).where({ ID }));

    return { processed, failed, suspense };
  });

  // ── SUSPENSE RESOLUTION ───────────────────────────────────────────────
  srv.on('resolveToAccount', 'SuspensePayments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { targetAccountID, notes } = req.data;
    const db = await cds.connect.to('db');

    const sp = await db.run(SELECT.one.from('sains.ar.SuspensePayment').where({ ID }));
    if (!sp) return req.error(404, 'Suspense payment not found');

    const paymentID = uuidv4();
    await db.run(INSERT.into('sains.ar.Payment').entries({
      ID: paymentID,
      account_ID: targetAccountID,
      paymentReference: sp.paymentReference || `SUSPENSE-${ID}`,
      paymentDate: sp.paymentDate,
      valueDate: sp.paymentDate,
      receivedDateTime: new Date().toISOString(),
      channel: sp.sourceChannel,
      status: PAYMENT_STATUS.RECEIVED,
      amount: sp.amount,
      amountAllocated: 0,
      amountUnallocated: sp.amount,
    }));

    await db.run(UPDATE('sains.ar.SuspensePayment').set({
      status: 'RESOLVED',
      resolvedAccountID: targetAccountID,
      resolvedPaymentID: paymentID,
      resolutionNotes: notes,
      reviewedBy: req.user.id,
      reviewedAt: new Date().toISOString(),
    }).where({ ID }));

    return true;
  });

  srv.on('returnToSource', 'SuspensePayments', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.SuspensePayment').set({
      status: 'RETURNED',
      resolutionNotes: reason,
      reviewedBy: req.user.id,
      reviewedAt: new Date().toISOString(),
    }).where({ ID }));

    return true;
  });

  // ── BANK STATEMENT ────────────────────────────────────────────────────
  srv.on('runAutoMatch', 'BankStatementImports', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');
    const { importBankStatement } = require('../external/bank-statement-adapter');

    const lines = await db.run(
      SELECT.from('sains.ar.BankStatementLine')
        .where({ statement_ID: ID, status: 'UNMATCHED' })
    );

    let matched = 0;
    for (const line of lines) {
      if (line.debitCreditCode !== 'C' || !line.bankReference) continue;

      const payment = await db.run(
        SELECT.one.from('sains.ar.Payment')
          .where({ bankReference: line.bankReference, status: { not: 'REVERSED' } })
      );

      if (payment && Math.abs(Number(payment.amount) - Number(line.amount)) < 0.01) {
        await db.run(UPDATE('sains.ar.BankStatementLine').set({
          status: 'MATCHED', matchedPaymentID: payment.ID,
          matchedAt: new Date().toISOString(), matchedBy: 'SYSTEM', matchConfidence: 'AUTO_HIGH',
        }).where({ ID: line.ID }));
        matched++;
      }
    }

    await db.run(UPDATE('sains.ar.BankStatementImport').set({
      matchedCount: matched, unmatchedCount: lines.length - matched,
      status: matched === lines.length ? 'MATCHED' : 'MATCHING',
    }).where({ ID }));

    return { matched, unmatched: lines.length - matched };
  });

  srv.on('manualMatch', 'BankStatementImports', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { lineID, paymentID } = req.data;
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.BankStatementLine').set({
      status: 'MANUALLY_MATCHED', matchedPaymentID: paymentID,
      matchedAt: new Date().toISOString(), matchedBy: req.user.id, matchConfidence: 'MANUAL',
    }).where({ ID: lineID }));

    return true;
  });

  srv.on('approveReconciliation', 'BankStatementImports', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.BankStatementImport').set({
      status: 'APPROVED',
      reconciledBy: req.user.id,
      reconciledAt: new Date().toISOString(),
    }).where({ ID }));

    return true;
  });

  // ── PRIVATE: ALLOCATE AND PERSIST ─────────────────────────────────────
  async function _allocateAndPersist(payment, req) {
    const db = await cds.connect.to('db');

    const openInvoices = await db.run(
      SELECT.from('sains.ar.Invoice')
        .where({
          account_ID: payment.account_ID,
          status: { in: [INVOICE_STATUS.OPEN, INVOICE_STATUS.PARTIAL] },
        })
        .orderBy({ dueDate: 'asc' })
    );

    if (openInvoices.length === 0) return;

    const result = allocatePayment(payment, openInvoices);

    // Persist clearings
    for (const cl of result.clearings) {
      await db.run(INSERT.into('sains.ar.PaymentClearing').entries({
        ID: uuidv4(), ...cl,
      }));
    }

    // Update invoice statuses
    for (const isu of result.invoiceStatusUpdates) {
      await db.run(UPDATE('sains.ar.Invoice').set({
        status: isu.newStatus,
        amountOutstanding: isu.newAmountOutstanding,
        amountCleared: isu.newAmountCleared,
      }).where({ ID: isu.invoiceID }));
    }

    // Update payment status
    await db.run(UPDATE('sains.ar.Payment').set({
      status: result.paymentStatusFinal,
      amountAllocated: result.totalAllocated,
      amountUnallocated: result.totalUnallocated,
    }).where({ ID: payment.ID }));

    // Update account balance
    if (result.totalAllocated > 0) {
      await db.run(
        UPDATE('sains.ar.CustomerAccount')
          .set({ balanceOutstanding: { '-=': result.totalAllocated } })
          .where({ ID: payment.account_ID })
      );
    }

    // Credit overpayment to account
    if (result.overpaymentAmount > 0) {
      await db.run(
        UPDATE('sains.ar.CustomerAccount')
          .set({ balanceCreditOnAccount: { '+=': result.overpaymentAmount } })
          .where({ ID: payment.account_ID })
      );

      if (result.notifyOverpayment) {
        const account = await db.run(
          SELECT.one.from('sains.ar.CustomerAccount')
            .columns('emailAddress', 'accountNumber')
            .where({ ID: payment.account_ID })
        );
        if (account?.emailAddress) {
          await sendEmail({
            to: account.emailAddress,
            subject: `[SAINS] Overpayment credited — Account ${account.accountNumber}`,
            body: `An overpayment of RM ${result.overpaymentAmount.toFixed(2)} has been credited to your account.`,
            templateKey: 'overpayment_notification',
          });
        }
      }
    }
  }

  function _addBusinessDays(dateStr, days) {
    let current = dayjs(dateStr);
    let added = 0;
    while (added < days) {
      current = current.add(1, 'day');
      const dow = current.day();
      if (dow !== 0 && dow !== 6) added++;
    }
    return current.format('YYYY-MM-DD');
  }
};
