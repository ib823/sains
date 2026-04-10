using sains.ar as ar from '../db/schema';

@requires: ['FinanceManager','CFO','ICTManager','SystemAdmin']
service AdminService @(path:'/admin') {

  @(requires:['FinanceManager','ICTManager'])
  entity TariffBands       as projection on ar.TariffBand;
  @(requires:['FinanceManager'])
  entity TariffBlocks      as projection on ar.TariffBlock;
  @(requires:['FinanceManager'])
  entity TaxRateHistory    as projection on ar.TaxRateHistory;
  @(requires:['FinanceManager'])
  entity GLAccountMappings as projection on ar.GLAccountMapping;
  @(requires:['FinanceManager'])
  entity DunningProcedures as projection on ar.DunningProcedure;
  @(requires:['FinanceManager'])
  entity ChargeTypes       as projection on ar.ChargeType;
  @(requires:['FinanceSupervisor','FinanceManager'])
  entity HardshipCriteria  as projection on ar.HardshipEligibilityCriteria;

  entity GLPostingBatches as projection on ar.GLPostingBatch
  actions {
    @(requires:['FinanceManager'])
    action approveRetry() returns Boolean;

    @(requires:['FinanceManager','SystemProcess'])
    action submitBatch() returns {
      success: Boolean;
      sapDocNumber: String(20);
      errorMessage: String(500);
    };

    @(requires:['FinanceAdmin','FinanceManager'])
    action downloadBatchCSV() returns {
      csvContent : LargeString;
      fileName   : String(100);
      lineCount  : Integer;
    };
  }

  entity PeriodCloseChecklists as projection on ar.PeriodCloseChecklist;
  entity PeriodCloseSteps      as projection on ar.PeriodCloseStep;
  entity ReconciliationRecords as projection on ar.ReconciliationRecord;
  entity BadDebtProvisions     as projection on ar.BadDebtProvision;

  @(requires:['FinanceManager','CFO'])
  function getProvisionMatrix() returns array of {
    agingBucket: String(20);
    accountType: String(10);
    rate: Decimal(5,4);
    source: String(10);
  };

  @(requires:['FinanceManager'])
  action updateProvisionRate(
    agingBucket: String(20),
    accountType: String(10),
    newRate: Decimal(5,4),
    reason: String(255)
  ) returns Boolean;

  @(requires:['ICTManager'])
  action grantEmergencyAccess(
    userID: String(60),
    reason: String(500),
    durationHours: Integer
  ) returns Boolean;

  @(requires:['FinanceManager','ICTManager'])
  function getEmergencyAccessLog(fromDate: Date, toDate: Date) returns array of {
    userID: String(60);
    grantedAt: DateTime;
    expiresAt: DateTime;
    reason: String(500);
    actionsPerformed: Integer;
  };

  @(requires:['FinanceManager'])
  action initiatePaymentProcedure(
    remittancePeriod: String(7),
    totalAmount: Decimal(15,2),
    notes: String(500)
  ) returns { glPostingRef: String(30); apDocNumber: String(20); };

  @(requires:['FinanceManager'])
  action activateTariffChange(
    tariffBandCode: String(10),
    newBlockIDs: array of UUID,
    spanApprovalRef: String(50),
    effectiveFrom: Date
  ) returns Boolean;

  @(requires:['FinanceAdmin','FinanceManager'])
  action verifyBuyerTIN(tin: String(20)) returns {
    valid: Boolean;
    registeredName: String(150);
    message: String(255);
  };

  @(requires:['FinanceManager','CFO'])
  action signOffPeriodClose(periodYear: Integer, periodMonth: Integer) returns Boolean;
}
