using sains.ar.analytics as ana from '../db/schema-phase2-analytics';
using sains.ar as ar from '../db/schema';

@requires: ['FinanceSupervisor','FinanceManager','CFO','Auditor','ReportViewer']
service AnalyticsService @(path:'/analytics') {

  @readonly
  entity ARKPISnapshots as projection on ana.ARKPISnapshot;

  @readonly
  entity ConsumptionProfiles as projection on ana.ConsumptionProfile;

  @(requires:['FinanceSupervisor','FinanceManager','BILSupervisor'])
  entity ConsumptionAnomalies as projection on ana.ConsumptionAnomaly
  actions {
    @(requires:['FinanceSupervisor','BILSupervisor'])
    action resolveAnomaly(
      resolution : String(500),
      outcome    : String(30)
    ) returns Boolean;

    @(requires:['BILSupervisor'])
    action holdBillingPending() returns Boolean;

    @(requires:['BILSupervisor'])
    action releaseBillingHold() returns Boolean;
  };

  @readonly
  entity CustomerLifetimeValues as projection on ana.CustomerLifetimeValue;

  @readonly
  entity RevenueForecasts as projection on ana.RevenueForecast;

  @(requires:['FinanceManager','CFO','Auditor'])
  entity SPANKPIReports as projection on ana.SPANKPIReport
  actions {
    @(requires:['FinanceManager'])
    action approveReport() returns Boolean;

    @(requires:['CFO'])
    action submitToSPAN() returns { submissionRef: String(50); };

    @(requires:['FinanceManager','CFO'])
    action exportReport(format: String(10) default 'CSV') returns {
      content  : LargeString;
      fileName : String(100);
      mimeType : String(50);
    };
  };

  @readonly
  entity FraudDensityZones as projection on ana.FraudDensityZone;

  @(requires:['FinanceSupervisor','FinanceManager','CFO'])
  function getARAgingReport(
    asOfDate         : Date,
    branchCode       : String(20),
    accountTypeCode  : String(10)
  ) returns array of {
    agingBucket      : String(20);
    accountCount     : Integer;
    totalAmount      : Decimal(18,2);
    percentOfTotal   : Decimal(5,4);
  };

  @(requires:['FinanceSupervisor','FinanceManager','CFO'])
  function getCollectionTrend(
    fromDate         : Date,
    toDate           : Date,
    granularity      : String(10)
  ) returns array of {
    period           : String(10);
    billed           : Decimal(18,2);
    collected        : Decimal(18,2);
    efficiency       : Decimal(5,4);
    dso              : Decimal(8,2);
  };

  @(requires:['FinanceSupervisor','FinanceManager','CFO'])
  function getPaymentChannelAnalysis(
    fromDate         : Date,
    toDate           : Date
  ) returns array of {
    channel          : String(30);
    transactionCount : Integer;
    totalAmount      : Decimal(18,2);
    averageAmount    : Decimal(15,2);
    percentOfTotal   : Decimal(5,4);
    failureRate      : Decimal(5,4);
  };

  @(requires:['FinanceManager','CFO'])
  function getRevenueLeakageReport(
    periodYear       : Integer,
    periodMonth      : Integer
  ) returns {
    billedNotCollected     : Decimal(18,2);
    estimatedRevenueAtRisk : Decimal(18,2);
    highRiskAccountCount   : Integer;
    consumptionAnomalyCount: Integer;
    suspenseNotResolved    : Decimal(18,2);
  };

  @(requires:['SystemProcess'])
  action triggerKPISnapshot(snapshotDate: Date) returns Boolean;

  @(requires:['SystemProcess'])
  action triggerConsumptionProfileUpdate(asOfDate: Date)
    returns { updated: Integer; };

  @(requires:['SystemProcess'])
  action triggerAnomalyDetection(asOfDate: Date)
    returns { detected: Integer; };

  @(requires:['SystemProcess'])
  action triggerCLVCalculation(asOfDate: Date)
    returns { calculated: Integer; };

  @(requires:['SystemProcess'])
  action triggerSPANReportGeneration(
    year  : Integer,
    month : Integer
  ) returns { reportID: UUID; };

  @(requires:['SystemProcess'])
  action triggerFraudDensityMap(asOfDate: Date)
    returns { zonesUpdated: Integer; };
}
