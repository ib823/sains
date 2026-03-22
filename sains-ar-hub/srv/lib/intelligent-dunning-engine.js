'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const { DUNNING_THRESHOLDS, PAYMENT_CHANNEL } = require('./constants');

const logger = cds.log('intelligent-dunning-engine');

/**
 * Evaluate dunning for an account using intelligent, segment-aware logic.
 *
 * This replaces the Phase 1 static dunning-engine.js evaluateDunning function.
 * It incorporates:
 * 1. Customer segment (persona) lookup
 * 2. Dynamic dunning path step evaluation
 * 3. Vulnerability protection enforcement
 * 4. Compassionate collections rules
 * 5. Early intervention opportunity detection
 *
 * @param {Object}  account      - CustomerAccount record with all flags
 * @param {Array}   openInvoices - Open/Partial invoices for this account
 * @param {Date}    evalDate     - Evaluation date
 * @param {Object}  segment      - CustomerSegment record (if exists, else null)
 * @param {Array}   pathSteps    - DunningPathStep records for this account's path
 * @returns {Object} Dunning decision with action, channels, and tone
 */
function evaluateDunningIntelligent(account, openInvoices, evalDate, segment, pathSteps) {

  // STEP 1: Determine if there is anything to dun
  const overdueInvoices = openInvoices.filter(inv =>
    dayjs(inv.dueDate).isBefore(dayjs(evalDate))
  );

  if (overdueInvoices.length === 0) {
    // If account was at a non-zero level but now has no overdue: reset
    if (account.dunningLevel > 0) {
      return { proposedLevel: 0, action: 'RESET', shouldUpdate: true,
               exclusionReason: null, overdueAmount: 0, maxOverdueDays: 0,
               stepAction: null, tone: null };
    }
    return { proposedLevel: 0, action: 'MAINTAIN', shouldUpdate: false,
             exclusionReason: null, overdueAmount: 0, maxOverdueDays: 0,
             stepAction: null, tone: null };
  }

  // STEP 2: Critical exclusions — these override everything
  if (account.isLegalAction) {
    return _excluded('LEGAL_ACTION', account.dunningLevel);
  }
  if (account.isWrittenOff) {
    return _excluded('WRITTEN_OFF', account.dunningLevel);
  }

  // STEP 3: Vulnerability protection
  const vulnerability = _getVulnerabilityProtection(account);
  if (vulnerability.fullyExcluded) {
    return _excluded(`VULNERABILITY_${vulnerability.category}`, account.dunningLevel);
  }

  // STEP 4: Government account exclusion
  if (account.isGovernment || account.accountType_code === 'GOV') {
    return _excluded('GOVERNMENT_ACCOUNT', account.dunningLevel);
  }

  // STEP 5: Active payment plan or hardship — suspend escalation
  if (account.isPaymentPlan) {
    return _excluded('ACTIVE_PAYMENT_PLAN', account.dunningLevel);
  }
  if (account.isHardship) {
    // Hardship: allow up to Level 2 only
    return _hardshipCapped(account, overdueInvoices, evalDate);
  }

  // STEP 6: Active dispute suspends escalation above current level
  if (account.isDisputed) {
    return _excluded('ACTIVE_DISPUTE', account.dunningLevel);
  }

  // STEP 7: Calculate overdue metrics
  const maxOverdueDays = Math.max(
    ...overdueInvoices.map(inv => dayjs(evalDate).diff(dayjs(inv.dueDate), 'day'))
  );
  const overdueAmount = overdueInvoices.reduce((s, i) => s + Number(i.amountOutstanding), 0);

  // STEP 8: Determine proposed level based on path steps
  // If a segment with a path exists, use path step thresholds.
  // Otherwise fall back to Phase 1 static thresholds.
  let proposedLevel = 0;
  let stepAction = null;
  let tone = 'STANDARD';

  if (pathSteps && pathSteps.length > 0) {
    // Find the highest step where daysOverdue threshold is met
    const applicableSteps = pathSteps
      .filter(s => maxOverdueDays >= s.daysOverdue)
      .sort((a, b) => b.daysOverdue - a.daysOverdue);

    if (applicableSteps.length > 0) {
      const currentStep = applicableSteps[0];
      proposedLevel = Math.min(currentStep.stepSequence, 4);
      stepAction = currentStep.actionType;
      tone = currentStep.tone || 'STANDARD';

      // Apply vulnerability max cap
      if (vulnerability.maxLevel !== null) {
        proposedLevel = Math.min(proposedLevel, vulnerability.maxLevel);
      }
    }
  } else {
    // Phase 1 fallback
    if (maxOverdueDays >= DUNNING_THRESHOLDS.LEVEL_4) proposedLevel = 4;
    else if (maxOverdueDays >= DUNNING_THRESHOLDS.LEVEL_3) proposedLevel = 3;
    else if (maxOverdueDays >= DUNNING_THRESHOLDS.LEVEL_2) proposedLevel = 2;
    else if (maxOverdueDays >= DUNNING_THRESHOLDS.LEVEL_1) proposedLevel = 1;

    // Apply segment tone
    if (segment?.segmentCode === 'VULNERABLE') tone = 'COMPASSIONATE';
    else if (segment?.segmentCode === 'HIGH_RISK') tone = 'FIRM';
    else if (segment?.segmentCode === 'LOW_RISK') tone = 'FRIENDLY';
  }

  const shouldUpdate = proposedLevel !== account.dunningLevel;
  const action = proposedLevel > account.dunningLevel ? 'ESCALATE'
    : proposedLevel < account.dunningLevel ? 'RESET'
    : 'MAINTAIN';

  return {
    proposedLevel,
    action,
    shouldUpdate,
    exclusionReason: null,
    overdueAmount,
    maxOverdueDays,
    stepAction,
    tone,
    requiresApproval: _requiresApproval(proposedLevel, vulnerability, account),
    noticeRequired: action === 'ESCALATE',
  };
}

/**
 * Get communication channels for a dunning notice.
 * Incorporates tone-based channel selection and vulnerability rules.
 *
 * @param {Number}  level    - Proposed dunning level
 * @param {Object}  account  - CustomerAccount
 * @param {String}  tone     - FRIENDLY | STANDARD | FIRM | URGENT | COMPASSIONATE
 * @returns {{ email, sms, whatsapp, postal, phone }}
 */
function getNoticeChannelsIntelligent(level, account, tone = 'STANDARD') {
  const channels = {
    email: !!account.emailAddress && !account.emailBounced,
    sms: !!account.primaryPhone,
    whatsapp: !!account.primaryPhone && !account.whatsAppOptOut,
    postal: false,
    phoneQueue: false,
  };

  // Paper billing accounts always get postal
  if (account.paperBillingElected) {
    channels.postal = true;
    channels.email = false;
    channels.whatsapp = false;
  }

  // Level-based postal requirement (Act 655 — formal disconnection notice must be postal)
  if (level >= 3) channels.postal = true;

  // Tone-based overrides
  if (tone === 'COMPASSIONATE') {
    // Compassionate: no SMS blasts, prefer personal contact
    channels.sms = false;
    channels.phoneQueue = level >= 2;
  }
  if (tone === 'FIRM' || tone === 'URGENT') {
    // Firm: all channels including phone queue at Level 2+
    channels.phoneQueue = level >= 2;
  }
  if (tone === 'FRIENDLY') {
    // Friendly: WhatsApp with payment link preferred, no postal below Level 3
    channels.postal = level >= 3;
  }

  return channels;
}

/**
 * Detect early intervention signals for an account.
 * Returns alert objects if any signals are detected.
 *
 * @param {Object} account         - CustomerAccount
 * @param {Array}  recentPayments  - Last 6 months of payments
 * @param {Array}  recentInvoices  - Last 6 months of invoices
 * @returns {Array} Alert objects to create
 */
function detectEarlyInterventionSignals(account, recentPayments, recentInvoices) {
  const alerts = [];
  const today = dayjs();

  // Signal 1: Declining payment amounts
  if (recentPayments.length >= 4) {
    const recent3 = recentPayments.slice(0, 3).map(p => Number(p.amount));
    const older3 = recentPayments.slice(3, 6).map(p => Number(p.amount));
    if (older3.length >= 3) {
      const recentAvg = recent3.reduce((s, v) => s + v, 0) / recent3.length;
      const olderAvg = older3.reduce((s, v) => s + v, 0) / older3.length;
      if (olderAvg > 0 && recentAvg < olderAvg * 0.6) {
        alerts.push({
          alertType: 'DECLINING_PAYMENT',
          signalDescription: `Average payment amount dropped from RM ${olderAvg.toFixed(2)} to RM ${recentAvg.toFixed(2)} over last 6 months (decline >40%).`,
          riskLevel: 'MEDIUM',
        });
      }
    }
  }

  // Signal 2: Shift from automated to manual payment
  const recentChannels = recentPayments.slice(0, 3).map(p => p.channel);
  const olderChannels = recentPayments.slice(3, 6).map(p => p.channel);
  const autoChannels = [PAYMENT_CHANNEL.EMANDATE, 'STANDING_ORDER'];
  const wasAuto = olderChannels.some(c => autoChannels.includes(c));
  const isNowManual = recentChannels.length > 0 && !recentChannels.some(c => autoChannels.includes(c));
  if (wasAuto && isNowManual) {
    alerts.push({
      alertType: 'CHANNEL_SHIFT',
      signalDescription: 'Account shifted from automatic payment to manual payment channel in last 3 months. Possible financial difficulty indicator.',
      riskLevel: 'MEDIUM',
    });
  }

  // Signal 3: Partial payments beginning
  const partialPayments = recentPayments.filter(p => {
    const matchedInv = recentInvoices.find(i => i.billingPeriodTo === p.paymentDate?.substring(0, 7));
    if (!matchedInv) return false;
    return Number(p.amount) < Number(matchedInv.totalAmount) * 0.95;
  });
  if (partialPayments.length >= 2) {
    alerts.push({
      alertType: 'PARTIAL_PATTERN',
      signalDescription: `${partialPayments.length} partial payments detected in last 6 months. Customer paying less than bill amount — potential affordability stress.`,
      riskLevel: 'HIGH',
    });
  }

  // Signal 4: Long payment gap
  if (recentPayments.length > 0) {
    const lastPaymentDate = dayjs(recentPayments[0].paymentDate);
    const daysSinceLastPayment = today.diff(lastPaymentDate, 'day');
    const avgBillingCycle = 30;
    if (daysSinceLastPayment > avgBillingCycle * 2 && account.dunningLevel === 0) {
      alerts.push({
        alertType: 'LONG_PAYMENT_GAP',
        signalDescription: `${daysSinceLastPayment} days since last payment. Account still at Level 0 but payment gap is unusual for this account.`,
        riskLevel: 'MEDIUM',
      });
    }
  }

  // Signal 5: eMandate cancellation
  if (account.eMandateCancelledRecently) {
    alerts.push({
      alertType: 'EMANDATE_CANCELLED',
      signalDescription: 'Direct debit mandate cancelled in last 30 days. Account reverts to manual payment — high delinquency risk.',
      riskLevel: 'HIGH',
    });
  }

  return alerts;
}

/**
 * Check if a specific dunning action requires approval.
 * Disconnection of CRITICAL vulnerability accounts always requires Finance Manager.
 */
function _requiresApproval(level, vulnerability, account) {
  if (level >= 3 && vulnerability.severity === 'CRITICAL') return true;
  if (level >= 4 && vulnerability.severity === 'HIGH') return true;
  if (level >= 4 && account.isHardship) return true;
  return false;
}

function _excluded(reason, currentLevel) {
  return {
    proposedLevel: currentLevel,
    action: 'MAINTAIN',
    shouldUpdate: false,
    exclusionReason: reason,
    overdueAmount: 0,
    maxOverdueDays: 0,
    stepAction: null,
    tone: null,
    requiresApproval: false,
    noticeRequired: false,
  };
}

function _hardshipCapped(account, overdueInvoices, evalDate) {
  const maxOverdueDays = Math.max(
    ...overdueInvoices.map(inv => dayjs(evalDate).diff(dayjs(inv.dueDate), 'day'))
  );
  const overdueAmount = overdueInvoices.reduce((s, i) => s + Number(i.amountOutstanding), 0);

  // Hardship accounts: maximum Level 2 (never Level 3 or 4)
  let proposedLevel = 0;
  if (maxOverdueDays >= DUNNING_THRESHOLDS.LEVEL_2) proposedLevel = 2;
  else if (maxOverdueDays >= DUNNING_THRESHOLDS.LEVEL_1) proposedLevel = 1;

  return {
    proposedLevel,
    action: proposedLevel > account.dunningLevel ? 'ESCALATE'
      : proposedLevel < account.dunningLevel ? 'RESET' : 'MAINTAIN',
    shouldUpdate: proposedLevel !== account.dunningLevel,
    exclusionReason: null,
    overdueAmount,
    maxOverdueDays,
    stepAction: proposedLevel > 0 ? 'WHATSAPP' : null,
    tone: 'COMPASSIONATE',
    requiresApproval: false,
    noticeRequired: proposedLevel > account.dunningLevel,
  };
}

function _getVulnerabilityProtection(account) {
  // This would normally query VulnerabilityRecord — but for performance,
  // the vulnerability flag is cached on the account record.
  // Phase 2 adds: vulnSeverity field to CustomerAccount.
  const severity = account.vulnSeverity || null;
  if (!severity) return { fullyExcluded: false, maxLevel: null, severity: null };

  return {
    fullyExcluded: severity === 'CRITICAL',
    maxLevel: severity === 'CRITICAL' ? 0
      : severity === 'HIGH' ? 3
      : severity === 'MEDIUM' ? 3
      : null,
    severity,
    category: account.vulnCategory || 'UNKNOWN',
  };
}

/**
 * Phase 1 backward-compatible wrapper.
 * Code that imports evaluateDunning from dunning-engine.js still works.
 */
function evaluateDunning(account, openInvoices, evalDate) {
  return evaluateDunningIntelligent(account, openInvoices, evalDate, null, null);
}

function getNoticeChannels(level, account) {
  return getNoticeChannelsIntelligent(level, account, 'STANDARD');
}

function isPTPBroken(ptp, recentPayments, evalDate) {
  if (ptp.status !== 'ACTIVE') return false;
  const promisedDate = dayjs(ptp.promisedDate);
  if (dayjs(evalDate).isBefore(promisedDate)) return false;
  const qualifying = (recentPayments || []).find(p =>
    !dayjs(p.paymentDate).isAfter(promisedDate) &&
    Number(p.amount) >= Number(ptp.promisedAmount) &&
    p.status !== 'REVERSED'
  );
  return !qualifying;
}

function isPTPBlockingEscalation(ptp, evalDate) {
  if (!ptp || ptp.status !== 'ACTIVE') return false;
  return dayjs(ptp.promisedDate).isAfter(dayjs(evalDate));
}

module.exports = {
  evaluateDunningIntelligent,
  getNoticeChannelsIntelligent,
  detectEarlyInterventionSignals,
  // Phase 1 backward-compatible exports
  evaluateDunning,
  getNoticeChannels,
  isPTPBroken,
  isPTPBlockingEscalation,
};
