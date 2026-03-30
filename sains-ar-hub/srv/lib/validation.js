'use strict';

const dayjs = require('dayjs');
const { WRITEOFF_THRESHOLDS, PAYMENT_PLAN_LIMITS } = require('./constants');

function validateCustomerAccount(data) {
  const errors = [];
  if (!data.accountNumber) errors.push('Account number is required.');
  if (!data.legalName || data.legalName.trim().length < 2)
    errors.push('Legal name must be at least 2 characters.');
  if (!data.idNumber) errors.push('IC/BRN number is required.');
  if (!data.primaryPhone || !/^(\+60|0)[0-9]{8,11}$/.test(data.primaryPhone))
    errors.push('Primary phone must be a valid Malaysian number.');
  if (data.emailAddress && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.emailAddress))
    errors.push('Email address format is invalid.');
  if (!data.serviceAddress1) errors.push('Service address is required.');
  if (!data.serviceCity) errors.push('City is required.');
  if (!data.serviceState) errors.push('State is required.');
  if (!data.servicePostcode || !/^[0-9]{5}$/.test(data.servicePostcode))
    errors.push('Malaysian postcode must be exactly 5 digits.');
  if (!data.accountOpenDate) errors.push('Account open date is required.');
  if (!data.accountType_code && !data.accountType?.code) errors.push('Account type is required.');
  if (!data.tariffBand_code && !data.tariffBand?.code) errors.push('Tariff band is required.');
  if (!data.branchCode) errors.push('Branch code is required.');
  return { valid: errors.length === 0, errors };
}

function validateManualInvoice(data) {
  const errors = [];
  if (!data.account_ID) errors.push('Account ID is required.');
  if (!data.invoiceDate) errors.push('Invoice date is required.');
  if (!data.dueDate) errors.push('Due date is required.');
  if (!data.totalAmount || data.totalAmount <= 0) errors.push('Total amount must be > 0.');
  if (dayjs(data.dueDate).isBefore(dayjs(data.invoiceDate)))
    errors.push('Due date cannot be before invoice date.');
  if (!data.lineItems || data.lineItems.length === 0)
    errors.push('At least one line item is required.');
  return { valid: errors.length === 0, errors };
}

function validatePayment(data) {
  const errors = [];
  if (!data.account_ID) errors.push('Account ID is required.');
  if (!data.amount || data.amount <= 0) errors.push('Payment amount must be > 0.');
  if (data.amount > 999999.99) errors.push('Payment exceeds RM 999,999.99 limit.');
  if (!data.paymentDate) errors.push('Payment date is required.');
  if (!data.channel) errors.push('Payment channel is required.');
  const today = dayjs().startOf('day');
  const payDate = dayjs(data.paymentDate);
  if (payDate.isAfter(today.add(1, 'day')))
    errors.push('Payment date cannot be more than 1 day in the future.');
  return { valid: errors.length === 0, errors };
}

function validatePaymentPlan(data, account) {
  const errors = [];
  if (!data.account_ID) errors.push('Account ID is required.');
  if (!account) errors.push('Account not found.');
  else {
    if (account.balanceOutstanding < PAYMENT_PLAN_LIMITS.MINIMUM_BALANCE)
      errors.push(`Minimum outstanding balance for payment plan is RM ${PAYMENT_PLAN_LIMITS.MINIMUM_BALANCE}.`);
  }
  if (!data.totalInstalments || data.totalInstalments < 1)
    errors.push('At least 1 instalment is required.');
  if (!data.startDate) errors.push('Start date is required.');
  if (!data.instalmentAmount || data.instalmentAmount <= 0)
    errors.push('Instalment amount must be > 0.');
  return { valid: errors.length === 0, errors };
}

function validateWriteOff(data, amount) {
  const errors = [];
  if (!data.account_ID) errors.push('Account ID is required.');
  if (!data.invoiceID) errors.push('Invoice ID is required.');
  if (!data.reason || data.reason.length < 20)
    errors.push('Write-off reason must be at least 20 characters.');
  if (!data.collectionHistory || data.collectionHistory.length < 20)
    errors.push('Collection history must be documented (at least 20 characters).');

  let requiredApproval;
  if (amount >= WRITEOFF_THRESHOLDS.BOARD)       requiredApproval = 'BOARD';
  else if (amount >= WRITEOFF_THRESHOLDS.CFO)    requiredApproval = 'CFO';
  else if (amount >= WRITEOFF_THRESHOLDS.MANAGER)requiredApproval = 'MANAGER';
  else                                            requiredApproval = 'SUPERVISOR';

  return { valid: errors.length === 0, errors, requiredApproval };
}

function validateAdjustment(data, invoiceAmount) {
  const errors = [];
  if (!data.account_ID) errors.push('Account ID is required.');
  if (!data.adjustmentType) errors.push('Adjustment type is required.');
  if (!data.direction || !['CREDIT', 'DEBIT'].includes(data.direction))
    errors.push('Direction must be CREDIT or DEBIT.');
  if (!data.amount || data.amount <= 0) errors.push('Amount must be > 0.');
  if (!data.reason || data.reason.trim().length < 10)
    errors.push('Reason must be at least 10 characters.');
  // Cross-validate adjustment amount against invoice if available
  if (invoiceAmount != null && data.amount > invoiceAmount) {
    errors.push(`Adjustment amount RM${data.amount} exceeds invoice total RM${invoiceAmount}.`);
  }
  return { valid: errors.length === 0, errors };
}

function throwIfInvalid(validationResult) {
  if (!validationResult.valid) {
    const error = new Error(validationResult.errors.join('; '));
    error.statusCode = 400;
    throw error;
  }
}

module.exports = {
  validateCustomerAccount, validateManualInvoice, validatePayment,
  validatePaymentPlan, validateWriteOff, validateAdjustment, throwIfInvalid,
};
