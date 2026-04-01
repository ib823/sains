/**
 * SAINS AR Hub — External System Simulator Service
 *
 * This service provides mock endpoints for all external systems that the AR Hub
 * integrates with. It is used for POC demonstrations when real external systems
 * are not yet connected. Each simulator captures inbound/outbound events in a
 * shared SimulatorEventLog for the demo operator to review.
 *
 * NOT for production — exclude from BTP deployment.
 */

using sains.simulator as sim from '../db/schema-simulator';

@path: '/simulator'
@requires: 'authenticated-user'
service SimulatorService {

  // ── Shared event log visible in simulator dashboard ──────────────────
  @readonly
  entity EventLog as projection on sim.EventLog;

  // ── iWRS Simulator Actions ───────────────────────────────────────────
  // Simulate iWRS sending events to AR Hub (Pattern A — REST)
  action simulateAccountCreated(
    accountNumber: String,
    customerName: String,
    idNumber: String,
    idType: String,       // IC or BRN
    accountType: String,  // DOM, COM_S, COM_L, IND, GOV, INST
    address1: String,
    city: String,
    postcode: String,
    phone: String,
    email: String,
    branchCode: String,
    tariffCode: String,
    meterRef: String
  ) returns String;

  action simulateInvoiceGenerated(
    accountNumber: String,
    invoiceNumber: String,
    invoiceDate: Date,
    dueDate: Date,
    totalAmount: Decimal(15,2),
    taxAmount: Decimal(15,2),
    consumptionM3: Decimal(10,2),
    meterReadPrevious: Integer,
    meterReadCurrent: Integer
  ) returns String;

  action simulateCounterPayment(
    accountNumber: String,
    amount: Decimal(15,2),
    channel: String,       // COUNTER_CASH, COUNTER_CHEQUE, COUNTER_CARD
    receiptNumber: String,
    cashierID: String
  ) returns String;

  // ── Bank Statement Simulator ─────────────────────────────────────────
  action generateMT940(
    bankName: String,
    statementDate: Date,
    transactionCount: Integer
  ) returns String;

  // ── LHDN MyInvois Simulator ──────────────────────────────────────────
  // Responds to e-invoice submissions from AR Hub
  action simulateEInvoiceResponse(
    submissionBatchID: String,
    responseType: String   // ACCEPTED, REJECTED, PARTIAL
  ) returns String;

  // ── DuitNow QR Payment Simulator ─────────────────────────────────────
  action simulateDuitNowPayment(
    accountNumber: String,
    amount: Decimal(15,2),
    transactionID: String
  ) returns String;

  // ── FPX Payment Simulator ────────────────────────────────────────────
  action simulateFPXPayment(
    sellerOrderNo: String,
    amount: Decimal(15,2),
    buyerBankId: String,
    status: String         // 00 (approved), 99 (failed)
  ) returns String;

  // ── JomPAY Batch Simulator ───────────────────────────────────────────
  action generateJomPAYFile(
    batchDate: Date,
    transactionCount: Integer
  ) returns String;

  // ── eMandate Simulator ───────────────────────────────────────────────
  action simulateMandateRegistered(
    mandateRef: String,
    bankCode: String,
    status: String         // ACTIVE, REJECTED
  ) returns String;

  action simulateDebitResult(
    mandateID: String,
    amount: Decimal(15,2),
    returnCode: String     // SUCCESS, NSF, INVALID_ACCOUNT, STOPPED, DECEASED
  ) returns String;

  // ── Metis Work Order Simulator ───────────────────────────────────────
  action simulateWorkOrderCompleted(
    workOrderRef: String,
    completionDate: Date,
    completionType: String // DISCONNECTED, RECONNECTED
  ) returns String;

  // ── SAP GL Simulator ─────────────────────────────────────────────────
  // Captures GL postings that AR Hub sends to SAP
  @readonly
  entity GLPostingLog as projection on sim.GLPostingLog;

  // ── Notification Inbox ───────────────────────────────────────────────
  // Captures all emails, SMS, WhatsApp messages sent by AR Hub
  @readonly
  entity NotificationInbox as projection on sim.NotificationInbox;

  // ── Dashboard summary ────────────────────────────────────────────────
  function getDashboardSummary() returns {
    totalEvents: Integer;
    iwrsEvents: Integer;
    paymentEvents: Integer;
    einvoiceEvents: Integer;
    glPostings: Integer;
    notifications: Integer;
    lastEventAt: Timestamp;
  };
}
