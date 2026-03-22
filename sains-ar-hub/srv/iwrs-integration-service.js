'use strict';

const cds = require('@sap/cds');
const iwrs = require('./external/iwrs-adapter');
const metis = require('./external/metis-adapter');

const logger = cds.log('iwrs-integration-service');

module.exports = cds.service.impl(async function () {
  const { iWRSEventLogs, MetisWorkOrders, iWRSConfigs } = this.entities;

  // ── iWRS INBOUND ACTIONS ──────────────────────────────────────────────────

  this.on('receiveAccountEvent', async req => {
    const { eventType, iWRSReference, accountNumber, payload } = req.data;
    let parsed;
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      req.error(400, `Invalid payload JSON for account event ${iWRSReference}`);
      return;
    }
    return await iwrs.processAccountEvent(eventType, iWRSReference, accountNumber, parsed);
  });

  this.on('receiveInvoiceEvent', async req => {
    const { iWRSReference, accountNumber, payload } = req.data;
    let parsed;
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      req.error(400, `Invalid payload JSON for invoice event ${iWRSReference}`);
      return;
    }
    return await iwrs.processInvoiceEvent(iWRSReference, accountNumber, parsed);
  });

  this.on('receivePaymentEvent', async req => {
    const { iWRSReference, accountNumber, payload } = req.data;
    let parsed;
    try {
      parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch {
      req.error(400, `Invalid payload JSON for payment event ${iWRSReference}`);
      return;
    }
    return await iwrs.processPaymentEvent(iWRSReference, accountNumber, parsed);
  });

  // ── METIS INBOUND ──────────────────────────────────────────────────────────

  this.on('receiveMetisCompletion', async req => {
    const {
      workOrderRef, completionStatus, completedAt,
      fieldTeamID, notes, rawPayload
    } = req.data;
    const db = await cds.connect.to('db');

    const workOrder = await db.run(
      SELECT.one.from('sains.ar.integration.MetisWorkOrder')
        .where({ metisWorkOrderRef: workOrderRef })
    );
    if (!workOrder) {
      logger.warn(`Metis completion received for unknown work order: ${workOrderRef}`);
      return false;
    }

    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: completionStatus === 'COMPLETED' ? 'COMPLETED' : 'FAILED',
      completedAt,
      completedBy: fieldTeamID,
      completionNotes: notes,
      rawCompletionPayload: rawPayload,
    }).where({ ID: workOrder.ID }));

    // Update CustomerAccount status
    if (completionStatus === 'COMPLETED' && workOrder.workOrderType === 'DISCONNECTION') {
      await db.run(UPDATE('sains.ar.CustomerAccount').set({
        accountStatus: 'TEMP_DISCONNECTED',
      }).where({ ID: workOrder.account_ID }));
      logger.info(`Account ${workOrder.account_ID} status set to TEMP_DISCONNECTED via Metis`);
    }

    return true;
  });

  // ── PATTERN B/C JOB TRIGGERS ───────────────────────────────────────────────

  this.on('triggerPatternBProcessing', async req => {
    return await iwrs.processPatternBDeltaFile(req.data.fileDate);
  });

  this.on('triggerPatternCSync', async req => {
    return await iwrs.pollPatternCAccounts(req.data.asOfTimestamp);
  });

  // ── RETRY ACTIONS ──────────────────────────────────────────────────────────

  this.on('retryFailedEvent', async req => {
    const db = await cds.connect.to('db');
    const event = await db.run(
      SELECT.one.from('sains.ar.integration.iWRSEventLog')
        .where({ ID: req.params[0], processingStatus: 'FAILED' })
    );
    if (!event) {
      req.error(404, 'Event not found or not in FAILED status');
      return;
    }

    const payload = JSON.parse(event.rawPayload);
    await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
      processingStatus: 'RECEIVED',
      processingError: null,
      retryCount: { '+=': 1 },
    }).where({ ID: event.ID }));

    if (event.eventType === 'ACCOUNT_CREATED' || event.eventType === 'ACCOUNT_UPDATED' || event.eventType === 'ACCOUNT_CLOSED') {
      await iwrs.processAccountEvent(event.eventType, event.iWRSReference, event.accountNumber, payload);
    } else if (event.eventType === 'INVOICE_GENERATED') {
      await iwrs.processInvoiceEvent(event.iWRSReference, event.accountNumber, payload);
    } else if (event.eventType === 'PAYMENT_RECEIVED') {
      await iwrs.processPaymentEvent(event.iWRSReference, event.accountNumber, payload);
    }

    return true;
  });

  this.on('reprocessSuspenseEvents', async req => {
    const db = await cds.connect.to('db');
    const suspense = await db.run(
      SELECT.from('sains.ar.integration.iWRSEventLog')
        .where({
          processingStatus: 'SUSPENSE',
          createdAt: { '>=': req.data.asOfDate },
        })
        .limit(500)
    );

    let reprocessed = 0, resolved = 0, failed = 0;
    for (const event of suspense) {
      try {
        reprocessed++;
        const payload = JSON.parse(event.rawPayload);
        if (event.eventType === 'INVOICE_GENERATED') {
          const result = await iwrs.processInvoiceEvent(event.iWRSReference, event.accountNumber, payload);
          if (result.success) resolved++;
        } else if (event.eventType === 'PAYMENT_RECEIVED') {
          await iwrs.processPaymentEvent(event.iWRSReference, event.accountNumber, payload);
          resolved++;
        }
      } catch { failed++; }
    }

    return { reprocessed, resolved, failed };
  });

  // ── WORK ORDER ACTIONS ─────────────────────────────────────────────────────

  this.on('cancelWorkOrder', async req => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: 'CANCELLED',
      completionNotes: req.data.reason,
    }).where({ ID: req.params[0] }));
    return true;
  });

  this.on('retryWorkOrder', async req => {
    const db = await cds.connect.to('db');
    const wo = await db.run(
      SELECT.one.from('sains.ar.integration.MetisWorkOrder').where({ ID: req.params[0] })
    );
    if (!wo) { req.error(404, 'Work order not found'); return; }

    await db.run(UPDATE('sains.ar.integration.MetisWorkOrder').set({
      status: 'PENDING',
      retryCount: { '+=': 1 },
      lastRetryAt: new Date().toISOString(),
    }).where({ ID: req.params[0] }));

    // Re-send to Metis
    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ ID: wo.account_ID })
    );
    if (wo.workOrderType === 'DISCONNECTION') {
      await metis.createDisconnectionWorkOrder(account, wo.authorisedBy, wo.ID);
    }
    return true;
  });

  // ── ANALYTICS ─────────────────────────────────────────────────────────────

  this.on('getIntegrationHealthReport', async req => {
    const db = await cds.connect.to('db');
    const { fromDate, toDate } = req.data;

    const stats = await db.run(
      SELECT.from('sains.ar.integration.iWRSEventLog')
        .columns([
          'COUNT(*) as total',
          "SUM(CASE WHEN processingStatus='PROCESSED' THEN 1 ELSE 0 END) as ok",
          "SUM(CASE WHEN processingStatus='FAILED' THEN 1 ELSE 0 END) as failed",
          "SUM(CASE WHEN processingStatus='SUSPENSE' THEN 1 ELSE 0 END) as suspense",
          'AVG(processingDurationMs) as avgMs',
        ])
        .where({ createdAt: { between: fromDate, and: toDate } })
    );

    const config = await db.run(
      SELECT.one.from('sains.ar.integration.iWRSIntegrationConfig')
        .where({ isActive: true })
    );

    return {
      totalEvents: Number(stats?.[0]?.total || 0),
      processedOK: Number(stats?.[0]?.ok || 0),
      failed: Number(stats?.[0]?.failed || 0),
      suspense: Number(stats?.[0]?.suspense || 0),
      avgProcessingMs: Math.round(Number(stats?.[0]?.avgMs || 0) * 100) / 100,
      patternActive: config?.activePattern || 'PATTERN_A',
    };
  });
});
