using sains.ar.integration as intg from '../db/schema-phase3-integration';
using sains.ar as ar from '../db/schema';

// This service has two audiences:
// 1. iWRS system — calls inbound endpoints to push events to AR Hub
// 2. Finance Admin — views event log for monitoring and error resolution

@requires: 'authenticated-user'
service iWRSIntegrationService @(path:'/integration') {

  // ── iWRS EVENT LOG — read-only for Finance Admin ──────────────────────────

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','ICTManager'])
  @readonly
  entity iWRSEventLogs as projection on intg.iWRSEventLog;

  // ── METIS WORK ORDERS — for Finance and BIL supervision ───────────────────

  @(requires:['BILSupervisor','FinanceSupervisor','FinanceManager','ICTManager'])
  entity MetisWorkOrders as projection on intg.MetisWorkOrder
  actions {
    @(requires:['BILSupervisor','FinanceSupervisor'])
    action cancelWorkOrder(reason: String(255)) returns Boolean;

    @(requires:['BILSupervisor'])
    action retryWorkOrder() returns Boolean;
  };

  // ── BANK SFTP CONFIG — ICT Manager only ───────────────────────────────────

  @(requires:['ICTManager','SystemAdmin'])
  entity BankSFTPConfigs as projection on intg.BankSFTPConfig;

  // ── iWRS INTEGRATION CONFIG ────────────────────────────────────────────────

  @(requires:['ICTManager','SystemAdmin'])
  entity iWRSConfigs as projection on intg.iWRSIntegrationConfig;

  // ── INBOUND ENDPOINTS (called by iWRS system account) ─────────────────────
  // These are the Pattern A endpoints. Pattern B and C do not use these.
  // iWRS authenticates using the 'iWRSServiceAccount' role JWT.

  @(requires:['iWRSServiceAccount','SystemProcess'])
  action receiveAccountEvent(
    eventType      : String(30),   // ACCOUNT_CREATED | ACCOUNT_UPDATED | ACCOUNT_CLOSED
    iWRSReference  : String(50),
    accountNumber  : String(20),
    payload        : LargeString   // Full account JSON from iWRS
  ) returns {
    success        : Boolean;
    arHubAccountID : UUID;
    message        : String(255);
  };

  @(requires:['iWRSServiceAccount','SystemProcess'])
  action receiveInvoiceEvent(
    iWRSReference  : String(50),
    accountNumber  : String(20),
    payload        : LargeString   // Full invoice JSON from iWRS/SiBMA
  ) returns {
    success        : Boolean;
    arHubInvoiceID : UUID;
    message        : String(255);
  };

  @(requires:['iWRSServiceAccount','SystemProcess'])
  action receivePaymentEvent(
    iWRSReference  : String(50),
    accountNumber  : String(20),
    payload        : LargeString   // Full payment JSON from iWRS counter
  ) returns {
    success        : Boolean;
    arHubEventID   : UUID;
    message        : String(255);
  };

  // ── METIS INBOUND (called by Metis system account) ────────────────────────

  @(requires:['MetisServiceAccount','SystemProcess'])
  action receiveMetisCompletion(
    workOrderRef   : String(50),
    completionStatus : String(20), // COMPLETED | FAILED | CANCELLED
    completedAt    : DateTime,
    fieldTeamID    : String(50),
    notes          : String(255),
    rawPayload     : LargeString
  ) returns Boolean;

  // ── PATTERN B/C JOB TRIGGERS (called by scheduler) ────────────────────────

  @(requires:['SystemProcess'])
  action triggerPatternBProcessing(fileDate: Date)
    returns { processed: Integer; failed: Integer; };

  @(requires:['SystemProcess'])
  action triggerPatternCSync(asOfTimestamp: DateTime)
    returns { accounts: Integer; invoices: Integer; payments: Integer; };

  // ── MANUAL RETRY (Finance Admin resolution) ───────────────────────────────

  @(requires:['FinanceAdmin','ICTManager'])
  action retryFailedEvent(eventID: UUID) returns Boolean;

  @(requires:['FinanceAdmin','ICTManager'])
  action reprocessSuspenseEvents(asOfDate: Date)
    returns { reprocessed: Integer; resolved: Integer; failed: Integer; };

  // ── ANALYTICS FUNCTIONS ───────────────────────────────────────────────────

  @(requires:['FinanceManager','ICTManager'])
  function getIntegrationHealthReport(
    fromDate: Date,
    toDate  : Date
  ) returns {
    totalEvents       : Integer;
    processedOK       : Integer;
    failed            : Integer;
    suspense          : Integer;
    avgProcessingMs   : Decimal(8,2);
    patternActive     : String(10);
  };
}
