namespace sains.ar.payment;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

entity PaymentOrchestratorEvent : cuid, managed {
  sourceChannel      : String(30)  not null;
  rawReference       : String(100) not null;
  payerReference     : String(50);
  resolvedAccountID  : UUID;
  amount             : Decimal(15,2) not null;
  currency           : String(3) default 'MYR';
  transactionDate    : Date not null;
  transactionTime    : Time;
  valueDate          : Date;
  batchID            : String(50);
  status             : String(20) not null default 'RECEIVED';
  processingError    : String(500);
  paymentID          : UUID;
  duplicateOfID      : UUID;
  processorUser      : String(60);
  processorNotes     : String(500);
  sourceMetadata     : LargeString;
}

entity JomPAYBatch : cuid, managed {
  batchDate          : Date not null;
  billerCode         : String(10) not null;
  bankCode           : String(10) not null;
  bankName           : String(80);
  totalTransactions  : Integer default 0;
  totalAmount        : Decimal(15,2) default 0;
  status             : String(20) default 'UPLOADED';
  uploadedBy         : String(60);
  uploadedAt         : DateTime;
  reconciledBy       : String(60);
  reconciledAt       : DateTime;
  sourceFileName     : String(255);
  processingErrors   : Integer default 0;
  lines              : Composition of many JomPAYLine on lines.batch = $self;
}

entity JomPAYLine : cuid, managed {
  batch              : Association to JomPAYBatch not null;
  lineSequence       : Integer not null;
  transactionDate    : Date not null;
  transactionTime    : String(8);
  billRefNo          : String(30) not null;
  payerName          : String(100);
  payerBank          : String(10);
  amount             : Decimal(15,2) not null;
  jomPayRef          : String(30);
  fpxMsgToken        : String(50);
  status             : String(20) default 'PENDING';
  resolvedAccountID  : UUID;
  paymentEventID     : UUID;
  rejectionReason    : String(255);
}

entity DuitNowQRCode : cuid, managed {
  invoice            : Association to ar.Invoice not null;
  account            : Association to ar.CustomerAccount not null;
  merchantID         : String(30) not null;
  merchantName       : String(100) not null default 'SAINS';
  amount             : Decimal(15,2) not null;
  currency           : String(3) default 'MYR';
  billRef            : String(30) not null;
  productDetail      : String(25);
  expiryDate         : Date;
  qrPayload          : LargeString not null;
  qrImageBase64      : LargeString;
  status             : String(20) default 'ACTIVE';
  scannedAt          : DateTime;
  paidAt             : DateTime;
  payerRef           : String(50);
  paymentEventID     : UUID;
}

entity eMandate : cuid, managed {
  account            : Association to ar.CustomerAccount not null;
  mandateID          : String(30) not null;
  mandateRef         : String(20) not null;
  bankCode           : String(10) not null;
  bankAccountNumber  : String(30) not null;
  bankAccountName    : String(100) not null;
  maxAmountPerDebit  : Decimal(15,2) not null;
  frequency          : String(20) not null default 'MONTHLY';
  effectiveDate      : Date not null;
  expiryDate         : Date;
  status             : String(20) not null default 'PENDING';
  registrationMethod : String(20) default 'ONLINE';
  registeredAt       : DateTime;
  registeredBy       : String(60);
  lastDebitDate      : Date;
  lastDebitAmount    : Decimal(15,2);
  lastDebitStatus    : String(20);
  consecutiveFailures: Integer default 0;
  totalDebitsRun     : Integer default 0;
  totalAmountDebited : Decimal(15,2) default 0;
  suspensionReason   : String(255);
  cancelledAt        : DateTime;
  cancelledBy        : String(60);
  cancellationReason : String(500);
}

entity eMandateDebitRun : cuid, managed {
  mandate            : Association to eMandate not null;
  account            : Association to ar.CustomerAccount not null;
  runDate            : Date not null;
  debitDate          : Date not null;
  amount             : Decimal(15,2) not null;
  invoiceID          : UUID;
  status             : String(20) default 'PENDING';
  bankRef            : String(50);
  returnCode         : String(10);
  returnReason       : String(255);
  paymentID          : UUID;
  retryCount         : Integer default 0;
  nextRetryDate      : Date;
}

entity PaymentChannelConfig : cuid, managed {
  channelCode        : String(30) not null;
  channelName        : String(80) not null;
  isEnabled          : Boolean not null default true;
  feeRate            : Decimal(5,4) default 0;
  feeFixed           : Decimal(8,2) default 0;
  dailyLimit         : Decimal(15,2);
  cutOffTime         : Time;
  settlementDays     : Integer default 1;
  reconciliationMethod : String(20) default 'FILE';
  apiEndpoint        : String(255);
  apiKeyRef          : String(100);
  contactBankCode    : String(10);
  notes              : String(500);
}

entity WhatsAppMessage : cuid, managed {
  account            : Association to ar.CustomerAccount not null;
  invoice            : Association to ar.Invoice;
  dunningHistory     : Association to ar.DunningHistory;
  phoneNumber        : String(20) not null;
  messageType        : String(30) not null;
  templateName       : String(50) not null;
  language           : String(5) default 'ms';
  messageBody        : LargeString not null;
  paymentLink        : String(500);
  qrPayloadShortURL  : String(255);
  status             : String(20) default 'QUEUED';
  wamID              : String(100);
  sentAt             : DateTime;
  deliveredAt        : DateTime;
  readAt             : DateTime;
  failureReason      : String(255);
  customerOptedOut   : Boolean default false;
  optOutAt           : DateTime;
}
