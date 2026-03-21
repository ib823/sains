using EInvoiceExcellenceService as service from '../../srv/einvoice-excellence-service';

annotate service.SubmissionBatches with @(
  UI.LineItem: [
    { Value: batchDate }, { Value: invoiceType },
    { Value: documentCount, Label: 'Documents' },
    { Value: acceptedCount, Label: 'Accepted' },
    { Value: rejectedCount, Label: 'Rejected' },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'FULLY_ACCEPTED',      Criticality: 3 },
          { Value: 'PARTIALLY_ACCEPTED',  Criticality: 2 },
          { Value: 'SUBMITTED',           Criticality: 2 },
          { Value: 'PREPARING',           Criticality: 2 },
          { Value: 'REJECTED',            Criticality: 1 },
          { Value: 'FAILED',              Criticality: 1 },
        ]
      }
    },
    { Value: lhdnSubmissionUID, Label: 'LHDN Submission UID' },
    { Value: submittedAt },
    { Value: retryCount, Label: 'Retries' },
  ],
  UI.SelectionFields: [ status, invoiceType, batchDate ],
  UI.HeaderInfo: {
    TypeName: 'Submission Batch', TypeNamePlural: 'Submission Batches',
    Title: { Value: lhdnSubmissionUID }, Description: { Value: invoiceType }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Batch Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#BatchMain' },
    ]},
    { $Type: 'UI.ReferenceFacet', Target: 'lines/@UI.LineItem', Label: 'Submission Lines' },
  ],
  UI.FieldGroup#BatchMain: { Data: [
    { Value: batchDate }, { Value: invoiceType }, { Value: documentCount },
    { Value: status }, { Value: lhdnSubmissionUID }, { Value: submittedAt },
    { Value: acceptedCount }, { Value: rejectedCount }, { Value: retryCount },
  ]},
);

annotate service.SubmissionLines with @UI.LineItem: [
  { Value: lineSequence, Label: '#' },
  { Value: invoiceNumber, Label: 'Invoice' },
  { Value: buyerName, Label: 'Buyer' },
  { Value: totalIncludingTax, Label: 'Total (RM)' },
  {
    Value: status, Label: 'Status',
    Criticality: {
      $Path: 'status',
      Mapping: [
        { Value: 'ACCEPTED',   Criticality: 3 }, { Value: 'PENDING',   Criticality: 2 },
        { Value: 'REJECTED',   Criticality: 1 }, { Value: 'CANCELLED', Criticality: 0 },
        { Value: 'INVALID',    Criticality: 1 },
      ]
    }
  },
  { Value: lhdnUUID, Label: 'LHDN UUID' },
  { Value: cancelDeadline, Label: 'Cancel Deadline' },
];

annotate service.ConsolidatedBatches with @(
  UI.LineItem: [
    { Value: periodYear }, { Value: periodMonth },
    { Value: totalTransactions, Label: 'Transactions' },
    { Value: totalAmount, Label: 'Total (RM)' },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'ACCEPTED',  Criticality: 3 }, { Value: 'READY',    Criticality: 2 },
          { Value: 'PREPARING', Criticality: 2 }, { Value: 'REJECTED', Criticality: 1 },
        ]
      }
    },
    { Value: submissionDeadline, Label: 'Deadline' },
    { Value: lhdnUUID, Label: 'LHDN UUID' },
  ],
  UI.SelectionFields: [ status, periodYear, periodMonth ],
  UI.HeaderInfo: {
    TypeName: 'Consolidated B2C Batch', TypeNamePlural: 'Consolidated B2C Batches',
    Title: { Value: periodYear }, Description: { Value: periodMonth }
  },
);

annotate service.DigitalCertificates with @(
  UI.LineItem: [
    { Value: serialNumber }, { Value: issuedTo }, { Value: notBefore }, { Value: notAfter },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'ACTIVE',  Criticality: 3 }, { Value: 'PENDING',  Criticality: 2 },
          { Value: 'EXPIRED', Criticality: 1 }, { Value: 'REVOKED',  Criticality: 1 },
        ]
      }
    },
  ],
);
