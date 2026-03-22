'use strict';

const cds = require('@sap/cds');

const logger = cds.log('customer-portal-service');

module.exports = cds.service.impl(async function () {

  // ── ROW-LEVEL SECURITY ENFORCEMENT ──────────────────────────────────────
  // The Customer JWT contains the accountNumber(s) the customer is authorised for.
  // The token is issued by Keycloak / XSUAA after successful customer authentication.
  // Claim: 'sains_account_numbers' — array of account numbers this customer can access.
  // For single-account customers (most domestic): one element.
  // For commercial customers with multiple accounts: multiple elements.

  /**
   * Get the account numbers the authenticated customer can access.
   * Reads from the JWT token's custom claim.
   * @param {Object} req - CDS request
   * @returns {String[]} Array of account numbers
   */
  function _getAuthorisedAccountNumbers(req) {
    // XSUAA: custom attribute in the token
    const xsuaaAttr = req.user.attr?.sains_account_numbers;
    if (xsuaaAttr) {
      return Array.isArray(xsuaaAttr) ? xsuaaAttr : [xsuaaAttr];
    }
    // Keycloak: custom claim in the token
    const keycloakClaim = req.user.tokenInfo?.getTokenValue('sains_account_numbers');
    if (keycloakClaim) {
      return Array.isArray(keycloakClaim) ? keycloakClaim : [keycloakClaim];
    }
    // Development-only fallback — never runs in production
    if (process.env.NODE_ENV !== 'production') {
      const userID = req.user.id;
      if (userID && userID.match(/^\d{8,15}$/)) {
        const devLogger = require('@sap/cds').log('customer-portal');
        devLogger.warn(`DEV MODE: Using numeric user ID as account number: ${userID}`);
        return [userID];
      }
    }
    // In production, no fallback — empty array means access denied
    return [];
  }

  /**
   * Validate that the requested account is authorised for the current customer.
   * @throws {Error} If account is not authorised
   */
  async function _validateAccountAccess(req, accountNumber) {
    const authorised = _getAuthorisedAccountNumbers(req);
    if (authorised.length === 0) {
      req.error(403, 'No account numbers found in authentication token');
      return false;
    }
    if (!authorised.includes(accountNumber)) {
      req.error(403, `Access denied to account ${accountNumber}`);
      return false;
    }
    return true;
  }

  // ── BEFORE HANDLERS — inject account filter ──────────────────────────────

  this.before('READ', 'MyAccount', async req => {
    const accountNumbers = _getAuthorisedAccountNumbers(req);
    if (accountNumbers.length === 0) {
      req.error(403, 'No account numbers in token');
      return;
    }
    // Inject filter so customer can only see their own accounts
    req.query.where({ accountNumber: { in: accountNumbers } });
  });

  this.before('READ', 'MyInvoices', async req => {
    const db = await cds.connect.to('db');
    const accountNumbers = _getAuthorisedAccountNumbers(req);
    if (accountNumbers.length === 0) { req.error(403, 'No account numbers in token'); return; }

    const accounts = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('ID')
        .where({ accountNumber: { in: accountNumbers } })
    );
    const accountIDs = accounts.map(a => a.ID);
    if (accountIDs.length === 0) { req.error(404, 'No accounts found'); return; }

    req.query.where({ account_ID: { in: accountIDs } });
  });

  // Same pattern for MyInvoiceLines, MyPayments, MyActiveQRCodes, MyPTPs, MyDisputes
  // For nested entities (MyInvoiceLines), join to MyInvoices to check account ownership
  this.before('READ', 'MyInvoiceLines', async req => {
    const db = await cds.connect.to('db');
    const accountNumbers = _getAuthorisedAccountNumbers(req);

    if (accountNumbers.length === 0) {
      req.error(403, 'No account numbers in authentication token');
      return;
    }

    // Step 1: Resolve account IDs for this customer
    const accounts = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('ID')
        .where({ accountNumber: { in: accountNumbers } })
    );

    if (accounts.length === 0) {
      req.error(404, 'No accounts found for this customer');
      return;
    }

    const accountIDs = accounts.map(a => a.ID);

    // Step 2: Resolve invoice IDs belonging to those accounts
    // CDS does NOT auto-filter nested entities when addressed directly via OData.
    const invoices = await db.run(
      SELECT.from('sains.ar.Invoice')
        .columns('ID')
        .where({ account_ID: { in: accountIDs } })
    );

    if (invoices.length === 0) {
      // No invoices — return empty result, not an error
      req.query.where({ invoice_ID: null });
      return;
    }

    const invoiceIDs = invoices.map(i => i.ID);

    // Step 3: Restrict query to only line items for this customer's invoices
    req.query.where({ invoice_ID: { in: invoiceIDs } });
  });

  this.before('READ', ['MyPayments', 'MyActiveQRCodes', 'MyPTPs', 'MyDisputes'], async req => {
    const db = await cds.connect.to('db');
    const accountNumbers = _getAuthorisedAccountNumbers(req);
    if (accountNumbers.length === 0) { req.error(403, 'No account numbers in token'); return; }

    const accounts = await db.run(
      SELECT.from('sains.ar.CustomerAccount').columns('ID')
        .where({ accountNumber: { in: accountNumbers } })
    );
    const accountIDs = accounts.map(a => a.ID);
    if (accountIDs.length === 0) { req.error(404, 'No accounts found'); return; }

    req.query.where({ account_ID: { in: accountIDs } });
  });

  // ── PTP CREATION (Scenario 7.2) ─────────────────────────────────────────

  this.on('createPTP', async req => {
    const db = await cds.connect.to('db');
    const { promisedPaymentDate, promisedAmount, customerReference, invoiceIDs } = req.data;

    const accountNumbers = _getAuthorisedAccountNumbers(req);
    if (accountNumbers.length === 0) { req.error(403, 'No account numbers in token'); return; }

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns('ID', 'balanceOutstanding', 'dunningLevel', 'isPaymentPlan', 'accountStatus')
        .where({ accountNumber: accountNumbers[0] }) // Use first account if multiple
    );
    if (!account) { req.error(404, 'Account not found'); return; }
    if (account.accountStatus === 'CLOSED') { req.error(400, 'Account is closed'); return; }

    // Validation
    const promisedDate = new Date(promisedPaymentDate);
    const today = new Date();
    const maxDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

    if (promisedDate <= today) {
      req.error(400, 'Promised payment date must be in the future');
      return;
    }
    if (promisedDate > maxDate) {
      req.error(400, 'Promised payment date cannot be more than 30 days from today');
      return;
    }
    if (Number(promisedAmount) <= 0) {
      req.error(400, 'Promised amount must be greater than zero');
      return;
    }
    if (Number(promisedAmount) > Number(account.balanceOutstanding)) {
      req.error(400, 'Promised amount cannot exceed outstanding balance');
      return;
    }

    // Check for existing active PTP
    const existingPTP = await db.run(
      SELECT.one.from('sains.ar.collections.PTPSelfService')
        .where({ account_ID: account.ID, status: 'CONFIRMED' })
    );
    if (existingPTP) {
      req.error(400, 'You already have an active promise to pay. Cancel it before creating a new one.');
      return;
    }

    const ptpID = cds.utils.uuid();
    await db.run(INSERT.into('sains.ar.collections.PTPSelfService').entries({
      ID: ptpID,
      account_ID: account.ID,
      initiationChannel: 'ISAINS_PORTAL',
      requestedDate: new Date().toISOString(),
      promisedPaymentDate,
      promisedAmount,
      invoiceIDs: invoiceIDs || null,
      status: 'CONFIRMED',
      customerReference: customerReference?.substring(0, 50),
    }));

    // Link to Phase 1 PromiseToPay entity
    const linkedPTPID = cds.utils.uuid();
    await db.run(INSERT.into('sains.ar.PromiseToPay').entries({
      ID: linkedPTPID,
      account_ID: account.ID,
      promisedDate: promisedPaymentDate,
      promisedAmount,
      status: 'ACTIVE',
      initiatedBy: 'CUSTOMER_SELF_SERVICE',
      channel: 'ISAINS_PORTAL',
    }));

    await db.run(UPDATE('sains.ar.collections.PTPSelfService').set({
      linkedPTPID,
    }).where({ ID: ptpID }));

    logger.info(`Customer PTP created: ${ptpID} for account ${accountNumbers[0]} due ${promisedPaymentDate}`);
    return { ptpID, status: 'CONFIRMED', message: `Promise to pay created. We will remind you on ${promisedPaymentDate}.` };
  });

  // ── DISPUTE SUBMISSION (Scenario 7.3) ───────────────────────────────────

  this.on('submitDispute', async req => {
    const db = await cds.connect.to('db');
    const { invoiceID, disputeType, description, disputeAmount } = req.data;

    const accountNumbers = _getAuthorisedAccountNumbers(req);
    if (accountNumbers.length === 0) { req.error(403, 'No account numbers in token'); return; }

    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns('ID', 'accountNumber')
        .where({ accountNumber: accountNumbers[0] })
    );
    if (!account) { req.error(404, 'Account not found'); return; }

    // Verify the invoice belongs to this account
    if (invoiceID) {
      const invoice = await db.run(
        SELECT.one.from('sains.ar.Invoice')
          .columns('ID', 'account_ID')
          .where({ ID: invoiceID })
      );
      if (!invoice || invoice.account_ID !== account.ID) {
        req.error(403, 'Invoice does not belong to your account');
        return;
      }
    }

    // Check for existing open dispute on same invoice
    const existingDispute = await db.run(
      SELECT.one.from('sains.ar.Dispute')
        .where({
          account_ID: account.ID,
          invoice_ID: invoiceID,
          status: { in: ['OPEN', 'UNDER_REVIEW'] },
        })
    );
    if (existingDispute) {
      req.error(400, 'A dispute is already open for this invoice');
      return;
    }

    const disputeID = cds.utils.uuid();
    await db.run(INSERT.into('sains.ar.Dispute').entries({
      ID: disputeID,
      account_ID: account.ID,
      invoice_ID: invoiceID || null,
      disputeDate: new Date().toISOString().substring(0, 10),
      disputeType: disputeType || 'BILLING_ERROR',
      description: description.substring(0, 500),
      disputeAmount: disputeAmount || null,
      status: 'OPEN',
      openedBy: 'CUSTOMER',
      openedChannel: 'ISAINS_PORTAL',
    }));

    // Set invoice disputed flag
    if (invoiceID) {
      await db.run(UPDATE('sains.ar.Invoice').set({
        isDisputed: true,
      }).where({ ID: invoiceID }));

      await db.run(UPDATE('sains.ar.CustomerAccount').set({
        isDisputed: true,
      }).where({ ID: account.ID }));
    }

    logger.info(`Customer dispute submitted: ${disputeID} for account ${account.accountNumber}`);
    return { disputeID, message: 'Your dispute has been submitted. Our team will review and contact you within 5 business days.' };
  });

  // ── WHATSAPP OPT-OUT (Scenario 4.8) ─────────────────────────────────────

  this.on('optOutWhatsApp', async req => {
    const db = await cds.connect.to('db');
    const accountNumbers = _getAuthorisedAccountNumbers(req);
    if (accountNumbers.length === 0) { req.error(403, 'No account numbers in token'); return; }

    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      whatsAppOptOut: true,
      whatsAppOptOutAt: new Date().toISOString(),
    }).where({ accountNumber: { in: accountNumbers } }));

    logger.info(`WhatsApp opt-out: ${accountNumbers[0]}`);
    return true;
  });

  this.on('optInWhatsApp', async req => {
    const db = await cds.connect.to('db');
    const accountNumbers = _getAuthorisedAccountNumbers(req);
    const { phoneNumber } = req.data;

    // Validate Malaysian phone number format
    if (!phoneNumber.match(/^\+60[0-9]{8,10}$/)) {
      req.error(400, 'Phone number must be in format +60XXXXXXXXX');
      return;
    }

    await db.run(UPDATE('sains.ar.CustomerAccount').set({
      whatsAppOptOut: false,
      whatsAppOptOutAt: null,
      primaryPhone: phoneNumber,
    }).where({ accountNumber: { in: accountNumbers } }));

    return true;
  });

  // ── FPX PAYMENT URL (Scenario 4.6A) ──────────────────────────────────────

  this.on('getFPXPaymentURL', async req => {
    const db = await cds.connect.to('db');
    const { invoiceID } = req.data;
    const accountNumbers = _getAuthorisedAccountNumbers(req);

    const invoice = await db.run(
      SELECT.one.from('sains.ar.Invoice')
        .columns('ID', 'account_ID', 'invoiceNumber', 'amountOutstanding')
        .where({ ID: invoiceID })
    );
    if (!invoice) { req.error(404, 'Invoice not found'); return; }

    // Verify ownership
    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns('ID', 'accountNumber')
        .where({ ID: invoice.account_ID, accountNumber: { in: accountNumbers } })
    );
    if (!account) { req.error(403, 'Invoice does not belong to your account'); return; }

    const fpx = require('./external/fpx-adapter');
    const result = fpx.buildPaymentInitiationURL(
      account.accountNumber,
      Number(invoice.amountOutstanding),
      invoice.invoiceNumber
    );

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15-minute expiry
    return { ...result, expiresAt: expiresAt.toISOString() };
  });

  // ── PTP CANCELLATION ─────────────────────────────────────────────────────

  this.on('cancelMyPTP', 'MyPTPs', async req => {
    const db = await cds.connect.to('db');
    const accountNumbers = _getAuthorisedAccountNumbers(req);

    const ptp = await db.run(
      SELECT.one.from('sains.ar.collections.PTPSelfService')
        .columns('ID', 'account_ID', 'linkedPTPID', 'status')
        .where({ ID: req.params[0] })
    );
    if (!ptp) { req.error(404, 'PTP not found'); return; }

    // Verify ownership
    const account = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount')
        .columns('ID')
        .where({ ID: ptp.account_ID, accountNumber: { in: accountNumbers } })
    );
    if (!account) { req.error(403, 'Access denied'); return; }

    if (ptp.status !== 'CONFIRMED') {
      req.error(400, `Cannot cancel PTP with status ${ptp.status}`);
      return;
    }

    await db.run(UPDATE('sains.ar.collections.PTPSelfService').set({
      status: 'CANCELLED',
    }).where({ ID: ptp.ID }));

    if (ptp.linkedPTPID) {
      await db.run(UPDATE('sains.ar.PromiseToPay').set({
        status: 'CANCELLED',
      }).where({ ID: ptp.linkedPTPID }));
    }

    return true;
  });
});
