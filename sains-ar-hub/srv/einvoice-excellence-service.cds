using sains.ar.einvoice as ei from '../db/schema-phase2-einvoice';
using sains.ar as ar from '../db/schema';

@requires: 'authenticated-user'
service EInvoiceExcellenceService @(path:'/einvoice') {

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity SubmissionBatches as projection on ei.EInvoiceSubmissionBatch
  actions {
    @(requires:['FinanceAdmin','SystemProcess'])
    action retryBatch() returns {
      accepted: Integer;
      rejected: Integer;
    };

    @(requires:['FinanceAdmin'])
    action cancelSubmission(reason: String(255)) returns Boolean;
  };

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity SubmissionLines as projection on ei.EInvoiceSubmissionLine;

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity ConsolidatedBatches as projection on ei.ConsolidatedB2CBatch
  actions {
    @(requires:['FinanceSupervisor','FinanceManager'])
    action approveConsolidated() returns Boolean;

    @(requires:['FinanceAdmin','SystemProcess'])
    action submitConsolidated() returns { lhdnUUID: String(36); };
  };

  @(requires:['FinanceManager','ICTManager'])
  entity DigitalCertificates as projection on ei.DigitalCertificate;

  @(requires:['FinanceAdmin','FinanceSupervisor'])
  entity ErrorLogs as projection on ei.EInvoiceErrorLog
  actions {
    @(requires:['FinanceAdmin'])
    action markResolved(notes: String(500)) returns Boolean;
  };

  @(requires:['FinanceAdmin','SystemProcess'])
  action submitInvoiceToLHDN(invoiceID: UUID) returns {
    success          : Boolean;
    lhdnUUID         : String(36);
    cancelDeadline   : DateTime;
    errorMessage     : String(500);
  };

  @(requires:['FinanceAdmin'])
  action cancelEInvoiceWithLHDN(invoiceID: UUID, reason: String(255)) returns {
    success      : Boolean;
    errorMessage : String(500);
  };

  @(requires:['FinanceAdmin','SystemProcess'])
  action submitCreditNoteToLHDN(
    originalInvoiceID: UUID,
    creditNoteID     : UUID,
    reason           : String(255)
  ) returns {
    success    : Boolean;
    lhdnUUID   : String(36);
    errorMessage: String(500);
  };

  @(requires:['SystemProcess'])
  action triggerMonthlyConsolidatedB2C(
    year : Integer,
    month: Integer
  ) returns { batchID: UUID; documentCount: Integer; };

  @(requires:['SystemProcess'])
  action triggerIndividualSubmissionQueue() returns {
    submitted: Integer;
    failed   : Integer;
  };

  @(requires:['SystemProcess'])
  action triggerCancellationDeadlineAlert() returns { alertsSent: Integer; };
}
