'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const {
  calculateDailyKPISnapshot,
  updateConsumptionProfiles,
  detectConsumptionAnomalies,
  calculateCLV,
  generateSPANReport,
  updateFraudDensityMap,
} = require('./lib/analytics-engine');
const { logAction, logSystemAction } = require('./lib/audit-logger');

const logger = cds.log('analytics-service');

module.exports = cds.service.impl(async function () {
  const db = await cds.connect.to('db');
  const {
    ARKPISnapshot,
    ConsumptionProfile,
    ConsumptionAnomaly,
    CustomerLifetimeValue,
    RevenueForecast,
    SPANKPIReport,
    FraudDensityZone,
  } = db.entities('sains.ar.analytics');
  const ar = db.entities('sains.ar');

  // ── CONSUMPTION ANOMALIES ───────────────────────────────────────────

  this.on('resolveAnomaly', 'ConsumptionAnomalies', async (req) => {
    const { ID } = req.params[0];
    const { resolution, outcome } = req.data;

    const anomaly = await SELECT.one.from(ConsumptionAnomaly).where({ ID });
    if (!anomaly) return req.error(404, 'Consumption anomaly not found');
    if (anomaly.status !== 'OPEN') {
      return req.error(409, `Anomaly status "${anomaly.status}" cannot be resolved`);
    }

    await UPDATE(ConsumptionAnomaly).set({
      status: 'RESOLVED',
      resolution,
      outcome,
      reviewedBy: req.user.id,
      reviewedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'ANOMALY_RESOLVED', 'ConsumptionAnomaly', ID, { resolution, outcome });

    logger.info(`Consumption anomaly ${ID} resolved with outcome: ${outcome}`);
    return true;
  });

  this.on('holdBillingPending', 'ConsumptionAnomalies', async (req) => {
    const { ID } = req.params[0];

    const anomaly = await SELECT.one.from(ConsumptionAnomaly).where({ ID });
    if (!anomaly) return req.error(404, 'Consumption anomaly not found');

    await UPDATE(ConsumptionAnomaly).set({
      billHeld: true,
      billHeldBy: req.user.id,
      billHeldAt: new Date().toISOString(),
    }).where({ ID });

    // Hold linked invoice if exists
    if (anomaly.invoice_ID) {
      await UPDATE(ar.Invoice).set({
        status: 'HELD',
      }).where({ ID: anomaly.invoice_ID });
    }

    await logAction(req, 'BILLING_HELD', 'ConsumptionAnomaly', ID, {});

    logger.info(`Billing held for anomaly ${ID}`);
    return true;
  });

  this.on('releaseBillingHold', 'ConsumptionAnomalies', async (req) => {
    const { ID } = req.params[0];

    const anomaly = await SELECT.one.from(ConsumptionAnomaly).where({ ID });
    if (!anomaly) return req.error(404, 'Consumption anomaly not found');
    if (!anomaly.billHeld) {
      return req.error(409, 'Anomaly does not have a billing hold');
    }

    await UPDATE(ConsumptionAnomaly).set({
      billHeld: false,
      billReleasedBy: req.user.id,
      billReleasedAt: new Date().toISOString(),
    }).where({ ID });

    // Restore linked invoice status
    if (anomaly.invoice_ID) {
      await UPDATE(ar.Invoice).set({
        status: 'ISSUED',
      }).where({ ID: anomaly.invoice_ID });
    }

    await logAction(req, 'BILLING_HOLD_RELEASED', 'ConsumptionAnomaly', ID, {});

    logger.info(`Billing hold released for anomaly ${ID}`);
    return true;
  });

  // ── SPAN KPI REPORTS ────────────────────────────────────────────────

  this.on('approveReport', 'SPANKPIReports', async (req) => {
    const { ID } = req.params[0];

    const report = await SELECT.one.from(SPANKPIReport).where({ ID });
    if (!report) return req.error(404, 'SPAN KPI report not found');
    if (report.status === 'APPROVED' || report.status === 'SUBMITTED') {
      return req.error(409, `Report status "${report.status}" cannot be approved`);
    }

    await UPDATE(SPANKPIReport).set({
      status: 'APPROVED',
      approvedBy: req.user.id,
      approvedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'SPAN_REPORT_APPROVED', 'SPANKPIReport', ID, {});

    logger.info(`SPAN KPI report ${ID} approved`);
    return true;
  });

  this.on('submitToSPAN', 'SPANKPIReports', async (req) => {
    const { ID } = req.params[0];

    const report = await SELECT.one.from(SPANKPIReport).where({ ID });
    if (!report) return req.error(404, 'SPAN KPI report not found');
    if (report.status !== 'APPROVED') {
      return req.error(409, 'Report must be approved before submission to SPAN');
    }

    // TBC: actual SPAN API call — for now log and update status
    /* TBC: SPAN API endpoint and authentication credentials */
    const submissionRef = `SPAN-${dayjs().format('YYYYMMDD')}-${ID.substring(0, 8)}`;

    await UPDATE(SPANKPIReport).set({
      status: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
      submittedBy: req.user.id,
      submissionRef,
    }).where({ ID });

    await logAction(req, 'SPAN_REPORT_SUBMITTED', 'SPANKPIReport', ID, { submissionRef });

    logger.info(`SPAN KPI report ${ID} submitted with ref ${submissionRef}`);
    return { submissionRef };
  });

  // ── Phase 3: SPAN Report Export (GAP-014) ───────────────────────────

  this.on('exportReport', 'SPANKPIReports', async (req) => {
    const { ID } = req.params[0];
    const report = await SELECT.one.from(SPANKPIReport).where({ ID });
    if (!report) return req.error(404, 'Report not found');

    const format = req.data.format || 'CSV';
    const periodStr = `${report.reportingYear}-${String(report.reportingMonth).padStart(2, '0')}`;

    if (format === 'CSV') {
      const headers = [
        'Reporting Period', 'Total Connections', 'Total Billed (RM)', 'Total Collected (RM)',
        'Collection Ratio', 'Outstanding Debt (RM)', 'Bad Debt Written Off (RM)',
        'Bad Debt Provision (RM)', 'Billing Accuracy (%)', 'Complaints Received',
        'Complaints Resolved', 'Avg Complaint Resolution Days', 'Disconnections', 'Reconnections',
      ].join(',');

      const dataRow = [
        `"${periodStr}"`, report.totalConnections, report.totalBilled?.toFixed(2),
        report.totalCollected?.toFixed(2), ((report.collectionRatio || 0) * 100).toFixed(2) + '%',
        report.outstandingDebt?.toFixed(2), report.badDebtWrittenOff?.toFixed(2),
        report.badDebtProvision?.toFixed(2), ((report.billingAccuracyPct || 0) * 100).toFixed(2) + '%',
        report.complaintsReceived, report.complaintsResolved, report.avgComplaintDays?.toFixed(1),
        report.disconnectionCount, report.reconnectionCount,
      ].join(',');

      const content = `${headers}\n${dataRow}`;
      const fileName = `SAINS_SPAN_KPI_${periodStr}.csv`;
      logger.info(`SPAN report ${ID} exported as CSV`);
      return { content, fileName, mimeType: 'text/csv' };
    }

    req.error(400, 'Excel format: TBC — use CSV format for now');
  });

  // ── JOB TRIGGER ACTIONS ─────────────────────────────────────────────

  this.on('triggerKPISnapshot', async (req) => {
    const { snapshotDate } = req.data;

    try {
      await calculateDailyKPISnapshot(snapshotDate);
      logger.info(`KPI snapshot triggered for ${snapshotDate}`);
      return true;
    } catch (err) {
      logger.error(`KPI snapshot failed: ${err.message}`);
      return false;
    }
  });

  this.on('triggerConsumptionProfileUpdate', async (req) => {
    const { asOfDate } = req.data;

    const result = await updateConsumptionProfiles(asOfDate);

    logger.info(`Consumption profile update completed: ${result.updated} updated`);
    return result;
  });

  this.on('triggerAnomalyDetection', async (req) => {
    const { asOfDate } = req.data;

    const result = await detectConsumptionAnomalies(asOfDate);

    logger.info(`Anomaly detection completed: ${result.detected} detected`);
    return result;
  });

  this.on('triggerCLVCalculation', async (req) => {
    const { asOfDate } = req.data;

    const result = await calculateCLV(asOfDate);

    logger.info(`CLV calculation completed: ${result.calculated} calculated`);
    return result;
  });

  this.on('triggerSPANReportGeneration', async (req) => {
    const { year, month } = req.data;

    const result = await generateSPANReport(year, month);

    logger.info(`SPAN report generated for ${year}-${month}: ${result.reportID}`);
    return result;
  });

  this.on('triggerFraudDensityMap', async (req) => {
    const { asOfDate } = req.data;

    const result = await updateFraudDensityMap(asOfDate);

    logger.info(`Fraud density map updated: ${result.zonesUpdated} zones`);
    return result;
  });

  // ── ANALYTICS FUNCTIONS ─────────────────────────────────────────────

  this.on('getARAgingReport', async (req) => {
    const { asOfDate, branchCode, accountTypeCode } = req.data;

    const where = { status: { '!=': 'CANCELLED' } };
    if (branchCode) where.branchCode = branchCode;
    if (accountTypeCode) where.accountTypeCode = accountTypeCode;

    const invoices = await SELECT.from(ar.Invoice).where(where);

    const buckets = {
      'CURRENT': { accountCount: 0, totalAmount: 0 },
      '1-30': { accountCount: 0, totalAmount: 0 },
      '31-60': { accountCount: 0, totalAmount: 0 },
      '61-90': { accountCount: 0, totalAmount: 0 },
      '91-180': { accountCount: 0, totalAmount: 0 },
      '181-365': { accountCount: 0, totalAmount: 0 },
      '365+': { accountCount: 0, totalAmount: 0 },
    };

    const checkDate = dayjs(asOfDate);
    const accountSet = {};

    for (const inv of invoices) {
      if (!inv.dueDate || inv.amountDue <= 0) continue;
      const daysOverdue = checkDate.diff(dayjs(inv.dueDate), 'day');

      let bucket;
      if (daysOverdue <= 0) bucket = 'CURRENT';
      else if (daysOverdue <= 30) bucket = '1-30';
      else if (daysOverdue <= 60) bucket = '31-60';
      else if (daysOverdue <= 90) bucket = '61-90';
      else if (daysOverdue <= 180) bucket = '91-180';
      else if (daysOverdue <= 365) bucket = '181-365';
      else bucket = '365+';

      buckets[bucket].totalAmount += parseFloat(inv.amountDue) || 0;
      const key = `${bucket}-${inv.accountNumber}`;
      if (!accountSet[key]) {
        accountSet[key] = true;
        buckets[bucket].accountCount++;
      }
    }

    const grandTotal = Object.values(buckets).reduce((s, b) => s + b.totalAmount, 0);

    return Object.entries(buckets).map(([agingBucket, data]) => ({
      agingBucket,
      accountCount: data.accountCount,
      totalAmount: data.totalAmount,
      percentOfTotal: grandTotal > 0 ? data.totalAmount / grandTotal : 0,
    }));
  });

  this.on('getCollectionTrend', async (req) => {
    const { fromDate, toDate, granularity } = req.data;

    const snapshots = await SELECT.from(ARKPISnapshot)
      .where({
        snapshotDate: { '>=': fromDate, '<=': toDate },
      })
      .orderBy({ snapshotDate: 'asc' });

    // Group by granularity (daily, weekly, monthly)
    const grouped = {};

    for (const snap of snapshots) {
      let period;
      const d = dayjs(snap.snapshotDate);
      if (granularity === 'monthly') {
        period = d.format('YYYY-MM');
      } else if (granularity === 'weekly') {
        period = d.startOf('week').format('YYYY-MM-DD');
      } else {
        period = d.format('YYYY-MM-DD');
      }

      if (!grouped[period]) {
        grouped[period] = { billed: 0, collected: 0, count: 0, dsoSum: 0 };
      }
      grouped[period].billed += parseFloat(snap.totalBilled) || 0;
      grouped[period].collected += parseFloat(snap.totalCollected) || 0;
      grouped[period].dsoSum += parseFloat(snap.dso) || 0;
      grouped[period].count++;
    }

    return Object.entries(grouped).map(([period, data]) => ({
      period,
      billed: data.billed,
      collected: data.collected,
      efficiency: data.billed > 0 ? data.collected / data.billed : 0,
      dso: data.count > 0 ? data.dsoSum / data.count : 0,
    }));
  });

  this.on('getPaymentChannelAnalysis', async (req) => {
    const { fromDate, toDate } = req.data;

    const payments = await SELECT.from(ar.Payment)
      .where({
        paymentDate: { '>=': fromDate, '<=': toDate },
        status: { '!=': 'REVERSED' },
      });

    const channels = {};
    let grandTotal = 0;
    let totalTx = 0;

    for (const pay of payments) {
      const channel = pay.paymentChannel || pay.paymentMethod || 'UNKNOWN';
      if (!channels[channel]) {
        channels[channel] = { count: 0, total: 0, failed: 0 };
      }
      channels[channel].count++;
      channels[channel].total += parseFloat(pay.amount) || 0;
      if (pay.status === 'FAILED') channels[channel].failed++;
      grandTotal += parseFloat(pay.amount) || 0;
      totalTx++;
    }

    return Object.entries(channels).map(([channel, data]) => ({
      channel,
      transactionCount: data.count,
      totalAmount: data.total,
      averageAmount: data.count > 0 ? data.total / data.count : 0,
      percentOfTotal: grandTotal > 0 ? data.total / grandTotal : 0,
      failureRate: data.count > 0 ? data.failed / data.count : 0,
    }));
  });

  this.on('getRevenueLeakageReport', async (req) => {
    const { periodYear, periodMonth } = req.data;

    const startDate = dayjs(`${periodYear}-${String(periodMonth).padStart(2, '0')}-01`);
    const endDate = startDate.endOf('month');

    // Billed not collected
    const overdueInvoices = await SELECT.from(ar.Invoice)
      .where({
        status: { in: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'] },
        invoiceDate: { '>=': startDate.format('YYYY-MM-DD'), '<=': endDate.format('YYYY-MM-DD') },
      });

    let billedNotCollected = 0;
    for (const inv of overdueInvoices) {
      billedNotCollected += parseFloat(inv.amountDue) || 0;
    }

    // High risk accounts
    const highRiskAccounts = await SELECT.from(ar.CustomerAccount)
      .where({ riskCategory: 'HIGH' })
      .columns('count(*) as count');

    // Consumption anomalies
    const anomalyCount = await SELECT.from(ConsumptionAnomaly)
      .where({ status: 'OPEN' })
      .columns('count(*) as count');

    // Unresolved suspense — estimate from payment orchestrator events
    let suspenseNotResolved = 0;
    try {
      const pay = db.entities('sains.ar.payment');
      const suspenseEvents = await SELECT.from(pay.PaymentOrchestratorEvent)
        .where({ status: 'SUSPENSE' });
      for (const evt of suspenseEvents) {
        suspenseNotResolved += parseFloat(evt.amount) || 0;
      }
    } catch (err) {
      logger.warn(`Suspense query failed: ${err.message}`);
    }

    // Estimated revenue at risk = billed not collected * risk factor
    const estimatedRevenueAtRisk = billedNotCollected * 0.15; // 15% risk factor

    return {
      billedNotCollected,
      estimatedRevenueAtRisk,
      highRiskAccountCount: highRiskAccounts[0]?.count || 0,
      consumptionAnomalyCount: anomalyCount[0]?.count || 0,
      suspenseNotResolved,
    };
  });
});
