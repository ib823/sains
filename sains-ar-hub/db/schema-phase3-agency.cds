namespace sains.ar.agency;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

// ── AGENCY FILE FORMAT ─────────────────────────────────────────────────────
// Configuration per agency. The agency-file-parser engine reads this row to
// know how to parse the file. One row per agency code.

entity AgencyFileFormat : cuid, managed {
  agencyCode          : String(20) not null;
  agencyName          : String(100) not null;
  fileType            : String(10) not null default 'CSV';
                        // CSV | TSV | FIXED_WIDTH | PIPE
  delimiter           : String(5) default ',';
  hasHeaderRow        : Boolean default true;
  encoding            : String(20) default 'UTF-8';
                        // UTF-8 | ASCII | LATIN1
  dateFormat          : String(20) default 'YYYY-MM-DD';
                        // dayjs-compatible format
  amountFormat        : String(20) default 'DECIMAL_DOT';
                        // DECIMAL_DOT | DECIMAL_COMMA | CENTS
  accountRefColumn    : String(50) not null;
                        // column name (header) or 0-based position;
                        // for FIXED_WIDTH: 'start-end' (e.g. '0-19')
  amountColumn        : String(50) not null;
  paymentDateColumn   : String(50) not null;
  paymentRefColumn    : String(50);
  payerNameColumn     : String(50);
  bankRefColumn       : String(50);
  skipRowsTop         : Integer default 0;
  skipRowsBottom      : Integer default 0;
  totalLinePattern    : String(100);
                        // regex for total/footer lines to skip
  accountRefType      : String(20) default 'ACCOUNT_NUMBER';
                        // ACCOUNT_NUMBER | IC_NUMBER | CUSTOM_REF
  isActive            : Boolean default true;
  notes               : String(500);
}

// ── AGENCY FILE BATCH ──────────────────────────────────────────────────────

entity AgencyFileBatch : cuid, managed {
  agencyCode          : String(20) not null;
  fileName            : String(255) not null;
  fileDate            : Date not null;
  uploadedBy          : String(60) not null;
  uploadedAt          : DateTime not null;
  totalLines          : Integer default 0;
  totalAmount         : Decimal(15,2) default 0;
  parsedLines         : Integer default 0;
  failedLines         : Integer default 0;
  suspenseLines       : Integer default 0;
  status              : String(20) default 'UPLOADED';
                        // UPLOADED | PARSING | PARSED | PROCESSING | COMPLETED | FAILED
  errorSummary        : LargeString;
  lines               : Composition of many AgencyFileLine
                          on lines.batch = $self;
}

// ── AGENCY FILE LINE ───────────────────────────────────────────────────────

entity AgencyFileLine : cuid, managed {
  batch               : Association to AgencyFileBatch not null;
  lineNumber          : Integer not null;
  rawLine             : String(2000);
  accountReference    : String(30);
  amount              : Decimal(15,2);
  paymentDate         : Date;
  paymentReference    : String(50);
  payerName           : String(150);
  bankReference       : String(50);
  status              : String(20) default 'PARSED';
                        // PARSED | RESOLVED | FAILED | SUSPENSE | SKIPPED
  resolvedAccountID   : UUID;
  paymentEventID      : UUID;
  parseError          : String(255);
  resolutionError     : String(255);
}
