'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const {
  runECLCalculation,
  postProvisionToGL,
  extractMFRS15Revenue,
  scanUnclaimedMoneys,
  extractSustainabilityData,
} = require('./lib/advanced-provision-engine');
const { sendEmail } = require('./external/notification-service');
const { logAction, logSystemAction } = require('./lib/audit-logger');

const logger = cds.log('provision-reporting-service');

module.exports = cds.service.impl(async function () {
  const db = await cds.connect.to('db');
  const {
    ProvisionMatrixVersion, ProvisionRate,
    ECLCalculationRun, ECLSegmentResult,
    ForwardLookingFactor,
    MFRS15RevenueRecord,
    DepositLiabilityRegister, DepositLiabilityEntry,
    AuditorConfirmationLetter,
    SustainabilityARData,
  } = db.entities('sains.ar.provision');
  const ar = db.entities('sains.ar');

  // ── MATRIX VERSIONS ─────────────────────────────────────────────────

  this.on('activateVersion', 'MatrixVersions', async (req) => {
    const { ID } = req.params[0];

    const version = await SELECT.one.from(ProvisionMatrixVersion).where({ ID });
    if (!version) return req.error(404, 'Provision matrix version not found');
    if (version.isActive) return req.error(409, 'Version is already active');

    // Deactivate all other versions
    await UPDATE(ProvisionMatrixVersion).set({ isActive: false })
      .where({ isActive: true });

    // Activate this version
    await UPDATE(ProvisionMatrixVersion).set({
      isActive: true,
      activatedBy: req.user.id,
      activatedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'MATRIX_VERSION_ACTIVATED', 'ProvisionMatrixVersion', ID, {
      versionCode: version.versionCode,
    });

    logger.info(`Provision matrix version ${version.versionCode} activated`);
    return true;
  });

  this.on('confirmAuditApproval', 'MatrixVersions', async (req) => {
    const { ID } = req.params[0];
    const { auditFirm, auditConfirmationRef } = req.data;

    const version = await SELECT.one.from(ProvisionMatrixVersion).where({ ID });
    if (!version) return req.error(404, 'Provision matrix version not found');

    await UPDATE(ProvisionMatrixVersion).set({
      auditFirmConfirmed: true,
      auditFirm,
      auditConfirmationRef,
      auditConfirmedBy: req.user.id,
      auditConfirmedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'MATRIX_AUDIT_CONFIRMED', 'ProvisionMatrixVersion', ID, {
      auditFirm, auditConfirmationRef,
    });

    logger.info(`Matrix version ${version.versionCode} audit confirmed by ${auditFirm}`);
    return true;
  });

  // ── ECL CALCULATION RUNS ────────────────────────────────────────────

  this.on('approveRun', 'ECLCalculationRuns', async (req) => {
    const { ID } = req.params[0];

    const run = await SELECT.one.from(ECLCalculationRun).where({ ID });
    if (!run) return req.error(404, 'ECL calculation run not found');
    if (run.status !== 'COMPLETED') {
      return req.error(409, 'Run must be in COMPLETED status before approval');
    }
    if (run.status === 'APPROVED') {
      return req.error(409, 'Run is already approved');
    }

    await UPDATE(ECLCalculationRun).set({
      status: 'APPROVED',
      approvedBy: req.user.id,
      approvedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'ECL_RUN_APPROVED', 'ECLCalculationRun', ID, {
      runType: run.runType,
      periodYear: run.periodYear,
      periodMonth: run.periodMonth,
    });

    logger.info(`ECL calculation run ${ID} approved`);
    return true;
  });

  this.on('postToGL', 'ECLCalculationRuns', async (req) => {
    const { ID } = req.params[0];

    try {
      const result = await postProvisionToGL(ID);

      await logAction(req, 'ECL_POSTED_TO_GL', 'ECLCalculationRun', ID, {
        glBatchID: result.glBatchID,
        documentNumber: result.documentNumber,
      });

      logger.info(`ECL run ${ID} posted to GL: batch ${result.glBatchID}, doc ${result.documentNumber}`);
      return result;
    } catch (err) {
      logger.error(`ECL GL posting failed for run ${ID}: ${err.message}`);
      return req.error(500, err.message);
    }
  });

  // ── DEPOSIT LIABILITY REGISTERS ─────────────────────────────────────

  this.on('approveRegister', 'DepositLiabilityRegisters', async (req) => {
    const { ID } = req.params[0];

    const register = await SELECT.one.from(DepositLiabilityRegister).where({ ID });
    if (!register) return req.error(404, 'Deposit liability register not found');
    if (register.status === 'APPROVED') {
      return req.error(409, 'Register is already approved');
    }

    await UPDATE(DepositLiabilityRegister).set({
      status: 'APPROVED',
      approvedBy: req.user.id,
      approvedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'DEPOSIT_REGISTER_APPROVED', 'DepositLiabilityRegister', ID, {});

    logger.info(`Deposit liability register ${ID} approved`);
    return true;
  });

  this.on('confirmLodgement', 'DepositLiabilityRegisters', async (req) => {
    const { ID } = req.params[0];
    const { lodgementRef } = req.data;

    const register = await SELECT.one.from(DepositLiabilityRegister).where({ ID });
    if (!register) return req.error(404, 'Deposit liability register not found');
    if (register.status !== 'APPROVED') {
      return req.error(409, 'Register must be approved before lodgement confirmation');
    }

    await UPDATE(DepositLiabilityRegister).set({
      status: 'LODGED',
      lodgedAt: new Date().toISOString(),
      lodgementRef,
      lodgedBy: req.user.id,
    }).where({ ID });

    await logAction(req, 'DEPOSIT_REGISTER_LODGED', 'DepositLiabilityRegister', ID, { lodgementRef });

    logger.info(`Deposit liability register ${ID} lodgement confirmed: ${lodgementRef}`);
    return true;
  });

  // ── AUDITOR CONFIRMATION LETTERS ────────────────────────────────────

  this.on('recordResponse', 'AuditorConfirmationLetters', async (req) => {
    const { ID } = req.params[0];
    const { responseBalance, differenceResolution } = req.data;

    const letter = await SELECT.one.from(AuditorConfirmationLetter).where({ ID });
    if (!letter) return req.error(404, 'Auditor confirmation letter not found');

    const difference = Math.abs(
      (parseFloat(letter.confirmedBalance) || 0) - (parseFloat(responseBalance) || 0)
    );

    await UPDATE(AuditorConfirmationLetter).set({
      responseReceived: true,
      responseDate: new Date().toISOString(),
      responseBalance,
      differenceAmount: difference,
      differenceResolution: differenceResolution || null,
      recordedBy: req.user.id,
      recordedAt: new Date().toISOString(),
    }).where({ ID });

    await logAction(req, 'AUDITOR_RESPONSE_RECORDED', 'AuditorConfirmationLetter', ID, {
      responseBalance, differenceAmount: difference,
    });

    logger.info(`Auditor confirmation letter ${ID} response recorded, difference: ${difference}`);
    return true;
  });

  // ── GENERATE AUDITOR CONFIRMATION LETTERS ───────────────────────────

  this.on('generateAuditorConfirmationLetters', async (req) => {
    const { auditYear, sampleSize, minBalance } = req.data;
    let generated = 0;

    // Sample accounts by balance criteria
    const accounts = await SELECT.from(ar.CustomerAccount)
      .where({
        status: 'ACTIVE',
        balanceOutstanding: { '>=': minBalance },
      })
      .orderBy({ balanceOutstanding: 'desc' })
      .limit(sampleSize);

    for (const account of accounts) {
      try {
        const letter = {
          auditYear,
          account_ID: account.ID,
          accountNumber: account.accountNumber,
          customerName: account.customerName,
          confirmedBalance: account.balanceOutstanding,
          letterDate: new Date().toISOString(),
          status: 'GENERATED',
          responseReceived: false,
        };

        await INSERT.into(AuditorConfirmationLetter).entries(letter);

        // Trigger email notification
        try {
          await sendEmail({
            to: /* TBC: Auditor email address */ account.email || 'auditor@sains.com.my',
            subject: `SAINS - Auditor Confirmation Letter - Account ${account.accountNumber} - Year ${auditYear}`,
            body: `Dear Account Holder,\n\n` +
              `This is a confirmation letter for audit year ${auditYear}.\n` +
              `Account Number: ${account.accountNumber}\n` +
              `Balance as at year-end: RM ${account.balanceOutstanding}\n\n` +
              `Please confirm or report any discrepancy.\n\n` +
              `Regards,\nSAINS Finance Department`,
          });
        } catch (emailErr) {
          logger.warn(`Email notification failed for account ${account.accountNumber}: ${emailErr.message}`);
        }

        generated++;
      } catch (err) {
        logger.error(`Failed to generate letter for account ${account.accountNumber}: ${err.message}`);
      }
    }

    await logSystemAction('AUDITOR_LETTERS_GENERATED', 'AuditorConfirmationLetter', null, {
      auditYear, sampleSize, minBalance, generated,
    });

    logger.info(`Auditor confirmation letters generated: ${generated} of ${sampleSize} requested`);
    return { generated };
  });

  // ── JOB TRIGGER ACTIONS ─────────────────────────────────────────────

  this.on('triggerECLCalculation', async (req) => {
    const { year, month, runType } = req.data;

    try {
      const result = await runECLCalculation(year, month, runType);

      logger.info(`ECL calculation triggered: run ${result.runID}, total provision ${result.totalProvision}`);
      return result;
    } catch (err) {
      logger.error(`ECL calculation failed: ${err.message}`);
      return req.error(500, err.message);
    }
  });

  this.on('triggerMFRS15Extract', async (req) => {
    const { year, month } = req.data;

    try {
      const result = await extractMFRS15Revenue(year, month);

      logger.info(`MFRS 15 extract completed: ${result.recordCount} records`);
      return result;
    } catch (err) {
      logger.error(`MFRS 15 extract failed: ${err.message}`);
      return req.error(500, err.message);
    }
  });

  this.on('triggerUnclaimedMoneysScan', async (req) => {
    const { year } = req.data;

    try {
      const result = await scanUnclaimedMoneys(year);

      logger.info(`Unclaimed moneys scan completed: ${result.dormantFound} dormant, total RM ${result.totalAmount}`);
      return result;
    } catch (err) {
      logger.error(`Unclaimed moneys scan failed: ${err.message}`);
      return req.error(500, err.message);
    }
  });

  this.on('triggerSustainabilityExtract', async (req) => {
    const { year, month } = req.data;

    try {
      await extractSustainabilityData(year, month);

      logger.info(`Sustainability extract completed for ${year}-${month}`);
      return true;
    } catch (err) {
      logger.error(`Sustainability extract failed: ${err.message}`);
      return false;
    }
  });

  // ── REPORTING FUNCTIONS ─────────────────────────────────────────────

  this.on('getProvisionMatrixReport', async (req) => {
    const { matrixVersionCode } = req.data;

    const version = await SELECT.one.from(ProvisionMatrixVersion)
      .where({ versionCode: matrixVersionCode });
    if (!version) return req.error(404, `Matrix version "${matrixVersionCode}" not found`);

    const rates = await SELECT.from(ProvisionRate)
      .where({ matrixVersion_ID: version.ID })
      .orderBy({ accountTypeCode: 'asc', agingBucket: 'asc' });

    // Get the latest ECL run segment results for context
    const latestRun = await SELECT.one.from(ECLCalculationRun)
      .where({ status: { in: ['COMPLETED', 'APPROVED', 'POSTED'] } })
      .orderBy({ calculatedAt: 'desc' });

    const segmentResults = latestRun
      ? await SELECT.from(ECLSegmentResult).where({ run_ID: latestRun.ID })
      : [];

    const segmentMap = {};
    for (const seg of segmentResults) {
      const key = `${seg.accountTypeCode}-${seg.agingBucket}`;
      segmentMap[key] = seg;
    }

    return rates.map(rate => {
      const key = `${rate.accountTypeCode}-${rate.agingBucket}`;
      const seg = segmentMap[key] || {};
      return {
        accountTypeCode: rate.accountTypeCode,
        agingBucket: rate.agingBucket,
        openARAmount: seg.openARAmount || 0,
        provisionRatePct: rate.provisionRatePct || 0,
        provisionAmount: seg.provisionAmount || 0,
        rationale: rate.rationale || '',
      };
    });
  });

  this.on('getMFRS15DisaggregationReport', async (req) => {
    const { periodYear, periodMonth } = req.data;

    const records = await SELECT.from(MFRS15RevenueRecord)
      .where({ periodYear, periodMonth });

    // Aggregate by revenue type
    const aggregated = {};
    let grandTotal = 0;

    for (const rec of records) {
      const type = rec.revenueType || 'OTHER';
      if (!aggregated[type]) {
        aggregated[type] = {
          billedRevenue: 0,
          unbilledAccrual: 0,
          totalRevenue: 0,
          recognitionTiming: rec.recognitionTiming || 'POINT_IN_TIME',
        };
      }
      aggregated[type].billedRevenue += parseFloat(rec.billedRevenue) || 0;
      aggregated[type].unbilledAccrual += parseFloat(rec.unbilledAccrual) || 0;
      aggregated[type].totalRevenue += (parseFloat(rec.billedRevenue) || 0) + (parseFloat(rec.unbilledAccrual) || 0);
      grandTotal += (parseFloat(rec.billedRevenue) || 0) + (parseFloat(rec.unbilledAccrual) || 0);
    }

    return Object.entries(aggregated).map(([revenueType, data]) => ({
      revenueType,
      billedRevenue: data.billedRevenue,
      unbilledAccrual: data.unbilledAccrual,
      totalRevenue: data.totalRevenue,
      percentOfTotal: grandTotal > 0 ? data.totalRevenue / grandTotal : 0,
      recognitionTiming: data.recognitionTiming,
    }));
  });

  this.on('getARAuditTrailReport', async (req) => {
    const { fromDate, toDate, entityType } = req.data;

    const where = {};
    if (fromDate) where.timestamp = { '>=': fromDate };
    if (toDate) {
      where.timestamp = where.timestamp
        ? { ...where.timestamp, '<=': toDate }
        : { '<=': toDate };
    }
    if (entityType) where.entityType = entityType;

    const entries = await SELECT.from(ar.AuditTrailEntry)
      .where(where)
      .orderBy({ timestamp: 'desc' })
      .limit(5000);

    return entries.map(e => ({
      timestamp: e.timestamp,
      userID: e.userID,
      actionType: e.actionType,
      entityType: e.entityType,
      entityID: e.entityID,
      changeDetail: e.changeDetail,
    }));
  });
});
