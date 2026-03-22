'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const dayjs = require('dayjs');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('iwrs-adapter');

// ── CONFIGURATION ───────────────────────────────────────────────────────────
// Loaded at runtime from iWRSIntegrationConfig entity (single active record).
// Fallback to environment variables if DB config not available.

const IWRS_CONFIG = {
  PATTERN_A_BASE_URL:
    process.env.IWRS_API_BASE_URL ||
    '/* TBC: iWRS REST API base URL — from iWRS vendor after Pattern A engagement */',
  PATTERN_A_API_KEY:
    process.env.IWRS_API_KEY ||
    '/* TBC: iWRS API key — store in BTP Credential Store or HashiCorp Vault */',
  PATTERN_B_SFTP_HOST:
    '/* TBC: iWRS SFTP hostname — confirm with iWRS vendor if Pattern B selected */',
  PATTERN_B_SFTP_USER:
    '/* TBC: iWRS SFTP username */',
  PATTERN_B_SFTP_KEY_REF:
    '/* TBC: SSH private key reference in BTP Credential Store / Vault */',
  PATTERN_B_DELTA_PATH:
    '/* TBC: path on iWRS SFTP where delta files are deposited */',
  PATTERN_B_FILE_PATTERN:
    '/* TBC: file naming pattern e.g. DELTA_ACCOUNTS_YYYYMMDD.csv */',
  PATTERN_C_DB_HOST:
    '/* TBC: iWRS database hostname — only if Pattern C selected as last resort */',
  PATTERN_C_DB_PORT:
    '/* TBC: iWRS database port */',
  PATTERN_C_DB_SCHEMA:
    '/* TBC: iWRS read-only schema name */',
  PATTERN_C_DB_USER_REF:
    '/* TBC: iWRS read-only service account credential reference */',
  OUTBOUND_ENDPOINT:
    process.env.IWRS_OUTBOUND_URL ||
    '/* TBC: iWRS endpoint to receive AR Hub notifications (disconnection/reconnection) */',
  OUTBOUND_API_KEY:
    process.env.IWRS_OUTBOUND_API_KEY ||
    '/* TBC: outbound API key for iWRS notification endpoint */',
  DEFAULT_PATTERN: process.env.IWRS_ACTIVE_PATTERN || 'PATTERN_A',
  REQUEST_TIMEOUT_MS: 30000,
};

// ═══════════════════════════════════════════════════════════════════════════
// PATTERN A — REST API (PRIMARY IMPLEMENTATION)
// Called when iWRS pushes events to AR Hub via HTTP POST.
// All inbound processing functions are called by the iWRS Integration Service
// handler when a receiveAccountEvent / receiveInvoiceEvent / receivePaymentEvent
// action is triggered.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Process an account event received from iWRS via Pattern A (REST).
 * Handles ACCOUNT_CREATED, ACCOUNT_UPDATED, and ACCOUNT_CLOSED.
 *
 * @param {String} eventType    - ACCOUNT_CREATED | ACCOUNT_UPDATED | ACCOUNT_CLOSED
 * @param {String} iWRSRef      - iWRS event reference
 * @param {String} accountNumber
 * @param {Object} payload      - Parsed iWRS account payload
 * @returns {{ success, arHubAccountID, message }}
 */
async function processAccountEvent(eventType, iWRSRef, accountNumber, payload) {
  const db = await cds.connect.to('db');
  const startTime = Date.now();

  // Log event receipt immediately (before processing — for auditability)
  const eventID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.integration.iWRSEventLog').entries({
    ID: eventID,
    eventType,
    eventSource: 'PATTERN_A',
    iWRSReference: iWRSRef,
    accountNumber,
    rawPayload: JSON.stringify(payload),
    processingStatus: 'RECEIVED',
  }));

  try {
    // Wrap core processing in a transaction for atomicity
    const result = await cds.tx(async tx => {
      let arHubAccountID;
      let message;

      if (eventType === 'ACCOUNT_CREATED') {
        arHubAccountID = await _createAccountFromiWRS(tx, payload);
        message = `Account ${accountNumber} created in AR Hub`;

      } else if (eventType === 'ACCOUNT_UPDATED') {
        arHubAccountID = await _updateAccountFromiWRS(tx, accountNumber, payload);
        message = `Account ${accountNumber} updated in AR Hub`;

      } else if (eventType === 'ACCOUNT_CLOSED') {
        arHubAccountID = await _closeAccountFromiWRS(tx, accountNumber, payload);
        message = `Account ${accountNumber} closure processed in AR Hub`;

      } else {
        throw new Error(`Unknown account event type: ${eventType}`);
      }

      return { arHubAccountID, message };
    });

    // Update event log — PROCESSED (outside transaction — always commits)
    const durationMs = Date.now() - startTime;
    await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
      processingStatus: 'PROCESSED',
      resolvedAccountID: result.arHubAccountID,
      processingDurationMs: durationMs,
      processedAt: new Date().toISOString(),
    }).where({ ID: eventID }));

    return { success: true, arHubAccountID: result.arHubAccountID, message: result.message };

  } catch (err) {
    logger.error(`iWRS account event ${eventType} for ${accountNumber} failed: ${err.message}`);
    await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
      processingStatus: 'FAILED',
      processingError: err.message.substring(0, 500),
      processingDurationMs: Date.now() - startTime,
      processedAt: new Date().toISOString(),
    }).where({ ID: eventID }));

    throw err;
  }
}

/**
 * Create a new CustomerAccount record from an iWRS account payload.
 * Mapping: iWRS fields → AR Hub CustomerAccount fields.
 *
 * FIELD MAPPING (TBC — confirm field names with iWRS vendor):
 * iWRS field name → AR Hub field name
 * acc_no          → accountNumber
 * cust_name       → legalName
 * id_no           → ICNumber (will be encrypted)
 * id_type         → holderType ('IC' → 'INDIVIDUAL', 'BRN' → 'COMPANY')
 * acc_type        → accountType_code mapping (see mapping table below)
 * addr_1..4       → serviceAddress1..4
 * addr_postcode   → servicePostcode
 * addr_city       → serviceCity
 * addr_state      → serviceState
 * phone_1         → primaryPhone
 * phone_2         → secondaryPhone
 * email           → emailAddress
 * branch_code     → branchCode
 * tariff_code     → tariffBand_code
 * meter_ref       → meterReference
 * pipe_size_mm    → connectionSizeMM
 * open_date       → accountOpenDate
 * billing_type    → billingBasis_code ('M' → 'MTR', 'E' → 'EST', 'F' → 'FLAT')
 *
 * TBC: Confirm exact iWRS field names with iWRS vendor before go-live
 */
async function _createAccountFromiWRS(db, payload) {
  const accountNumber = payload.acc_no || payload.accountNumber;
  if (!accountNumber) throw new Error('iWRS payload missing account number');

  // Check for duplicate (idempotency)
  const existing = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .columns('ID')
      .where({ accountNumber })
  );
  if (existing) {
    logger.warn(`iWRS ACCOUNT_CREATED: account ${accountNumber} already exists — treating as update`);
    return await _updateAccountFromiWRS(db, accountNumber, payload);
  }

  // Map account type code
  // /* TBC: Confirm iWRS account type codes with iWRS vendor */
  const accTypeMap = {
    'DOM': 'DOM', 'RES': 'DOM', 'R': 'DOM',           // Domestic
    'COM_S': 'COM_S', 'CS': 'COM_S',                   // Small commercial
    'COM_L': 'COM_L', 'CL': 'COM_L',                   // Large commercial
    'IND': 'IND', 'I': 'IND',                          // Industrial
    'GOV': 'GOV', 'G': 'GOV',                          // Government
    'INST': 'INST', 'IN': 'INST',                      // Institutional
  };

  const billingBasisMap = {
    'M': 'MTR', 'METER': 'MTR', 'METERED': 'MTR',
    'E': 'EST', 'ESTIMATE': 'EST', 'ESTIMATED': 'EST',
    'F': 'FLAT', 'FLAT': 'FLAT',
  };

  const holderTypeMap = {
    'IC': 'INDIVIDUAL', 'NRIC': 'INDIVIDUAL', 'PP': 'INDIVIDUAL',
    'BRN': 'COMPANY', 'RN': 'COMPANY', 'CO': 'COMPANY',
  };

  const rawAccType = payload.acc_type || payload.accountType || 'DOM';
  const rawBilling = payload.billing_type || payload.billingType || 'M';
  const rawIDType  = payload.id_type || payload.idType || 'IC';

  const accountID = cds.utils.uuid();

  // Encrypt IC number if provided
  let encryptedIC = null;
  if (payload.id_no || payload.idNumber) {
    const { encryptField } = require('../lib/crypto-helper');
    encryptedIC = await encryptField(payload.id_no || payload.idNumber);
  }

  await db.run(INSERT.into('sains.ar.CustomerAccount').entries({
    ID: accountID,
    accountNumber,
    legalName: (payload.cust_name || payload.legalName || '').substring(0, 200),
    ICNumber: encryptedIC,
    holderType: holderTypeMap[rawIDType] || 'INDIVIDUAL',
    accountType_code: accTypeMap[rawAccType] || 'DOM',
    billingBasis_code: billingBasisMap[rawBilling] || 'MTR',
    accountStatus: 'ACTIVE',
    dunningLevel: 0,
    balanceOutstanding: 0,
    balanceCreditOnAccount: 0,
    balanceDeposit: 0,
    serviceAddress1: (payload.addr_1 || payload.address1 || '').substring(0, 100),
    serviceAddress2: (payload.addr_2 || payload.address2 || '').substring(0, 100),
    serviceAddress3: (payload.addr_3 || payload.address3 || '').substring(0, 100),
    serviceAddress4: (payload.addr_4 || payload.address4 || '').substring(0, 100),
    servicePostcode: payload.addr_postcode || payload.postcode || '00000',
    serviceCity: payload.addr_city || payload.city || '',
    serviceState: payload.addr_state || payload.state || '',
    primaryPhone: payload.phone_1 || payload.primaryPhone || '',
    secondaryPhone: payload.phone_2 || payload.secondaryPhone || '',
    emailAddress: payload.email || payload.emailAddress || '',
    branchCode: payload.branch_code || payload.branchCode || '/* TBC */',
    tariffBand_code: payload.tariff_code || payload.tariffCode || '/* TBC */',
    meterReference: payload.meter_ref || payload.meterReference || '',
    connectionSizeMM: parseInt(payload.pipe_size_mm || payload.connectionSizeMM || '15'),
    accountOpenDate: payload.open_date || payload.openDate || new Date().toISOString().substring(0, 10),
    isGovernment: (accTypeMap[rawAccType] === 'GOV'),
    isHardship: false,
    isPaymentPlan: false,
    isWrittenOff: false,
    isLegalAction: false,
    isDisputed: false,
    paperBillingElected: false,
    einvoiceRequired: (accTypeMap[rawAccType] !== 'DOM'),
    einvoiceStatus: 'NOT_REQUIRED',
  }));

  await logSystemAction({
    accountID,
    actionType: 'CREATE',
    entityType: 'CustomerAccount',
    entityID: accountID,
    afterState: { accountNumber, sourceSystem: 'iWRS', eventType: 'ACCOUNT_CREATED' },
    sourceSystem: 'iWRS',
  });

  logger.info(`iWRS: Account ${accountNumber} created — AR Hub ID ${accountID}`);
  return accountID;
}

/**
 * Update an existing CustomerAccount from an iWRS account-updated event.
 * Only updates fields that iWRS is authoritative for.
 * Does not overwrite fields owned by AR Hub (balances, dunning state, etc.).
 * Creates an auto-approved AccountChangeRequest for restricted fields.
 */
async function _updateAccountFromiWRS(db, accountNumber, payload) {
  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .where({ accountNumber })
  );
  if (!account) {
    // Account not found — create it (handles race conditions)
    logger.warn(`iWRS ACCOUNT_UPDATED: ${accountNumber} not in AR Hub — creating`);
    return await _createAccountFromiWRS(db, payload);
  }

  // Build update object — only iWRS-owned fields
  const updates = {};

  if (payload.cust_name || payload.legalName) {
    updates.legalName = (payload.cust_name || payload.legalName).substring(0, 200);
  }
  if (payload.addr_1 !== undefined) updates.serviceAddress1 = (payload.addr_1 || '').substring(0, 100);
  if (payload.addr_2 !== undefined) updates.serviceAddress2 = (payload.addr_2 || '').substring(0, 100);
  if (payload.addr_3 !== undefined) updates.serviceAddress3 = (payload.addr_3 || '').substring(0, 100);
  if (payload.addr_4 !== undefined) updates.serviceAddress4 = (payload.addr_4 || '').substring(0, 100);
  if (payload.addr_postcode) updates.servicePostcode = payload.addr_postcode;
  if (payload.addr_city) updates.serviceCity = payload.addr_city;
  if (payload.phone_1) updates.primaryPhone = payload.phone_1;
  if (payload.phone_2) updates.secondaryPhone = payload.phone_2;
  if (payload.email) updates.emailAddress = payload.email;
  if (payload.tariff_code) updates.tariffBand_code = payload.tariff_code;
  if (payload.meter_ref) updates.meterReference = payload.meter_ref;

  if (Object.keys(updates).length > 0) {
    await db.run(UPDATE('sains.ar.CustomerAccount').set(updates).where({ ID: account.ID }));

    await logSystemAction({
      accountID: account.ID,
      actionType: 'UPDATE',
      entityType: 'CustomerAccount',
      entityID: account.ID,
      beforeState: { accountNumber },
      afterState: { ...updates, sourceSystem: 'iWRS', eventType: 'ACCOUNT_UPDATED' },
      sourceSystem: 'iWRS',
    });
  }

  return account.ID;
}

/**
 * Process account closure from iWRS.
 * Steps per comms architecture Scenario 2.3:
 * 1. If balanceOutstanding > 0: flag for Finance review, do not close
 * 2. If balance = 0 and deposit > 0: initiate deposit refund workflow
 * 3. If both zero: set CLOSED
 * 4. Cancel active PTP and payment plan
 * 5. Freeze dunning
 */
async function _closeAccountFromiWRS(db, accountNumber, payload) {
  const account = await db.run(
    SELECT.one.from('sains.ar.CustomerAccount')
      .columns('ID', 'accountNumber', 'accountStatus', 'balanceOutstanding', 'balanceDeposit',
               'dunningLevel', 'isPaymentPlan')
      .where({ accountNumber })
  );
  if (!account) {
    throw new Error(`Account ${accountNumber} not found in AR Hub for closure`);
  }

  if (Number(account.balanceOutstanding) > 0) {
    // Cannot close — flag for Finance review
    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      accountStatus: 'PENDING_CLOSURE',
    }).where({ ID: account.ID }));

    logger.warn(`iWRS ACCOUNT_CLOSED: ${accountNumber} has outstanding balance RM ${account.balanceOutstanding} — pending Finance review`);
    return account.ID;
  }

  if (Number(account.balanceDeposit) > 0) {
    // Trigger deposit refund workflow
    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      accountStatus: 'PENDING_CLOSURE',
    }).where({ ID: account.ID }));

    // Create deposit refund request — Finance Admin picks it up
    const deposits = await db.run(
      SELECT.from('sains.ar.DepositRecord')
        .where({ account_ID: account.ID, status: 'HELD' })
    );
    for (const deposit of deposits) {
      await db.run(UPDATE('sains.ar.DepositRecord').set({
        status: 'REFUND_REQUESTED',
        refundRequestedAt: new Date().toISOString(),
        refundReason: 'Account closure initiated by iWRS',
      }).where({ ID: deposit.ID }));
    }

    logger.info(`iWRS ACCOUNT_CLOSED: ${accountNumber} deposit refund triggered`);
    return account.ID;
  }

  // Both zero — close immediately
  await db.run(UPDATE('sains.ar.CustomerAccount').set({
    accountStatus: 'CLOSED',
    accountCloseDate: payload.close_date || new Date().toISOString().substring(0, 10),
    dunningLevel: 0,
  }).where({ ID: account.ID }));

  // Cancel active PTPs
  await db.run(UPDATE('sains.ar.PromiseToPay').set({
    status: 'CANCELLED',
  }).where({ account_ID: account.ID, status: 'ACTIVE' }));

  // Cancel active payment plans
  await db.run(UPDATE('sains.ar.PaymentPlan').set({
    status: 'CANCELLED',
  }).where({ account_ID: account.ID, status: { in: ['ACTIVE', 'PARTIAL'] } }));

  await logSystemAction({
    accountID: account.ID,
    actionType: 'CLOSE',
    entityType: 'CustomerAccount',
    entityID: account.ID,
    afterState: { accountNumber, status: 'CLOSED', sourceSystem: 'iWRS' },
    sourceSystem: 'iWRS',
  });

  logger.info(`iWRS ACCOUNT_CLOSED: ${accountNumber} closed in AR Hub`);
  return account.ID;
}

/**
 * Process an invoice event received from iWRS (originally from SiBMA).
 * Creates an Invoice record and open item.
 *
 * iWRS → AR Hub invoice payload field mapping (TBC — confirm with iWRS vendor):
 * bill_no          → invoiceNumber
 * acc_no           → accountNumber → resolves to account_ID
 * bill_date        → invoiceDate
 * due_date         → dueDate
 * period_from      → billingPeriodFrom
 * period_to        → billingPeriodTo
 * line_items[]     → InvoiceLineItem records
 *   line_items[].charge_code → chargeType_code
 *   line_items[].desc        → description
 *   line_items[].qty         → quantity
 *   line_items[].unit_price  → unitPrice
 *   line_items[].amount      → lineAmount
 *   line_items[].tax_amt     → taxAmount
 * total_amount     → totalAmount
 * tax_total        → taxAmount (header level)
 * meter_prev       → meterReadPrevious
 * meter_curr       → meterReadCurrent
 * consumption_m3   → consumptionM3
 * read_type        → meterReadType ('A' → 'ACTUAL', 'E' → 'ESTIMATED')
 *
 * TBC: Confirm exact iWRS invoice payload field names with iWRS vendor
 */
async function processInvoiceEvent(iWRSRef, accountNumber, payload) {
  const db = await cds.connect.to('db');
  const startTime = Date.now();

  const eventID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.integration.iWRSEventLog').entries({
    ID: eventID,
    eventType: 'INVOICE_GENERATED',
    eventSource: 'PATTERN_A',
    iWRSReference: iWRSRef,
    accountNumber,
    rawPayload: JSON.stringify(payload),
    processingStatus: 'RECEIVED',
  }));

  try {
    const invoiceNumber = payload.bill_no || payload.invoiceNumber;
    if (!invoiceNumber) throw new Error('iWRS invoice payload missing bill_no');

    // Check for duplicate invoice (outside transaction — read-only check)
    const existingInvoice = await db.run(
      SELECT.one.from('sains.ar.Invoice')
        .columns('ID')
        .where({ invoiceNumber })
    );
    if (existingInvoice) {
      logger.warn(`iWRS INVOICE_GENERATED: ${invoiceNumber} already exists — skipping`);
      await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
        processingStatus: 'DUPLICATE',
        processingDurationMs: Date.now() - startTime,
        processedAt: new Date().toISOString(),
      }).where({ ID: eventID }));
      return { success: true, arHubInvoiceID: existingInvoice.ID, message: 'Duplicate — skipped' };
    }

    // Resolve account (outside transaction — read-only check)
    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns('ID', 'accountStatus', 'accountType_code', 'balanceOutstanding',
                 'einvoiceRequired', 'buyerTIN', 'buyerTINVerified')
        .where({ accountNumber })
    );
    if (!account) {
      // Account not yet in AR Hub — put invoice in suspense
      await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
        processingStatus: 'SUSPENSE',
        processingError: `Account ${accountNumber} not found in AR Hub`,
        processingDurationMs: Date.now() - startTime,
        processedAt: new Date().toISOString(),
      }).where({ ID: eventID }));
      return {
        success: false,
        arHubInvoiceID: null,
        message: `Account ${accountNumber} not in AR Hub — invoice in suspense`,
      };
    }

    const totalAmount = Number(payload.total_amount || payload.totalAmount || 0);
    const taxAmount = Number(payload.tax_total || payload.taxAmount || 0);
    const invoiceDate = payload.bill_date || payload.invoiceDate;
    const dueDate = payload.due_date || payload.dueDate ||
      dayjs(invoiceDate).add(30, 'day').format('YYYY-MM-DD');

    // Determine eInvoice status
    let einvoiceStatus = 'NOT_REQUIRED';
    if (account.einvoiceRequired) {
      einvoiceStatus = account.buyerTINVerified ? 'PENDING' : 'HELD_NO_TIN';
    }

    // Wrap all data mutations in a single transaction for atomicity
    const invoiceID = await cds.tx(async tx => {
      const newInvoiceID = cds.utils.uuid();

      await tx.run(INSERT.into('sains.ar.Invoice').entries({
        ID: newInvoiceID,
        account_ID: account.ID,
        invoiceNumber,
        invoiceType: 'STANDARD',
        invoiceDate,
        dueDate,
        billingPeriodFrom: payload.period_from || payload.billingPeriodFrom,
        billingPeriodTo: payload.period_to || payload.billingPeriodTo,
        totalAmount,
        taxAmount,
        amountOutstanding: totalAmount,
        amountCleared: 0,
        status: 'OPEN',
        einvoiceRequired: account.einvoiceRequired || false,
        einvoiceStatus,
        sourceSystem: 'iWRS',
        sourceReference: iWRSRef,
        meterReadPrevious: payload.meter_prev || payload.meterReadPrevious,
        meterReadCurrent: payload.meter_curr || payload.meterReadCurrent,
        consumptionM3: payload.consumption_m3 || payload.consumptionM3,
        meterReadType: (payload.read_type === 'E' || payload.meterReadType === 'ESTIMATED')
          ? 'ESTIMATED' : 'ACTUAL',
      }));

      // Create line items
      const lineItems = payload.line_items || payload.lineItems || [];
      for (let i = 0; i < lineItems.length; i++) {
        const line = lineItems[i];
        await tx.run(INSERT.into('sains.ar.InvoiceLineItem').entries({
          ID: cds.utils.uuid(),
          invoice_ID: newInvoiceID,
          lineSequence: i + 1,
          chargeType_code: line.charge_code || line.chargeType || 'WATER_CONSUMPTION',
          description: (line.desc || line.description || '').substring(0, 200),
          quantity: Number(line.qty || line.quantity || 1),
          unitPrice: Number(line.unit_price || line.unitPrice || 0),
          lineAmount: Number(line.amount || line.lineAmount || 0),
          taxAmount: Number(line.tax_amt || line.taxAmount || 0),
          taxCategory: 'E', // Water is exempt supply in Malaysia
          discountAmount: Number(line.discount || line.discountAmount || 0),
        }));
      }

      // Update account balance
      await tx.run(UPDATE('sains.ar.CustomerAccount')
        .set({ balanceOutstanding: { '+=': totalAmount } })
        .where({ ID: account.ID })
      );

      // Create meter read history record
      if (payload.meter_curr) {
        await tx.run(INSERT.into('sains.ar.MeterReadHistory').entries({
          ID: cds.utils.uuid(),
          account_ID: account.ID,
          readDate: invoiceDate,
          meterReadType: (payload.read_type === 'E') ? 'ESTIMATED' : 'ACTUAL',
          readValue: Number(payload.meter_curr || 0),
          previousValue: Number(payload.meter_prev || 0),
          consumptionM3: Number(payload.consumption_m3 || 0),
          sourceSystem: 'iWRS',
        }));
      }

      return newInvoiceID;
    });

    // Update event log — PROCESSED (outside transaction — always commits)
    await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
      processingStatus: 'PROCESSED',
      resolvedAccountID: account.ID,
      processingDurationMs: Date.now() - startTime,
      processedAt: new Date().toISOString(),
    }).where({ ID: eventID }));

    logger.info(`iWRS: Invoice ${invoiceNumber} created for ${accountNumber} — RM ${totalAmount}`);
    return { success: true, arHubInvoiceID: invoiceID, message: `Invoice ${invoiceNumber} created` };

  } catch (err) {
    logger.error(`iWRS invoice event for ${accountNumber} failed: ${err.message}`);
    await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
      processingStatus: 'FAILED',
      processingError: err.message.substring(0, 500),
      processingDurationMs: Date.now() - startTime,
      processedAt: new Date().toISOString(),
    }).where({ ID: eventID }));
    throw err;
  }
}

/**
 * Process a counter payment event received from iWRS.
 * Creates a PaymentOrchestratorEvent for the clearing engine.
 *
 * iWRS payment payload field mapping (TBC — confirm with iWRS vendor):
 * receipt_no    → rawReference (unique receipt number)
 * acc_no        → accountNumber
 * pay_date      → transactionDate
 * pay_time      → transactionTime
 * channel_code  → sourceChannel ('CASH' → 'COUNTER_CASH', 'CHQ' → 'COUNTER_CHEQUE',
 *                                 'CARD' → 'COUNTER_CARD')
 * amount        → amount
 * cashier_id    → metadata.cashierId
 * counter_code  → metadata.counterCode
 * branch_code   → metadata.branchCode
 * cheque_no     → metadata.chequeNumber (for COUNTER_CHEQUE)
 * cheque_bank   → metadata.chequeBank
 * cheque_date   → metadata.chequeClearanceDueDate (set to T+3 business days)
 *
 * TBC: Confirm exact iWRS payment payload field names with iWRS vendor
 */
async function processPaymentEvent(iWRSRef, accountNumber, payload) {
  const db = await cds.connect.to('db');
  const startTime = Date.now();

  const eventID = cds.utils.uuid();
  await db.run(INSERT.into('sains.ar.integration.iWRSEventLog').entries({
    ID: eventID,
    eventType: 'PAYMENT_RECEIVED',
    eventSource: 'PATTERN_A',
    iWRSReference: iWRSRef,
    accountNumber,
    rawPayload: JSON.stringify(payload),
    processingStatus: 'RECEIVED',
  }));

  try {
    const receiptNo = payload.receipt_no || payload.receiptNumber;
    if (!receiptNo) throw new Error('iWRS payment payload missing receipt_no');

    // ── DUPLICATE GUARD ────────────────────────────────────────────────────
    // Check if a PaymentOrchestratorEvent with this receipt number already exists.
    // iWRS may retry the notification if it receives a timeout or 5xx response.
    // Without this guard, a retry creates a second event and double-credits the account.
    const existingEvent = await db.run(
      SELECT.one.from('sains.ar.payment.PaymentOrchestratorEvent')
        .columns('ID', 'status')
        .where({ rawReference: receiptNo, sourceChannel: { in: [
          'COUNTER_CASH', 'COUNTER_CHEQUE', 'COUNTER_CARD'
        ]}})
    );

    if (existingEvent) {
      logger.warn(`iWRS PAYMENT_RECEIVED: receipt ${receiptNo} already in Orchestrator (${existingEvent.status}) — skipping`);
      await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
        processingStatus: 'DUPLICATE',
        processingDurationMs: Date.now() - startTime,
        processedAt: new Date().toISOString(),
      }).where({ ID: eventID }));
      return {
        success: true,
        arHubEventID: existingEvent.ID,
        message: `Duplicate receipt ${receiptNo} — skipped`,
      };
    }
    // ── END DUPLICATE GUARD ────────────────────────────────────────────────

    const channelMap = {
      'CASH': 'COUNTER_CASH', 'C': 'COUNTER_CASH',
      'CHQ': 'COUNTER_CHEQUE', 'Q': 'COUNTER_CHEQUE', 'CHEQUE': 'COUNTER_CHEQUE',
      'CARD': 'COUNTER_CARD', 'D': 'COUNTER_CARD', 'DEBIT': 'COUNTER_CARD',
    };
    const rawChannel = payload.channel_code || payload.channelCode || 'CASH';
    const sourceChannel = channelMap[rawChannel] || 'COUNTER_CASH';

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns('ID', 'accountStatus')
        .where({ accountNumber })
    );

    // Wrap payment event creation in transaction for atomicity
    const orchEventID = await cds.tx(async tx => {
      const newID = cds.utils.uuid();
      await tx.run(INSERT.into('sains.ar.payment.PaymentOrchestratorEvent').entries({
        ID: newID,
        sourceChannel,
        rawReference: receiptNo,
        payerReference: accountNumber,
        resolvedAccountID: account?.ID || null,
        amount: Number(payload.amount || 0),
        currency: 'MYR',
        transactionDate: payload.pay_date || payload.transactionDate,
        transactionTime: payload.pay_time || payload.transactionTime,
        valueDate: payload.pay_date || payload.transactionDate,
        status: account ? 'RESOLVED' : 'SUSPENSE',
        sourceMetadata: JSON.stringify({
          cashierId: payload.cashier_id || payload.cashierId,
          counterCode: payload.counter_code || payload.counterCode,
          branchCode: payload.branch_code || payload.branchCode,
          chequeNumber: payload.cheque_no || payload.chequeNumber,
          chequeBank: payload.cheque_bank || payload.chequeBank,
          iWRSReceiptNo: receiptNo,
        }),
      }));
      return newID;
    });

    await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
      processingStatus: 'PROCESSED',
      resolvedAccountID: account?.ID || null,
      processingDurationMs: Date.now() - startTime,
      processedAt: new Date().toISOString(),
    }).where({ ID: eventID }));

    logger.info(`iWRS: Payment ${receiptNo} for ${accountNumber} RM ${payload.amount} queued in Orchestrator`);
    return { success: true, arHubEventID: orchEventID, message: `Payment ${receiptNo} queued` };

  } catch (err) {
    logger.error(`iWRS payment event for ${accountNumber} failed: ${err.message}`);
    await db.run(UPDATE('sains.ar.integration.iWRSEventLog').set({
      processingStatus: 'FAILED',
      processingError: err.message.substring(0, 500),
      processingDurationMs: Date.now() - startTime,
      processedAt: new Date().toISOString(),
    }).where({ ID: eventID }));
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTBOUND — AR HUB → iWRS
// Called by dunning.js (disconnection) and clearing-engine.js (reconnection).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Notify iWRS that disconnection has been authorised for an account.
 * Called after BILSupervisor / FinanceSupervisor authorises disconnection in AR Hub.
 *
 * @param {Object} account         - CustomerAccount record
 * @param {String} authorisedBy    - User ID of authoriser
 * @param {String} authorisationRef - AR Hub authorisation reference
 */
async function notifyDisconnectionAuthorised(account, authorisedBy, authorisationRef) {
  if (!IWRS_CONFIG.OUTBOUND_ENDPOINT || IWRS_CONFIG.OUTBOUND_ENDPOINT.startsWith('/*')) {
    logger.warn(`iWRS outbound endpoint not configured — logging disconnection notification only`);
    logger.info(`DISCONNECTION AUTHORISED: account=${account.accountNumber} ref=${authorisationRef}`);
    return false;
  }

  try {
    const payload = {
      eventType: 'DISCONNECTION_AUTHORISED',
      accountNumber: account.accountNumber,
      authorisedBy,
      authorisationRef,
      authorisationDate: new Date().toISOString().substring(0, 10),
      outstandingBalance: account.balanceOutstanding,
      dunningLevel: account.dunningLevel,
      arHubAccountID: account.ID,
    };

    await axios.post(IWRS_CONFIG.OUTBOUND_ENDPOINT, payload, {
      headers: {
        'Authorization': `Bearer ${IWRS_CONFIG.OUTBOUND_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Source': 'SAINS-AR-HUB',
      },
      timeout: IWRS_CONFIG.REQUEST_TIMEOUT_MS,
    });

    logger.info(`iWRS: Disconnection notification sent for ${account.accountNumber}`);
    return true;

  } catch (err) {
    // Non-blocking — log the failure but do not roll back the disconnection authorisation
    logger.error(`iWRS: Disconnection notification FAILED for ${account.accountNumber}: ${err.message}`);
    // Alert Finance Admin via notification service
    const notif = require('./notification-service');
    await notif.sendSystemAlert({
      type: 'iWRS_OUTBOUND_FAILURE',
      subject: `iWRS disconnection notification failed — ${account.accountNumber}`,
      body: `Failed to notify iWRS of disconnection authorisation for account ${account.accountNumber}. Error: ${err.message}. Manual iWRS update may be required.`,
      recipients: 'FinanceAdmin',
    });
    return false;
  }
}

/**
 * Notify iWRS that an account has been reconnected (balance cleared).
 * Called automatically by the clearing engine when a TEMP_DISCONNECTED account
 * reaches zero balance.
 */
async function notifyReconnection(account, paymentReference, clearedAt) {
  if (!IWRS_CONFIG.OUTBOUND_ENDPOINT || IWRS_CONFIG.OUTBOUND_ENDPOINT.startsWith('/*')) {
    logger.warn(`iWRS outbound endpoint not configured — logging reconnection notification only`);
    logger.info(`RECONNECTION TRIGGERED: account=${account.accountNumber} payment=${paymentReference}`);
    return false;
  }

  try {
    const payload = {
      eventType: 'RECONNECTION_AUTHORISED',
      accountNumber: account.accountNumber,
      paymentReference,
      clearedAt,
      clearedBalance: 0,
      arHubAccountID: account.ID,
    };

    await axios.post(IWRS_CONFIG.OUTBOUND_ENDPOINT, payload, {
      headers: {
        'Authorization': `Bearer ${IWRS_CONFIG.OUTBOUND_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Source': 'SAINS-AR-HUB',
      },
      timeout: IWRS_CONFIG.REQUEST_TIMEOUT_MS,
    });

    logger.info(`iWRS: Reconnection notification sent for ${account.accountNumber}`);
    return true;

  } catch (err) {
    logger.error(`iWRS: Reconnection notification FAILED for ${account.accountNumber}: ${err.message}`);
    const notif = require('./notification-service');
    await notif.sendSystemAlert({
      type: 'iWRS_OUTBOUND_FAILURE',
      subject: `iWRS reconnection notification failed — ${account.accountNumber}`,
      body: `Failed to notify iWRS of reconnection for account ${account.accountNumber}. Error: ${err.message}. Manual iWRS update required.`,
      recipients: 'FinanceAdmin',
    });
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PATTERN B — SFTP BATCH FILE (TBC STUB)
// Activated when iWRS vendor confirms SFTP capability.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Download and process iWRS delta file from SFTP.
 * Called by scheduled job when Pattern B is active.
 * TBC: Implement after iWRS vendor confirms SFTP file format and path.
 */
async function processPatternBDeltaFile(fileDate) {
  // TBC: Implement with ssh2-sftp-client after iWRS vendor confirms:
  // 1. SFTP hostname, port, username, key
  // 2. File path and naming convention
  // 3. File format (CSV columns for accounts, invoices, payments)
  // 4. Whether one file per event type or combined

  logger.warn(`iWRS Pattern B not yet implemented — TBC pending iWRS vendor confirmation`);
  throw new Error(
    'iWRS SFTP Pattern B: TBC — implement after iWRS vendor confirms SFTP capability. ' +
    'Required: SFTP hostname, username, key, file path, file format specification.'
  );
}

/**
 * Parse an iWRS account delta CSV file.
 * TBC: Column names depend on iWRS vendor's export format.
 */
function parsePatternBAccountFile(csvContent) {
  // TBC: Parse CSV file from iWRS SFTP
  // Expected columns (TBC — confirm with iWRS vendor):
  // EVENT_TYPE, TIMESTAMP, ACC_NO, CUST_NAME, ID_NO, ID_TYPE, ACC_TYPE,
  // ADDR_1..4, POSTCODE, CITY, STATE, PHONE_1, PHONE_2, EMAIL,
  // BRANCH_CODE, TARIFF_CODE, METER_REF, PIPE_SIZE_MM, OPEN_DATE,
  // BILLING_TYPE, CLOSE_DATE (if closure)
  throw new Error('iWRS Pattern B account parser: TBC');
}

/**
 * Parse an iWRS invoice delta CSV file.
 * TBC: Column names depend on iWRS vendor's export format.
 */
function parsePatternBInvoiceFile(csvContent) {
  // TBC: Parse CSV file from iWRS SFTP
  // Expected columns (TBC — confirm with iWRS vendor):
  // BILL_NO, ACC_NO, BILL_DATE, DUE_DATE, PERIOD_FROM, PERIOD_TO,
  // TOTAL_AMOUNT, TAX_TOTAL, METER_PREV, METER_CURR, CONSUMPTION_M3,
  // READ_TYPE, [line items as multiple columns or separate file]
  throw new Error('iWRS Pattern B invoice parser: TBC');
}

// ═══════════════════════════════════════════════════════════════════════════
// PATTERN C — DIRECT DB QUERY (TBC STUB — LAST RESORT ONLY)
// Only use if iWRS vendor cannot provide REST API or SFTP.
// Creates direct schema dependency on iWRS database — strongly discouraged.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Poll iWRS database for new accounts since last sync timestamp.
 * TBC: Implement only if Patterns A and B are both unavailable.
 * Requires read-only service account and schema stability guarantee from iWRS vendor.
 */
async function pollPatternCAccounts(sinceTimestamp) {
  // TBC: Implement with mssql / mysql2 / pg client depending on iWRS DB engine
  // Required from iWRS vendor:
  // 1. DB engine type (MS SQL / Oracle / MySQL / PostgreSQL)
  // 2. Read-only service account credentials
  // 3. Schema name and table names for accounts, invoices, payments
  // 4. Timestamp column name for delta detection
  // 5. Written guarantee that schema will not change without prior notice (SLA)

  logger.warn('iWRS Pattern C (Direct DB): TBC — last resort only. Requires iWRS vendor schema documentation.');
  throw new Error(
    'iWRS Pattern C: TBC — implement only if Patterns A and B are unavailable. ' +
    'Requires: DB engine, read-only credentials, schema documentation, SLA on schema stability.'
  );
}

module.exports = {
  // Pattern A (primary)
  processAccountEvent,
  processInvoiceEvent,
  processPaymentEvent,
  // Outbound
  notifyDisconnectionAuthorised,
  notifyReconnection,
  // Pattern B stubs
  processPatternBDeltaFile,
  parsePatternBAccountFile,
  parsePatternBInvoiceFile,
  // Pattern C stubs
  pollPatternCAccounts,
};
