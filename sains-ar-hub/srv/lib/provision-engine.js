'use strict';

const Decimal = require('decimal.js');
const dayjs = require('dayjs');
const { AGING_BUCKETS, DEFAULT_PROVISION_RATES, INVOICE_STATUS } = require('./constants');

/**
 * Calculate bad debt provision for a set of invoices.
 * Signature: calculateProvision(invoices, rateOverrides, asOfDate, periodYear, periodMonth)
 *
 * @param {Array}  invoices       - All invoices
 * @param {Object} [rateOverrides] - Optional rate overrides keyed by bucket_type
 * @param {Date}   [asOfDate]     - Evaluation date
 * @param {Number} [periodYear]   - Period year
 * @param {Number} [periodMonth]  - Period month
 * @returns {Array} provisions per aging bucket (only non-zero buckets, or all if invoices exist)
 */
function calculateProvision(invoices, rateOverrides, asOfDate, periodYear, periodMonth) {
  const evalDate = asOfDate ? dayjs(asOfDate) : dayjs();

  // Filter: exclude REVERSED, CLEARED, CANCELLED invoices
  const eligibleInvoices = (invoices || []).filter(inv =>
    inv.status !== INVOICE_STATUS.REVERSED &&
    inv.status !== INVOICE_STATUS.CLEARED &&
    inv.status !== INVOICE_STATUS.CANCELLED &&
    inv.amountOutstanding > 0
  );

  if (eligibleInvoices.length === 0) return [];

  const results = [];

  for (const bucket of AGING_BUCKETS) {
    const bucketInvoices = eligibleInvoices.filter(inv => {
      const daysOverdue = evalDate.diff(dayjs(inv.dueDate), 'day');
      if (daysOverdue < 0) return false;
      if (bucket.toDays === null) return daysOverdue >= bucket.fromDays;
      return daysOverdue >= bucket.fromDays && daysOverdue <= bucket.toDays;
    });

    const openARAmount = bucketInvoices.reduce(
      (sum, inv) => sum.plus(new Decimal(inv.amountOutstanding)),
      new Decimal(0)
    );

    // Determine account type from invoice or default to DOM
    const accountType = bucketInvoices[0]?.accountTypeCode || 'DOM';
    const rateKey = `${bucket.code}_${accountType}`;

    let rate;
    if (rateOverrides && rateOverrides[rateKey] !== undefined) {
      rate = new Decimal(rateOverrides[rateKey]);
    } else {
      rate = new Decimal(DEFAULT_PROVISION_RATES[rateKey] || 0);
    }

    const provisionAmount = openARAmount.times(rate);

    results.push({
      agingBucket: bucket.code,
      accountType,
      openARAmount: openARAmount.toNumber(),
      provisionRate: rate.toNumber(),
      provisionAmount: provisionAmount.toDP(2).toNumber(),
    });
  }

  return results;
}

/**
 * Calculate provision movement between two periods.
 * @param {Array} previousProvisions
 * @param {Array} currentProvisions
 * @returns {{ netMovement, direction, movements }}
 */
function calculateProvisionMovement(previousProvisions, currentProvisions) {
  const prevTotal = (previousProvisions || []).reduce((s, p) => s + (p.provisionAmount || 0), 0);
  const currTotal = (currentProvisions || []).reduce((s, p) => s + (p.provisionAmount || 0), 0);
  const netMovement = currTotal - prevTotal;

  let direction;
  if (netMovement > 0) direction = 'INCREASE';
  else if (netMovement < 0) direction = 'DECREASE';
  else direction = 'UNCHANGED';

  return {
    netMovement,
    totalMovement: netMovement,
    direction,
    previousTotal: prevTotal,
    currentTotal: currTotal,
  };
}

module.exports = { calculateProvision, calculateProvisionMovement };
