'use strict';

const dayjs = require('dayjs');
const { DUNNING_THRESHOLDS, DUNNING_LEVEL } = require('./constants');

function evaluateDunning(account, invoices, asOfDate) {
  const evalDate = asOfDate ? dayjs(asOfDate) : dayjs();

  // Exclusion checks
  if (account.isGovernment) {
    return { excluded: true, exclusionReason: 'GOVERNMENT_ACCOUNT', shouldUpdate: false,
      proposedLevel: account.dunningLevel || 0, overdueDays: 0, overdueAmount: 0, noticeType: null };
  }
  if (account.isPaymentPlan) {
    return { excluded: true, exclusionReason: 'ACTIVE_PAYMENT_PLAN', shouldUpdate: false,
      proposedLevel: account.dunningLevel || 0, overdueDays: 0, overdueAmount: 0, noticeType: null };
  }
  if (account.isHardship) {
    return { excluded: true, exclusionReason: 'HARDSHIP_ACCOUNT', shouldUpdate: false,
      proposedLevel: Math.min(account.dunningLevel || 0, 2), overdueDays: 0, overdueAmount: 0, noticeType: null };
  }
  if (account.isDisputed) {
    return { excluded: true, exclusionReason: 'DISPUTED_ACCOUNT', shouldUpdate: false,
      proposedLevel: Math.min(account.dunningLevel || 0, 2), overdueDays: 0, overdueAmount: 0, noticeType: null };
  }

  // Find overdue open invoices
  const overdueInvoices = (invoices || []).filter(inv =>
    (inv.status === 'OPEN' || inv.status === 'PARTIAL') &&
    inv.amountOutstanding > 0 &&
    dayjs(inv.dueDate).isBefore(evalDate)
  );

  if (overdueInvoices.length === 0) {
    // Reset to 0
    return {
      excluded: false, exclusionReason: null, shouldUpdate: account.dunningLevel > 0,
      proposedLevel: 0, overdueDays: 0, overdueAmount: 0, noticeType: null,
      action: account.dunningLevel > 0 ? 'RESET' : 'NONE', shouldReset: account.dunningLevel > 0,
    };
  }

  // Sort by dueDate ascending — oldest first
  overdueInvoices.sort((a, b) => dayjs(a.dueDate).diff(dayjs(b.dueDate)));
  const oldestInvoice = overdueInvoices[0];
  const overdueDays = evalDate.diff(dayjs(oldestInvoice.dueDate), 'day');
  const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + (inv.amountOutstanding || 0), 0);

  let proposedLevel;
  let noticeType;

  if (overdueDays >= DUNNING_THRESHOLDS.LEVEL_4) {
    proposedLevel = DUNNING_LEVEL.DISCONNECTED;
    noticeType = 'DISCONNECTION_CONFIRMATION';
  } else if (overdueDays >= DUNNING_THRESHOLDS.LEVEL_3) {
    proposedLevel = DUNNING_LEVEL.DISCONNECTION_NOTICE;
    noticeType = 'DISCONNECTION_NOTICE';
  } else if (overdueDays >= DUNNING_THRESHOLDS.LEVEL_2) {
    proposedLevel = DUNNING_LEVEL.FINAL_NOTICE;
    noticeType = 'FINAL_NOTICE';
  } else if (overdueDays >= DUNNING_THRESHOLDS.LEVEL_1) {
    proposedLevel = DUNNING_LEVEL.FIRST_REMINDER;
    noticeType = 'FIRST_REMINDER';
  } else {
    proposedLevel = DUNNING_LEVEL.CURRENT;
    noticeType = null;
  }

  const shouldUpdate = proposedLevel !== (account.dunningLevel || 0);
  const action = proposedLevel > (account.dunningLevel || 0) ? 'ESCALATE' : 'NONE';

  return {
    excluded: false, exclusionReason: null,
    proposedLevel, newDunningLevel: proposedLevel,
    overdueDays, overdueAmount, noticeType, maxOverdueDays: overdueDays,
    shouldUpdate, action, shouldReset: false,
  };
}

function getNoticeChannels(dunningLevel, account) {
  if (dunningLevel <= 0) return { email: false, sms: false, postal: false };

  const email = !!(account.emailAddress && !account.paperBillingElected);
  const sms = !!account.primaryPhone;
  const postal = dunningLevel >= 3 || !!account.paperBillingElected;

  const result = { email, sms, postal };

  // Also support array-like iteration via includes()
  result.includes = (ch) => {
    if (ch === 'EMAIL') return email;
    if (ch === 'SMS') return sms;
    if (ch === 'POSTAL') return postal;
    return false;
  };

  return result;
}

function isPTPBlockingEscalation(ptp) {
  if (!ptp || ptp.status !== 'ACTIVE') return false;
  return dayjs(ptp.promisedDate).isAfter(dayjs()) || dayjs(ptp.promisedDate).isSame(dayjs(), 'day');
}

function isPTPBroken(ptp, payments, asOfDate) {
  if (!ptp || ptp.status !== 'ACTIVE') return false;
  const evalDate = asOfDate ? dayjs(asOfDate) : dayjs();
  const promisedDate = dayjs(ptp.promisedDate);

  if (!promisedDate.isBefore(evalDate, 'day')) return false;

  // Check if a qualifying payment was received before/on the promised date
  if (payments && payments.length > 0) {
    const qualifying = payments.filter(p =>
      p.status !== 'REVERSED' && p.status !== 'BOUNCED' &&
      dayjs(p.paymentDate).isBefore(promisedDate) || dayjs(p.paymentDate).isSame(promisedDate, 'day')
    );
    const totalPaid = qualifying.reduce((s, p) => s + (p.amount || 0), 0);
    if (totalPaid >= (ptp.promisedAmount || 0)) return false;
  }

  return true;
}

module.exports = { evaluateDunning, getNoticeChannels, isPTPBlockingEscalation, isPTPBroken };
