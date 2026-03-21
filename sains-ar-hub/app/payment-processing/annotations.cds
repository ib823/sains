using ARService as service from '../../srv/ar-service';

// ── PAYMENTS ───────────────────────────────────────────────────────────────

annotate service.Payments with @(
  UI.LineItem: [
    { Value: paymentDate,             Label: '{i18n>date}' },
    { Value: account.accountNumber,   Label: '{i18n>accountNumber}' },
    { Value: account.legalName,       Label: '{i18n>customerName}' },
    { Value: channel,                 Label: '{i18n>channel}' },
    { Value: amount,                  Label: '{i18n>amount}', @UI.Importance: #High },
    {
      Value: status,
      Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'ALLOCATED',            Criticality: 3 },
          { Value: 'PARTIALLY_ALLOCATED',  Criticality: 2 },
          { Value: 'RECEIVED',             Criticality: 2 },
          { Value: 'CLEARING_PENDING',     Criticality: 2 },
          { Value: 'UNALLOCATED',          Criticality: 1 },
          { Value: 'REVERSED',             Criticality: 0 },
          { Value: 'BOUNCED',              Criticality: 1 },
          { Value: 'CHARGEBACK',           Criticality: 1 }
        ]
      }
    },
    { Value: amountAllocated,         Label: '{i18n>allocated}' },
    { Value: amountUnallocated,       Label: '{i18n>unallocated}' },
    { Value: paymentReference,        Label: '{i18n>reference}' },
    { Value: bankReference,           Label: '{i18n>bankRef}' },
    { Value: chequeClearanceStatus,   Label: '{i18n>chequeClearance}' },
  ],

  UI.SelectionFields: [
    status, channel, paymentDate, chequeClearanceStatus, isThirdParty
  ],

  UI.HeaderInfo: {
    TypeName: '{i18n>payment}', TypeNamePlural: '{i18n>payments}',
    Title: { Value: paymentReference }, Description: { Value: account.legalName }
  },

  UI.Facets: [
    {
      $Type: 'UI.CollectionFacet', Label: '{i18n>sectionPaymentDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#PaymentMain',     Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#PaymentCheque',   Label: '{i18n>sectionCheque}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#PaymentReversal', Label: '{i18n>sectionReversal}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#ThirdParty',      Label: '{i18n>sectionThirdParty}' },
      ]
    },
    { $Type: 'UI.ReferenceFacet', Target: 'clearings/@UI.LineItem', Label: '{i18n>sectionClearings}' },
  ],

  UI.FieldGroup#PaymentMain: {
    Data: [
      { Value: paymentDate }, { Value: valueDate,    Label: '{i18n>valueDate}' },
      { Value: channel },     { Value: status },
      { Value: amount,        Label: '{i18n>amount}' },
      { Value: amountAllocated }, { Value: amountUnallocated },
      { Value: bankReference },   { Value: batchReference },
      { Value: cashierID,     Label: '{i18n>cashier}' },
      { Value: counterCode,   Label: '{i18n>counter}' },
    ]
  },

  UI.FieldGroup#PaymentCheque: {
    Data: [
      { Value: chequeClearanceStatus,  Label: '{i18n>clearanceStatus}' },
      { Value: chequeClearanceDueDate, Label: '{i18n>clearanceDue}' },
    ]
  },

  UI.FieldGroup#PaymentReversal: {
    Data: [
      { Value: reversalType,   Label: '{i18n>reversalType}' },
      { Value: reversalReason, Label: '{i18n>reversalReason}' },
      { Value: reversedAt,     Label: '{i18n>reversedAt}' },
      { Value: reversedBy,     Label: '{i18n>reversedBy}' },
    ]
  },

  UI.FieldGroup#ThirdParty: {
    Data: [
      { Value: isThirdParty },
      { Value: thirdPartyName, Label: '{i18n>thirdPartyName}' },
    ]
  }
);

// PaymentClearing sub-list
annotate service.PaymentClearing with @UI.LineItem: [
  { Value: invoice.invoiceNumber, Label: '{i18n>invoiceNumber}' },
  { Value: clearedAmount,         Label: '{i18n>clearedAmount}' },
  { Value: clearingDate,          Label: '{i18n>date}' },
  { Value: clearingType,          Label: '{i18n>clearingType}' },
  { Value: isPartial,             Label: '{i18n>partial}' },
];

// ── COLLECTION IMPORT BATCHES ──────────────────────────────────────────────

annotate service.CollectionImportBatches with @(
  UI.LineItem: [
    { Value: batchDate,       Label: '{i18n>date}' },
    { Value: sourceChannel,   Label: '{i18n>channel}' },
    { Value: sourceReference, Label: '{i18n>reference}' },
    { Value: recordCount,     Label: '{i18n>records}' },
    { Value: totalAmount,     Label: '{i18n>total}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'PROCESSED',   Criticality: 3 },
          { Value: 'VALID',       Criticality: 2 },
          { Value: 'PROCESSING',  Criticality: 2 },
          { Value: 'RECEIVED',    Criticality: 2 },
          { Value: 'INVALID',     Criticality: 1 },
          { Value: 'FAILED',      Criticality: 1 }
        ]
      }
    },
    { Value: processedCount,  Label: '{i18n>processed}' },
    { Value: failedCount,     Label: '{i18n>failed}' },
    { Value: suspenseCount,   Label: '{i18n>suspense}' },
  ],

  UI.SelectionFields: [ status, sourceChannel, batchDate ],

  UI.HeaderInfo: {
    TypeName: '{i18n>importBatch}', TypeNamePlural: '{i18n>importBatches}',
    Title: { Value: sourceReference }, Description: { Value: sourceChannel }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>batchDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#BatchHeader', Label: '{i18n>sectionHeader}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#BatchCounts', Label: '{i18n>sectionCounts}' },
      ]
    },
    { $Type: 'UI.ReferenceFacet', Target: 'lines/@UI.LineItem', Label: '{i18n>sectionLines}' },
  ],

  UI.FieldGroup#BatchHeader: {
    Data: [
      { Value: batchDate }, { Value: sourceChannel }, { Value: sourceReference },
      { Value: status }, { Value: totalAmount }, { Value: recordCount },
      { Value: confirmedBy, Label: '{i18n>confirmedBy}' }, { Value: confirmedAt, Label: '{i18n>confirmedAt}' },
    ]
  },

  UI.FieldGroup#BatchCounts: {
    Data: [
      { Value: processedCount }, { Value: processedAmount, Label: '{i18n>processedAmount}' },
      { Value: failedCount }, { Value: suspenseCount },
    ]
  }
);

// CollectionImportLine sub-list — GAP CLOSED
annotate service.CollectionImportLine with @(
  UI.LineItem: [
    { Value: lineSequence,       Label: '{i18n>lineNo}' },
    { Value: sourceAccountRef,   Label: '{i18n>sourceAccount}' },
    { Value: amount,             Label: '{i18n>amount}' },
    { Value: paymentDate,        Label: '{i18n>paymentDate}' },
    { Value: paymentReference,   Label: '{i18n>reference}' },
    { Value: channel,            Label: '{i18n>channel}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'PROCESSED',   Criticality: 3 },
          { Value: 'MATCHED',     Criticality: 3 },
          { Value: 'PENDING',     Criticality: 2 },
          { Value: 'UNMATCHED',   Criticality: 2 },
          { Value: 'SUSPENSE',    Criticality: 1 },
          { Value: 'REJECTED',    Criticality: 1 }
        ]
      }
    },
    { Value: rejectionReason,    Label: '{i18n>rejectionReason}' },
  ]
);

// ── SUSPENSE PAYMENTS ──────────────────────────────────────────────────────

annotate service.SuspensePayments with @(
  UI.LineItem: [
    { Value: sourceChannel,      Label: '{i18n>channel}' },
    { Value: sourceBatchRef,     Label: '{i18n>batchRef}' },
    { Value: sourceAccountRef,   Label: '{i18n>sourceAccount}' },
    { Value: amount,             Label: '{i18n>amount}' },
    { Value: paymentDate,        Label: '{i18n>paymentDate}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'RESOLVED',      Criticality: 3 },
          { Value: 'RETURNED',      Criticality: 0 },
          { Value: 'PENDING',       Criticality: 1 },
          { Value: 'UNDER_REVIEW',  Criticality: 2 }
        ]
      }
    },
    { Value: reviewedBy,         Label: '{i18n>reviewedBy}' },
  ],

  UI.SelectionFields: [ status, sourceChannel, paymentDate ],

  UI.HeaderInfo: {
    TypeName: '{i18n>suspensePayment}', TypeNamePlural: '{i18n>suspensePayments}',
    Title: { Value: paymentReference }, Description: { Value: sourceAccountRef }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>suspenseDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SuspenseSource',     Label: '{i18n>sourceInfo}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SuspenseResolution', Label: '{i18n>resolution}' },
      ]
    }
  ],

  UI.FieldGroup#SuspenseSource: {
    Data: [
      { Value: sourceChannel }, { Value: sourceBatchRef }, { Value: sourceLineRef, Label: '{i18n>lineRef}' },
      { Value: sourceAccountRef }, { Value: amount }, { Value: paymentDate }, { Value: status },
    ]
  },

  UI.FieldGroup#SuspenseResolution: {
    Data: [
      { Value: reviewedBy }, { Value: reviewedAt, Label: '{i18n>reviewedAt}' },
      { Value: resolutionNotes, Label: '{i18n>notes}' },
      { Value: resolvedAccountID, Label: '{i18n>resolvedAccount}' },
    ]
  }
);

// ── BANK STATEMENT IMPORTS ─────────────────────────────────────────────────

annotate service.BankStatementImports with @(
  UI.LineItem: [
    { Value: statementDate,          Label: '{i18n>statementDate}' },
    { Value: bankName,               Label: '{i18n>bank}' },
    { Value: accountNumberMasked,    Label: '{i18n>accountNumber}' },
    { Value: format },
    { Value: openingBalance,         Label: '{i18n>openingBalance}' },
    { Value: closingBalance,         Label: '{i18n>closingBalance}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'APPROVED',    Criticality: 3 },
          { Value: 'MATCHED',     Criticality: 3 },
          { Value: 'MATCHING',    Criticality: 2 },
          { Value: 'IMPORTED',    Criticality: 2 },
          { Value: 'UNBALANCED',  Criticality: 1 }
        ]
      }
    },
    { Value: matchedCount,           Label: '{i18n>matched}' },
    { Value: unmatchedCount,         Label: '{i18n>unmatched}' },
  ],

  UI.SelectionFields: [ status, statementDate, bankCode ],

  UI.HeaderInfo: {
    TypeName: '{i18n>bankStatement}', TypeNamePlural: '{i18n>bankStatements}',
    Title: { Value: statementDate }, Description: { Value: bankName }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>statementSummary}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#StatementHeader', Label: '{i18n>sectionHeader}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#StatementTotals', Label: '{i18n>sectionTotals}' },
      ]
    },
    { $Type: 'UI.ReferenceFacet', Target: 'lines/@UI.LineItem', Label: '{i18n>sectionLines}' },
  ],

  UI.FieldGroup#StatementHeader: {
    Data: [
      { Value: statementDate }, { Value: bankCode, Label: '{i18n>bankCode}' }, { Value: bankName },
      { Value: accountNumberMasked }, { Value: format }, { Value: status },
      { Value: reconciledBy, Label: '{i18n>reconciledBy}' }, { Value: reconciledAt, Label: '{i18n>reconciledAt}' },
    ]
  },

  UI.FieldGroup#StatementTotals: {
    Data: [
      { Value: openingBalance }, { Value: closingBalance },
      { Value: totalCredits, Label: '{i18n>totalCredits}' },
      { Value: totalDebits,  Label: '{i18n>totalDebits}' },
      { Value: matchedCount }, { Value: unmatchedCount },
    ]
  }
);

annotate service.BankStatementLines with @(
  UI.LineItem: [
    { Value: valueDate,          Label: '{i18n>valueDate}' },
    { Value: amount,             Label: '{i18n>amount}' },
    { Value: debitCreditCode,    Label: '{i18n>drCr}' },
    { Value: bankReference,      Label: '{i18n>bankRef}' },
    { Value: description },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'MATCHED',           Criticality: 3 },
          { Value: 'MANUALLY_MATCHED',  Criticality: 3 },
          { Value: 'UNMATCHED',         Criticality: 1 },
          { Value: 'EXCLUDED',          Criticality: 0 }
        ]
      }
    },
    { Value: matchConfidence,    Label: '{i18n>confidence}' },
    { Value: matchedBy,          Label: '{i18n>matchedBy}' },
  ]
);
