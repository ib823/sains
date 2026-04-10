namespace sains.ar.sibma;

using { cuid, managed } from '@sap/cds/common';

// ── SiBMA CONFIG ───────────────────────────────────────────────────────────
// Single active record pattern. Outbound integration with SiBMA Water Billing.

entity SiBMAConfig : cuid, managed {
  apiBaseURL              : String(255);    // MOCK: SiBMA REST API base URL — configure in BTP Credential Store
  apiKeyRef               : String(100);    // MOCK: SiBMA API key in BTP Credential Store
  authMethod              : String(20) default 'API_KEY';
                            // API_KEY | OAUTH2 | BASIC
  pushPaymentConfirmations : Boolean default true;
  pushBalanceUpdates      : Boolean default true;
  pushTransactionHistory  : Boolean default false;
  retryIntervalMinutes    : Integer default 30;
  maxRetries              : Integer default 5;
  isActive                : Boolean default false;
  lastPushAt              : DateTime;
  consecutiveFailures     : Integer default 0;
}

// ── SiBMA OUTBOUND QUEUE ───────────────────────────────────────────────────
// Retry queue for failed pushes from AR Hub to SiBMA.

@cds.persistence.index: [
  { columns: [ 'status', 'createdAt' ] }
]
entity SiBMAOutboundQueue : cuid, managed {
  eventType        : String(30) not null;
                     // PAYMENT_CONFIRMATION | BALANCE_UPDATE | TRANSACTION_HISTORY
  accountNumber    : String(20) not null;
  payload          : LargeString not null;
  status           : String(20) not null default 'PENDING';
                     // PENDING | SENT | DEAD_LETTER
  retryCount       : Integer default 0;
  lastRetryAt      : DateTime;
  lastError        : String(500);
  sentAt           : DateTime;
  sibmaRef         : String(50);
}
