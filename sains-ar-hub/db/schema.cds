namespace sains.ar;
using { cuid, managed } from '@sap/cds/common';

// ─── DOMAIN TYPES ──────────────────────────────────────────────────────────

type MoneyMYR       : Decimal(15,2);
type AccountNumber  : String(20);
type PhoneNumber    : String(20);    // BLOCKER-1: corrected from PhonePhone
type EmailAddress   : String(255);
type ICNumber       : String(512);   // AES-256-CBC ciphertext (CRITICAL-5)
type MeterReference : String(30);
type InvoiceNumber  : String(30);
type PaymentRef     : String(50);
type GLAccount      : String(10);
type UserID         : String(60);
type PostcodeMS     : String(5);

// ─── CODE LISTS ────────────────────────────────────────────────────────────

entity AccountType {
  key code : String(10);
      name : localized String(100);
      description : localized String(255);
      isActive : Boolean default true;
}

entity BillingBasis {
  key code : String(10);
      name : localized String(100);
      isActive : Boolean default true;
}

entity TariffBand : cuid {
  key code            : String(10);
      name            : localized String(100);
      accountTypeCode : String(10);
      tariffBlocks    : Composition of many TariffBlock on tariffBlocks.tariffBand = $self;
      isActive        : Boolean default true;
}

// CRITICAL-4: effective dating — never delete old blocks, just set effectiveTo
entity TariffBlock : cuid {
      tariffBand      : Association to TariffBand not null;
      blockSequence   : Integer not null;
      fromM3          : Decimal(10,3) not null;
      toM3            : Decimal(10,3);
      ratePerM3       : MoneyMYR not null;
      fixedCharge     : MoneyMYR default 0;
      effectiveFrom   : Date not null;
      effectiveTo     : Date;
      approvedBy      : UserID;
      approvedAt      : DateTime;
      spanApprovalRef : String(50);       // MAJOR-4: SPAN approval reference
}

// CRITICAL-13: SST rate history with effective dating
entity TaxRateHistory : cuid {
      chargeTypeCode  : String(10) not null;
      taxCategory     : String(5) not null;
      taxRate         : Decimal(5,2) not null;
      effectiveFrom   : Date not null;
      effectiveTo     : Date;
      approvedBy      : UserID not null;
      approvedAt      : DateTime not null;
      notes           : String(255);
}

entity CollectionRiskCategory {
  key code        : String(10);
      name        : localized String(100);
      description : localized String(255);
}

entity ChargeType {
  key code             : String(10);
      name             : localized String(100);
      glAccount        : GLAccount;
      taxCategory      : String(5);
      einvoiceRequired : Boolean default false;
      isActive         : Boolean default true;
      // taxRate resolved at invoice time from TaxRateHistory
}

entity DunningProcedure {
  key code   : String(10);
      name   : localized String(100);
      levels : Composition of many DunningLevel on levels.procedure = $self;
}

entity DunningLevel : cuid {
      procedure      : Association to DunningProcedure not null;
      level          : Integer not null;
      daysOverdue    : Integer not null;
      noticeType     : String(30) not null;
      channels       : String(100) not null;
      postalRequired : Boolean default false;
      consequenceCode: String(30) not null;
}

entity GLAccountMapping : cuid {
      transactionType : String(30) not null;
      accountType     : String(10) not null;
      chargeType      : String(10) not null;
      debitGL         : GLAccount not null;
      creditGL        : GLAccount not null;
      profitCentre    : String(10) not null;
      description     : String(255);
      isActive        : Boolean default true;
}

// MAJOR-9: configurable hardship eligibility
entity HardshipEligibilityCriteria : cuid {
      criteriaCode     : String(20) not null;
      description      : localized String(255) not null;
      incomeThreshold  : MoneyMYR;
      incomeCategory   : String(10);
      requiresDocs     : Boolean default true;
      docDescription   : localized String(500);
      isActive         : Boolean default true;
      approvedBy       : UserID not null;
      approvedAt       : DateTime not null;
}

// REGULATORY-1: sequential e-invoice sequence counter
entity InvoiceSequenceCounter {
  key yearMonth          : String(7);  // YYYY-MM
      lastSequenceNumber : Integer not null default 0;
}

// ─── CUSTOMER ACCOUNT ──────────────────────────────────────────────────────

@assert.unique: { accountNumber: [ accountNumber ] }
entity CustomerAccount : cuid, managed {

  accountNumber     : AccountNumber not null;
  accountStatus     : String(20) not null default 'ACTIVE';
  // ACTIVE|VOID|RESTRICTED|TERMINATED|CLOSED|LEGAL|TEMP_DISCONNECTED

  accountType       : Association to AccountType not null;
  billingBasis      : Association to BillingBasis not null;
  tariffBand        : Association to TariffBand not null;
  riskCategory      : Association to CollectionRiskCategory not null;

  legalName         : String(150) not null;
  idNumber          : ICNumber;                // AES-256-CBC encrypted — nullable for OData create (set by system integration)
  idNumberMasked    : String(20);              // Always 'XXXXXX-XX-XXXX' — set by before-CREATE
  holderType        : String(10) not null;     // OWNER|TENANT|AGENT

  serviceAddress1   : String(100) not null;
  serviceAddress2   : String(100);
  serviceCity       : String(60) not null;
  serviceState      : String(30) not null;
  servicePostcode   : PostcodeMS not null;

  corrAddress1      : String(100);
  corrAddress2      : String(100);
  corrCity          : String(60);
  corrState         : String(30);
  corrPostcode      : PostcodeMS;
  corrSameAsService : Boolean default true;

  primaryPhone      : PhoneNumber not null;
  secondaryPhone    : PhoneNumber;             // BLOCKER-1 fix
  emailAddress      : EmailAddress;
  eBillingEnrolled  : Boolean default false;
  eBillingEnrolledDate : DateTime;
  eBillingEnrolmentRef : String(50);
  paperBillingElected  : Boolean default false;

  // CRITICAL-18: portal registration
  portalRegistered     : Boolean default false;
  portalRegisteredDate : DateTime;
  portalAuthMethod     : String(20);           // OTP|MYDIGITAL_ID|PASSWORD

  ownerName         : String(150);
  ownerPhone        : PhoneNumber;
  ownerEmail        : EmailAddress;
  ownerTripartiteAgreement : Boolean default false;

  meterReference    : MeterReference;
  connectionSizeMM  : Integer;
  accountOpenDate   : Date not null;
  accountCloseDate  : Date;
  lastVerificationDate : Date;

  // MAJOR-1: voluntary disconnection
  isVoluntaryDisconnected   : Boolean default false;
  voluntaryDisconnectedDate : Date;
  voluntaryReconnectDueDate : Date;

  isHardship        : Boolean default false;
  hardshipExpiry    : Date;
  hardshipCriteriaCode : String(20);
  isDisputed        : Boolean default false;
  isPaymentPlan     : Boolean default false;
  isGovernment      : Boolean default false;
  isWrittenOff      : Boolean default false;
  isLegalAction     : Boolean default false;
  isVoid            : Boolean default false;

  balanceOutstanding    : MoneyMYR default 0;
  balanceDeposit        : MoneyMYR default 0;
  balanceCreditOnAccount: MoneyMYR default 0;
  dunningLevel          : Integer default 0;
  dunningLevelDate      : DateTime;

  branchCode        : String(10);

  // Phase 3: last payment tracking (maintained by payment-orchestrator)
  lastPaymentDate      : Date;
  lastPaymentAmount    : Decimal(15,2);

  // Phase 3: vulnerability cache (from VulnerabilityRecord for dunning engine performance)
  vulnSeverity         : String(10);     // CRITICAL|HIGH|MEDIUM|LOW
  vulnCategory         : String(30);

  // Phase 3: WhatsApp opt-out (PDPA compliance)
  whatsAppOptOut       : Boolean default false;
  whatsAppOptOutAt     : DateTime;

  // Phase 3: eMandate cancellation flag
  eMandateCancelledRecently : Boolean default false;

  buyerTIN          : String(20);
  buyerTINVerified  : Boolean default false;    // CRITICAL-12
  buyerTINVerifiedDate : DateTime;              // CRITICAL-12
  buyerSSTNumber    : String(20);

  invoices          : Composition of many Invoice on invoices.account = $self;
  payments          : Composition of many Payment on payments.account = $self;
  deposits          : Composition of many DepositRecord on deposits.account = $self;
  dunningHistory    : Composition of many DunningHistory on dunningHistory.account = $self;
  paymentPlans      : Composition of many PaymentPlan on paymentPlans.account = $self;
  adjustments       : Composition of many Adjustment on adjustments.account = $self;
  disputes          : Composition of many Dispute on disputes.account = $self;
  notes             : Composition of many AccountNote on notes.account = $self;
  changeRequests    : Composition of many AccountChangeRequest on changeRequests.account = $self;
  meterReadHistory  : Composition of many MeterReadHistory on meterReadHistory.account = $self;
  auditTrail        : Composition of many AuditTrailEntry on auditTrail.account = $self;
}

// BLOCKER-5: change authority matrix enforcement
entity AccountChangeRequest : cuid, managed {
  account          : Association to CustomerAccount not null;
  fieldChanged     : String(50) not null;
  oldValue         : LargeString;
  newValue         : LargeString;
  changeReason     : String(500) not null;
  status           : String(20) not null default 'PENDING';
  // PENDING|APPROVED|REJECTED|APPLIED
  requestedBy      : UserID not null;
  requestedAt      : DateTime not null;
  approvedBy       : UserID;
  approvedAt       : DateTime;
  rejectionReason  : String(255);
  appliedAt        : DateTime;
  customerNotified : Boolean default false;
  customerNotifiedAt: DateTime;
}

// CRITICAL-14: account-level note log
entity AccountNote : cuid, managed {
  account    : Association to CustomerAccount not null;
  noteDate   : DateTime not null;
  noteType   : String(20) not null;
  // GENERAL|COLLECTIONS|DISPUTE|FIELD_VISIT|LEGAL|PTP|HARDSHIP|SYSTEM
  noteText   : LargeString not null;
  isInternal : Boolean default true;
}

// CRITICAL-3: meter read history for estimation baseline
entity MeterReadHistory : cuid, managed {
  account             : Association to CustomerAccount not null;
  readDate            : Date not null;
  readType            : String(10) not null;
  // ACTUAL|ESTIMATED|ASSESSED|METER_CHANGE_PRE|METER_CHANGE_POST
  readingM3           : Decimal(10,3) not null;
  consumptionM3       : Decimal(10,3);
  sourceSystem        : String(30) not null;
  invoiceID           : UUID;
  meterSerial         : String(30);
  replacedMeterSerial : String(30);
  notes               : String(255);
}

// ─── INVOICE ───────────────────────────────────────────────────────────────

entity Invoice : cuid, managed {
  account           : Association to CustomerAccount not null;
  invoiceNumber     : InvoiceNumber not null;
  invoiceDate       : Date not null;
  dueDate           : Date not null;
  billingPeriodFrom : Date not null;
  billingPeriodTo   : Date not null;
  isPartialPeriod   : Boolean default false;  // CRITICAL-8
  partialPeriodDays : Integer;                // CRITICAL-8

  invoiceType       : String(20) not null;
  // STANDARD|ADJUSTMENT|MANUAL|ESTIMATED|CREDIT_NOTE|DEBIT_NOTE|METER_CHANGE

  status            : String(20) not null default 'OPEN';
  // OPEN|PARTIAL|CLEARED|REVERSED|CANCELLED|DISPUTED|HELD|HELD_NO_TIN

  sourceSystem      : String(30) not null;

  totalAmount       : MoneyMYR not null;
  taxAmount         : MoneyMYR default 0;
  taxRateApplied    : Decimal(5,2) default 0;  // CRITICAL-13: rate locked at invoice date
  amountCleared     : MoneyMYR default 0;
  amountOutstanding : MoneyMYR not null;

  consumptionM3     : Decimal(10,3);
  meterReadPrevious : Decimal(10,3);
  meterReadCurrent  : Decimal(10,3);
  meterReadType     : String(10);  // ACTUAL|ESTIMATED|ASSESSED

  lineItems         : Composition of many InvoiceLineItem on lineItems.invoice = $self;

  einvoiceRequired  : Boolean default false;
  einvoiceStatus    : String(20) default 'NOT_REQUIRED';
  einvoiceUUID      : String(36);
  einvoiceSubmittedAt: DateTime;
  einvoiceCancelledAt: DateTime;
  einvoiceCancelDeadline: DateTime;
  einvoiceSequenceNo : Integer;  // REGULATORY-1

  originalInvoiceID : UUID;
  disputeID         : UUID;
}

entity InvoiceLineItem : cuid {
  invoice     : Association to Invoice not null;
  lineSequence: Integer not null;
  chargeType  : Association to ChargeType not null;
  description : String(255);
  quantity    : Decimal(10,3) default 1;
  unitPrice   : MoneyMYR not null;
  lineAmount  : MoneyMYR not null;
  taxCategory : String(5);
  taxAmount   : MoneyMYR default 0;
}

// ─── PAYMENT ───────────────────────────────────────────────────────────────

entity Payment : cuid, managed {
  account           : Association to CustomerAccount not null;
  paymentReference  : PaymentRef not null;
  paymentDate       : Date not null;
  valueDate         : Date not null;
  // CRITICAL-11: valueDate = bank clearance date for cheques (T+3 bus. days)
  chequeClearanceStatus   : String(20);
  // null|PENDING_CLEARANCE|CLEARED|BOUNCED — COUNTER_CHEQUE only
  chequeClearanceDueDate  : Date;
  receivedDateTime  : DateTime not null;

  channel           : String(30) not null;
  // COUNTER_CASH|COUNTER_CHEQUE|COUNTER_CARD|FPX|DUITNOW_QR|JOMPAY|EMANDATE|
  // AGENT_COLLECTION|BAYARAN_PUKAL|MANUAL_EFT|SYSTEM_TRANSFER

  status            : String(20) not null default 'RECEIVED';
  // RECEIVED|CLEARING_PENDING|ALLOCATED|PARTIALLY_ALLOCATED|UNALLOCATED|REVERSED|BOUNCED|CHARGEBACK

  amount            : MoneyMYR not null;
  amountAllocated   : MoneyMYR default 0;
  amountUnallocated : MoneyMYR not null;

  batchReference    : String(50);
  bankReference     : String(50);
  agencyCode        : String(20);
  counterCode       : String(10);
  cashierID         : UserID;

  reversalReason    : String(255);
  reversedAt        : DateTime;
  reversedBy        : UserID;
  reversalType      : String(20);

  clearings         : Composition of many PaymentClearing on clearings.payment = $self;

  thirdPartyName    : String(150);
  isThirdParty      : Boolean default false;
  mandateID         : UUID;   // DirectDebitMandate reference
}

entity PaymentClearing : cuid {
  payment       : Association to Payment not null;
  invoice       : Association to Invoice not null;
  clearedAmount : MoneyMYR not null;
  clearingDate  : Date not null;
  clearingType  : String(20) not null default 'FIFO';
  isPartial     : Boolean default false;
}

// CRITICAL-2: Suspense for unmatched payment lines
entity SuspensePayment : cuid, managed {
  sourceChannel     : String(30) not null;
  sourceBatchRef    : String(100);
  sourceLineRef     : String(50);
  sourceAccountRef  : String(30);
  amount            : MoneyMYR not null;
  paymentDate       : Date not null;
  paymentReference  : String(50);
  status            : String(20) not null default 'PENDING';
  // PENDING|UNDER_REVIEW|RESOLVED|WRITTEN_OFF|RETURNED
  reviewedBy        : UserID;
  reviewedAt        : DateTime;
  resolvedAccountID : UUID;
  resolvedPaymentID : UUID;
  resolutionNotes   : String(500);
  glSuspensePosted  : Boolean default false;
  glSuspenseRef     : String(30);
}

// Direct debit mandate (PAY-4.7)
entity DirectDebitMandate : cuid, managed {
  account             : Association to CustomerAccount not null;
  mandateRef          : String(50) not null;
  bankName            : String(100) not null;
  bankCode            : String(20);
  accountHolderName   : String(150) not null;
  bankAccountNumberEnc: String(512);   // AES-256 encrypted (same approach as ICNumber)
  mandateType         : String(20) not null;   // FPX_DIRECT_DEBIT|BANK_AUTODEBIT
  signedDate          : Date not null;
  status              : String(20) not null default 'ACTIVE';
  cancelledDate       : Date;
  cancelledReason     : String(255);
  firstCollectionDate : Date;
  lastCollectionDate  : Date;
  failCount           : Integer default 0;
}

// ─── DEPOSIT ───────────────────────────────────────────────────────────────

entity DepositRecord : cuid, managed {
  account           : Association to CustomerAccount not null;
  depositDate       : Date not null;
  amount            : MoneyMYR not null;
  status            : String(20) not null default 'HELD';
  depositBasis      : String(50);
  refundAmount      : MoneyMYR;
  refundDate        : Date;
  refundMethod      : String(30);
  refundReference   : String(50);
  refundApprovedBy  : UserID;
  refundApprovalDate: DateTime;
  refundAPPostingRef: String(30);
  appliedAmount     : MoneyMYR;
  appliedDate       : Date;
  appliedApprovedBy : UserID;
  lastReviewDate    : Date;          // DEP-6.5 annual review
  topUpRequestedDate: Date;
  topUpDueDate      : Date;
  dormancyNotice1SentAt: DateTime;
  dormancyNotice2SentAt: DateTime;
  unclaimed_transferDate: Date;
  unclaimed_registrarRef: String(50);
  notes             : String(500);
  glStatus          : String(20) default 'PENDING';   // PENDING|POSTED|FAILED
  glPostedAt        : DateTime;
  glPostingError    : String(255);
}

// ─── DUNNING ───────────────────────────────────────────────────────────────

entity DunningHistory : cuid, managed {
  account           : Association to CustomerAccount not null;
  dunningLevel      : Integer not null;
  triggeredDate     : Date not null;
  overdueDays       : Integer not null;
  overdueAmount     : MoneyMYR not null;
  noticeType        : String(30) not null;
  emailSentAt       : DateTime;
  emailDelivered    : Boolean;
  emailBounced      : Boolean default false;
  smsSentAt         : DateTime;
  smsDelivered      : Boolean;
  postalDispatchedAt: DateTime;
  postalReference   : String(50);
  postalReturnedAt  : DateTime;
  resolvedAt        : DateTime;
  resolutionType    : String(30);  // PAYMENT | PTP | PLAN | DISPUTE | MANUAL
  resolvedByPaymentID  : UUID;
  resolvedByPTPID      : UUID;
  resolvedByPlanID     : UUID;
  regulatoryRef        : String(50);  // Act 655 section reference
}

// ─── PAYMENT PLAN ──────────────────────────────────────────────────────────

entity PaymentPlan : cuid, managed {
  account           : Association to CustomerAccount not null;
  planStatus        : String(20) not null default 'ACTIVE';
  outstandingAtStart: MoneyMYR not null;
  totalInstalments  : Integer not null;
  instalmentAmount  : MoneyMYR not null;
  startDate         : Date not null;
  endDate           : Date not null;
  approvedBy        : UserID not null;
  approvalDate      : DateTime not null;
  breachCount       : Integer default 0;
  voidedAt          : DateTime;
  voidedReason      : String(255);
  completedAt       : DateTime;
  instalments       : Composition of many PaymentPlanInstalment on instalments.plan = $self;
}

entity PaymentPlanInstalment : cuid {
  plan             : Association to PaymentPlan not null;
  instalmentNumber : Integer not null;
  dueDate          : Date not null;
  amount           : MoneyMYR not null;
  status           : String(20) not null default 'PENDING';
  paidDate         : Date;
  paidAmount       : MoneyMYR;
  paymentID        : UUID;
}

// ─── ADJUSTMENT ────────────────────────────────────────────────────────────

entity Adjustment : cuid, managed {
  account             : Association to CustomerAccount not null;
  adjustmentType      : String(30) not null;
  direction           : String(10) not null;  // CREDIT|DEBIT
  amount              : MoneyMYR not null;
  reason              : String(500) not null;
  originalInvoiceID   : UUID;
  adjustmentInvoiceID : UUID;
  status              : String(20) not null default 'PENDING';
  // PENDING|APPROVED|REJECTED|POSTED|REVERSED
  initiatedBy         : UserID not null;
  approvedBy          : UserID;
  approvalDate        : DateTime;
  rejectionReason     : String(255);
  postedAt            : DateTime;
  postedGLRef         : String(30);
}

// ─── DISPUTE ───────────────────────────────────────────────────────────────

entity Dispute : cuid, managed {
  account           : Association to CustomerAccount not null;
  disputeType       : String(30) not null;
  invoiceID         : UUID;
  description       : String(1000) not null;
  customerChannel   : String(20) not null;
  status            : String(20) not null default 'OPEN';
  assignedTo        : UserID not null;
  dunningLevelAtOpen: Integer;
  resolutionNotes   : String(1000);
  resolvedAt        : DateTime;
  resolvedBy        : UserID;
  adjustmentID      : UUID;
  spanEscalationRef : String(50);
  tribunalCaseRef   : String(50);
  slaDeadlineDate   : Date;    // SPAN SLA compliance tracking
}

// ─── GL POSTING ────────────────────────────────────────────────────────────

entity GLPostingBatch : cuid, managed {
  batchDate         : Date not null;
  postingType       : String(30) not null;
  // DAILY_SUMMARY|PERIOD_ACCRUAL|PROVISION|WRITEOFF|DEPOSIT_MOVEMENT|PAAB_REMITTANCE
  status            : String(20) not null default 'PREPARED';
  totalDebitAmount  : MoneyMYR not null default 0;
  totalCreditAmount : MoneyMYR not null default 0;
  lineCount         : Integer not null default 0;
  submittedAt       : DateTime;
  sapCoreDocNumber  : String(20);
  sapCorePostingDate: Date;
  sapCoreCompanyCode: String(4);
  rejectionReason   : String(500);
  retryCount        : Integer default 0;
  approvedBy        : UserID;
  idempotencyKey    : String(60);   // Prevents duplicate posting
  lines             : Composition of many GLPostingLine on lines.batch = $self;
}

entity GLPostingLine : cuid {
  batch            : Association to GLPostingBatch not null;
  lineSequence     : Integer not null;
  debitCreditCode  : String(1) not null;
  glAccount        : GLAccount not null;
  amount           : MoneyMYR not null;
  profitCentre     : String(10);
  costCentre       : String(10);
  assignment       : String(18);
  text             : String(50);
  referenceDocType : String(20);
  referenceDocID   : UUID;
}

// ─── BAD DEBT ──────────────────────────────────────────────────────────────

entity BadDebtProvision : cuid, managed {
  periodYear    : Integer not null;
  periodMonth   : Integer not null;
  accountType   : String(10) not null;
  agingBucket   : String(20) not null;
  openARAmount  : MoneyMYR not null;
  provisionRate : Decimal(5,4) not null;
  provisionAmount: MoneyMYR not null;
  glPostingRef  : String(30);
  status        : String(20) default 'CALCULATED';
  approvedBy    : UserID;
}

entity WriteOff : cuid, managed {
  account          : Association to CustomerAccount not null;
  invoiceID        : UUID not null;
  invoiceNumber    : InvoiceNumber not null;
  writeOffAmount   : MoneyMYR not null;
  writeOffDate     : Date not null;
  approvalLevel    : String(20) not null;  // SUPERVISOR|MANAGER|CFO|BOARD
  approvedBy       : UserID not null;
  approvalDate     : DateTime not null;
  boardResolutionRef: String(50);
  reason           : String(1000) not null;
  collectionHistory: String(2000);
  glPostingRef     : String(30);
  glStatus         : String(20) default 'PENDING';   // PENDING|POSTED|FAILED
  glPostedAt       : DateTime;
  glPostingError   : String(255);
  recoveries       : Composition of many WriteOffRecovery on recoveries.writeOff = $self;
}

entity WriteOffRecovery : cuid, managed {
  writeOff       : Association to WriteOff not null;
  recoveryDate   : Date not null;
  recoveryAmount : MoneyMYR not null;
  paymentID      : UUID not null;
  glPostingRef   : String(30);
}

// ─── PROMISE TO PAY ────────────────────────────────────────────────────────

entity PromiseToPay : cuid, managed {
  account              : Association to CustomerAccount not null;
  promisedAmount       : MoneyMYR not null;
  promisedDate         : Date not null;
  recordedBy           : UserID not null;
  status               : String(20) not null default 'ACTIVE';
  // ACTIVE|HONOURED|BROKEN|EXPIRED|SUPERSEDED
  channel              : String(20) not null;
  notes                : String(500);
  resolvedAt           : DateTime;
  dunningLevelAtPTP    : Integer;
  countThisYear        : Integer default 0;    // CRITICAL-7: set by before-CREATE handler
  requiresEscalation   : Boolean default false;
  escalationApprovedBy : UserID;
}

// ─── FRAUD ALERT ───────────────────────────────────────────────────────────

entity FraudAlert : cuid, managed {
  account           : Association to CustomerAccount not null;
  alertPattern      : String(50) not null;
  alertSeverity     : String(10) not null;  // HIGH|MEDIUM|LOW
  alertDescription  : String(500) not null;
  triggeredByAction : String(30) not null;
  triggeredByUser   : UserID not null;
  transactionRef    : UUID;
  status            : String(20) not null default 'OPEN';
  // OPEN|UNDER_REVIEW|CLEARED|ESCALATED
  assignedTo        : UserID not null;
  reviewedBy        : UserID;
  reviewedAt        : DateTime;
  reviewNotes       : String(500);
  actionTaken       : String(30);
}

// ─── COLLECTION IMPORT ─────────────────────────────────────────────────────

entity CollectionImportBatch : cuid, managed {
  batchDate        : Date not null;
  sourceChannel    : String(30) not null;
  sourceReference  : String(100);
  recordCount      : Integer default 0;
  totalAmount      : MoneyMYR default 0;
  status           : String(20) default 'RECEIVED';
  validationErrors : String(2000);
  processedCount   : Integer default 0;
  processedAmount  : MoneyMYR default 0;
  failedCount      : Integer default 0;
  suspenseCount    : Integer default 0;  // CRITICAL-2
  confirmedBy      : UserID;
  confirmedAt      : DateTime;
  lines            : Composition of many CollectionImportLine on lines.batch = $self;
}

entity CollectionImportLine : cuid {
  batch             : Association to CollectionImportBatch not null;
  lineSequence      : Integer not null;
  sourceAccountRef  : String(30) not null;
  resolvedAccountID : UUID;
  amount            : MoneyMYR not null;
  paymentDate       : Date not null;
  paymentReference  : String(50);
  channel           : String(30);
  status            : String(20) default 'PENDING';
  rejectionReason   : String(255);
  processedPaymentID: UUID;
  suspensePaymentID : UUID;  // CRITICAL-2
}

// ─── BANK STATEMENT (CRITICAL-6) ───────────────────────────────────────────

entity BankStatementImport : cuid, managed {
  statementDate    : Date not null;
  bankCode         : String(20) not null;
  bankName         : String(100);
  accountNumberMasked: String(30) not null;  // Masked: last 4 digits only
  format           : String(10) not null;    // MT940|CAMT053
  openingBalance   : MoneyMYR not null;
  closingBalance   : MoneyMYR not null;
  status           : String(20) not null default 'IMPORTED';
  // IMPORTED|MATCHING|MATCHED|UNBALANCED|APPROVED
  matchedCount     : Integer default 0;
  unmatchedCount   : Integer default 0;
  totalCredits     : MoneyMYR default 0;
  totalDebits      : MoneyMYR default 0;
  reconciledBy     : UserID;
  reconciledAt     : DateTime;
  lines            : Composition of many BankStatementLine on lines.statement = $self;
}

entity BankStatementLine : cuid {
  statement        : Association to BankStatementImport not null;
  lineSequence     : Integer not null;
  valueDate        : Date not null;
  bookingDate      : Date;
  amount           : MoneyMYR not null;
  debitCreditCode  : String(1) not null;  // D|C
  bankReference    : String(50);
  transactionCode  : String(10);
  description      : String(255);
  status           : String(20) not null default 'UNMATCHED';
  // UNMATCHED|MATCHED|MANUALLY_MATCHED|EXCLUDED
  matchedPaymentID : UUID;
  matchedSuspenseID: UUID;
  matchedBy        : UserID;
  matchedAt        : DateTime;
  matchConfidence  : String(10);  // AUTO_HIGH|AUTO_LOW|MANUAL
}

// ─── AUDIT TRAIL (CRITICAL-5, DGR-12.3) ────────────────────────────────────
// Append-only enforced by before-DELETE handler in srv/handlers/
// Financial events also written to SAP Audit Log Service (DGR-12.3)
// Note on PDPA/SECURITY-3: ipAddress stored for security purposes under
// PDPA legitimate interests basis. Retention: 7 years per DGR-12.1.

entity AuditTrailEntry : cuid {
  account       : Association to CustomerAccount;
  timestamp     : DateTime not null;
  userID        : UserID not null;
  userRole      : String(50) not null;
  actionType    : String(30) not null;
  entityType    : String(50) not null;
  entityID      : UUID;
  beforeState   : LargeString;  // idNumber field always REDACTED in snapshot
  afterState    : LargeString;
  sourceSystem  : String(30) not null;
  authorisedBy  : UserID;
  authorisedAt  : DateTime;
  sessionID     : String(100);
  ipAddress     : String(45);
}

// ─── RECONCILIATION ────────────────────────────────────────────────────────

entity ReconciliationRecord : cuid, managed {
  reconciliationType : String(30) not null;
  reconciliationDate : Date not null;
  performedBy        : UserID not null;
  reviewedBy         : UserID;
  reviewedAt         : DateTime;
  status             : String(20) not null default 'IN_PROGRESS';
  systemBalance      : MoneyMYR;
  externalBalance    : MoneyMYR;
  difference         : MoneyMYR;
  withinTolerance    : Boolean;
  toleranceAmount    : MoneyMYR;
  notes              : String(1000);
  attachmentRef      : String(255);
}

// ─── PERIOD CLOSE ──────────────────────────────────────────────────────────

entity PeriodCloseChecklist : cuid, managed {
  periodYear  : Integer not null;
  periodMonth : Integer not null;
  isYearEnd   : Boolean default false;
  status      : String(20) not null default 'IN_PROGRESS';
  steps       : Composition of many PeriodCloseStep on steps.checklist = $self;
  signedOffBy : UserID;
  signedOffAt : DateTime;
}

entity PeriodCloseStep : cuid {
  checklist        : Association to PeriodCloseChecklist not null;
  stepCode         : String(20) not null;
  stepName         : localized String(100);
  dueByBusinessDay : Integer not null;
  status           : String(20) not null default 'PENDING';
  completedBy      : UserID;
  completedAt      : DateTime;
  reviewedBy       : UserID;
  reviewedAt       : DateTime;
  skipReason       : String(255);
  notes            : String(500);
}

// ─── PERIOD LOCK ────────────────────────────────────────────────────────────

entity PeriodLock : cuid, managed {
  periodYear   : Integer not null;
  periodMonth  : Integer not null;
  lockedAt     : DateTime not null;
  lockedBy     : UserID not null;
  isLocked     : Boolean not null default true;
  unlockedAt   : DateTime;
  unlockedBy   : UserID;
  unlockReason : String(500);
}
