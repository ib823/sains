'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { Decimal } = require('decimal.js');
const { logSystemAction } = require('./audit-logger');
const { buildDailySummaryBatch, buildJournalEntryPayload } = require('./gl-builder');

const logger = cds.log('advanced-provision-engine');

// ── AGING BUCKETS ──────────────────────────────────────────────────────────
const AGING_BUCKETS = [
  { code: 'CURRENT',   minDays: -9999, maxDays: 0   },
  { code: 'D1_30',     minDays: 1,     maxDays: 30   },
  { code: 'D31_60',    minDays: 31,    maxDays: 60   },
  { code: 'D61_90',    minDays: 61,    maxDays: 90   },
  { code: 'D91_180',   minDays: 91,    maxDays: 180  },
  { code: 'D181_365',  minDays: 181,   maxDays: 365  },
  { code: 'OVER_365',  minDays: 366,   maxDays: 9999 },
];

/**
 * Run the full MFRS 9 ECL provision calculation.
 * Loads the active provision matrix, fetches all open AR,
 * segments by account type and aging bucket, applies forward-looking
 * adjustments, calculates ECL, compares to prior period, and persists
 * the full run with segment results for auditor review.
 *
 * @param {Number} year
 * @param {Number} month
 * @param {String} runType  MONTHLY | QUARTERLY | ANNUAL | INTERIM
 * @returns {{ runID, totalProvision, netMovement }}
 */
async function runECLCalculation(year, month, runType = 'MONTHLY') {
  const db = await cds.connect.to('db');
  const runStart = Date.now();
  const asOfDate = dayjs(`${year}-${String(month).padStart(2,'0')}-01`)
    .endOf('month').format('YYYY-MM-DD');

  // 1. Load active provision matrix
  const activeVersion = await db.run(
    SELECT.one.from('sains.ar.provision.ProvisionMatrixVersion')
      .where({ isActive: true })
  );
  if (!activeVersion) {
    throw new Error('No active provision matrix version found. Activate a matrix version before running ECL.');
  }

  const rates = await db.run(
    SELECT.from('sains.ar.provision.ProvisionRate')
      .where({ version_ID: activeVersion.ID })
  );

  // Build rate lookup: { accountType_agingBucket: rate }
  const rateMap = {};
  for (const rate of rates) {
    rateMap[`${rate.accountTypeCode}_${rate.agingBucket}`] = rate;
  }

  // 2. Load forward-looking factor for this period
  const macroFactor = await db.run(
    SELECT.one.from('sains.ar.provision.ForwardLookingFactor')
      .where({ periodYear: year, periodMonth: month })
  );
  const macroAdj = macroFactor?.macroAdjFactor || 1.0;

  // 3. Fetch all open invoices with account type
  const openInvoices = await db.run(
    `SELECT
       i.amountOutstanding,
       i.dueDate,
       a.accountType_code,
       a.isGovernment
     FROM "SAINS_AR_INVOICE" i
     JOIN "SAINS_AR_CUSTOMERACCOUNT" a ON a.ID = i.account_ID
     WHERE i.status IN ('OPEN','PARTIAL')
       AND i.invoiceDate <= '${asOfDate}'`
  );

  // 4. Segment invoices into aging × account type buckets
  const segments = {};
  const today = dayjs(asOfDate);

  for (const inv of openInvoices) {
    const daysOverdue = today.diff(dayjs(inv.dueDate), 'day');
    const bucket = AGING_BUCKETS.find(b => daysOverdue >= b.minDays && daysOverdue <= b.maxDays);
    if (!bucket) continue;

    const acctType = inv.isGovernment ? 'GOV' : (inv.accountType_code || 'DOM');
    const key = `${acctType}_${bucket.code}`;

    if (!segments[key]) {
      segments[key] = {
        accountTypeCode: acctType,
        agingBucket: bucket.code,
        openARAmount: new Decimal(0),
        accountCount: 0,
      };
    }
    segments[key].openARAmount = segments[key].openARAmount.plus(new Decimal(String(inv.amountOutstanding)));
    segments[key].accountCount++;
  }

  // 5. Apply provision rates and calculate ECL per segment
  let totalProvision = new Decimal(0);
  const segmentResults = [];

  for (const [key, seg] of Object.entries(segments)) {
    // Look up rate: exact match first, then ALL wildcard, then 0%
    const rate = rateMap[key]
      || rateMap[`ALL_${seg.agingBucket}`]
      || { provisionRatePct: 0, historicalLossRate: 0, forwardLookingAdj: 0, rationale: 'Default rate (no specific mapping)' };

    // Apply forward-looking adjustment and macro factor
    const baseRate = new Decimal(String(rate.provisionRatePct));
    const fwdAdj = new Decimal(String(rate.forwardLookingAdj || 0));
    const adjustedRate = baseRate.plus(fwdAdj).times(new Decimal(String(macroAdj)));
    const clampedRate = Decimal.min(
      Decimal.max(adjustedRate, new Decimal(String(rate.minRate || 0))),
      new Decimal(String(rate.maxRate || 1))
    );

    const provisionAmount = seg.openARAmount.times(clampedRate);
    totalProvision = totalProvision.plus(provisionAmount);

    segmentResults.push({
      accountTypeCode: seg.accountTypeCode,
      agingBucket: seg.agingBucket,
      openARAmount: seg.openARAmount.toNumber(),
      accountCount: seg.accountCount,
      provisionRatePct: clampedRate.toNumber(),
      provisionAmount: provisionAmount.toDecimalPlaces(2).toNumber(),
      gdpGrowthRate: macroFactor?.gdpGrowthPct || 0,
      unemploymentRate: macroFactor?.unemploymentPct || 0,
      cpiRate: macroFactor?.cpiPct || 0,
      macroAdjFactor: macroAdj,
    });
  }

  // 6. Get prior period provision for movement calculation
  const priorMonth = month > 1 ? month - 1 : 12;
  const priorYear = month > 1 ? year : year - 1;
  const priorRuns = await db.run(
    `SELECT * FROM "SAINS_AR_PROVISION_ECLCALCULATIONRUN"
     WHERE status IN ('APPROVED','GL_POSTED')
       AND ((periodYear = ${priorYear} AND periodMonth = ${priorMonth}))
     ORDER BY runDate DESC
     LIMIT 1`
  );
  const priorRun = priorRuns?.[0] || null;
  const priorProvision = priorRun?.totalProvisionRequired || 0;
  const totalProvisionNum = totalProvision.toDecimalPlaces(2).toNumber();
  const netMovement = new Decimal(totalProvisionNum).minus(new Decimal(String(priorProvision))).toNumber();

  // 7. Create ECL run record
  const runID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.provision.ECLCalculationRun').entries({
    ID: runID,
    runDate: dayjs().format('YYYY-MM-DD'),
    periodYear: year,
    periodMonth: month,
    matrixVersion_ID: activeVersion.ID,
    runType,
    status: 'COMPLETED',
    totalOpenAR: openInvoices.reduce((s, i) => s + Number(i.amountOutstanding), 0),
    totalProvisionRequired: totalProvisionNum,
    priorPeriodProvision: priorProvision,
    netMovement,
    runDurationSeconds: Math.round((Date.now() - runStart) / 1000),
  }));

  // 8. Create segment result records
  for (const seg of segmentResults) {
    const priorSeg = priorRun ? await db.run(
      SELECT.one.from('sains.ar.provision.ECLSegmentResult')
        .where({ run_ID: priorRun.ID, accountTypeCode: seg.accountTypeCode, agingBucket: seg.agingBucket })
    ) : null;

    await db.run(INSERT.into('sains.ar.provision.ECLSegmentResult').entries({
      ID: cds.utils.uuid(),
      run_ID: runID,
      ...seg,
      priorPeriodAmount: priorSeg?.provisionAmount || 0,
      movement: seg.provisionAmount - (priorSeg?.provisionAmount || 0),
    }));
  }

  logger.info(`ECL run ${runID}: total provision RM ${totalProvisionNum.toFixed(2)}, movement RM ${netMovement.toFixed(2)}`);
  return { runID, totalProvision: totalProvisionNum, netMovement };
}

/**
 * Post ECL provision movement to SAP S/4HANA via Journal Entry API.
 * Movement > 0: Dr Bad Debt Expense / Cr Allowance for ECL
 * Movement < 0: Dr Allowance for ECL / Cr Bad Debt Expense (reversal)
 *
 * @param {String} runID
 * @param {Object} glMappings
 * @returns {{ glBatchID, documentNumber }}
 */
async function postProvisionToGL(runID, glMappings) {
  const db = await cds.connect.to('db');

  const run = await db.run(
    SELECT.one.from('sains.ar.provision.ECLCalculationRun').where({ ID: runID })
  );
  if (!run) throw new Error(`ECL run ${runID} not found`);
  if (run.status !== 'APPROVED') throw new Error(`ECL run ${runID} must be APPROVED before posting`);
  if (run.glBatchID) throw new Error(`ECL run ${runID} already posted to GL`);

  const { netMovement, periodYear, periodMonth, totalProvisionRequired } = run;
  const postingDate = dayjs(`${periodYear}-${String(periodMonth).padStart(2,'0')}-01`)
    .endOf('month').format('YYYY-MM-DD');

  // Build GL posting transaction
  const transactions = [{
    transactionType: 'PROVISION',
    accountTypeCode: 'ALL',
    chargeTypeCode: 'ALL',
    chargeType: 'ALL',
    branchCode: 'COMMON',
    amount: Math.abs(netMovement),
    referenceDocType: 'ECL_RUN',
    referenceDocID: runID,
    // If movement positive: debit BAD_DEBT_EXPENSE, credit PROVISION
    // If movement negative: debit PROVISION, credit BAD_DEBT_EXPENSE
    overrideDebitGL: netMovement >= 0 ? null : '/* TBC: PROVISION_GL */',
    overrideCreditGL: netMovement >= 0 ? null : '/* TBC: BAD_DEBT_EXPENSE_GL */',
  }];

  const batch = buildDailySummaryBatch(transactions, glMappings, postingDate,
    '/* TBC: SAP_COMPANY_CODE */');
  batch.headerText = `MFRS9 ECL Provision ${periodYear}-${String(periodMonth).padStart(2,'0')}`;

  const payload = buildJournalEntryPayload(batch);

  // Post to SAP Core
  const sapCoreApi = require('../external/sap-core-api');
  const postResult = await sapCoreApi.postJournalEntry(payload);

  if (!postResult.success) {
    throw new Error(`GL posting failed: ${postResult.errorMessage}`);
  }

  // Update run record
  const glBatchID = cds.utils.uuid();
  await db.run(UPDATE('sains.ar.provision.ECLCalculationRun').set({
    status: 'GL_POSTED',
    glBatchID,
  }).where({ ID: runID }));

  // Update BadDebtProvision records in Phase 1 entity
  // Create/update provision records per segment
  const segments = await db.run(
    SELECT.from('sains.ar.provision.ECLSegmentResult').where({ run_ID: runID })
  );
  for (const seg of segments) {
    const existing = await db.run(
      SELECT.one.from('sains.ar.BadDebtProvision')
        .where({ periodYear, periodMonth, accountType: seg.accountTypeCode, agingBucket: seg.agingBucket })
    );

    const provisionRecord = {
      periodYear, periodMonth,
      accountType: seg.accountTypeCode,
      agingBucket: seg.agingBucket,
      openARAmount: seg.openARAmount,
      provisionRate: seg.provisionRatePct,
      provisionAmount: seg.provisionAmount,
      status: 'POSTED',
      approvedBy: run.approvedBy,
      glPostingRef: postResult.documentNumber,
    };

    if (existing) {
      await db.run(UPDATE('sains.ar.BadDebtProvision').set(provisionRecord).where({ ID: existing.ID }));
    } else {
      await db.run(INSERT.into('sains.ar.BadDebtProvision').entries({
        ID: cds.utils.uuid(), ...provisionRecord,
      }));
    }
  }

  logger.info(`ECL run ${runID} posted to GL: document ${postResult.documentNumber}`);
  return { glBatchID, documentNumber: postResult.documentNumber };
}

/**
 * Extract MFRS 15 revenue disaggregation data for a period.
 * Reads from InvoiceLineItems grouped by charge type.
 *
 * @param {Number} year
 * @param {Number} month
 */
async function extractMFRS15Revenue(year, month) {
  const db = await cds.connect.to('db');
  const periodStr = `${year}-${String(month).padStart(2,'0')}`;
  const fromDate = `${periodStr}-01`;
  const toDate = dayjs(`${periodStr}-01`).endOf('month').format('YYYY-MM-DD');

  const revenueByType = await db.run(
    `SELECT
       li.chargeType_code,
       a.accountType_code,
       SUM(li.lineAmount - COALESCE(li.taxAmount, 0)) AS revenue,
       SUM(COALESCE(li.taxAmount, 0)) AS taxAmt
     FROM "SAINS_AR_INVOICELINEITEM" li
     JOIN "SAINS_AR_INVOICE" i ON i.ID = li.invoice_ID
     JOIN "SAINS_AR_CUSTOMERACCOUNT" a ON a.ID = i.account_ID
     WHERE i.invoiceDate BETWEEN '${fromDate}' AND '${toDate}'
       AND i.status NOT IN ('REVERSED','CANCELLED')
     GROUP BY li.chargeType_code, a.accountType_code`
  );

  let recordCount = 0;
  for (const row of revenueByType) {
    const revenueType = _mapChargeTypeToMFRS15(row.chargeType_code);
    const recognitionTiming = ['CONNECTION_FEE', 'RECONNECTION_FEE', 'METER_RENTAL']
      .includes(row.chargeType_code) ? 'POINT_IN_TIME' : 'OVER_TIME';

    const existing = await db.run(
      SELECT.one.from('sains.ar.provision.MFRS15RevenueRecord')
        .where({
          periodYear: year, periodMonth: month,
          revenueType, accountTypeCode: row.accountType_code,
        })
    );

    const record = {
      periodYear: year, periodMonth: month,
      revenueType, accountTypeCode: row.accountType_code,
      recognitionTiming,
      billedRevenue: Number(row.revenue || 0),
      unbilledAccrual: 0, // Calculated separately by period accrual job
      totalRevenue: Number(row.revenue || 0),
      taxAmount: Number(row.taxAmt || 0),
    };

    if (existing) {
      await db.run(UPDATE('sains.ar.provision.MFRS15RevenueRecord').set(record).where({ ID: existing.ID }));
    } else {
      await db.run(INSERT.into('sains.ar.provision.MFRS15RevenueRecord').entries({
        ID: cds.utils.uuid(), ...record,
      }));
    }
    recordCount++;
  }

  return { recordCount };
}

/**
 * Scan for dormant deposits for Unclaimed Moneys Act compliance.
 * Deposits dormant for 7+ years must be reported to Registrar.
 *
 * @param {Number} year - Reporting year
 */
async function scanUnclaimedMoneys(year) {
  const db = await cds.connect.to('db');
  const dormancyCutoff = dayjs(`${year}-01-01`).subtract(7, 'year').format('YYYY-MM-DD');

  const dormantDeposits = await db.run(
    SELECT.from('sains.ar.DepositRecord')
      .columns('ID', 'account_ID', 'depositDate', 'amount', 'status')
      .where({
        status: 'HELD',
        depositDate: { '<=': dormancyCutoff },
      })
  );

  if (dormantDeposits.length === 0) {
    return { dormantFound: 0, totalAmount: 0 };
  }

  const totalAmount = dormantDeposits.reduce((s, d) => s + Number(d.amount), 0);

  // Create or update register
  const existing = await db.run(
    SELECT.one.from('sains.ar.provision.DepositLiabilityRegister').where({ reportYear: year })
  );

  const registerData = {
    reportYear: year,
    generatedAt: new Date().toISOString(),
    status: 'DRAFT',
    totalDepositHeld: 0, // Full total calculated separately
    dormantCount: dormantDeposits.length,
    dormantAmount: totalAmount,
  };

  let registerID;
  if (existing) {
    registerID = existing.ID;
    await db.run(UPDATE('sains.ar.provision.DepositLiabilityRegister').set(registerData).where({ ID: registerID }));
    await db.run(DELETE.from('sains.ar.provision.DepositLiabilityEntry').where({ register_ID: registerID }));
  } else {
    registerID = cds.utils.uuid();
    await db.run(INSERT.into('sains.ar.provision.DepositLiabilityRegister').entries({
      ID: registerID, ...registerData,
    }));
  }

  for (const deposit of dormantDeposits) {
    await db.run(INSERT.into('sains.ar.provision.DepositLiabilityEntry').entries({
      ID: cds.utils.uuid(),
      register_ID: registerID,
      account_ID: deposit.account_ID,
      deposit_ID: deposit.ID,
      depositAmount: deposit.amount,
      depositDate: deposit.depositDate,
      dormancySince: deposit.depositDate,
      isDormant: true,
      noticesSent: 0,
    }));
  }

  logger.info(`Unclaimed moneys scan: ${dormantDeposits.length} dormant deposits, RM ${totalAmount.toFixed(2)}`);
  return { dormantFound: dormantDeposits.length, totalAmount };
}

/**
 * Extract sustainability / ESG AR data for NSRF reporting.
 */
async function extractSustainabilityData(year, month) {
  const db = await cds.connect.to('db');
  const periodStr = `${year}-${String(month).padStart(2,'0')}`;
  const fromDate = `${periodStr}-01`;
  const toDate = dayjs(`${periodStr}-01`).endOf('month').format('YYYY-MM-DD');

  const [customers, arrears, hardship, vulnerable, digital] = await Promise.all([
    db.run(`SELECT COUNT(*) AS c FROM "SAINS_AR_CUSTOMERACCOUNT"
            WHERE accountStatus NOT IN ('VOID','CLOSED')`),
    db.run(`SELECT COUNT(*) AS c, AVG(balanceOutstanding) AS avg
            FROM "SAINS_AR_CUSTOMERACCOUNT"
            WHERE balanceOutstanding > 0 AND accountStatus = 'ACTIVE'`),
    db.run(`SELECT COUNT(*) AS c, SUM(monthlyPaymentAmount) AS amt
            FROM "SAINS_AR_COLLECTIONS_HARDSHIPASSESSMENT"
            WHERE outcome = 'APPROVED' AND schemeEndDate >= '${fromDate}'`),
    db.run(`SELECT COUNT(*) AS c FROM "SAINS_AR_COLLECTIONS_VULNERABILITYRECORD"
            WHERE isActive = TRUE`),
    db.run(`SELECT
              SUM(CASE WHEN channel IN ('FPX','PORTAL_FPX','DUITNOW_QR','JOMPAY','EMANDATE') THEN 1 ELSE 0 END) AS digi,
              COUNT(*) AS total
            FROM "SAINS_AR_PAYMENT"
            WHERE paymentDate BETWEEN '${fromDate}' AND '${toDate}'
              AND status NOT IN ('REVERSED','BOUNCED')`),
  ]);

  const totalCustomers = Number(customers?.[0]?.c || 0);
  const totalPayments = Number(digital?.[0]?.total || 1);

  const data = {
    periodYear: year, periodMonth: month,
    totalCustomers,
    customersInArrears: Number(arrears?.[0]?.c || 0),
    arrearsRatio: totalCustomers > 0 ? Number(arrears?.[0]?.c || 0) / totalCustomers : 0,
    avgArrearsAmount: Number(arrears?.[0]?.avg || 0),
    hardshipSchemeCount: Number(hardship?.[0]?.c || 0),
    hardshipSchemeAmount: Number(hardship?.[0]?.amt || 0),
    vulnerableRegistered: Number(vulnerable?.[0]?.c || 0),
    digitalPaymentPct: totalPayments > 0 ? Number(digital?.[0]?.digi || 0) / totalPayments : 0,
  };

  const existing = await db.run(
    SELECT.one.from('sains.ar.provision.SustainabilityARData')
      .where({ periodYear: year, periodMonth: month })
  );

  if (existing) {
    await db.run(UPDATE('sains.ar.provision.SustainabilityARData').set(data).where({ ID: existing.ID }));
  } else {
    await db.run(INSERT.into('sains.ar.provision.SustainabilityARData').entries({ ID: cds.utils.uuid(), ...data }));
  }

  return true;
}

function _mapChargeTypeToMFRS15(chargeTypeCode) {
  const mapping = {
    'WATER_CONSUMPTION': 'WATER_CONSUMPTION',
    'BASE_CHARGE':       'BASE_CHARGE',
    'SEWERAGE':          'SEWERAGE',
    'PAAB':              'PAAB',
    'CONNECTION_FEE':    'CONNECTION_FEE',
    'RECONNECTION_FEE':  'RECONNECTION_FEE',
    'LATE_PAYMENT':      'LATE_PAYMENT',
    'METER_RENTAL':      'METER_RENTAL',
    'DEPOSIT_RECEIPT':   'OTHER',
    'ADJUSTMENT_CREDIT': 'OTHER',
    'ADJUSTMENT_DEBIT':  'OTHER',
    'LEGAL_FEE':         'OTHER',
  };
  return mapping[chargeTypeCode] || 'OTHER';
}

module.exports = {
  runECLCalculation,
  postProvisionToGL,
  extractMFRS15Revenue,
  scanUnclaimedMoneys,
  extractSustainabilityData,
};
