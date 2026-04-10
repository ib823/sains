'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');
const { logAction } = require('../lib/audit-logger');
const { sendEmail } = require('../external/notification-service');

const logger = cds.log('account-change');

const RESTRICTED_FIELDS = [
  'legalName', 'idNumber', 'accountType_code', 'tariffBand_code',
  'serviceAddress1', 'serviceAddress2', 'serviceCity', 'serviceState', 'servicePostcode',
  'meterReference', 'connectionSizeMM', 'branchCode',
  'ownerName', 'ownerPhone', 'ownerEmail',
];

module.exports = (srv) => {

  srv.before('UPDATE', 'CustomerAccounts', async (req) => {
    const data = req.data;
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const current = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ ID })
    );
    if (!current) return;

    for (const field of RESTRICTED_FIELDS) {
      if (data[field] !== undefined && data[field] !== current[field]) {
        await db.run(INSERT.into('sains.ar.AccountChangeRequest').entries({
          ID: uuidv4(),
          account_ID: ID,
          fieldChanged: field,
          oldValue: JSON.stringify(current[field]),
          newValue: JSON.stringify(data[field]),
          changeReason: data._changeReason || 'Field update requested',
          status: 'PENDING',
          requestedBy: req.user.id,
          requestedAt: new Date().toISOString(),
        }));

        delete data[field];
      }
    }
  });

  srv.on('approveChange', 'AccountChangeRequests', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const cr = await db.run(SELECT.one.from('sains.ar.AccountChangeRequest').where({ ID }));
    if (!cr) return req.error(404, 'Change request not found');
    if (cr.status !== 'PENDING') return req.error(400, `Cannot approve request in status ${cr.status}`);

    const newValue = JSON.parse(cr.newValue);
    await db.run(
      UPDATE('sains.ar.CustomerAccount').set({ [cr.fieldChanged]: newValue }).where({ ID: cr.account_ID })
    );

    await db.run(UPDATE('sains.ar.AccountChangeRequest').set({
      status: 'APPLIED',
      approvedBy: req.user.id,
      approvedAt: new Date().toISOString(),
      appliedAt: new Date().toISOString(),
    }).where({ ID }));

    await logAction(req, 'APPROVE_CHANGE_REQUEST', 'AccountChangeRequest', ID,
      { status: 'PENDING' }, { status: 'APPLIED', fieldChanged: cr.fieldChanged }, cr.account_ID);

    // If accountType changed, create a system note about tariff reclassification
    if (cr.fieldChanged === 'accountType_code') {
      try {
        await db.run(INSERT.into('sains.ar.AccountNote').entries({
          ID: uuidv4(),
          account_ID: cr.account_ID,
          noteDate: new Date().toISOString().substring(0, 10),
          noteType: 'SYSTEM',
          noteText: `Account reclassified from ${cr.oldValue} to ${cr.newValue}. Tariff rebilling may be required for current billing period.`,
          isInternal: true,
        }));
        // MOCK: tariff difference calculation uses simplified flat-rate assumption.
        // Full tiered tariff recalculation requires tariff engine (Batch 9).
        logger.info(`Account ${cr.account_ID} reclassified: ${cr.oldValue} → ${cr.newValue}`);
      } catch (err) {
        logger.warn(`Tariff reclassification note failed: ${err.message}`);
      }
    }

    return true;
  });

  srv.on('rejectChange', 'AccountChangeRequests', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const cr = await db.run(SELECT.one.from('sains.ar.AccountChangeRequest').where({ ID }));
    if (!cr) return req.error(404, 'Change request not found');
    if (cr.status !== 'PENDING') return req.error(400, `Cannot reject request in status ${cr.status}`);

    await db.run(UPDATE('sains.ar.AccountChangeRequest').set({
      status: 'REJECTED',
      approvedBy: req.user.id,
      approvedAt: new Date().toISOString(),
      rejectionReason: reason,
    }).where({ ID }));

    await logAction(req, 'REJECT_CHANGE_REQUEST', 'AccountChangeRequest', ID,
      { status: 'PENDING' }, { status: 'REJECTED' }, cr.account_ID);
    return true;
  });
};
