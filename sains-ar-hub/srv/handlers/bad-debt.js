'use strict';

const cds = require('@sap/cds');
const { logAction } = require('../lib/audit-logger');
const { validateWriteOff, throwIfInvalid } = require('../lib/validation');
const { checkFraudPatterns } = require('./fraud-detection');
const { WRITEOFF_THRESHOLDS, FRAUD_ALERT_PATTERN } = require('../lib/constants');

module.exports = (srv) => {

  srv.before('CREATE', 'WriteOffs', async (req) => {
    const wo = req.data;
    const result = validateWriteOff(wo, wo.writeOffAmount);
    throwIfInvalid(result);

    wo.approvalLevel = result.requiredApproval;
    wo.writeOffDate = wo.writeOffDate || new Date().toISOString().split('T')[0];

    // Check for double write-off fraud
    const db = await cds.connect.to('db');
    const existing = await db.run(
      SELECT.one.from('sains.ar.WriteOff').where({ invoiceID: wo.invoiceID })
    );
    if (existing) {
      await checkFraudPatterns(FRAUD_ALERT_PATTERN.DOUBLE_WRITEOFF, {
        accountID: wo.account_ID,
        transactionID: wo.invoiceID,
        accountNumber: wo.invoiceNumber,
        action: 'CREATE_WRITEOFF',
      }, req);
    }

    // Check bulk write-off same user
    const yearStart = `${new Date().getFullYear()}-01-01`;
    const userWriteOffs = await db.run(
      SELECT.from('sains.ar.WriteOff')
        .where({ approvedBy: req.user.id, createdAt: { '>=': yearStart } })
    );
    if (userWriteOffs.length >= 3) {
      await checkFraudPatterns(FRAUD_ALERT_PATTERN.BULK_WRITEOFF_SAME_USER, {
        accountID: wo.account_ID,
        userID: req.user.id,
        writeOffCount: userWriteOffs.length + 1,
        action: 'CREATE_WRITEOFF',
      }, req);
    }
  });

  srv.on('approveWriteOff_Supervisor', 'WriteOffs', async (req) => {
    return _approveWriteOff(req, 'SUPERVISOR', WRITEOFF_THRESHOLDS.MANAGER);
  });

  srv.on('approveWriteOff_Manager', 'WriteOffs', async (req) => {
    return _approveWriteOff(req, 'MANAGER', WRITEOFF_THRESHOLDS.CFO);
  });

  srv.on('approveWriteOff_CFO', 'WriteOffs', async (req) => {
    return _approveWriteOff(req, 'CFO', WRITEOFF_THRESHOLDS.BOARD);
  });

  async function _approveWriteOff(req, level, ceiling) {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const wo = await db.run(SELECT.one.from('sains.ar.WriteOff').where({ ID }));
    if (!wo) return req.error(404, 'Write-off not found');

    if (wo.writeOffAmount >= ceiling) {
      return req.error(400, `Write-off amount RM${wo.writeOffAmount} exceeds ${level} authority ceiling of RM${ceiling}`);
    }

    await db.run(UPDATE('sains.ar.WriteOff').set({
      approvedBy: req.user.id,
      approvalDate: new Date().toISOString(),
      approvalLevel: level,
    }).where({ ID }));

    // Mark account as written off
    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      isWrittenOff: true,
    }).where({ ID: wo.account_ID }));

    // Update invoice
    await db.run(UPDATE('sains.ar.Invoice').set({
      status: 'REVERSED',
    }).where({ ID: wo.invoiceID }));

    await logAction(req, `APPROVE_WRITEOFF_${level}`, 'WriteOff', ID, wo,
      { ...wo, approvalLevel: level, approvedBy: req.user.id }, wo.account_ID);
    return true;
  }
};
