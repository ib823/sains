namespace sains.ar.einvoice;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

entity EInvoiceSubmissionBatch : cuid, managed {
  batchDate            : Date not null;
  invoiceType          : String(20) not null;
  documentCount        : Integer not null;
  submittedAt          : DateTime;
  submittedBy          : String(60);
  status               : String(20) default 'PREPARING';
  lhdnSubmissionUID    : String(36);
  acceptedCount        : Integer default 0;
  rejectedCount        : Integer default 0;
  retryCount           : Integer default 0;
  lastRetryAt          : DateTime;
  errorSummary         : LargeString;
  lines                : Composition of many EInvoiceSubmissionLine on lines.batch = $self;
}

entity EInvoiceSubmissionLine : cuid, managed {
  batch                : Association to EInvoiceSubmissionBatch not null;
  invoice              : Association to ar.Invoice;
  consolidatedBatch    : UUID;
  lineSequence         : Integer not null;
  documentUUID         : String(36) not null;
  invoiceNumber        : String(50);
  buyerTIN             : String(20);
  buyerName            : String(200);
  totalExcludingTax    : Decimal(18,2);
  taxAmount            : Decimal(18,2);
  totalIncludingTax    : Decimal(18,2);
  status               : String(20) default 'PENDING';
  lhdnUUID             : String(36);
  lhdnLongID           : String(100);
  lhdnValidationDate   : DateTime;
  cancelDeadline       : DateTime;
  rejectionReason      : LargeString;
  cancelledAt          : DateTime;
  cancelledBy          : String(60);
  cancellationReason   : String(500);
}

entity EInvoiceSequenceCounter : cuid, managed {
  counterKey           : String(30) not null;
  documentType         : String(20) not null;
  periodYear           : Integer not null;
  periodMonth          : Integer not null;
  lastSequence         : Integer not null default 0;
  prefix               : String(10);
}

entity ConsolidatedB2CBatch : cuid, managed {
  periodYear           : Integer not null;
  periodMonth          : Integer not null;
  invoiceDate          : Date not null;
  submissionDeadline   : Date not null;
  totalTransactions    : Integer default 0;
  totalAmount          : Decimal(18,2) default 0;
  taxAmount            : Decimal(18,2) default 0;
  status               : String(20) default 'PREPARING';
  documentUUID         : String(36);
  lhdnUUID             : String(36);
  lhdnValidationDate   : DateTime;
  cancelDeadline       : DateTime;
  submissionBatchID    : UUID;
  accountTypesCovered  : String(100);
  excludedAccountTypes : String(100);
  lines                : Composition of many ConsolidatedB2CLine on lines.batch = $self;
}

entity ConsolidatedB2CLine : cuid, managed {
  batch                : Association to ConsolidatedB2CBatch not null;
  invoice              : Association to ar.Invoice not null;
  lineAmount           : Decimal(15,2) not null;
  taxAmount            : Decimal(15,2) default 0;
  description          : String(100);
}

entity DigitalCertificate : cuid, managed {
  serialNumber         : String(50) not null;
  issuer               : String(200);
  issuedTo             : String(200);
  notBefore            : Date not null;
  notAfter             : Date not null;
  status               : String(20) default 'ACTIVE';
  keystoreRef          : String(100);
  alertSentAt          : DateTime;
}

entity EInvoiceErrorLog : cuid, managed {
  submissionBatch      : Association to EInvoiceSubmissionBatch;
  invoice              : Association to ar.Invoice;
  occurredAt           : DateTime not null;
  errorCode            : String(20);
  errorCategory        : String(30);
  errorMessage         : String(2000) not null;
  rawResponse          : LargeString;
  resolved             : Boolean default false;
  resolvedBy           : String(60);
  resolvedAt           : DateTime;
  resolutionNotes      : String(500);
}
