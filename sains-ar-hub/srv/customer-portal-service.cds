using sains.ar as ar from '../db/schema';
using sains.ar.payment as pay from '../db/schema-phase2-payment';
using sains.ar.collections as col from '../db/schema-phase2-collections';

// Customer-facing service for iSAINS portal and mobile app.
// ALL projections enforce: account must belong to the authenticated customer.
// Row-level security is enforced in the service implementation, not in CDS.
// The @requires: 'Customer' scope ensures only authenticated customers can call this.

@requires: 'Customer'
service CustomerPortalService @(path:'/portal') {

  // ── ACCOUNT SUMMARY (Scenario 7.1) ─────────────────────────────────────
  // Read-only. Customer sees only their own account(s).
  // Fields exposed are limited — no internal financial flags visible.

  @readonly
  entity MyAccount as select from ar.CustomerAccount {
    ID,
    accountNumber,
    legalName,
    accountStatus,
    balanceOutstanding,
    balanceCreditOnAccount,
    dunningLevel,
    isPaymentPlan,
    lastPaymentDate,
    lastPaymentAmount,
    serviceAddress1,
    serviceAddress2,
    serviceCity,
    servicePostcode,
    primaryPhone,
    emailAddress,
    accountType,
    billingBasis,
    tariffBand,
    paperBillingElected,
    whatsAppOptOut,
    // Explicitly excluded: ICNumber, balanceDeposit (shown separately),
    // isGovernment, isHardship, isWrittenOff, isLegalAction, dunning thresholds,
    // all internal workflow fields
  };

  // ── INVOICES (Scenario 7.1) ─────────────────────────────────────────────

  @readonly
  entity MyInvoices as select from ar.Invoice {
    ID,
    invoiceNumber,
    invoiceDate,
    dueDate,
    billingPeriodFrom,
    billingPeriodTo,
    totalAmount,
    taxAmount,
    amountOutstanding,
    amountCleared,
    status,
    consumptionM3,
    meterReadType,
    meterReadPrevious,
    meterReadCurrent,
    einvoiceStatus,
    einvoiceUUID,
    // Excluded: internal processing fields, GL refs, dunning references
  };

  // ── INVOICE LINE ITEMS (Scenario 7.1) ───────────────────────────────────

  @readonly
  entity MyInvoiceLines as select from ar.InvoiceLineItem {
    ID,
    invoice,
    lineSequence,
    chargeType,
    description,
    quantity,
    unitPrice,
    lineAmount,
    taxAmount,
    taxCategory,
  };

  // ── PAYMENTS (Scenario 7.1 — payment history) ───────────────────────────

  @readonly
  entity MyPayments as select from ar.Payment {
    ID,
    paymentDate,
    channel,
    status,
    amount,
    paymentReference,
    // Excluded: cheque clearance details, bank references, GL refs
  } where status <> 'REVERSED';

  // ── DUITNOW QR CODE (Scenario 7.1 — for display on bill) ──────────────

  @readonly
  entity MyActiveQRCodes as select from pay.DuitNowQRCode {
    ID,
    invoice,
    amount,
    expiryDate,
    qrPayload,
    qrImageBase64,
    status,
  } where status = 'ACTIVE';

  // ── PTP SELF-SERVICE (Scenario 7.2) ─────────────────────────────────────

  entity MyPTPs as select from col.PTPSelfService {
    ID,
    initiationChannel,
    requestedDate,
    promisedPaymentDate,
    promisedAmount,
    status,
    paymentID,
    honouredAt,
    customerReference,
  }
  actions {
    action cancelMyPTP(reason: String(255)) returns Boolean;
  };

  // ── DISPUTES (Scenario 7.3) ─────────────────────────────────────────────

  entity MyDisputes as select from ar.Dispute {
    ID,
    createdAt,
    disputeType,
    description,
    status,
    resolvedAt,
    resolutionNotes,
    invoiceID,
  };

  // ── UNBOUND ACTIONS ──────────────────────────────────────────────────────

  // Create PTP self-service (Scenario 7.2)
  action createPTP(
    promisedPaymentDate: Date,
    promisedAmount     : Decimal(15,2),
    customerReference  : String(50),
    invoiceIDs         : LargeString   // JSON array of invoice IDs
  ) returns {
    ptpID   : UUID;
    status  : String(20);
    message : String(255);
  };

  // Submit dispute (Scenario 7.3)
  action submitDispute(
    invoiceID    : UUID,
    disputeType  : String(30),
    description  : String(500),
    disputeAmount: Decimal(15,2)
  ) returns {
    disputeID: UUID;
    message  : String(255);
  };

  // Opt out of WhatsApp notifications
  action optOutWhatsApp() returns Boolean;

  // Opt in to WhatsApp notifications
  action optInWhatsApp(phoneNumber: String(20)) returns Boolean;

  // Get FPX payment initiation URL (Scenario 4.6A)
  function getFPXPaymentURL(
    invoiceID: UUID
  ) returns {
    paymentURL: String(1000);
    orderNo   : String(50);
    expiresAt : DateTime;
  };
}
