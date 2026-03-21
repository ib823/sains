namespace sains.ar.collections;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

entity CustomerSegment : cuid, managed {
  account : Association to ar.CustomerAccount not null;
  segmentCode : String(20) not null;
  segmentVersion : Integer not null default 1;
  scoreDate : Date not null;
  propensityScore : Decimal(5,4);
  riskScore : Decimal(5,4);
  vulnerabilityFlag : Boolean default false;
  vulnerabilityCategory : String(30);
  affordabilityRating : String(10);
  paymentBehaviourCode : String(20);
  daysToPay_avg90 : Decimal(5,1);
  daysToPay_avg365 : Decimal(5,1);
  paymentChannelPref : String(30);
  ptpComplianceRate : Decimal(5,4);
  dunningPathCode : String(20) not null;
  modelVersion : String(20);
  modelRunID : String(50);
  expiresAt : Date;
  overrideBy : String(60);
  overrideReason : String(255);
}

entity DunningPath : cuid, managed {
  pathCode : String(20) not null;
  pathName : String(80) not null;
  description : String(500);
  targetSegment : String(20);
  isActive : Boolean default true;
  steps : Composition of many DunningPathStep on steps.path = $self;
}

entity DunningPathStep : cuid, managed {
  path : Association to DunningPath not null;
  stepSequence : Integer not null;
  daysOverdue : Integer not null;
  actionType : String(30) not null;
  messageTemplate : String(50);
  tone : String(20) default 'STANDARD';
  pauseEscalation : Boolean default false;
  pauseDays : Integer default 0;
  requiresApproval : Boolean default false;
  approvalRole : String(30);
  isDisconnectionStep : Boolean default false;
  isFinalStep : Boolean default false;
}

entity VulnerabilityRecord : cuid, managed {
  account : Association to ar.CustomerAccount not null;
  category : String(30) not null;
  severity : String(10) not null;
  registeredBy : String(60) not null;
  registeredAt : DateTime not null;
  verificationDocument : String(255);
  reviewDate : Date;
  isActive : Boolean default true;
  deactivatedAt : DateTime;
  deactivatedBy : String(60);
  deactivationReason : String(255);
}

entity HardshipAssessment : cuid, managed {
  account : Association to ar.CustomerAccount not null;
  applicationDate : Date not null;
  applicationChannel : String(20);
  householdSize : Integer;
  monthlyHouseholdIncome : Decimal(15,2);
  incomeCategory : String(10);
  employmentStatus : String(20);
  supportingDocuments : LargeString;
  assessedBy : String(60);
  assessedAt : DateTime;
  outcome : String(20);
  schemeCode : String(20);
  monthlyPaymentAmount : Decimal(15,2);
  schemeStartDate : Date;
  schemeEndDate : Date;
  reviewDate : Date;
  rejectionReason : String(255);
  notes : LargeString;
}

entity PropensityScoreHistory : cuid, managed {
  account : Association to ar.CustomerAccount not null;
  scoreDate : Date not null;
  modelVersion : String(20) not null;
  modelRunID : String(50) not null;
  propensityScore : Decimal(5,4) not null;
  riskScore : Decimal(5,4) not null;
  featureVector : LargeString;
  previousScore : Decimal(5,4);
  scoreDelta : Decimal(5,4);
  segmentAssigned : String(20);
  dunningPathAssigned : String(20);
}

entity EarlyInterventionAlert : cuid, managed {
  account : Association to ar.CustomerAccount not null;
  alertDate : Date not null;
  alertType : String(30) not null;
  signalDescription : String(500) not null;
  riskLevel : String(10) default 'MEDIUM';
  assignedTo : String(60);
  status : String(20) default 'OPEN';
  actionTaken : String(500);
  actionDate : Date;
  resolvedAt : DateTime;
}

entity PTPSelfService : cuid, managed {
  account : Association to ar.CustomerAccount not null;
  initiationChannel : String(20) not null;
  requestedDate : DateTime not null;
  promisedPaymentDate : Date not null;
  promisedAmount : Decimal(15,2) not null;
  invoiceIDs : LargeString;
  status : String(20) default 'CONFIRMED';
  paymentID : UUID;
  reminderSentAt : DateTime;
  honouredAt : DateTime;
  brokenAt : DateTime;
  customerReference : String(50);
  linkedPTPID : UUID;
}
