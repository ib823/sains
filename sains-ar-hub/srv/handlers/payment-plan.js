'use strict';

const cds = require('@sap/cds');
const { logAction } = require('../lib/audit-logger');
const { validatePaymentPlan, throwIfInvalid } = require('../lib/validation');
const { PAYMENT_PLAN_LIMITS } = require('../lib/constants');

module.exports = (srv) => {

  srv.before('CREATE', 'PaymentPlans', async (req) => {
    const plan = req.data;
    const db = await cds.connect.to('db');

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').where({ ID: plan.account_ID })
    );

    const result = validatePaymentPlan(plan, account);
    throwIfInvalid(result);

    plan.planStatus = 'PENDING_APPROVAL';
    plan.outstandingAtStart = account.balanceOutstanding;

    // CHANGE 2: Auto-generate instalments
    const dayjs = require('dayjs');
    const totalAmount = Number(plan.outstandingAtStart || 0);
    const startDate = plan.startDate ? dayjs(plan.startDate) : dayjs();

    // Determine duration: explicit field → compute from endDate → totalInstalments → default 6
    let durationMonths = plan.durationMonths;
    if (!durationMonths && plan.startDate && plan.endDate) {
      durationMonths = Math.max(1, dayjs(plan.endDate).diff(startDate, 'month'));
    }
    if (!durationMonths) durationMonths = plan.totalInstalments || 6;

    const instalmentAmount = Math.round((totalAmount / durationMonths) * 100) / 100;
    const remainder = Math.round((totalAmount - instalmentAmount * durationMonths) * 100) / 100;

    plan.totalInstalments = durationMonths;
    plan.instalmentAmount = instalmentAmount;

    plan.instalments = [];
    for (let i = 1; i <= durationMonths; i++) {
      const dueDate = startDate.add(i, 'month').format('YYYY-MM-DD');
      const amount = i === durationMonths
        ? Math.round((instalmentAmount + remainder) * 100) / 100
        : instalmentAmount;
      plan.instalments.push({ instalmentNumber: i, dueDate, amount, status: 'PENDING' });
    }
  });

  srv.on('approvePlan', 'PaymentPlans', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const db = await cds.connect.to('db');

    const plan = await db.run(SELECT.one.from('sains.ar.PaymentPlan').where({ ID }));
    if (!plan) return req.error(404, 'Payment plan not found');
    if (plan.planStatus !== 'PENDING_APPROVAL')
      return req.error(400, `Cannot approve plan in status ${plan.planStatus}`);

    // Check duration authority
    const dayjs = require('dayjs');
    const durationMonths = dayjs(plan.endDate).diff(dayjs(plan.startDate), 'month');

    if (durationMonths > PAYMENT_PLAN_LIMITS.SUPERVISOR_MAX_MONTHS) {
      // Only Manager can approve plans > 6 months
      if (!req.user.is('FinanceManager')) {
        return req.error(403, `Plans exceeding ${PAYMENT_PLAN_LIMITS.SUPERVISOR_MAX_MONTHS} months require Finance Manager approval`);
      }
    }

    await db.run(UPDATE('sains.ar.PaymentPlan').set({
      planStatus: 'ACTIVE',
      approvedBy: req.user.id,
      approvalDate: new Date().toISOString(),
    }).where({ ID }));

    // Flag account as having payment plan
    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      isPaymentPlan: true,
    }).where({ ID: plan.account_ID }));

    await logAction(req, 'APPROVE_PAYMENT_PLAN', 'PaymentPlan', ID, plan,
      { ...plan, planStatus: 'ACTIVE' }, plan.account_ID);
    return true;
  });

  srv.on('voidPlan', 'PaymentPlans', async (req) => {
    const ID = req.params[0]?.ID ?? req.params[0];
    const { reason } = req.data;
    const db = await cds.connect.to('db');

    const plan = await db.run(SELECT.one.from('sains.ar.PaymentPlan').where({ ID }));
    if (!plan) return req.error(404, 'Payment plan not found');

    // CHANGE 5: Calculate residual = sum of all PENDING instalment amounts
    const pendingInstalments = await db.run(
      SELECT.from('sains.ar.PaymentPlanInstalment').where({ plan_ID: ID, status: 'PENDING' })
    );
    const residualAmount = pendingInstalments.reduce((sum, inst) => sum + Number(inst.amount || 0), 0);
    const voidedReason = residualAmount > 0
      ? `${reason || ''} [Residual outstanding: RM ${residualAmount.toFixed(2)}]`.trim()
      : reason;

    await db.run(UPDATE('sains.ar.PaymentPlan').set({
      planStatus: 'VOIDED',
      voidedAt: new Date().toISOString(),
      voidedReason,
    }).where({ ID }));

    // Remove payment plan flag from account
    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      isPaymentPlan: false,
    }).where({ ID: plan.account_ID }));

    await logAction(req, 'VOID_PAYMENT_PLAN', 'PaymentPlan', ID, plan,
      { planStatus: 'VOIDED', reason }, plan.account_ID);
    return true;
  });
};
