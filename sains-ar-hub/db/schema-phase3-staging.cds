namespace sains.ar.staging;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

// ── STAGING DB CONFIG ──────────────────────────────────────────────────────
// Runtime-configurable connection parameters for the SAINS Staging DB
// (Pattern E1 fallback when iWRS Pattern A is unavailable).
// Single active record pattern — only one row should have isActive = true.

entity StagingDBConfig : cuid, managed {
  dbType                : String(20) not null default 'MSSQL';
                          // MSSQL | MYSQL | POSTGRES | ORACLE
  dbHost                : String(255);  // /* TBC: Staging DB hostname */
  dbPort                : Integer;
  dbName                : String(100);  // /* TBC: Staging DB database name */
  dbSchema              : String(50);   // /* TBC: Staging DB schema name */
  dbUserRef             : String(100);  // /* TBC: read-only service account credential reference in BTP Credential Store */
  pollIntervalMinutes   : Integer default 15;
  lastPollAt            : DateTime;
  lastSuccessAt         : DateTime;
  lastPollRecordCount   : Integer default 0;
  isActive              : Boolean default false;
  failCount             : Integer default 0;
}

// ── STAGING PAYMENT RECORD ─────────────────────────────────────────────────
// Append-only log of every row ingested from the Staging DB.

@cds.persistence.index: [
  { columns: [ 'processingStatus', 'createdAt' ] },
  { columns: [ 'stagingID' ], unique: true },
  { columns: [ 'accountReference' ] }
]
entity StagingPaymentRecord : cuid, managed {
  stagingID             : String(50) not null;  // PK from the Staging DB row
  channelCode           : String(30) not null;  // payment channel identifier
  accountReference      : String(30) not null;  // account number / IC / custom ref
  amount                : Decimal(15,2) not null;
  paymentDate           : Date not null;
  paymentTime           : Time;
  bankReference         : String(50);
  payerName             : String(150);
  payerReference        : String(50);
  rawData               : LargeString;          // full Staging DB row JSON
  processingStatus      : String(20) not null default 'RECEIVED';
                          // RECEIVED | RESOLVED | FAILED | DUPLICATE | SUSPENSE
  resolvedAccountID     : UUID;
  paymentEventID        : UUID;
  processingError       : String(500);
  processedAt           : DateTime;
}
