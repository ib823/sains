using sains.ar.payment as pay from '../db/schema-phase2-payment';
using sains.ar as ar from '../db/schema';

@requires: 'authenticated-user'
service PaymentInnovationService @(path:'/payment') {

  // ── PAYMENT ORCHESTRATOR ─────────────────────────────────────────────

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','SystemProcess'])
  entity PaymentEvents as projection on pay.PaymentOrchestratorEvent
  actions {
    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action resolveManually(
      targetAccountID: UUID,
      notes          : String(500)
    ) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action rejectEvent(reason: String(255)) returns Boolean;
  };

  // ── JOMPAY ────────────────────────────────────────────────────────────

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','SystemProcess'])
  entity JomPAYBatches as projection on pay.JomPAYBatch
  actions {
    @(requires:['FinanceAdmin','SystemProcess'])
    action processFile() returns {
      processed: Integer;
      matched  : Integer;
      suspense : Integer;
      failed   : Integer;
    };

    @(requires:['FinanceSupervisor','FinanceManager'])
    action approveReconciliation() returns Boolean;
  };

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity JomPAYLines as projection on pay.JomPAYLine;

  // ── DUITNOW QR ────────────────────────────────────────────────────────

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','SystemProcess'])
  entity DuitNowQRCodes as projection on pay.DuitNowQRCode;

  @(requires:['SystemProcess'])
  action generateQRForInvoice(invoiceID: UUID) returns {
    qrCodeID : UUID;
    qrPayload: String;
    expiryDate: Date;
  };

  @(requires:['SystemProcess'])
  action processWebhookNotification(
    merchantID   : String(30),
    billRef      : String(30),
    amount       : Decimal(15,2),
    payerRef     : String(50),
    transDateTime: DateTime
  ) returns Boolean;

  // ── EMANDATE ─────────────────────────────────────────────────────────

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','SystemProcess'])
  entity eMandates as projection on pay.eMandate
  actions {
    @(requires:['FinanceAdmin','BILStaff'])
    action initiateRegistration(
      registrationMethod: String(20)
    ) returns { registrationURL: String(500); };

    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action suspendMandate(reason: String(255)) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action cancelMandate(reason: String(500)) returns Boolean;

    @(requires:['SystemProcess'])
    action confirmMandateActive(mandateID: String(30)) returns Boolean;
  };

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity eMandateDebitRuns as projection on pay.eMandateDebitRun;

  // ── CHANNEL CONFIGURATION ─────────────────────────────────────────────

  @(requires:['FinanceManager','ICTManager'])
  entity ChannelConfigs as projection on pay.PaymentChannelConfig;

  // ── WHATSAPP MESSAGES ─────────────────────────────────────────────────

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity WhatsAppMessages as projection on pay.WhatsAppMessage;

  // ── JOB TRIGGER ACTIONS ───────────────────────────────────────────────

  @(requires:['SystemProcess'])
  action triggerJomPAYFileDownload(fileDate: Date) returns {
    success : Boolean;
    fileName: String(255);
  };

  @(requires:['SystemProcess'])
  action triggerEmandateDebitRun(runDate: Date) returns {
    submitted: Integer;
    skipped  : Integer;
    failed   : Integer;
  };

  @(requires:['SystemProcess'])
  action triggerQRExpiry(asOfDate: Date) returns { expired: Integer; };

  @(requires:['SystemProcess'])
  action triggerWhatsAppReminders(
    dunningLevel: Integer,
    asOfDate    : Date
  ) returns { queued: Integer; };

  @(requires:['SystemProcess'])
  action processResolvedPaymentEvents(asOfDate: Date) returns {
    converted: Integer;
    failed   : Integer;
  };
}
