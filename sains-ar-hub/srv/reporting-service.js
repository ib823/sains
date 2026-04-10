'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const Decimal = require('decimal.js');
const { calculateProvision } = require('./lib/provision-engine');
const { AGING_BUCKETS, DEFAULT_PROVISION_RATES, INVOICE_STATUS } = require('./lib/constants');

module.exports = cds.service.impl(async function() {
  const srv = this;

  srv.on('getDSOReport', async (req) => {
    const { periodYear, periodMonth } = req.data;
    const db = await cds.connect.to('db');
    const endDate = dayjs(`${periodYear}-${String(periodMonth).padStart(2, '0')}-01`).endOf('month');

    const openInvoices = await db.run(
      SELECT.from('sains.ar.Invoice')
        .columns('amountOutstanding')
        .where({ status: { in: ['OPEN', 'PARTIAL'] } })
    );
    const totalOpenAR = openInvoices.reduce((s, i) => s + (i.amountOutstanding || 0), 0);

    const allInvoices = await db.run(
      SELECT.from('sains.ar.Invoice')
        .columns('totalAmount')
        .where({ invoiceDate: { '>=': `${periodYear}-01-01` }, status: { '!=': 'REVERSED' } })
    );
    const annualBilledRevenue = allInvoices.reduce((s, i) => s + (i.totalAmount || 0), 0);
    const dso = annualBilledRevenue > 0 ? (totalOpenAR / (annualBilledRevenue / 365)) : 0;

    return { dso: Math.round(dso * 100) / 100, annualBilledRevenue, totalOpenAR, asOfDate: endDate.format('YYYY-MM-DD') };
  });

  srv.on('getCollectionEfficiencyReport', async (req) => {
    const { periodYear, periodMonth } = req.data;
    const db = await cds.connect.to('db');
    const startDate = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`;
    const endDate = dayjs(startDate).endOf('month').format('YYYY-MM-DD');

    // Group by account type for SPAN-compliant segmented reporting
    const accountTypes = ['DOM', 'COM_S', 'COM_L', 'IND', 'GOV', 'INST', 'BULK', 'TEMP'];
    const results = [];

    for (const at of accountTypes) {
      const billed = await db.run(
        SELECT.one.from('sains.ar.Invoice').columns('sum(totalAmount) as total')
          .where({
            'account.accountType_code': at,
            invoiceDate: { between: startDate, and: endDate },
            status: { '!=': 'REVERSED' },
          })
      );
      const collected = await db.run(
        SELECT.one.from('sains.ar.Payment').columns('sum(amount) as total')
          .where({
            'account.accountType_code': at,
            paymentDate: { between: startDate, and: endDate },
            status: { '!=': 'REVERSED' },
          })
      );
      const totalBilled = billed?.total || 0;
      const totalCollected = collected?.total || 0;
      results.push({
        accountType: at,
        totalBilled,
        totalCollected,
        efficiencyRate: totalBilled > 0 ? totalCollected / totalBilled : 0,
      });
    }
    return results;
  });

  srv.on('getBadDebtProvisionReport', async (req) => {
    const { periodYear, periodMonth } = req.data;
    const db = await cds.connect.to('db');
    const provisions = await db.run(
      SELECT.from('sains.ar.BadDebtProvision')
        .where({ periodYear, periodMonth })
    );
    return provisions.map(p => ({
      accountType: p.accountType, agingBucket: p.agingBucket,
      openARAmount: p.openARAmount, provisionRate: p.provisionRate,
      provisionAmount: p.provisionAmount,
    }));
  });

  srv.on('getMFRS15DisaggregationReport', async (req) => {
    const { periodYear, periodMonth } = req.data;
    const db = await cds.connect.to('db');
    const startDate = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`;
    const endDate = dayjs(startDate).endOf('month').format('YYYY-MM-DD');

    const invoices = await db.run(
      SELECT.from('sains.ar.Invoice')
        .columns('invoiceType', 'totalAmount', 'taxAmount')
        .where({ invoiceDate: { between: startDate, and: endDate }, status: { '!=': 'REVERSED' } })
    );

    const categories = {};
    for (const inv of invoices) {
      const cat = inv.invoiceType || 'OTHER';
      if (!categories[cat]) categories[cat] = { revenue: 0, tax: 0 };
      categories[cat].revenue += inv.totalAmount - (inv.taxAmount || 0);
      categories[cat].tax += inv.taxAmount || 0;
    }

    const results = [];
    for (const [cat, vals] of Object.entries(categories)) {
      results.push({ revenueCategory: cat, subCategory: 'Revenue', amount: vals.revenue });
      if (vals.tax > 0) results.push({ revenueCategory: cat, subCategory: 'Tax', amount: vals.tax });
    }
    return results;
  });

  srv.on('getSPANKPIReport', async (req) => {
    const { periodYear, periodMonth } = req.data;
    const db = await cds.connect.to('db');
    const asOfDate = periodYear && periodMonth
      ? dayjs(`${periodYear}-${String(periodMonth).padStart(2, '0')}-01`).endOf('month').format('YYYY-MM-DD')
      : new Date().toISOString().substring(0, 10);

    const dunningDist = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('dunningLevel', 'count(ID) as cnt', 'sum(balanceOutstanding) as total')
        .where({ accountStatus: 'ACTIVE' })
        .groupBy('dunningLevel')
    );

    // Fetch the most recent KPI snapshot for the requested period
    const snapshot = await db.run(
      SELECT.one.from('sains.ar.analytics.ARKPISnapshot')
        .where({ snapshotDate: { '<=': asOfDate } })
        .orderBy('snapshotDate desc')
    );

    return {
      collectionEfficiencyRate: snapshot?.collectionEfficiency || 0,
      dso: snapshot?.dso || 0,
      badDebtRatio: snapshot?.badDebtRatio || 0,
      billingAccuracyRate: snapshot?.billingAccuracyRate || 95.0,
      delinquencyRate: snapshot?.over90DaysRatio || 0,
      dunningDistribution: dunningDist.map(d => ({
        level: d.dunningLevel, accountCount: d.cnt, totalAmount: d.total || 0,
      })),
    };
  });

  srv.on('getCustomerStatement', async (req) => {
    const { accountID, fromDate, toDate } = req.data;
    const db = await cds.connect.to('db');

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ ID: accountID })
    );
    if (!account) return req.error(404, 'Account not found');

    const invoices = await db.run(
      SELECT.from('sains.ar.Invoice')
        .where({ account_ID: accountID, invoiceDate: { between: fromDate, and: toDate } })
        .orderBy({ invoiceDate: 'asc' })
    );
    const payments = await db.run(
      SELECT.from('sains.ar.Payment')
        .where({ account_ID: accountID, paymentDate: { between: fromDate, and: toDate }, status: { '!=': 'REVERSED' } })
        .orderBy({ paymentDate: 'asc' })
    );

    const transactions = [];
    let running = account.balanceOutstanding;

    for (const inv of invoices) {
      transactions.push({
        transactionDate: inv.invoiceDate, description: `Invoice ${inv.invoiceNumber}`,
        debitAmount: inv.totalAmount, creditAmount: 0, runningBalance: running,
        reference: inv.invoiceNumber, transactionType: 'INVOICE',
      });
    }
    for (const pay of payments) {
      transactions.push({
        transactionDate: pay.paymentDate, description: `Payment ${pay.paymentReference}`,
        debitAmount: 0, creditAmount: pay.amount, runningBalance: running,
        reference: pay.paymentReference, transactionType: 'PAYMENT',
      });
    }

    transactions.sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));

    return {
      accountNumber: account.accountNumber, customerName: account.legalName,
      statementDate: toDate, openingBalance: 0, closingBalance: account.balanceOutstanding,
      depositHeld: account.balanceDeposit, overdueAmount: account.balanceOutstanding,
      accountStatus: account.accountStatus, transactions,
    };
  });

  srv.on('getReconciliationStatus', async (req) => {
    const { reconciliationDate } = req.data;
    const db = await cds.connect.to('db');
    const records = await db.run(
      SELECT.from('sains.ar.ReconciliationRecord')
        .where({ reconciliationDate })
    );
    return records.map(r => ({
      reconciliationType: r.reconciliationType, status: r.status,
      difference: r.difference, withinTolerance: r.withinTolerance,
    }));
  });

  srv.on('getDunningDistributionReport', async (req) => {
    const db = await cds.connect.to('db');
    const dist = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('dunningLevel', 'count(ID) as cnt', 'sum(balanceOutstanding) as total')
        .where({ accountStatus: 'ACTIVE' })
        .groupBy('dunningLevel')
    );
    return dist.map(d => ({ level: d.dunningLevel, accountCount: d.cnt, totalOverdueAmount: d.total || 0 }));
  });

  srv.on('generateAuditorConfirmationLetters', async (req) => {
    const { sampleAccountIDs, periodEndDate } = req.data;
    const db = await cds.connect.to('db');
    const results = [];
    for (const accID of sampleAccountIDs) {
      const account = await db.run(SELECT.one.from('sains.ar.CustomerAccount').where({ ID: accID }));
      if (!account) continue;
      const addr = [account.serviceAddress1, account.serviceAddress2, account.serviceCity, account.serviceState, account.servicePostcode].filter(Boolean).join(', ');
      results.push({
        accountID: accID, accountNumber: account.accountNumber, customerName: account.legalName,
        serviceAddress: addr, balanceAsAtDate: account.balanceOutstanding,
        letterText: `Dear ${account.legalName},\n\nWe confirm that as at ${periodEndDate}, your account ${account.accountNumber} shows a balance of RM${(account.balanceOutstanding || 0).toFixed(2)}.\n\nPlease confirm this balance by replying to this letter.\n\nSyarikat Air Negeri Sembilan Sdn Bhd`,
      });
    }
    return results;
  });

  srv.on('getDepositSufficiencyReviewReport', async (req) => {
    const { reviewYear } = req.data;
    const REQUIRED_DEPOSIT = { DOM: 100, COM_S: 500, COM_L: 2000, IND: 5000, GOV: 10000, INST: 1000 };
    const db = await cds.connect.to('db');

    const accounts = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('ID', 'accountNumber', 'accountType_code', 'balanceDeposit')
        .where({ accountStatus: 'ACTIVE' })
    );

    // Fetch all held deposits for active accounts in one query
    const accountIDs = accounts.map(a => a.ID);
    let heldDeposits = [];
    if (accountIDs.length > 0) {
      heldDeposits = await db.run(
        SELECT.from('sains.ar.DepositRecord')
          .columns('account_ID', 'amount')
          .where({ status: 'HELD' })
      );
    }

    // Build map of account_ID -> sum of held deposits
    const depositByAccount = {};
    for (const d of heldDeposits) {
      depositByAccount[d.account_ID] = (depositByAccount[d.account_ID] || 0) + Number(d.amount || 0);
    }

    return accounts.map(a => {
      const required = REQUIRED_DEPOSIT[a.accountType_code] || 0;
      const actual = depositByAccount[a.ID] || Number(a.balanceDeposit || 0);
      const shortfall = Math.max(0, required - actual);
      return {
        accountID: a.ID,
        accountNumber: a.accountNumber,
        accountType: a.accountType_code,
        currentDepositAmount: actual,
        avgMonthlyBill6Months: 0,
        requiredDeposit: required,
        shortfall,
        topUpRequired: shortfall > 0,
      };
    });
  });

  srv.on('getSuspenseReport', async (req) => {
    const { asOfDate } = req.data;
    const db = await cds.connect.to('db');
    const items = await db.run(
      SELECT.from('sains.ar.SuspensePayment').where({ status: 'PENDING' })
    );
    const totalBalance = items.reduce((s, i) => s + (i.amount || 0), 0);
    const oldest = items.reduce((max, i) => {
      const days = dayjs(asOfDate).diff(dayjs(i.paymentDate), 'day');
      return days > max ? days : max;
    }, 0);
    return {
      totalSuspenseBalance: totalBalance, pendingCount: items.length, oldestDaysInSuspense: oldest,
      items: items.map(i => ({
        id: i.ID, sourceChannel: i.sourceChannel, amount: i.amount,
        paymentDate: i.paymentDate,
        daysInSuspense: dayjs(asOfDate).diff(dayjs(i.paymentDate), 'day'),
        status: i.status,
      })),
    };
  });
});
