'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { runSegmentationBatch, runEarlyInterventionScan } = require('./handlers/segmentation');
const { isPTPBroken } = require('./lib/intelligent-dunning-engine');
const { logAction, logSystemAction } = require('./lib/audit-logger');
const { VULNERABILITY_CATEGORIES } = require('./lib/constants');

const logger = cds.log('intelligent-collections-service');

module.exports = cds.service.impl(async function () {
  const db = await cds.connect.to('db');
  const {
    CustomerSegment,
    DunningPath, DunningPathStep,
    VulnerabilityRecord,
    HardshipAssessment,
    EarlyInterventionAlert,
    PTPSelfService,
  } = db.entities('sains.ar.collections');
  const ar = db.entities('sains.ar');
  const ana = db.entities('sains.ar.analytics');

  // ── CUSTOMER SEGMENTS ───────────────────────────────────────────────

  this.on('overrideSegment', 'CustomerSegments', async (req) => {
    const { ID } = req.params[0];
    const { newSegmentCode, newDunningPath, reason } = req.data;

    const segment = await SELECT.one.from(CustomerSegment).where({ ID });
    if (!segment) return req.error(404, 'Customer segment not found');

    const previousSegment = segment.segmentCode;
    const previousPath = segment.dunningPathCode;

    await UPDATE(CustomerSegment).set({
      segmentCode: newSegmentCode,
      dunningPathCode: newDunningPath,
      isOverridden: true,
      overriddenBy: req.user.id,
      overriddenAt: new Date().toISOString(),
      overrideReason: reason,
    }).where({ ID });

    await logAction(req, 'SEGMENT_OVERRIDDEN', 'CustomerSegment', ID, {
      previousSegment, previousPath,
      newSegmentCode, newDunningPath, reason,
    });

    logger.info(`Segment ${ID} overridden from ${previousSegment} to ${newSegmentCode}`);
    return true;
  });

  // ── VULNERABILITY RECORDS ───────────────────────────────────────────

  this.before('CREATE', 'VulnerabilityRecords', (req) => {
    if (req.data.category && !VULNERABILITY_CATEGORIES.includes(req.data.category)) {
      return req.error(400, `Invalid vulnerability type: ${req.data.category}. Allowed: ${VULNERABILITY_CATEGORIES.join(', ')}`);
    }
  });

  this.on('deactivateRecord', 'VulnerabilityRecords', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const record = await SELECT.one.from(VulnerabilityRecord).where({ ID });
    if (!record) return req.error(404, 'Vulnerability record not found');
    if (!record.isActive) return req.error(409, 'Record is already deactivated');

    await UPDATE(VulnerabilityRecord).set({
      isActive: false,
      deactivatedBy: req.user.id,
      deactivatedAt: new Date().toISOString(),
      deactivationReason: reason,
    }).where({ ID });

    // Clear vulnerability severity on the customer account
    if (record.account_ID) {
      await UPDATE(ar.CustomerAccount).set({
        vulnerabilitySeverity: null,
      }).where({ ID: record.account_ID });
    }

    await logAction(req, 'VULNERABILITY_DEACTIVATED', 'VulnerabilityRecord', ID, { reason });

    logger.info(`Vulnerability record ${ID} deactivated`);
    return true;
  });

  // ── HARDSHIP ASSESSMENTS ────────────────────────────────────────────

  this.on('approveAssessment', 'HardshipAssessments', async (req) => {
    const { ID } = req.params[0];
    const { schemeCode, monthlyPaymentAmount, schemeStartDate, schemeEndDate } = req.data;

    const assessment = await SELECT.one.from(HardshipAssessment).where({ ID });
    if (!assessment) return req.error(404, 'Hardship assessment not found');
    if (assessment.outcome && assessment.outcome !== 'PENDING') {
      return req.error(409, `Assessment already has outcome "${assessment.outcome}"`);
    }

    await UPDATE(HardshipAssessment).set({
      outcome: 'APPROVED',
      schemeCode,
      monthlyPaymentAmount,
      schemeStartDate,
      schemeEndDate,
      approvedBy: req.user.id,
      approvedAt: new Date().toISOString(),
    }).where({ ID });

    // Mark account as under hardship
    if (assessment.account_ID) {
      await UPDATE(ar.CustomerAccount).set({
        isHardship: true,
      }).where({ ID: assessment.account_ID });
    }

    await logAction(req, 'HARDSHIP_APPROVED', 'HardshipAssessment', ID, {
      schemeCode, monthlyPaymentAmount, schemeStartDate, schemeEndDate,
    });

    logger.info(`Hardship assessment ${ID} approved with scheme ${schemeCode}`);
    return true;
  });

  this.on('rejectAssessment', 'HardshipAssessments', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const assessment = await SELECT.one.from(HardshipAssessment).where({ ID });
    if (!assessment) return req.error(404, 'Hardship assessment not found');
    if (assessment.outcome && assessment.outcome !== 'PENDING') {
      return req.error(409, `Assessment already has outcome "${assessment.outcome}"`);
    }

    await UPDATE(HardshipAssessment).set({
      outcome: 'REJECTED',
      rejectionReason: reason,
      rejectedBy: req.user.id,
      rejectedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'HARDSHIP_REJECTED', 'HardshipAssessment', ID, { reason });

    logger.info(`Hardship assessment ${ID} rejected: ${reason}`);
    return true;
  });

  // ── EARLY INTERVENTION ALERTS ───────────────────────────────────────

  this.on('actionAlert', 'EarlyInterventionAlerts', async (req) => {
    const { ID } = req.params[0];
    const { action } = req.data;

    const alert = await SELECT.one.from(EarlyInterventionAlert).where({ ID });
    if (!alert) return req.error(404, 'Early intervention alert not found');
    if (alert.status !== 'OPEN') {
      return req.error(409, `Alert status "${alert.status}" cannot be actioned`);
    }

    await UPDATE(EarlyInterventionAlert).set({
      status: 'ACTIONED',
      actionTaken: action,
      actionedBy: req.user.id,
      actionDate: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'ALERT_ACTIONED', 'EarlyInterventionAlert', ID, { action });

    logger.info(`Early intervention alert ${ID} actioned`);
    return true;
  });

  this.on('dismissAlert', 'EarlyInterventionAlerts', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const alert = await SELECT.one.from(EarlyInterventionAlert).where({ ID });
    if (!alert) return req.error(404, 'Early intervention alert not found');
    if (alert.status !== 'OPEN') {
      return req.error(409, `Alert status "${alert.status}" cannot be dismissed`);
    }

    await UPDATE(EarlyInterventionAlert).set({
      status: 'DISMISSED',
      dismissalReason: reason,
      dismissedBy: req.user.id,
      dismissedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'ALERT_DISMISSED', 'EarlyInterventionAlert', ID, { reason });

    logger.info(`Early intervention alert ${ID} dismissed`);
    return true;
  });

  // ── PTP SELF-SERVICE ────────────────────────────────────────────────

  this.on('cancelPTP', 'PTPSelfServices', async (req) => {
    const { ID } = req.params[0];
    const { reason } = req.data;

    const ptp = await SELECT.one.from(PTPSelfService).where({ ID });
    if (!ptp) return req.error(404, 'PTP record not found');
    if (ptp.status === 'CANCELLED' || ptp.status === 'HONOURED') {
      return req.error(409, `PTP status "${ptp.status}" cannot be cancelled`);
    }

    await UPDATE(PTPSelfService).set({
      status: 'CANCELLED',
      cancellationReason: reason,
      cancelledBy: req.user.id,
      cancelledAt: new Date().toISOString(),
    }).where({ ID });

    // Create a linked PromiseToPay record in Phase 1 schema if applicable
    try {
      await INSERT.into(ar.PromiseToPay).entries({
        account_ID: ptp.account_ID,
        accountNumber: ptp.accountNumber,
        promisedAmount: ptp.promisedAmount,
        promisedDate: ptp.promisedDate,
        status: 'CANCELLED',
        cancellationReason: reason,
        source: 'SELF_SERVICE',
      });
    } catch (err) {
      logger.warn(`Could not create linked PTP record for ${ID}: ${err.message}`);
    }

    await logAction(req, 'PTP_CANCELLED', 'PTPSelfService', ID, { reason });

    logger.info(`PTP self-service ${ID} cancelled`);
    return true;
  });

  // ── JOB TRIGGER ACTIONS ─────────────────────────────────────────────

  this.on('triggerSegmentationRun', async (req) => {
    const { asOfDate } = req.data;

    const result = await runSegmentationBatch(asOfDate);

    logger.info(`Segmentation run completed: ${result.processed} processed, ${result.updated} updated`);
    return result;
  });

  this.on('triggerEarlyInterventionScan', async (req) => {
    const { asOfDate } = req.data;

    const result = await runEarlyInterventionScan(asOfDate);

    logger.info(`Early intervention scan completed: ${result.alertsCreated} alerts created`);
    return result;
  });

  this.on('triggerPTPComplianceCheck', async (req) => {
    const { asOfDate } = req.data;
    let honoured = 0, broken = 0;

    const activePTPs = await SELECT.from(PTPSelfService)
      .where({ status: 'ACTIVE' });

    for (const ptp of activePTPs) {
      const promisedDate = dayjs(ptp.promisedDate);
      const checkDate = dayjs(asOfDate);

      if (checkDate.isAfter(promisedDate)) {
        // Check if payment was made
        const ptpBroken = await isPTPBroken({
          accountNumber: ptp.accountNumber,
          promisedAmount: ptp.promisedAmount,
          promisedDate: ptp.promisedDate,
        });

        if (ptpBroken) {
          await UPDATE(PTPSelfService).set({
            status: 'BROKEN',
            brokenAt: new Date().toISOString(),
          }).where({ ID: ptp.ID });
          broken++;
        } else {
          await UPDATE(PTPSelfService).set({
            status: 'HONOURED',
            honouredAt: new Date().toISOString(),
          }).where({ ID: ptp.ID });
          honoured++;
        }
      }
    }

    await logSystemAction('PTP_COMPLIANCE_CHECK', 'PTPSelfService', null, {
      asOfDate, honoured, broken,
    });

    logger.info(`PTP compliance check: ${honoured} honoured, ${broken} broken`);
    return { honoured, broken };
  });

  // ── ANALYTICS FUNCTIONS ─────────────────────────────────────────────

  this.on('getCollectionsPerformanceDashboard', async (req) => {
    const { periodYear, periodMonth } = req.data;

    // Get latest KPI snapshot for the period
    const snapshotDate = dayjs(`${periodYear}-${String(periodMonth).padStart(2, '0')}-01`)
      .endOf('month').format('YYYY-MM-DD');

    let snapshot;
    try {
      snapshot = await SELECT.one.from(ana.ARKPISnapshot)
        .where({ snapshotDate: { '<=': snapshotDate } })
        .orderBy({ snapshotDate: 'desc' });
    } catch (err) {
      logger.warn(`KPI snapshot query failed: ${err.message}`);
    }

    // Count vulnerable accounts
    const vulnerableAccounts = await SELECT.from(VulnerabilityRecord)
      .where({ isActive: true })
      .columns('count(*) as count');
    const vulnerableCount = vulnerableAccounts[0]?.count || 0;

    // Count hardship schemes
    const hardshipSchemes = await SELECT.from(HardshipAssessment)
      .where({ outcome: 'APPROVED' })
      .columns('count(*) as count');
    const hardshipCount = hardshipSchemes[0]?.count || 0;

    // Count early intervention alerts
    const eiOpened = await SELECT.from(EarlyInterventionAlert)
      .columns('count(*) as count');
    const eiResolved = await SELECT.from(EarlyInterventionAlert)
      .where({ status: 'ACTIONED' })
      .columns('count(*) as count');

    return {
      collectionEfficiency: snapshot?.collectionEfficiency || 0,
      averageDaysToPay: snapshot?.averageDaysToPay || 0,
      ptpComplianceRate: snapshot?.ptpComplianceRate || 0,
      vulnerableAccountCount: vulnerableCount,
      hardshipSchemeCount: hardshipCount,
      earlyInterventionOpened: eiOpened[0]?.count || 0,
      earlyInterventionResolved: eiResolved[0]?.count || 0,
    };
  });

  this.on('getDunningPathPerformance', async (req) => {
    const { fromDate, toDate } = req.data;

    const paths = await SELECT.from(DunningPath);
    const results = [];

    for (const path of paths) {
      const segments = await SELECT.from(CustomerSegment)
        .where({
          dunningPathCode: path.pathCode,
          createdAt: { '>=': fromDate, '<=': toDate },
        });

      const accountsEntered = segments.length;
      let collected = 0, writtenOff = 0, totalDays = 0;

      for (const seg of segments) {
        if (seg.account_ID) {
          const account = await SELECT.one.from(ar.CustomerAccount)
            .where({ ID: seg.account_ID });
          if (account) {
            if (account.balanceOutstanding <= 0) collected++;
            if (account.status === 'WRITTEN_OFF') writtenOff++;
            if (seg.daysToPay) totalDays += seg.daysToPay;
          }
        }
      }

      results.push({
        pathCode: path.pathCode,
        accountsEntered,
        collected,
        writtenOff,
        avgDaysToCollect: accountsEntered > 0 ? (totalDays / accountsEntered) : 0,
        collectionRate: accountsEntered > 0 ? (collected / accountsEntered) : 0,
      });
    }

    return results;
  });
});
