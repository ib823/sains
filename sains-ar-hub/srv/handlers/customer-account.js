'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const { encryptICNumber, decryptICNumber, maskICNumber } = require('../lib/crypto-helper');
const { logAction } = require('../lib/audit-logger');
const { ACCOUNT_STATUS, INVOICE_STATUS } = require('../lib/constants');
const { sendEmail } = require('../external/notification-service');

module.exports = (srv) => {

  // ── BEFORE CREATE: encrypt IC number ──────────────────────────────────
  srv.before('CREATE', 'CustomerAccounts', async (req) => {
    const data = req.data;
    if (data.idNumber) {
      data.idNumber = await encryptICNumber(data.idNumber);
      data.idNumberMasked = maskICNumber();
    }
  });

  // ── CLOSE ACCOUNT ─────────────────────────────────────────────────────
  srv.on('closeAccount', 'CustomerAccounts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const account = await db.run(SELECT.one.from('sains.ar.CustomerAccount').where({ ID }));
    if (!account) return req.error(404, 'Account not found');
    if (account.balanceOutstanding > 0)
      return req.error(400, `Cannot close account with outstanding balance of RM${account.balanceOutstanding}`);

    // Check no active payment plans
    const activePlans = await db.run(
      SELECT.from('sains.ar.PaymentPlan')
        .where({ account_ID: ID, planStatus: 'ACTIVE' })
    );
    if (activePlans.length > 0)
      return req.error(400, 'Cannot close account with active payment plans');

    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      accountStatus: ACCOUNT_STATUS.CLOSED,
      accountCloseDate: new Date().toISOString().split('T')[0],
    }).where({ ID }));

    await logAction(req, 'CLOSE_ACCOUNT', 'CustomerAccount', ID, account,
      { accountStatus: 'CLOSED', reason }, ID);
    return true;
  });

  // ── ACTIVATE VOID ACCOUNT ─────────────────────────────────────────────
  srv.on('activateVoidAccount', 'CustomerAccounts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { notes } = req.data;
    const db = await cds.connect.to('db');

    const account = await db.run(SELECT.one.from('sains.ar.CustomerAccount').where({ ID }));
    if (!account) return req.error(404, 'Account not found');
    if (account.accountStatus !== ACCOUNT_STATUS.VOID)
      return req.error(400, 'Only VOID accounts can be activated');

    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      accountStatus: ACCOUNT_STATUS.ACTIVE,
      isVoid: false,
    }).where({ ID }));

    await logAction(req, 'ACTIVATE_VOID_ACCOUNT', 'CustomerAccount', ID, account,
      { accountStatus: 'ACTIVE', notes }, ID);
    return true;
  });

  // ── REQUEST DATA EXPORT ───────────────────────────────────────────────
  srv.on('requestDataExport', 'CustomerAccounts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const account = await db.run(SELECT.one.from('sains.ar.CustomerAccount').where({ ID }));
    if (!account) return req.error(404, 'Account not found');

    const exportRef = `EXPORT-${account.accountNumber}-${Date.now()}`;

    // IC number must appear masked in export data
    await sendEmail({
      to: '/* TBC: Finance Admin distribution list for postal queue */',
      subject: `[SAINS AR] Data export requested — ${account.accountNumber}`,
      body: `Data export requested for account ${account.accountNumber}.\n` +
            `Export reference: ${exportRef}\n` +
            `IC Number: ${account.idNumberMasked}\n` +
            `Requested by: ${req.user.id}`,
      templateKey: 'data_export_request',
    });

    await logAction(req, 'REQUEST_DATA_EXPORT', 'CustomerAccount', ID, null,
      { exportRef }, ID);
    return exportRef;
  });

  // ── DECRYPT ID NUMBER ─────────────────────────────────────────────────
  srv.on('decryptIdNumber', 'CustomerAccounts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').columns('ID', 'idNumber', 'account_ID')
        .where({ ID })
    );
    if (!account) return req.error(404, 'Account not found');

    const plaintext = await decryptICNumber(account.idNumber);

    // MANDATORY audit log entry for every call
    await logAction(req, 'DECRYPT_IC_NUMBER', 'CustomerAccount', ID, null,
      { action: 'IC_DECRYPTED' }, ID);

    return plaintext;
  });

  // ── VERIFY BUYER TIN ──────────────────────────────────────────────────
  srv.on('verifyBuyerTIN', 'CustomerAccounts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { tin } = req.data;
    const db = await cds.connect.to('db');

    // Validate TIN format (Malaysian TIN: typically 12-14 chars)
    if (!tin || tin.length < 10) {
      return { valid: false, registeredName: null, message: 'Invalid TIN format' };
    }

    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      buyerTIN: tin,
      buyerTINVerified: true,
      buyerTINVerifiedDate: new Date().toISOString(),
    }).where({ ID }));

    // Release HELD_NO_TIN invoices
    const heldInvoices = await db.run(
      SELECT.from('sains.ar.Invoice')
        .where({ account_ID: ID, status: INVOICE_STATUS.HELD_NO_TIN })
    );
    for (const inv of heldInvoices) {
      await db.run(UPDATE('sains.ar.Invoice').set({
        status: INVOICE_STATUS.OPEN,
        einvoiceStatus: 'PENDING',
      }).where({ ID: inv.ID }));
    }

    await logAction(req, 'VERIFY_BUYER_TIN', 'CustomerAccount', ID, null,
      { tin, releasedInvoices: heldInvoices.length }, ID);

    return { valid: true, registeredName: null, message: `TIN verified. ${heldInvoices.length} held invoices released.` };
  });

  // ── VOLUNTARY DISCONNECT ──────────────────────────────────────────────
  srv.on('voluntaryDisconnect', 'CustomerAccounts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reconnectDate } = req.data;
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      isVoluntaryDisconnected: true,
      voluntaryDisconnectedDate: new Date().toISOString().split('T')[0],
      voluntaryReconnectDueDate: reconnectDate,
      accountStatus: ACCOUNT_STATUS.TEMP_DISCONNECTED,
    }).where({ ID }));

    await logAction(req, 'VOLUNTARY_DISCONNECT', 'CustomerAccount', ID, null,
      { reconnectDate }, ID);
    return true;
  });

  // ── VOLUNTARY RECONNECT ───────────────────────────────────────────────
  srv.on('voluntaryReconnect', 'CustomerAccounts', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      isVoluntaryDisconnected: false,
      voluntaryDisconnectedDate: null,
      voluntaryReconnectDueDate: null,
      accountStatus: ACCOUNT_STATUS.ACTIVE,
    }).where({ ID }));

    await logAction(req, 'VOLUNTARY_RECONNECT', 'CustomerAccount', ID, null,
      { accountStatus: 'ACTIVE' }, ID);
    return true;
  });
};
