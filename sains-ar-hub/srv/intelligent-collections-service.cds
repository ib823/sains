using sains.ar.collections as col from '../db/schema-phase2-collections';
using sains.ar as ar from '../db/schema';

@requires: ['authenticated-user','CollectionsOfficer','CollectionsSupervisor']
service IntelligentCollectionsService @(path:'/collections') {

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILSupervisor'])
  entity CustomerSegments as projection on col.CustomerSegment
  actions {
    @(requires:['FinanceSupervisor','FinanceManager'])
    action overrideSegment(
      newSegmentCode   : String(20),
      newDunningPath   : String(20),
      reason           : String(255)
    ) returns Boolean;
  };

  @(requires:['FinanceManager'])
  entity DunningPaths as projection on col.DunningPath;

  @(requires:['FinanceManager'])
  entity DunningPathSteps as projection on col.DunningPathStep;

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
  entity VulnerabilityRecords as projection on col.VulnerabilityRecord
  actions {
    @(requires:['FinanceSupervisor','BILSupervisor'])
    action deactivateRecord(reason: String(255)) returns Boolean;
  };

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff'])
  entity HardshipAssessments as projection on col.HardshipAssessment
  actions {
    @(requires:['FinanceSupervisor','FinanceManager'])
    action approveAssessment(
      schemeCode           : String(20),
      monthlyPaymentAmount : Decimal(15,2),
      schemeStartDate      : Date,
      schemeEndDate        : Date
    ) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action rejectAssessment(reason: String(255)) returns Boolean;
  };

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
  entity EarlyInterventionAlerts as projection on col.EarlyInterventionAlert
  actions {
    @(requires:['FinanceAdmin','BILStaff','BILSupervisor'])
    action actionAlert(action: String(500)) returns Boolean;

    @(requires:['FinanceSupervisor','BILSupervisor'])
    action dismissAlert(reason: String(255)) returns Boolean;
  };

  @(requires:['authenticated-user'])
  entity PTPSelfServices as projection on col.PTPSelfService
  actions {
    @(requires:['authenticated-user'])
    action cancelPTP(reason: String(255)) returns Boolean;
  };

  @(requires:['FinanceSupervisor','FinanceManager','CFO'])
  function getCollectionsPerformanceDashboard(
    periodYear  : Integer,
    periodMonth : Integer
  ) returns {
    collectionEfficiency    : Decimal(5,4);
    averageDaysToPay        : Decimal(5,1);
    ptpComplianceRate       : Decimal(5,4);
    vulnerableAccountCount  : Integer;
    hardshipSchemeCount     : Integer;
    earlyInterventionOpened : Integer;
    earlyInterventionResolved: Integer;
  };

  @(requires:['FinanceSupervisor','FinanceManager'])
  function getDunningPathPerformance(
    fromDate: Date,
    toDate  : Date
  ) returns array of {
    pathCode          : String(20);
    accountsEntered   : Integer;
    collected         : Integer;
    writtenOff        : Integer;
    avgDaysToCollect  : Decimal(5,1);
    collectionRate    : Decimal(5,4);
  };

  @(requires:['SystemProcess'])
  action triggerSegmentationRun(
    asOfDate : Date
  ) returns { processed: Integer; updated: Integer; };

  @(requires:['SystemProcess'])
  action triggerEarlyInterventionScan(
    asOfDate : Date
  ) returns { alertsCreated: Integer; };

  @(requires:['SystemProcess'])
  action triggerPTPComplianceCheck(
    asOfDate : Date
  ) returns { honoured: Integer; broken: Integer; };
}
