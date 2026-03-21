namespace sains.ar.analytics;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

entity ARKPISnapshot : cuid, managed {
  snapshotDate          : Date not null;
  periodYear            : Integer not null;
  periodMonth           : Integer not null;
  branchCode            : String(20) default 'ALL';
  accountTypeCode       : String(10) default 'ALL';

  totalOpenAR           : Decimal(18,2);
  totalOverdueAR        : Decimal(18,2);
  dso                   : Decimal(8,2);
  cei                   : Decimal(5,4);
  collectionEfficiency  : Decimal(5,4);
  avgDaysToPay          : Decimal(8,2);

  currentRatio          : Decimal(5,4);
  over90DaysRatio       : Decimal(5,4);
  badDebtRatio          : Decimal(5,4);
  dunningL3L4Count      : Integer;
  disconnectedCount     : Integer;

  digitalPaymentRatio   : Decimal(5,4);
  counterPaymentRatio   : Decimal(5,4);
  directDebitRatio      : Decimal(5,4);
  jomPayRatio           : Decimal(5,4);

  portalRegisteredPct   : Decimal(5,4);
  eBillingPct           : Decimal(5,4);
  ptpSelfServiceCount   : Integer;

  billingAccuracyRate   : Decimal(5,4);
  nrwCommercialLossPct  : Decimal(5,4);
  disputeResolutionDays : Decimal(8,2);
}

entity ConsumptionProfile : cuid, managed {
  account              : Association to ar.CustomerAccount not null;
  profileDate          : Date not null;
  avgConsumption_12mo  : Decimal(10,3);
  stdDev_12mo          : Decimal(10,3);
  avgConsumption_3mo   : Decimal(10,3);
  seasonalIndex_Jan    : Decimal(5,4);
  seasonalIndex_Feb    : Decimal(5,4);
  seasonalIndex_Mar    : Decimal(5,4);
  seasonalIndex_Apr    : Decimal(5,4);
  seasonalIndex_May    : Decimal(5,4);
  seasonalIndex_Jun    : Decimal(5,4);
  seasonalIndex_Jul    : Decimal(5,4);
  seasonalIndex_Aug    : Decimal(5,4);
  seasonalIndex_Sep    : Decimal(5,4);
  seasonalIndex_Oct    : Decimal(5,4);
  seasonalIndex_Nov    : Decimal(5,4);
  seasonalIndex_Dec    : Decimal(5,4);
  trendSlope           : Decimal(8,4);
  minConsumption       : Decimal(10,3);
  maxConsumption       : Decimal(10,3);
  p5Consumption        : Decimal(10,3);
  p95Consumption       : Decimal(10,3);
  lastReadsCount       : Integer;
  profileVersion       : Integer default 1;
}

entity ConsumptionAnomaly : cuid, managed {
  account              : Association to ar.CustomerAccount not null;
  detectionDate        : Date not null;
  meterReadDate        : Date not null;
  actualConsumption    : Decimal(10,3) not null;
  expectedConsumption  : Decimal(10,3);
  anomalyType          : String(30) not null;
  anomalyScore         : Decimal(5,4);
  detectionMethod      : String(20) default 'RULE_BASED';
  zScore               : Decimal(8,4);
  fraudProbability     : Decimal(5,4);
  status               : String(20) default 'OPEN';
  reviewedBy           : String(60);
  reviewedAt           : DateTime;
  resolution           : String(500);
  billHeld             : Boolean default false;
  relatedInvoiceID     : UUID;
}

entity CustomerLifetimeValue : cuid, managed {
  account              : Association to ar.CustomerAccount not null;
  calculationDate      : Date not null;
  clvScore             : Decimal(10,2);
  revenueScore         : Decimal(10,2);
  costScore            : Decimal(10,2);
  riskScore            : Decimal(5,4);
  tenureMonths         : Integer;
  avgMonthlyRevenue    : Decimal(10,2);
  avgMonthlyPaymentDays: Decimal(8,2);
  clvBand              : String(10);
  clvRank              : Integer;
  model                : String(20) default 'RULE_V1';
}

entity RevenueForecast : cuid, managed {
  forecastDate         : Date not null;
  forecastMonth        : Date not null;
  accountTypeCode      : String(10) default 'ALL';
  branchCode           : String(20) default 'ALL';
  forecastedRevenue    : Decimal(18,2);
  forecastedCollections: Decimal(18,2);
  forecastedBadDebt    : Decimal(18,2);
  confidenceLow        : Decimal(18,2);
  confidenceHigh       : Decimal(18,2);
  modelVersion         : String(20);
  assumptions          : LargeString;
}

entity SPANKPIReport : cuid, managed {
  reportingYear        : Integer not null;
  reportingMonth       : Integer not null;
  reportingQuarter     : Integer;
  reportType           : String(20) not null;
  generatedAt          : DateTime not null;
  generatedBy          : String(60);
  status               : String(20) default 'DRAFT';
  approvedBy           : String(60);
  approvedAt           : DateTime;
  submittedAt          : DateTime;
  submissionRef        : String(50);
  rejectionReason      : String(500);

  totalConnections     : Integer;
  totalBilled          : Decimal(18,2);
  totalCollected       : Decimal(18,2);
  collectionRatio      : Decimal(5,4);
  outstandingDebt      : Decimal(18,2);
  badDebtWrittenOff    : Decimal(18,2);
  badDebtProvision     : Decimal(18,2);
  avgBillingCycleDays  : Decimal(5,1);
  complaintsReceived   : Integer;
  complaintsResolved   : Integer;
  avgComplaintDays     : Decimal(5,1);
  disconnectionCount   : Integer;
  reconnectionCount    : Integer;
  estimatedReads       : Integer;
  actualReads          : Integer;
  billingAccuracyPct   : Decimal(5,4);
  reportData           : LargeString;
}

entity FraudDensityZone : cuid, managed {
  calculationDate      : Date not null;
  zoneCode             : String(20) not null;
  zoneName             : String(80);
  latitude             : Decimal(10,6);
  longitude            : Decimal(10,6);
  totalAccounts        : Integer;
  anomalyFlagCount     : Integer;
  confirmedFraudCount  : Integer;
  fraudDensityPct      : Decimal(5,4);
  riskLevel            : String(10);
  recommendedAction    : String(255);
  lastInspectionDate   : Date;
}
