namespace sains.ar.provision;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

entity ProvisionMatrixVersion : cuid, managed {
  versionCode          : String(20) not null;
  description          : String(500);
  effectiveFrom        : Date not null;
  effectiveTo          : Date;
  isActive             : Boolean default false;
  approvedBy           : String(60);
  approvedAt           : DateTime;
  approvalNotes        : String(1000);
  auditFirmConfirmed   : Boolean default false;
  auditConfirmedBy     : String(100);
  auditConfirmedAt     : DateTime;
  auditConfirmationRef : String(100);
  rates                : Composition of many ProvisionRate on rates.version = $self;
}

entity ProvisionRate : cuid, managed {
  version              : Association to ProvisionMatrixVersion not null;
  accountTypeCode      : String(10) not null;
  agingBucket          : String(20) not null;
  provisionRatePct     : Decimal(8,6) not null;
  historicalLossRate   : Decimal(8,6);
  forwardLookingAdj    : Decimal(8,6) default 0;
  rationale            : String(500);
  minRate              : Decimal(8,6) default 0;
  maxRate              : Decimal(8,6) default 1;
}

entity ECLCalculationRun : cuid, managed {
  runDate              : Date not null;
  periodYear           : Integer not null;
  periodMonth          : Integer not null;
  matrixVersion        : Association to ProvisionMatrixVersion not null;
  runType              : String(20) default 'MONTHLY';
  status               : String(20) default 'RUNNING';
  totalOpenAR          : Decimal(18,2);
  totalProvisionRequired : Decimal(18,2);
  priorPeriodProvision : Decimal(18,2);
  netMovement          : Decimal(18,2);
  glBatchID            : UUID;
  approvedBy           : String(60);
  approvedAt           : DateTime;
  errorMessage         : String(1000);
  runDurationSeconds   : Integer;
  segments             : Composition of many ECLSegmentResult on segments.run = $self;
}

entity ECLSegmentResult : cuid, managed {
  run                  : Association to ECLCalculationRun not null;
  accountTypeCode      : String(10) not null;
  agingBucket          : String(20) not null;
  openARAmount         : Decimal(18,2) not null;
  accountCount         : Integer not null;
  provisionRatePct     : Decimal(8,6) not null;
  provisionAmount      : Decimal(18,2) not null;
  priorPeriodAmount    : Decimal(18,2) default 0;
  movement             : Decimal(18,2);
  gdpGrowthRate        : Decimal(8,4);
  unemploymentRate     : Decimal(8,4);
  cpiRate              : Decimal(8,4);
  macroAdjFactor       : Decimal(8,6) default 1;
}

entity ForwardLookingFactor : cuid, managed {
  periodYear           : Integer not null;
  periodMonth          : Integer not null;
  dataSource           : String(50) not null;
  gdpGrowthPct         : Decimal(8,4);
  unemploymentPct      : Decimal(8,4);
  cpiPct               : Decimal(8,4);
  waterTariffChangePct : Decimal(8,4) default 0;
  economicOutlook      : String(20) default 'STABLE';
  macroAdjFactor       : Decimal(8,6) default 1.0;
  computationBasis     : String(1000);
  importedBy           : String(60);
  importedAt           : DateTime;
}

entity MFRS15RevenueRecord : cuid, managed {
  periodYear           : Integer not null;
  periodMonth          : Integer not null;
  revenueType          : String(30) not null;
  accountTypeCode      : String(10) not null;
  geography            : String(20) default 'NEGERI_SEMBILAN';
  recognitionTiming    : String(20) default 'POINT_IN_TIME';
  billedRevenue        : Decimal(18,2) default 0;
  unbilledAccrual      : Decimal(18,2) default 0;
  totalRevenue         : Decimal(18,2) default 0;
  taxAmount            : Decimal(18,2) default 0;
  glAccountCode        : String(10);
}

entity DepositLiabilityRegister : cuid, managed {
  reportYear           : Integer not null;
  generatedAt          : DateTime;
  status               : String(20) default 'DRAFT';
  totalDepositHeld     : Decimal(18,2);
  dormantCount         : Integer;
  dormantAmount        : Decimal(18,2);
  lodgedWith           : String(50) default 'REGISTRAR_UNCLAIMED_MONEYS';
  lodgedAt             : DateTime;
  lodgementRef         : String(50);
  approvedBy           : String(60);
  entries              : Composition of many DepositLiabilityEntry on entries.register = $self;
}

entity DepositLiabilityEntry : cuid {
  register             : Association to DepositLiabilityRegister not null;
  account              : Association to ar.CustomerAccount not null;
  deposit              : Association to ar.DepositRecord not null;
  depositAmount        : Decimal(15,2) not null;
  depositDate          : Date not null;
  dormancySince        : Date;
  isDormant            : Boolean default false;
  lastContactDate      : Date;
  noticesSent          : Integer default 0;
  registrarRef         : String(50);
  transferDate         : Date;
  transferStatus       : String(20) default 'PENDING'; // PENDING | INITIATED | TRANSFERRED
}

entity AuditorConfirmationLetter : cuid, managed {
  auditYear            : Integer not null;
  letterDate           : Date not null;
  accountID            : UUID not null;
  accountNumber        : String(20) not null;
  legalName            : String(200) not null;
  balanceAsAt          : Date not null;
  confirmedBalance     : Decimal(15,2) not null;
  auditorFirm          : String(100);
  sentAt               : DateTime;
  responseReceived     : Boolean default false;
  responseDate         : Date;
  responseBalance      : Decimal(15,2);
  responseDifference   : Decimal(15,2);
  differenceResolution : String(500);
  status               : String(20) default 'SENT';
}

entity SustainabilityARData : cuid, managed {
  periodYear           : Integer not null;
  periodMonth          : Integer not null;
  totalCustomers       : Integer;
  customersInArrears   : Integer;
  arrearsRatio         : Decimal(5,4);
  avgArrearsAmount     : Decimal(15,2);
  hardshipSchemeCount  : Integer;
  hardshipSchemeAmount : Decimal(18,2);
  ptpSelfServiceCount  : Integer;
  vulnerableRegistered : Integer;
  affordabilityIndex   : Decimal(5,4);
  b40IdentifiedCount   : Integer;
  directDebitPenetration: Decimal(5,4);
  digitalPaymentPct    : Decimal(5,4);
  waterConservationNoticeCount: Integer;
}
