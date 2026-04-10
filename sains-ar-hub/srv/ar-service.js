'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const {
  runNightlyDunningJob,
  runDailyGLPostingJob,
  runPeriodAccrualJob,
  runPTPComplianceCheck,
} = require('./handlers/dunning');

const invoiceHandler     = require('./handlers/invoice');
const paymentHandler     = require('./handlers/payment');
const depositHandler     = require('./handlers/deposit');
const adjustmentHandler  = require('./handlers/adjustment');
const badDebtHandler     = require('./handlers/bad-debt');
const fraudHandler       = require('./handlers/fraud-detection');
const accountChangeHandler = require('./handlers/account-change');
const glPostingHandler   = require('./handlers/gl-posting');
const customerAccountHandler = require('./handlers/customer-account');
const paymentPlanHandler = require('./handlers/payment-plan');
const authMiddleware = require('./auth-middleware');
const { customerPortalLimiter, webhookLimiter } = require('./middleware/rate-limiter');
const { validateEnvironment } = require('./lib/env-validation');

// Validate environment on module load (before any requests)
try {
  validateEnvironment();
} catch (err) {
  // In production this will prevent startup; in dev it logs warnings
  if (process.env.NODE_ENV === 'production') throw err;
  cds.log('ar-service').error(`Environment validation: ${err.message}`);
}

// Register auth middleware and rate limiters before CDS service handlers
cds.on('bootstrap', app => {
  // 1. Auth middleware — must be first
  app.use(authMiddleware);

  // 2. Rate limiters
  app.use('/portal/', customerPortalLimiter);
  app.use('/payment/fpx/ipn', webhookLimiter);
  app.use('/payment/processWebhookNotification', webhookLimiter);
});

module.exports = cds.service.impl(async function() {
  const srv = this;

  // Register all handlers
  invoiceHandler(srv);
  paymentHandler(srv);
  depositHandler(srv);
  adjustmentHandler(srv);
  badDebtHandler(srv);
  accountChangeHandler(srv);
  glPostingHandler(srv);
  customerAccountHandler(srv);
  paymentPlanHandler(srv);

  // Register fraud detection handlers
  fraudHandler._registerHandlers(srv);

  // ── BEFORE DELETE — Audit Trail immutability ──────────────────────────
  srv.before('DELETE', 'AuditTrailEntry', (req) => {
    return req.error(403, 'Audit trail entries are immutable and cannot be deleted.');
  });

  // ── BEFORE DELETE — Invoices guard ────────────────────────────────────
  srv.before('DELETE', 'WriteOffs', (req) => {
    return req.error(405, 'Write-offs cannot be deleted.');
  });

  // ── PTP COUNT HANDLER (CRITICAL-7) ────────────────────────────────────
  const { PTP_LIMITS } = require('./lib/constants');
  const { logAction } = require('./lib/audit-logger');

  srv.before('CREATE', 'PromisesToPay', async (req) => {
    const ptp = req.data;
    const db = await cds.connect.to('db');
    const yearStart = `${new Date().getFullYear()}-01-01`;

    const existing = await db.run(
      SELECT.from('sains.ar.PromiseToPay')
        .where({
          account_ID: ptp.account_ID,
          createdAt: { '>=': yearStart },
          status: { '!=': 'SUPERSEDED' },
        })
    );

    const countThisYear = existing.length + 1;
    ptp.countThisYear = countThisYear;

    if (countThisYear > PTP_LIMITS.MAX_PER_YEAR_WITH_MANAGER) {
      return req.error(400, `Maximum ${PTP_LIMITS.MAX_PER_YEAR_WITH_MANAGER} PTPs per year reached.`);
    }
    if (countThisYear > PTP_LIMITS.MAX_PER_YEAR_WITHOUT_ESCALATION) {
      ptp.requiresEscalation = true;
      req.warn(200, `PTP #${countThisYear} this year — Finance Manager approval required.`);
    }
  });

  // ── PERIOD LOCK ENFORCEMENT ────────────────────────────────────────────────
  const { isPeriodLocked } = require('./lib/period-lock');

  srv.before('CREATE', 'Invoices', async (req) => {
    if (await isPeriodLocked(req.data.invoiceDate)) {
      return req.error(409, `Period is locked for ${req.data.invoiceDate}. Contact Finance Manager to unlock.`);
    }
  });

  srv.before('CREATE', 'Payments', async (req) => {
    if (await isPeriodLocked(req.data.paymentDate)) {
      return req.error(409, `Period is locked for ${req.data.paymentDate}. Contact Finance Manager to unlock.`);
    }
  });

  srv.before('CREATE', 'Adjustments', async (req) => {
    const postingDate = req.data.postingDate || req.data.createdAt || new Date().toISOString().substring(0, 10);
    if (await isPeriodLocked(postingDate)) {
      return req.error(409, `Period is locked for ${postingDate}. Contact Finance Manager to unlock.`);
    }
  });

  // ── PTP ACTIONS ───────────────────────────────────────────────────────
  srv.on('markBroken', 'PromisesToPay', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.PromiseToPay').set({
      status: 'BROKEN', resolvedAt: new Date().toISOString(),
    }).where({ ID }));

    return true;
  });

  srv.on('markHonoured', 'PromisesToPay', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.PromiseToPay').set({
      status: 'HONOURED', resolvedAt: new Date().toISOString(),
    }).where({ ID }));

    return true;
  });

  srv.on('approveExcessPTP', 'PromisesToPay', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const ptp = await db.run(SELECT.one.from('sains.ar.PromiseToPay').where({ ID }));
    if (!ptp) return req.error(404, 'PTP not found');

    await db.run(UPDATE('sains.ar.PromiseToPay').set({
      requiresEscalation: false,
      escalationApprovedBy: req.user.id,
    }).where({ ID }));

    await logAction(req, 'APPROVE_EXCESS_PTP', 'PromiseToPay', ID, ptp,
      { ...ptp, requiresEscalation: false }, ptp.account_ID);
    return true;
  });

  // ── DISPUTE ACTIONS ───────────────────────────────────────────────────
  srv.on('resolveDispute', 'Disputes', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { status, notes, adjustmentID } = req.data;
    const db = await cds.connect.to('db');

    const dispute = await db.run(SELECT.one.from('sains.ar.Dispute').where({ ID }));
    if (!dispute) return req.error(404, 'Dispute not found');

    await db.run(UPDATE('sains.ar.Dispute').set({
      status,
      resolutionNotes: notes,
      adjustmentID,
      resolvedAt: new Date().toISOString(),
      resolvedBy: req.user.id,
    }).where({ ID }));

    if (status === 'RESOLVED' || status === 'CLOSED') {
      await db.run(UPDATE('sains.ar.CustomerAccount').set({
        isDisputed: false,
      }).where({ ID: dispute.account_ID }));
    }

    return true;
  });

  srv.on('escalateToSPAN', 'Disputes', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { spanRef } = req.data;
    const db = await cds.connect.to('db');

    await db.run(UPDATE('sains.ar.Dispute').set({
      spanEscalationRef: spanRef,
      status: 'ESCALATED',
    }).where({ ID }));

    return true;
  });

  // ── WRITE-OFF BOARD SUBMISSION ────────────────────────────────────────
  srv.on('submitForBoardApproval', 'WriteOffs', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { notes } = req.data;
    const db = await cds.connect.to('db');

    const wo = await db.run(SELECT.one.from('sains.ar.WriteOff').where({ ID }));
    if (!wo) return req.error(404, 'Write-off not found');

    await db.run(UPDATE('sains.ar.WriteOff').set({
      approvalLevel: 'BOARD',
      collectionHistory: (wo.collectionHistory || '') + `\n\nBoard submission notes: ${notes}`,
    }).where({ ID }));

    await logAction(req, 'SUBMIT_FOR_BOARD', 'WriteOff', ID, wo,
      { approvalLevel: 'BOARD', notes }, wo.account_ID);
    return true;
  });

  // ── PTP COMPLIANCE CHECK ──────────────────────────────────────────────
  srv.on('triggerPTPComplianceCheck', async (req) => {
    return await runPTPComplianceCheck();
  });

  // ── POSTAL RETURN TRACKING (CHANGE 8) ─────────────────────────────────
  srv.on('recordPostalReturn', 'DunningHistories', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');
    const now = new Date().toISOString();
    await db.run(UPDATE('sains.ar.DunningHistory').set({
      postalReturnedAt: now,
    }).where({ ID }));
    await logAction(req, 'RECORD_POSTAL_RETURN', 'DunningHistory', ID, null, { postalReturnedAt: now });
    return true;
  });

  // ── JOB TRIGGERS ──────────────────────────────────────────────────────
  srv.on('triggerDunningBatch', async (req) => {
    const date = req.data?.date ? new Date(req.data.date) : new Date();
    return await runNightlyDunningJob(date);
  });

  srv.on('triggerGLPosting', async (req) => {
    const date = req.data?.date ? new Date(req.data.date) : new Date();
    return await runDailyGLPostingJob(date);
  });

  srv.on('triggerPeriodAccrual', async (req) => {
    const year = req.data?.year || new Date().getFullYear();
    const month = req.data?.month || new Date().getMonth() + 1;
    return await runPeriodAccrualJob(year, month);
  });

  // ── AGENCY FILE PARSER ───────────────────────────────────────────────
  const agencyFileParser = require('./external/agency-file-parser');

  srv.on('uploadAgencyFile', 'AgencyFileBatches', async (req) => {
    const { agencyCode, fileContent, fileName } = req.data;
    try {
      const result = await agencyFileParser.parseAgencyFile(agencyCode, fileContent, fileName);
      return {
        batchID: result.batchID,
        parsedLines: result.parsedLines,
        failedLines: result.failedLines,
      };
    } catch (err) {
      return req.error(400, err.message);
    }
  });

  srv.on('resolveAgencyBatch', 'AgencyFileBatches', async (req) => {
    const { batchID } = req.data;
    return await agencyFileParser.resolveAgencyBatch(batchID);
  });

  // ── JOB REGISTRATION ON SERVER START ──────────────────────────────────
  cds.on('served', async () => {
    await _registerScheduledJobs();
    cds.log('ar-service').info('SAINS AR Hub service started. Scheduled jobs registered.');
  });
});

async function _registerScheduledJobs() {
  const vcap = process.env.VCAP_SERVICES ? JSON.parse(process.env.VCAP_SERVICES) : {};
  const jobScheduler = vcap['jobscheduler']?.[0]?.credentials;

  if (!jobScheduler) {
    cds.log('ar-service').warn('BTP Job Scheduling Service not bound — using in-process timers (DEV ONLY)');
    return;
  }

  const appUrl = process.env.APP_URL || 'http://localhost:4004'; // MOCK: set APP_URL env var to production CF app URL before deployment
  const tokenResponse = await axios.post(
    `${jobScheduler.uaa.url}/oauth/token?grant_type=client_credentials`,
    null,
    { auth: { username: jobScheduler.uaa.clientid, password: jobScheduler.uaa.clientsecret } }
  );
  const token = tokenResponse.data.access_token;

  const jobs = [
    { name: 'sains-ar-nightly-dunning', description: 'Nightly dunning evaluation',
      schedules: [{ cron: '0 2 * * *', description: '2:00 AM MYT' }],
      httpMethod: 'POST', action: `${appUrl}/ar/triggerDunningBatch` },
    { name: 'sains-ar-ptp-compliance', description: 'Daily PTP compliance check and plan breach detection',
      schedules: [{ cron: '0 4 * * *', description: '4:00 AM MYT' }],
      httpMethod: 'POST', action: `${appUrl}/ar/triggerPTPComplianceCheck` },
    { name: 'sains-ar-daily-gl-posting', description: 'Daily GL summary posting',
      schedules: [{ cron: '0 1 * * *', description: '1:00 AM MYT' }],
      httpMethod: 'POST', action: `${appUrl}/ar/triggerGLPosting` },
    { name: 'sains-ar-period-accrual', description: 'Month-end accrual posting',
      schedules: [{ cron: '0 0 28-31 * *', description: 'Last days of month' }],
      httpMethod: 'POST', action: `${appUrl}/ar/triggerPeriodAccrual` },
    // ── Phase 2 additional jobs — APPEND ONLY ────────────────────────────
    { name: 'sains-ar-jompay-download', description: 'Download daily JomPAY reconciliation file',
      schedules: [{ cron: '30 0 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/payment/triggerJomPAYFileDownload` },
    { name: 'sains-ar-payment-orchestrator', description: 'Process resolved payment orchestrator events',
      schedules: [{ cron: '0 * * * *' }],
      httpMethod: 'POST', action: `${appUrl}/payment/processResolvedPaymentEvents` },
    { name: 'sains-ar-emandate-debit', description: 'Monthly eMandate direct debit run',
      schedules: [{ cron: '0 23 1-5 * *' }],
      httpMethod: 'POST', action: `${appUrl}/payment/triggerEmandateDebitRun` },
    { name: 'sains-ar-qr-expiry', description: 'Expire stale DuitNow QR codes',
      schedules: [{ cron: '30 16 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/payment/triggerQRExpiry` },
    { name: 'sains-ar-whatsapp-reminders', description: 'Send WhatsApp payment reminders',
      schedules: [{ cron: '0 1 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/payment/triggerWhatsAppReminders` },
    { name: 'sains-ar-kpi-snapshot', description: 'Daily AR KPI snapshot calculation',
      schedules: [{ cron: '30 0 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/analytics/triggerKPISnapshot` },
    { name: 'sains-ar-consumption-profiles', description: 'Weekly consumption profile update',
      schedules: [{ cron: '0 17 * * 0' }],
      httpMethod: 'POST', action: `${appUrl}/analytics/triggerConsumptionProfileUpdate` },
    { name: 'sains-ar-anomaly-detection', description: 'Daily consumption anomaly detection',
      schedules: [{ cron: '0 22 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/analytics/triggerAnomalyDetection` },
    { name: 'sains-ar-clv-calculation', description: 'Monthly CLV calculation',
      schedules: [{ cron: '0 18 2 * *' }],
      httpMethod: 'POST', action: `${appUrl}/analytics/triggerCLVCalculation` },
    { name: 'sains-ar-span-report', description: 'Monthly SPAN KPI report generation',
      schedules: [{ cron: '0 1 5 * *' }],
      httpMethod: 'POST', action: `${appUrl}/analytics/triggerSPANReportGeneration` },
    { name: 'sains-ar-fraud-density', description: 'Weekly fraud density map update',
      schedules: [{ cron: '0 23 * * 1' }],
      httpMethod: 'POST', action: `${appUrl}/analytics/triggerFraudDensityMap` },
    { name: 'sains-ar-ecl-calculation', description: 'Monthly ECL provision calculation',
      schedules: [{ cron: '0 18 3 * *' }],
      httpMethod: 'POST', action: `${appUrl}/provision/triggerECLCalculation` },
    { name: 'sains-ar-mfrs15-extract', description: 'Monthly MFRS 15 revenue extract',
      schedules: [{ cron: '0 20 3 * *' }],
      httpMethod: 'POST', action: `${appUrl}/provision/triggerMFRS15Extract` },
    { name: 'sains-ar-unclaimed-moneys', description: 'Annual unclaimed moneys scan',
      schedules: [{ cron: '0 1 15 1 *' }],
      httpMethod: 'POST', action: `${appUrl}/provision/triggerUnclaimedMoneysScan` },
    { name: 'sains-ar-sustainability-extract', description: 'Monthly sustainability AR data extract',
      schedules: [{ cron: '0 22 4 * *' }],
      httpMethod: 'POST', action: `${appUrl}/provision/triggerSustainabilityExtract` },
    { name: 'sains-ar-einvoice-queue', description: 'Submit pending individual e-invoices to LHDN',
      schedules: [{ cron: '0 */2 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/einvoice/triggerIndividualSubmissionQueue` },
    { name: 'sains-ar-einvoice-b2c', description: 'Monthly consolidated B2C e-invoice submission',
      schedules: [{ cron: '0 1 5 * *' }],
      httpMethod: 'POST', action: `${appUrl}/einvoice/triggerMonthlyConsolidatedB2C` },
    { name: 'sains-ar-einvoice-deadline-alert', description: 'Alert for e-invoice cancellation deadline approaching',
      schedules: [{ cron: '0 */4 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/einvoice/triggerCancellationDeadlineAlert` },
    { name: 'sains-ar-segmentation', description: 'Monthly customer segmentation run',
      schedules: [{ cron: '0 20 2 * *' }],
      httpMethod: 'POST', action: `${appUrl}/collections/triggerSegmentationRun` },
    { name: 'sains-ar-early-intervention', description: 'Weekly early intervention signal scan',
      schedules: [{ cron: '0 0 * * 2' }],
      httpMethod: 'POST', action: `${appUrl}/collections/triggerEarlyInterventionScan` },
    // Phase 3: Bank statement downloads (3x daily — Scenario 6.1)
    { name: 'sains-ar-bank-stmt-0800', description: 'Bank statement download 08:00 MYT',
      schedules: [{ cron: '0 0 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/integration/downloadBankStatements` },
    { name: 'sains-ar-bank-stmt-1200', description: 'Bank statement download 12:00 MYT',
      schedules: [{ cron: '0 4 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/integration/downloadBankStatements` },
    { name: 'sains-ar-bank-stmt-1800', description: 'Bank statement download 18:00 MYT',
      schedules: [{ cron: '0 10 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/integration/downloadBankStatements` },
    // Phase 3: PAAB monthly remittance (Scenario 1.6)
    { name: 'sains-ar-paab-monthly', description: 'Monthly PAAB remittance GL posting',
      schedules: [{ cron: '0 1 1 * *' }],
      httpMethod: 'POST', action: `${appUrl}/admin/initiatePaymentProcedure` },
    // Phase 3: Bayaran Pukal SFTP (Scenario 4.5B)
    { name: 'sains-ar-bayaran-sftp', description: 'Daily Bayaran Pukal SFTP file download',
      schedules: [{ cron: '0 2 * * *' }],
      httpMethod: 'POST', action: `${appUrl}/payment/processBayaranPukalSFTP` },
  ];

  for (const job of jobs) {
    try {
      await axios.post(`${jobScheduler.url}/scheduler/jobs`, job,
        { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } });
      cds.log('ar-service').info(`Job registered: ${job.name}`);
    } catch (error) {
      if (error.response?.status === 409) {
        cds.log('ar-service').info(`Job already registered: ${job.name}`);
      } else {
        cds.log('ar-service').error(`Job registration failed: ${job.name}`, error.message);
      }
    }
  }
}
