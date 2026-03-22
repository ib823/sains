namespace sains.ar.integration;

using { cuid, managed } from '@sap/cds/common';
using sains.ar as ar from './schema';

// ── iWRS EVENT LOG ──────────────────────────────────────────────────────────
// Append-only log of every event received from iWRS.
// Provides full audit trail of the iWRS → AR Hub integration.
// Never updated after creation. Never deleted.

entity iWRSEventLog : cuid, managed {
  eventType          : String(30) not null;
                       // ACCOUNT_CREATED | ACCOUNT_UPDATED | ACCOUNT_CLOSED |
                       // INVOICE_GENERATED | PAYMENT_RECEIVED
  eventSource        : String(20) not null default 'PATTERN_A';
                       // PATTERN_A | PATTERN_B | PATTERN_C
  iWRSReference      : String(50) not null;  // iWRS-assigned event/record reference
  accountNumber      : String(20);           // Account number from iWRS
  resolvedAccountID  : UUID;                 // Resolved AR Hub CustomerAccount.ID
  rawPayload         : LargeString not null; // JSON-serialised inbound payload
  processingStatus   : String(20) not null default 'RECEIVED';
                       // RECEIVED | PROCESSED | FAILED | DUPLICATE | SUSPENSE
  processingError    : String(500);
  processingDurationMs : Integer;
  processedAt        : DateTime;
  retryCount         : Integer default 0;
}

// ── METIS WORK ORDER ────────────────────────────────────────────────────────
// Tracks all work orders sent to Metis and their completion status.

entity MetisWorkOrder : cuid, managed {
  account            : Association to ar.CustomerAccount not null;
  workOrderType      : String(20) not null;
                       // DISCONNECTION | RECONNECTION
  metisWorkOrderRef  : String(50);          // Metis-assigned work order number (on creation)
  status             : String(20) not null default 'PENDING';
                       // PENDING | SENT | ACKNOWLEDGED | IN_PROGRESS | COMPLETED | FAILED | CANCELLED
  authorisedBy       : String(60) not null;
  authorisedAt       : DateTime not null;
  requestedDate      : Date;                // Requested execution date
  completedAt        : DateTime;
  completedBy        : String(60);          // Metis field team ID
  completionNotes    : String(255);
  outstandingBalance : Decimal(15,2);       // Balance at time of authorisation
  dunningLevelAtAuth : Integer;
  retryCount         : Integer default 0;
  lastRetryAt        : DateTime;
  rawCompletionPayload : LargeString;       // Raw Metis completion webhook payload
}

// ── BANK SFTP CONFIG ────────────────────────────────────────────────────────
// Per-bank SFTP configuration for automated bank statement download.

entity BankSFTPConfig : cuid, managed {
  bankCode           : String(10) not null; // e.g. MBB, CIMB, RHB, HLBB
  bankName           : String(80) not null;
  sftpHost           : String(255) not null; // /* TBC: bank SFTP hostname */
  sftpPort           : Integer default 22;
  sftpUsername       : String(100) not null; // /* TBC: bank SFTP username */
  sftpKeyRef         : String(100) not null; // BTP Credential Store / Vault key name
  sftpRemotePath     : String(255) not null; // /* TBC: path on bank SFTP */
  filePattern        : String(100);          // e.g. SAINS_*.mt940 or STATEMENT_*.xml
  fileFormat         : String(10) not null default 'MT940'; // MT940 | CAMT053
  accountNumber      : String(30);           // SAINS bank account number at this bank
  isActive           : Boolean default true;
  lastDownloadAt     : DateTime;
  lastSuccessAt      : DateTime;
  consecutiveFailures : Integer default 0;
}

// ── iWRS INTEGRATION CONFIG ─────────────────────────────────────────────────
// Runtime-configurable iWRS connection parameters.

entity iWRSIntegrationConfig : cuid, managed {
  activePattern      : String(10) not null default 'PATTERN_A';
                       // PATTERN_A | PATTERN_B | PATTERN_C
  // Pattern A — REST API
  apiBaseURL         : String(255); // /* TBC: iWRS REST API base URL */
  apiKeyRef          : String(100); // /* TBC: BTP Credential Store / Vault key for iWRS API key */
  apiTimeoutMs       : Integer default 30000;
  // Pattern B — SFTP
  sftpHost           : String(255); // /* TBC: iWRS SFTP hostname */
  sftpPort           : Integer default 22;
  sftpUsername       : String(100); // /* TBC: iWRS SFTP username */
  sftpKeyRef         : String(100); // /* TBC: SFTP private key in Credential Store */
  sftpDeltaPath      : String(255); // /* TBC: path where iWRS deposits delta files */
  sftpFilePattern    : String(100); // /* TBC: file naming pattern */
  // Pattern C — Direct DB (last resort)
  dbHost             : String(255); // /* TBC: iWRS DB hostname */
  dbPort             : Integer;     // /* TBC: iWRS DB port */
  dbSchema           : String(50);  // /* TBC: iWRS read-only schema name */
  dbUserRef          : String(100); // /* TBC: read-only service account credential reference */
  dbPollIntervalMin  : Integer default 5;
  // Outbound (for disconnection/reconnection notifications)
  outboundEndpoint   : String(255); // /* TBC: iWRS endpoint to receive AR Hub notifications */
  outboundApiKeyRef  : String(100); // /* TBC: outbound API key */
  isActive           : Boolean default true;
}

// ── INDEXES ─────────────────────────────────────────────────────────────────
// SCALE-001: iWRSEventLog indexes for dashboard queries at 17.6M rows/year
annotate iWRSEventLog with @(
  cds.persistence.index: [
    { elements: ['processingStatus', 'createdAt'] },
    { elements: ['accountNumber'] },
    { elements: ['eventType', 'createdAt'] },
  ]
);

// SCALE-002: MetisWorkOrder indexes for work order status queries
annotate MetisWorkOrder with @(
  cds.persistence.index: [
    { elements: ['account_ID', 'status'] },
    { elements: ['workOrderType', 'status'] },
  ]
);

// DB-LEVEL CONSTRAINT (add via migration script):
// CREATE UNIQUE INDEX ux_metis_active_workorder
//   ON sains_ar_integration_MetisWorkOrder (account_ID, workOrderType)
//   WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'FAILED');
// Prevents duplicate active work orders per account per type.
