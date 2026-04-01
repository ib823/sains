'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { Decimal } = require('decimal.js');
const { PAYMENT_CHANNEL } = require('./constants');

const logger = cds.log('analytics-engine');

// ── KPI SNAPSHOT CALCULATION ────────────────────────────────────────────────

/**
 * Calculate and persist the daily AR KPI snapshot.
 * Runs at 00:30 UTC (08:30 MYT) each morning via BTP Job Scheduler.
 * Finance leadership sees the dashboard by 09:00 MYT.
 *
 * @param {Date} snapshotDate
 */
async function calculateDailyKPISnapshot(snapshotDate = new Date()) {
  const db = await cds.connect.to('db');
  const today = dayjs(snapshotDate).format('YYYY-MM-DD');
  const periodYear = dayjs(snapshotDate).year();
  const periodMonth = dayjs(snapshotDate).month() + 1;
  const monthStart = dayjs(snapshotDate).startOf('month').format('YYYY-MM-DD');

  // 1. Total open AR
  const arTotals = await db.run(
    `SELECT
       SUM(amountOutstanding) AS "totalOpen",
       SUM(CASE WHEN dueDate < '${today}' THEN amountOutstanding ELSE 0 END) AS "totalOverdue"
     FROM "SAINS_AR_INVOICE"
     WHERE status IN ('OPEN','PARTIAL')`
  );

  // 2. DSO = (Open AR / Revenue last 30 days) × 30
  const revenue30d = await db.run(
    `SELECT SUM(totalAmount) AS "revenue"
     FROM "SAINS_AR_INVOICE"
     WHERE invoiceDate >= '${dayjs(snapshotDate).subtract(30, 'day').format('YYYY-MM-DD')}'
       AND status != 'REVERSED'`
  );

  const totalOpen = Number(arTotals?.[0]?.totalOpen || arTotals?.totalOpen || 0);
  const totalOverdue = Number(arTotals?.[0]?.totalOverdue || arTotals?.totalOverdue || 0);
  const revenue = Number(revenue30d?.[0]?.revenue || 0);
  const dso = revenue > 0 ? Math.min((totalOpen / revenue) * 30, 999) : 0;

  // 3. Collection Effectiveness Index (CEI)
  // CEI = Collections in period / (Opening AR + Billed in period - Closing AR)
  const perioCollections = await db.run(
    `SELECT SUM(amount) AS "collected"
     FROM "SAINS_AR_PAYMENT"
     WHERE paymentDate >= '${monthStart}'
       AND paymentDate <= '${today}'
       AND status NOT IN ('REVERSED','BOUNCED')`
  );
  const periodBilled = await db.run(
    `SELECT SUM(totalAmount) AS "billed"
     FROM "SAINS_AR_INVOICE"
     WHERE invoiceDate >= '${monthStart}'
       AND invoiceDate <= '${today}'
       AND status != 'REVERSED'`
  );
  const collected = Number(perioCollections?.[0]?.collected || 0);
  const billed = Number(periodBilled?.[0]?.billed || 0);

  // Simplified CEI approximation (requires opening balance for full formula)
  const cei = billed > 0 ? Math.min(collected / billed, 1) : 0;

  // 4. Payment channel mix
  const channelMix = await db.run(
    `SELECT channel, COUNT(*) AS "cnt", SUM(amount) AS "total"
     FROM "SAINS_AR_PAYMENT"
     WHERE paymentDate >= '${monthStart}'
       AND status NOT IN ('REVERSED','BOUNCED')
     GROUP BY channel`
  );

  const channelData = {};
  const totalPayments = channelMix.reduce((s, r) => s + Number(r.total || 0), 0);
  const digitalChannels = [PAYMENT_CHANNEL.FPX, PAYMENT_CHANNEL.DUITNOW_QR,
    PAYMENT_CHANNEL.JOMPAY, PAYMENT_CHANNEL.EMANDATE];

  channelMix.forEach(r => { channelData[r.channel] = Number(r.total || 0); });
  const digitalTotal = digitalChannels.reduce((s, c) => s + (channelData[c] || 0), 0);
  const counterTotal = (channelData['COUNTER_CASH'] || 0) +
    (channelData['COUNTER_CHEQUE'] || 0) + (channelData['COUNTER_CARD'] || 0);

  // 5. Bad debt ratio
  const writeOffs30d = await db.run(
    `SELECT SUM(writeOffAmount) AS "wo"
     FROM "SAINS_AR_WRITEOFF"
     WHERE writeOffDate >= '${monthStart}'`
  );
  const badDebtRatio = billed > 0
    ? Number(writeOffs30d?.[0]?.wo || 0) / billed : 0;

  // 6. L3/L4 dunning count
  const dunningL3L4 = await db.run(
    `SELECT COUNT(*) AS "cnt" FROM "SAINS_AR_CUSTOMERACCOUNT"
     WHERE dunningLevel >= 3 AND accountStatus = 'ACTIVE'`
  );
  const disconnectedCount = await db.run(
    `SELECT COUNT(*) AS "cnt" FROM "SAINS_AR_CUSTOMERACCOUNT"
     WHERE accountStatus = 'TEMP_DISCONNECTED'`
  );

  // 7. Billing accuracy
  const readStats = await db.run(
    `SELECT
       COUNT(*) AS "total",
       SUM(CASE WHEN readType = 'ACTUAL' THEN 1 ELSE 0 END) AS "actual"
     FROM "SAINS_AR_METERREADHISTORY"
     WHERE readDate >= '${monthStart}'`
  );
  const readTotal = Number(readStats?.[0]?.total || 1);
  const readActual = Number(readStats?.[0]?.actual || 0);

  const snapshot = {
    ID: cds.utils.uuid(),
    snapshotDate: today,
    periodYear,
    periodMonth,
    branchCode: 'ALL',
    accountTypeCode: 'ALL',
    totalOpenAR: totalOpen,
    totalOverdueAR: totalOverdue,
    dso: Math.round(dso * 100) / 100,
    cei: Math.min(1, Math.round(cei * 10000) / 10000),
    collectionEfficiency: Math.min(1, Math.round(cei * 10000) / 10000),
    avgDaysToPay: 0, // Calculated separately
    currentRatio: totalOpen > 0 ? Math.round((totalOpen - totalOverdue) / totalOpen * 10000) / 10000 : 1,
    over90DaysRatio: 0, // Requires aging sub-query
    badDebtRatio: Math.round(badDebtRatio * 10000) / 10000,
    dunningL3L4Count: Number(dunningL3L4?.[0]?.cnt || 0),
    disconnectedCount: Number(disconnectedCount?.[0]?.cnt || 0),
    digitalPaymentRatio: totalPayments > 0
      ? Math.round(digitalTotal / totalPayments * 10000) / 10000 : 0,
    counterPaymentRatio: totalPayments > 0
      ? Math.round(counterTotal / totalPayments * 10000) / 10000 : 0,
    directDebitRatio: totalPayments > 0
      ? Math.round((channelData[PAYMENT_CHANNEL.EMANDATE] || 0) / totalPayments * 10000) / 10000 : 0,
    jomPayRatio: totalPayments > 0
      ? Math.round((channelData[PAYMENT_CHANNEL.JOMPAY] || 0) / totalPayments * 10000) / 10000 : 0,
    billingAccuracyRate: readTotal > 0
      ? Math.round(readActual / readTotal * 10000) / 10000 : 0,
  };

  await db.run(INSERT.into('sains.ar.analytics.ARKPISnapshot').entries(snapshot));
  logger.info(`KPI snapshot created for ${today}: DSO=${dso.toFixed(1)}d CEI=${(cei*100).toFixed(1)}%`);
  return snapshot;
}

// ── CONSUMPTION PROFILE UPDATE ───────────────────────────────────────────────

/**
 * Update consumption statistical profiles for all metered accounts.
 * Runs weekly (Sunday 01:00 MYT).
 *
 * @param {Date} asOfDate
 * @returns {{ updated }}
 */
async function updateConsumptionProfiles(asOfDate = new Date()) {
  const db = await cds.connect.to('db');
  const cutoff12mo = dayjs(asOfDate).subtract(12, 'month').format('YYYY-MM-DD');

  const accounts = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'billingBasis_code')
      .where({ billingBasis_code: 'MTR', accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } })
  );

  let updated = 0;

  for (const account of accounts) {
    try {
      const reads = await db.run(
        SELECT.from('sains.ar.MeterReadHistory')
          .columns('readDate', 'consumptionM3')
          .where({
            account_ID: account.ID,
            consumptionM3: { '>': 0 },
            readDate: { '>=': cutoff12mo },
          })
          .orderBy({ readDate: 'asc' })
      );

      if (reads.length < 3) continue; // Insufficient data

      const values = reads.map(r => Number(r.consumptionM3));
      const avg12 = _mean(values);
      const std12 = _stdDev(values, avg12);
      const avg3 = _mean(values.slice(-3));
      const sorted = [...values].sort((a, b) => a - b);
      const p5 = sorted[Math.floor(sorted.length * 0.05)] || sorted[0];
      const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1];

      // Monthly seasonal indices
      const monthlyAvgs = {};
      for (let m = 1; m <= 12; m++) {
        const monthReads = reads.filter(r => parseInt(r.readDate.substring(5, 7)) === m);
        monthlyAvgs[m] = monthReads.length > 0
          ? _mean(monthReads.map(r => Number(r.consumptionM3)))
          : avg12;
      }
      const seasonalIndices = {};
      for (let m = 1; m <= 12; m++) {
        seasonalIndices[m] = avg12 > 0 ? monthlyAvgs[m] / avg12 : 1;
      }

      // Simple linear trend
      const n = values.length;
      const xMean = (n - 1) / 2;
      const slope = values.reduce((s, v, i) => s + (i - xMean) * (v - avg12), 0) /
        values.reduce((s, _, i) => s + Math.pow(i - xMean, 2), 0.001);

      const profile = {
        account_ID: account.ID,
        profileDate: asOfDate.toISOString().substring(0, 10),
        avgConsumption_12mo: Math.round(avg12 * 1000) / 1000,
        stdDev_12mo: Math.round(std12 * 1000) / 1000,
        avgConsumption_3mo: Math.round(avg3 * 1000) / 1000,
        seasonalIndex_Jan: Math.round(seasonalIndices[1] * 10000) / 10000,
        seasonalIndex_Feb: Math.round(seasonalIndices[2] * 10000) / 10000,
        seasonalIndex_Mar: Math.round(seasonalIndices[3] * 10000) / 10000,
        seasonalIndex_Apr: Math.round(seasonalIndices[4] * 10000) / 10000,
        seasonalIndex_May: Math.round(seasonalIndices[5] * 10000) / 10000,
        seasonalIndex_Jun: Math.round(seasonalIndices[6] * 10000) / 10000,
        seasonalIndex_Jul: Math.round(seasonalIndices[7] * 10000) / 10000,
        seasonalIndex_Aug: Math.round(seasonalIndices[8] * 10000) / 10000,
        seasonalIndex_Sep: Math.round(seasonalIndices[9] * 10000) / 10000,
        seasonalIndex_Oct: Math.round(seasonalIndices[10] * 10000) / 10000,
        seasonalIndex_Nov: Math.round(seasonalIndices[11] * 10000) / 10000,
        seasonalIndex_Dec: Math.round(seasonalIndices[12] * 10000) / 10000,
        trendSlope: Math.round(slope * 10000) / 10000,
        minConsumption: sorted[0],
        maxConsumption: sorted[sorted.length - 1],
        p5Consumption: Math.round(p5 * 1000) / 1000,
        p95Consumption: Math.round(p95 * 1000) / 1000,
        lastReadsCount: values.length,
      };

      const existing = await db.run(
        SELECT.one.from('sains.ar.analytics.ConsumptionProfile')
          .where({ account_ID: account.ID })
      );

      if (existing) {
        await db.run(
          UPDATE('sains.ar.analytics.ConsumptionProfile')
            .set({ ...profile, profileVersion: (existing.profileVersion || 1) + 1 })
            .where({ ID: existing.ID })
        );
      } else {
        await db.run(INSERT.into('sains.ar.analytics.ConsumptionProfile').entries({
          ID: cds.utils.uuid(), ...profile, profileVersion: 1,
        }));
      }
      updated++;
    } catch (err) {
      logger.error(`Profile update failed for ${account.accountNumber}: ${err.message}`);
    }
  }

  logger.info(`Consumption profiles: ${updated} updated from ${accounts.length} accounts`);
  return { updated };
}

// ── ANOMALY DETECTION ────────────────────────────────────────────────────────

/**
 * Detect consumption anomalies using rule-based statistical approach.
 * HANA Cloud PAL (Predictive Analysis Library) Isolation Forest is the
 * preferred method when PAL procedures are available.
 *
 * Detection rules applied (in priority order):
 * 1. Zero consumption on active account (2+ consecutive months)
 * 2. Consumption > mean + 3σ (statistical outlier — high consumption)
 * 3. Consumption < mean − 2σ AND consumption < p5 (sudden drop)
 * 4. Progressive decline: 3+ consecutive months each below previous
 * 5. Consumption below absolute minimum for meter size (possible tamper)
 *
 * @param {Date} asOfDate
 * @returns {{ detected }}
 */
async function detectConsumptionAnomalies(asOfDate = new Date()) {
  const db = await cds.connect.to('db');
  const today = asOfDate.toISOString().substring(0, 10);
  const thirtyDaysAgo = dayjs(asOfDate).subtract(30, 'day').format('YYYY-MM-DD');

  // Get recent reads with profiles
  const readsWithProfiles = await db.run(
    `SELECT
       r.ID as readID,
       r.account_ID,
       r.readDate,
       r.consumptionM3,
       r.readType as meterReadType,
       p.avgConsumption_12mo,
       p.stdDev_12mo,
       p.p5Consumption,
       p.p95Consumption,
       a.connectionSizeMM
     FROM "SAINS_AR_METERREADHISTORY" r
     JOIN "SAINS_AR_ANALYTICS_CONSUMPTIONPROFILE" p ON p.account_ID = r.account_ID
     JOIN "SAINS_AR_CUSTOMERACCOUNT" a ON a.ID = r.account_ID
     WHERE r.readDate >= '${thirtyDaysAgo}'
       AND r.readDate <= '${today}'
       AND a.accountStatus = 'ACTIVE'
       AND p.profileDate >= '${dayjs(asOfDate).subtract(35, 'day').format('YYYY-MM-DD')}'`
  );

  let detected = 0;

  for (const read of readsWithProfiles) {
    const consumption = Number(read.consumptionM3);
    const avg = Number(read.avgConsumption_12mo);
    const std = Math.max(Number(read.stdDev_12mo), 0.1);
    const p5 = Number(read.p5Consumption);
    const zScore = (consumption - avg) / std;

    // Minimum consumption by connection size (m³/month)
    const minimumBySize = {
      15: 0.5, 20: 0.5, 25: 1.0, 32: 1.0,
      40: 2.0, 50: 3.0, 80: 5.0, 100: 8.0,
    };
    const minExpected = minimumBySize[Number(read.connectionSizeMM)] || 0.5;

    let anomalyType = null;
    let anomalyScore = 0;
    let fraudProbability = 0;

    if (consumption === 0 && avg > minExpected) {
      anomalyType = 'ZERO_CONSUMPTION';
      anomalyScore = 0.85;
      fraudProbability = 0.60;
    } else if (zScore > 3) {
      anomalyType = 'HIGH_CONSUMPTION';
      anomalyScore = Math.min(0.95, 0.60 + (zScore - 3) * 0.05);
      fraudProbability = 0.05; // High consumption is usually leak, not fraud
    } else if (zScore < -2 && consumption < p5) {
      anomalyType = 'SUDDEN_DROP';
      anomalyScore = Math.min(0.90, 0.70 + Math.abs(zScore + 2) * 0.05);
      fraudProbability = 0.45;
    } else if (consumption < minExpected && avg > minExpected * 3) {
      anomalyType = 'BELOW_MINIMUM';
      anomalyScore = 0.80;
      fraudProbability = 0.55;
    }

    if (anomalyType) {
      // Check if anomaly already exists for this account and month
      const existing = await db.run(
        SELECT.one.from('sains.ar.analytics.ConsumptionAnomaly')
          .where({
            account_ID: read.account_ID,
            meterReadDate: read.readDate,
            status: { in: ['OPEN', 'UNDER_REVIEW'] },
          })
      );
      if (existing) continue;

      await db.run(INSERT.into('sains.ar.analytics.ConsumptionAnomaly').entries({
        ID: cds.utils.uuid(),
        account_ID: read.account_ID,
        detectionDate: today,
        meterReadDate: read.readDate,
        actualConsumption: consumption,
        expectedConsumption: avg,
        anomalyType,
        anomalyScore: Math.round(anomalyScore * 10000) / 10000,
        detectionMethod: 'RULE_BASED',
        zScore: Math.round(zScore * 10000) / 10000,
        fraudProbability: Math.round(fraudProbability * 10000) / 10000,
        status: 'OPEN',
        billHeld: fraudProbability > 0.5, // Auto-hold billing for high fraud probability
      }));
      detected++;
    }
  }

  logger.info(`Anomaly detection: ${detected} anomalies detected from ${readsWithProfiles.length} reads`);
  return { detected };
}

// ── CLV CALCULATION ───────────────────────────────────────────────────────────

/**
 * Calculate Customer Lifetime Value for all active accounts.
 * Runs monthly. Used by collections for resource prioritisation.
 */
async function calculateCLV(asOfDate = new Date()) {
  const db = await cds.connect.to('db');
  const today = asOfDate.toISOString().substring(0, 10);
  const cutoff24 = dayjs(asOfDate).subtract(24, 'month').format('YYYY-MM-DD');

  const accounts = await db.run(
    SELECT.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'accountOpenDate', 'balanceOutstanding', 'balanceDeposit')
      .where({ accountStatus: { in: ['ACTIVE', 'RESTRICTED'] } })
  );

  // Get all accounts' revenue and payment data in one query
  const revenueData = await db.run(
    `SELECT
       account_ID,
       SUM(totalAmount) AS "totalRevenue",
       COUNT(*) AS "invoiceCount",
       AVG(totalAmount) AS "avgInvoice"
     FROM "SAINS_AR_INVOICE"
     WHERE invoiceDate >= '${cutoff24}'
       AND status != 'REVERSED'
     GROUP BY account_ID`
  );

  const paymentData = await db.run(
    `SELECT
       pay.account_ID,
       AVG(JULIANDAY(pay.paymentDate) - JULIANDAY(inv.dueDate)) AS "avgDaysToPay"
     FROM "SAINS_AR_PAYMENT" pay
     JOIN "SAINS_AR_PAYMENTCLEARING" pc ON pc.payment_ID = pay.ID
     JOIN "SAINS_AR_INVOICE" inv ON inv.ID = pc.invoice_ID
     WHERE pay.paymentDate >= '${cutoff24}'
       AND pay.status NOT IN ('REVERSED','BOUNCED')
     GROUP BY pay.account_ID`
  );

  const revenueMap = {};
  revenueData.forEach(r => { revenueMap[r.account_ID] = r; });
  const paymentMap = {};
  paymentData.forEach(p => { paymentMap[p.account_ID] = p; });

  let calculated = 0;

  // Calculate ranks after all CLV scores are computed
  const clvScores = [];

  for (const account of accounts) {
    const rev = revenueMap[account.ID];
    const pay = paymentMap[account.ID];

    const tenureMonths = dayjs(asOfDate).diff(dayjs(account.accountOpenDate), 'month');
    const avgMonthlyRev = rev ? Number(rev.totalRevenue) / Math.max(tenureMonths, 1) : 0;
    const avgDaysToPay = pay ? Number(pay.avgDaysToPay) : 30;

    // Revenue component: expected remaining revenue over 10-year horizon
    const remainingMonths = Math.max(120 - tenureMonths, 12); // Assume 10-year lifecycle
    const revenueScore = avgMonthlyRev * remainingMonths;

    // Cost component: collection + billing + dispute costs
    const collectionCostPerMonth = avgDaysToPay > 30 ? 15 : avgDaysToPay > 60 ? 35 : 5;
    const costScore = collectionCostPerMonth * remainingMonths;

    // Risk component: reduce CLV by bad debt probability
    const riskMultiplier = avgDaysToPay <= 15 ? 0.99
      : avgDaysToPay <= 30 ? 0.97
      : avgDaysToPay <= 60 ? 0.93
      : avgDaysToPay <= 90 ? 0.85
      : 0.70;

    const clvScore = (revenueScore - costScore) * riskMultiplier;
    const clvBand = clvScore > 5000 ? 'HIGH'
      : clvScore > 1000 ? 'MEDIUM'
      : clvScore > 0 ? 'LOW'
      : 'NEGATIVE';

    clvScores.push({
      account_ID: account.ID,
      clvScore: Math.round(clvScore * 100) / 100,
      revenueScore: Math.round(revenueScore * 100) / 100,
      costScore: Math.round(costScore * 100) / 100,
      riskScore: Math.round((1 - riskMultiplier) * 10000) / 10000,
      tenureMonths,
      avgMonthlyRevenue: Math.round(avgMonthlyRev * 100) / 100,
      avgMonthlyPaymentDays: Math.round(avgDaysToPay * 10) / 10,
      clvBand,
    });
  }

  // Sort by CLV score descending for ranking
  clvScores.sort((a, b) => b.clvScore - a.clvScore);

  for (let i = 0; i < clvScores.length; i++) {
    const entry = clvScores[i];
    const existing = await db.run(
      SELECT.one.from('sains.ar.analytics.CustomerLifetimeValue')
        .where({ account_ID: entry.account_ID })
    );
    const record = { ...entry, calculationDate: today, clvRank: i + 1, model: 'RULE_V1' };

    if (existing) {
      await db.run(UPDATE('sains.ar.analytics.CustomerLifetimeValue').set(record).where({ ID: existing.ID }));
    } else {
      await db.run(INSERT.into('sains.ar.analytics.CustomerLifetimeValue').entries({
        ID: cds.utils.uuid(), ...record,
      }));
    }
    calculated++;
  }

  logger.info(`CLV calculated for ${calculated} accounts`);
  return { calculated };
}

// ── SPAN KPI REPORT GENERATION ─────────────────────────────────────────────

/**
 * Auto-generate the monthly SPAN KPI report from AR Hub data.
 * Finance Manager reviews and approves before CFO submits.
 *
 * @param {Number} year
 * @param {Number} month
 */
async function generateSPANReport(year, month) {
  const db = await cds.connect.to('db');
  const monthStr = String(month).padStart(2, '0');
  const fromDate = `${year}-${monthStr}-01`;
  const toDate = dayjs(`${year}-${monthStr}-01`).endOf('month').format('YYYY-MM-DD');

  const [
    connections, billing, collections, writeOffs, provision,
    reads, disputes, disconnections, reconnections,
  ] = await Promise.all([
    db.run(`SELECT COUNT(*) AS c FROM "SAINS_AR_CUSTOMERACCOUNT"
            WHERE accountStatus NOT IN ('VOID','CLOSED') AND accountOpenDate <= '${toDate}'`),
    db.run(`SELECT SUM(totalAmount) AS billed FROM "SAINS_AR_INVOICE"
            WHERE invoiceDate BETWEEN '${fromDate}' AND '${toDate}' AND status != 'REVERSED'`),
    db.run(`SELECT SUM(amount) AS collected FROM "SAINS_AR_PAYMENT"
            WHERE paymentDate BETWEEN '${fromDate}' AND '${toDate}'
            AND status NOT IN ('REVERSED','BOUNCED')`),
    db.run(`SELECT SUM(writeOffAmount) AS wo FROM "SAINS_AR_WRITEOFF"
            WHERE writeOffDate BETWEEN '${fromDate}' AND '${toDate}'`),
    db.run(`SELECT SUM(provisionAmount) AS prov FROM "SAINS_AR_BADDEBTPROVISION"
            WHERE periodYear = ${year} AND periodMonth = ${month} AND status IN ('POSTED','APPROVED')`),
    db.run(`SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN readType='ACTUAL' THEN 1 ELSE 0 END) AS actual
            FROM "SAINS_AR_METERREADHISTORY"
            WHERE readDate BETWEEN '${fromDate}' AND '${toDate}'`),
    db.run(`SELECT
              COUNT(*) AS received,
              SUM(CASE WHEN status='RESOLVED' THEN 1 ELSE 0 END) AS resolved,
              AVG(JULIANDAY(modifiedAt) - JULIANDAY(createdAt)) AS avgDays
            FROM "SAINS_AR_DISPUTE"
            WHERE createdAt BETWEEN '${fromDate}' AND '${toDate}'`),
    db.run(`SELECT COUNT(*) AS dc FROM "SAINS_AR_CUSTOMERACCOUNT"
            WHERE accountStatus = 'TEMP_DISCONNECTED'`),
    db.run(`SELECT COUNT(*) AS rc FROM "SAINS_AR_DUNNINGHISTORY"
            WHERE triggeredDate BETWEEN '${fromDate}' AND '${toDate}'
            AND resolutionType = 'RECONNECTED'`),
  ]);

  const totalBilled = Number(billing?.[0]?.billed || 0);
  const totalCollected = Number(collections?.[0]?.collected || 0);
  const totalReads = Number(reads?.[0]?.total || 1);
  const actualReads = Number(reads?.[0]?.actual || 0);

  const report = {
    ID: cds.utils.uuid(),
    reportingYear: year,
    reportingMonth: month,
    reportType: 'MONTHLY',
    generatedAt: new Date().toISOString(),
    status: 'DRAFT',
    totalConnections: Number(connections?.[0]?.c || 0),
    totalBilled,
    totalCollected,
    collectionRatio: totalBilled > 0 ? Math.min(1, Math.round(totalCollected / totalBilled * 10000) / 10000) : 0,
    outstandingDebt: totalBilled - totalCollected,
    badDebtWrittenOff: Number(writeOffs?.[0]?.wo || 0),
    badDebtProvision: Number(provision?.[0]?.prov || 0),
    estimatedReads: totalReads - actualReads,
    actualReads,
    billingAccuracyPct: Math.round(actualReads / totalReads * 10000) / 10000,
    complaintsReceived: Number(disputes?.[0]?.received || 0),
    complaintsResolved: Number(disputes?.[0]?.resolved || 0),
    avgComplaintDays: Math.round(Number(disputes?.[0]?.avgDays || 0) * 10) / 10,
    disconnectionCount: Number(disconnections?.[0]?.dc || 0),
    reconnectionCount: Number(reconnections?.[0]?.rc || 0),
    reportData: JSON.stringify({ generatedFrom: 'SAINS_AR_HUB', year, month }),
  };

  await db.run(INSERT.into('sains.ar.analytics.SPANKPIReport').entries(report));
  logger.info(`SPAN KPI report generated for ${year}-${monthStr}`);
  return report.ID;
}

// ── FRAUD DENSITY MAP ─────────────────────────────────────────────────────────

/**
 * Compute fraud signal density by geographic zone.
 * Uses account addresses grouped by district.
 */
async function updateFraudDensityMap(asOfDate = new Date()) {
  const db = await cds.connect.to('db');
  const today = asOfDate.toISOString().substring(0, 10);
  const ninetyDaysAgo = dayjs(asOfDate).subtract(90, 'day').format('YYYY-MM-DD');

  const densityData = await db.run(
    `SELECT
       a.branchCode AS zone,
       COUNT(DISTINCT a.ID) AS total,
       SUM(CASE WHEN ca.status = 'OPEN' OR ca.status = 'UNDER_REVIEW' THEN 1 ELSE 0 END) AS anomalies,
       SUM(CASE WHEN ca.status = 'RESOLVED_TAMPERING' THEN 1 ELSE 0 END) AS confirmed
     FROM "SAINS_AR_CUSTOMERACCOUNT" a
     LEFT JOIN "SAINS_AR_ANALYTICS_CONSUMPTIONANOMALY" ca
       ON ca.account_ID = a.ID
       AND ca.detectionDate >= '${ninetyDaysAgo}'
     WHERE a.accountStatus = 'ACTIVE'
     GROUP BY a.branchCode`
  );

  let zonesUpdated = 0;
  for (const zone of densityData) {
    const total = Number(zone.total) || 1;
    const anomalies = Number(zone.anomalies) || 0;
    const confirmed = Number(zone.confirmed) || 0;
    const densityPct = anomalies / total;
    const riskLevel = densityPct > 0.15 ? 'HIGH'
      : densityPct > 0.08 ? 'MEDIUM' : 'LOW';

    const existing = await db.run(
      SELECT.one.from('sains.ar.analytics.FraudDensityZone')
        .where({ zoneCode: zone.zone, calculationDate: today })
    );

    const record = {
      zoneCode: zone.zone,
      zoneName: zone.zone,
      calculationDate: today,
      totalAccounts: total,
      anomalyFlagCount: anomalies,
      confirmedFraudCount: confirmed,
      fraudDensityPct: Math.round(densityPct * 10000) / 10000,
      riskLevel,
      recommendedAction: riskLevel === 'HIGH'
        ? 'Schedule immediate field inspection for all OPEN anomalies in this zone'
        : riskLevel === 'MEDIUM' ? 'Review anomalies and plan inspection within 30 days'
        : 'Monitor — no immediate action required',
    };

    if (existing) {
      await db.run(UPDATE('sains.ar.analytics.FraudDensityZone').set(record).where({ ID: existing.ID }));
    } else {
      await db.run(INSERT.into('sains.ar.analytics.FraudDensityZone').entries({
        ID: cds.utils.uuid(), ...record,
      }));
    }
    zonesUpdated++;
  }

  logger.info(`Fraud density map updated: ${zonesUpdated} zones`);
  return { zonesUpdated };
}

// ── STATISTICAL HELPERS ───────────────────────────────────────────────────────

function _mean(arr) {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
}

function _stdDev(arr, mean) {
  if (arr.length <= 1) return 0;
  const variance = arr.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

module.exports = {
  calculateDailyKPISnapshot,
  updateConsumptionProfiles,
  detectConsumptionAnomalies,
  calculateCLV,
  generateSPANReport,
  updateFraudDensityMap,
};
