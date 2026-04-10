using sains.ar.provision as prov from '../db/schema-phase2-provision';
using sains.ar as ar from '../db/schema';

@requires: ['FinanceManager','CFO','Auditor']
service ProvisionReportingService @(path:'/provision') {

  @(requires:['FinanceManager','CFO'])
  entity MatrixVersions as projection on prov.ProvisionMatrixVersion
  actions {
    @(requires:['FinanceManager'])
    action activateVersion() returns Boolean;

    @(requires:['CFO'])
    action confirmAuditApproval(
      auditFirm           : String(100),
      auditConfirmationRef: String(100)
    ) returns Boolean;
  };

  @(requires:['FinanceManager','CFO'])
  entity ProvisionRates as projection on prov.ProvisionRate;

  @(requires:['FinanceManager','CFO','Auditor'])
  entity ECLCalculationRuns as projection on prov.ECLCalculationRun
  actions {
    @(requires:['FinanceManager'])
    action approveRun() returns Boolean;

    @(requires:['FinanceManager','SystemProcess'])
    action postToGL() returns { glBatchID: UUID; documentNumber: String(20); };
  };

  @readonly
  entity ECLSegmentResults as projection on prov.ECLSegmentResult;

  @(requires:['FinanceManager','CFO'])
  entity ForwardLookingFactors as projection on prov.ForwardLookingFactor;

  @readonly
  entity MFRS15Revenue as projection on prov.MFRS15RevenueRecord;

  @(requires:['FinanceManager','CFO'])
  entity DepositLiabilityRegisters as projection on prov.DepositLiabilityRegister
  actions {
    @(requires:['CFO'])
    action approveRegister() returns Boolean;

    @(requires:['CFO'])
    action confirmLodgement(lodgementRef: String(50)) returns Boolean;

    @(requires:['FinanceManager','CFO'])
    action initiateTransferToRegistrar() returns Boolean;
  };

  @(requires:['FinanceManager','CFO'])
  entity DepositLiabilityEntries as projection on prov.DepositLiabilityEntry
  actions {
    @(requires:['FinanceManager'])
    action confirmTransfer(registrarRef: String(50)) returns Boolean;
  };

  @(requires:['FinanceManager','CFO','Auditor'])
  entity AuditorConfirmationLetters as projection on prov.AuditorConfirmationLetter
  actions {
    @(requires:['FinanceManager'])
    action recordResponse(
      responseBalance    : Decimal(15,2),
      differenceResolution: String(500)
    ) returns Boolean;
  };

  @readonly
  entity SustainabilityData as projection on prov.SustainabilityARData;

  @(requires:['FinanceManager','CFO','Auditor'])
  function getProvisionMatrixReport(
    matrixVersionCode: String(20)
  ) returns array of {
    accountTypeCode : String(10);
    agingBucket     : String(20);
    openARAmount    : Decimal(18,2);
    provisionRatePct: Decimal(8,6);
    provisionAmount : Decimal(18,2);
    rationale       : String(500);
  };

  @(requires:['FinanceManager','CFO'])
  function getMFRS15DisaggregationReport(
    periodYear : Integer,
    periodMonth: Integer
  ) returns array of {
    revenueType         : String(30);
    billedRevenue       : Decimal(18,2);
    unbilledAccrual     : Decimal(18,2);
    totalRevenue        : Decimal(18,2);
    percentOfTotal      : Decimal(5,4);
    recognitionTiming   : String(20);
  };

  @(requires:['FinanceManager','CFO','Auditor'])
  function getARAuditTrailReport(
    fromDate : Date,
    toDate   : Date,
    entityType: String(30)
  ) returns array of {
    timestamp   : DateTime;
    userID      : String(60);
    actionType  : String(30);
    entityType  : String(30);
    entityID    : UUID;
    changeDetail: String(500);
  };

  @(requires:['SystemProcess'])
  action triggerECLCalculation(
    year         : Integer,
    month        : Integer,
    runType      : String(20)
  ) returns { runID: UUID; totalProvision: Decimal(18,2); };

  @(requires:['SystemProcess'])
  action triggerMFRS15Extract(
    year  : Integer,
    month : Integer
  ) returns { recordCount: Integer; };

  @(requires:['SystemProcess'])
  action triggerUnclaimedMoneysScan(year: Integer)
    returns { dormantFound: Integer; totalAmount: Decimal(18,2); };

  @(requires:['SystemProcess'])
  action triggerSustainabilityExtract(
    year  : Integer,
    month : Integer
  ) returns Boolean;

  @(requires:['FinanceManager'])
  action generateAuditorConfirmationLetters(
    auditYear    : Integer,
    sampleSize   : Integer,
    minBalance   : Decimal(15,2),
    auditorEmail : String(200)
  ) returns { generated: Integer; };
}
