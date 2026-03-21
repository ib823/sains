using PaymentInnovationService as service from '../../srv/payment-innovation-service';

// ── PAYMENT ORCHESTRATOR EVENTS ────────────────────────────────────────────

annotate service.PaymentEvents with @(
  UI.LineItem: [
    { Value: transactionDate,    Label: 'Date' },
    { Value: sourceChannel,      Label: 'Channel' },
    { Value: payerReference,     Label: 'Payer Reference' },
    { Value: amount,             Label: 'Amount (RM)' },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'RESOLVED',   Criticality: 3 },
          { Value: 'PROCESSED',  Criticality: 3 },
          { Value: 'RECEIVED',   Criticality: 2 },
          { Value: 'RESOLVING',  Criticality: 2 },
          { Value: 'SUSPENSE',   Criticality: 1 },
          { Value: 'REJECTED',   Criticality: 1 },
          { Value: 'DUPLICATE',  Criticality: 0 },
        ]
      }
    },
    { Value: rawReference,       Label: 'Source Ref' },
    { Value: processingError,    Label: 'Error' },
  ],
  UI.SelectionFields: [ status, sourceChannel, transactionDate ],
  UI.HeaderInfo: {
    TypeName: 'Payment Event', TypeNamePlural: 'Payment Events',
    Title: { Value: rawReference }, Description: { Value: sourceChannel }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Event Details',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#EventMain' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#EventResolution' },
      ]
    }
  ],
  UI.FieldGroup#EventMain: { Data: [
    { Value: sourceChannel }, { Value: rawReference }, { Value: payerReference },
    { Value: amount }, { Value: transactionDate }, { Value: valueDate, Label: 'Value Date' },
    { Value: batchID, Label: 'Batch ID' }, { Value: status },
  ]},
  UI.FieldGroup#EventResolution: { Data: [
    { Value: resolvedAccountID, Label: 'Resolved Account' },
    { Value: paymentID, Label: 'Payment ID' },
    { Value: processorUser, Label: 'Processed By' },
    { Value: processorNotes, Label: 'Notes' },
    { Value: processingError, Label: 'Error' },
  ]},
);

// ── JOMPAY BATCHES ─────────────────────────────────────────────────────────

annotate service.JomPAYBatches with @(
  UI.LineItem: [
    { Value: batchDate }, { Value: billerCode }, { Value: bankName },
    { Value: totalTransactions, Label: 'Transactions' },
    { Value: totalAmount, Label: 'Total (RM)' },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'RECONCILED', Criticality: 3 },
          { Value: 'PROCESSED',  Criticality: 2 },
          { Value: 'PROCESSING', Criticality: 2 },
          { Value: 'UPLOADED',   Criticality: 2 },
          { Value: 'FAILED',     Criticality: 1 },
        ]
      }
    },
    { Value: processingErrors, Label: 'Errors' },
  ],
  UI.SelectionFields: [ status, batchDate ],
  UI.HeaderInfo: {
    TypeName: 'JomPAY Batch', TypeNamePlural: 'JomPAY Batches',
    Title: { Value: batchDate }, Description: { Value: bankName }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Batch Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#JomPAYHeader' },
    ]},
    { $Type: 'UI.ReferenceFacet', Target: 'lines/@UI.LineItem', Label: 'Lines' },
  ],
  UI.FieldGroup#JomPAYHeader: { Data: [
    { Value: batchDate }, { Value: billerCode }, { Value: bankCode },
    { Value: bankName }, { Value: totalTransactions }, { Value: totalAmount },
    { Value: status }, { Value: processingErrors }, { Value: sourceFileName, Label: 'File' },
    { Value: uploadedBy }, { Value: uploadedAt }, { Value: reconciledBy }, { Value: reconciledAt },
  ]},
);

annotate service.JomPAYLines with @UI.LineItem: [
  { Value: lineSequence, Label: '#' }, { Value: transactionDate, Label: 'Date' },
  { Value: billRefNo, Label: 'Bill Ref' }, { Value: payerName, Label: 'Payer' },
  { Value: payerBank, Label: 'Bank' }, { Value: amount, Label: 'Amount (RM)' },
  { Value: jomPayRef, Label: 'JomPAY Ref' },
  {
    Value: status, Label: 'Status',
    Criticality: {
      $Path: 'status',
      Mapping: [
        { Value: 'MATCHED',  Criticality: 3 }, { Value: 'PENDING',   Criticality: 2 },
        { Value: 'SUSPENSE', Criticality: 1 }, { Value: 'REJECTED',  Criticality: 1 },
        { Value: 'DUPLICATE',Criticality: 0 },
      ]
    }
  },
  { Value: rejectionReason, Label: 'Reason' },
];

// ── EMANDATE ───────────────────────────────────────────────────────────────

annotate service.eMandates with @(
  UI.LineItem: [
    { Value: account.accountNumber, Label: 'Account' },
    { Value: account.legalName, Label: 'Customer' },
    { Value: bankCode }, { Value: bankAccountName, Label: 'Account Holder' },
    { Value: maxAmountPerDebit, Label: 'Max Debit (RM)' }, { Value: frequency },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'ACTIVE',     Criticality: 3 },
          { Value: 'PENDING',    Criticality: 2 },
          { Value: 'SUSPENDED',  Criticality: 1 },
          { Value: 'CANCELLED',  Criticality: 0 },
          { Value: 'REJECTED',   Criticality: 1 },
          { Value: 'EXPIRED',    Criticality: 0 },
        ]
      }
    },
    { Value: consecutiveFailures, Label: 'Failures' },
    { Value: lastDebitDate, Label: 'Last Debit' },
    { Value: lastDebitStatus, Label: 'Last Status' },
  ],
  UI.SelectionFields: [ status, bankCode, frequency ],
  UI.HeaderInfo: {
    TypeName: 'eMandate', TypeNamePlural: 'eMandates',
    Title: { Value: mandateRef }, Description: { Value: account.legalName }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Mandate Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#MandateMain' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#MandateHistory' },
    ]},
    { $Type: 'UI.ReferenceFacet', Target: 'eMandateDebitRuns/@UI.LineItem', Label: 'Debit History' },
  ],
  UI.FieldGroup#MandateMain: { Data: [
    { Value: mandateID, Label: 'PayNet Mandate ID' }, { Value: mandateRef, Label: 'SAINS Ref' },
    { Value: bankCode }, { Value: bankAccountName }, { Value: maxAmountPerDebit },
    { Value: frequency }, { Value: effectiveDate }, { Value: expiryDate },
    { Value: status }, { Value: registrationMethod }, { Value: registeredAt },
    { Value: totalDebitsRun, Label: 'Total Debits' }, { Value: totalAmountDebited, Label: 'Total Debited' },
  ]},
  UI.FieldGroup#MandateHistory: { Data: [
    { Value: lastDebitDate }, { Value: lastDebitAmount }, { Value: lastDebitStatus },
    { Value: consecutiveFailures }, { Value: suspensionReason }, { Value: cancellationReason },
  ]},
);
