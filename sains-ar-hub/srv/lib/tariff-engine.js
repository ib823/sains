'use strict';

const cds = require('@sap/cds');
const logger = cds.log('tariff-engine');

/**
 * Calculate water charges based on consumption and tariff band.
 * Uses tiered block pricing from TariffBlock entity.
 *
 * MOCK: tariff rates based on publicly available SPAN tariff schedule
 * for Negeri Sembilan. Confirm exact rates with SAINS during Blueprint.
 *
 * @param {number} consumptionM3 - water consumption in cubic metres
 * @param {string} tariffBandCode - e.g., 'DOM_A', 'COM_A'
 * @param {string} effectiveDate - ISO date for rate lookup
 * @returns {Promise<{baseCharge, tieredCharge, totalCharge, taxAmount, taxRate, lineItems[]}>}
 */
async function calculateCharge(consumptionM3, tariffBandCode, effectiveDate) {
  const db = await cds.connect.to('db');

  // Look up tariff band
  const band = await db.run(
    SELECT.one.from('sains.ar.TariffBand').where({ code: tariffBandCode, isActive: true })
  );
  if (!band) {
    logger.warn(`Tariff band ${tariffBandCode} not found — using default flat rate`);
    // Fallback flat rate: RM 1.50/m³
    const amount = Math.round(consumptionM3 * 1.50 * 100) / 100;
    return {
      baseCharge: 0,
      tieredCharge: amount,
      totalCharge: amount,
      taxAmount: Math.round(amount * 0.06 * 100) / 100,
      taxRate: 6.0,
      lineItems: [{ chargeType: 'WATER_CONSUMPTION', amount, description: 'Flat rate (default)' }],
    };
  }

  // Look up tariff blocks for this band
  const blocks = await db.run(
    SELECT.from('sains.ar.TariffBlock')
      .where({ tariffBand_ID: band.ID })
      .orderBy('blockSequence')
  );

  let remaining = consumptionM3;
  let tieredCharge = 0;
  const lineItems = [];
  let baseCharge = 0;

  if (blocks.length === 0) {
    // No blocks defined — use hardcoded SPAN rates as fallback
    // MOCK: Negeri Sembilan SPAN-published domestic tariff schedule
    const defaultBlocks = tariffBandCode.startsWith('DOM') ? [
      { from: 0, to: 20, rate: 0.57, fixed: 6.00, desc: 'Block 1: 0-20 m³' },
      { from: 20, to: 35, rate: 1.03, fixed: 0, desc: 'Block 2: 20-35 m³' },
      { from: 35, to: Infinity, rate: 2.00, fixed: 0, desc: 'Block 3: >35 m³' },
    ] : tariffBandCode.startsWith('COM') ? [
      { from: 0, to: Infinity, rate: 2.07, fixed: 30.00, desc: 'Commercial flat rate' },
    ] : tariffBandCode.startsWith('IND') ? [
      { from: 0, to: Infinity, rate: 2.28, fixed: 100.00, desc: 'Industrial flat rate' },
    ] : tariffBandCode.startsWith('GOV') ? [
      { from: 0, to: Infinity, rate: 1.50, fixed: 50.00, desc: 'Government flat rate' },
    ] : [
      { from: 0, to: Infinity, rate: 1.20, fixed: 20.00, desc: 'Default flat rate' },
    ];

    for (const block of defaultBlocks) {
      if (remaining <= 0) break;
      if (block.fixed > 0 && baseCharge === 0) baseCharge = block.fixed;
      const blockConsumption = Math.min(remaining, (block.to || Infinity) - block.from);
      const blockAmount = Math.round(blockConsumption * block.rate * 100) / 100;
      tieredCharge += blockAmount;
      lineItems.push({
        chargeType: 'WATER_CONSUMPTION',
        amount: blockAmount,
        description: `${block.desc} @ RM${block.rate}/m³ × ${blockConsumption.toFixed(1)} m³`,
      });
      remaining -= blockConsumption;
    }
  } else {
    // Use configured blocks from database
    for (const block of blocks) {
      if (remaining <= 0) break;
      if (Number(block.fixedCharge) > 0 && baseCharge === 0) baseCharge = Number(block.fixedCharge);
      const blockSize = block.toM3 ? (Number(block.toM3) - Number(block.fromM3)) : remaining;
      const blockConsumption = Math.min(remaining, blockSize);
      const blockAmount = Math.round(blockConsumption * Number(block.ratePerM3) * 100) / 100;
      tieredCharge += blockAmount;
      lineItems.push({
        chargeType: 'WATER_CONSUMPTION',
        amount: blockAmount,
        description: `Block ${block.blockSequence}: ${block.fromM3}-${block.toM3 || '∞'} m³ @ RM${block.ratePerM3}`,
      });
      remaining -= blockConsumption;
    }
  }

  if (baseCharge > 0) {
    lineItems.unshift({ chargeType: 'BASE_CHARGE', amount: baseCharge, description: 'Monthly base charge' });
  }

  const totalCharge = Math.round((baseCharge + tieredCharge) * 100) / 100;
  const taxRate = 6.0; // SST 6%
  const taxAmount = Math.round(totalCharge * taxRate / 100 * 100) / 100;

  return { baseCharge, tieredCharge, totalCharge, taxAmount, taxRate, lineItems };
}

/**
 * Verify an invoice's charges against the tariff engine calculation.
 * Flags discrepancies > RM 0.50.
 */
async function verifyInvoiceCharges(invoiceID) {
  const db = await cds.connect.to('db');
  const invoice = await db.run(SELECT.one.from('sains.ar.Invoice').where({ ID: invoiceID }));
  if (!invoice) return { verified: false, reason: 'Invoice not found' };

  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount').columns('tariffBand_code').where({ ID: invoice.account_ID })
  );
  if (!account?.tariffBand_code) return { verified: false, reason: 'No tariff band on account' };

  const calc = await calculateCharge(Number(invoice.consumptionM3 || 0), account.tariffBand_code, invoice.invoiceDate);
  const expectedTotal = calc.totalCharge + calc.taxAmount;
  const actualTotal = Number(invoice.totalAmount || 0);
  const discrepancy = Math.abs(expectedTotal - actualTotal);

  if (discrepancy > 0.50) {
    logger.warn(`Invoice ${invoice.invoiceNumber}: tariff discrepancy RM ${discrepancy.toFixed(2)} (expected ${expectedTotal.toFixed(2)}, actual ${actualTotal.toFixed(2)})`);
    return {
      verified: false,
      expectedTotal,
      actualTotal,
      discrepancy,
      reason: 'Amount discrepancy exceeds RM 0.50 tolerance',
    };
  }

  return { verified: true, expectedTotal, actualTotal, discrepancy };
}

module.exports = { calculateCharge, verifyInvoiceCharges };
