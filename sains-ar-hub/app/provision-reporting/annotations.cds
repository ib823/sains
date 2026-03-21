using ProvisionReportingService as service from '../../srv/provision-reporting-service';

annotate service.MatrixVersions with @(
  UI.LineItem: [
    { Value: versionCode }, { Value: description }, { Value: effectiveFrom }, { Value: effectiveTo },
    {
      Value: isActive, Label: 'Active',
      Criticality: { $Path: 'isActive', Mapping: [{ Value: true, Criticality: 3 }, { Value: false, Criticality: 0 }] }
    },
    { Value: approvedBy }, { Value: auditFirmConfirmed, Label: 'Auditor Confirmed' },
    { Value: auditConfirmedBy, Label: 'Confirmed By' },
  ],
  UI.SelectionFields: [ isActive, effectiveFrom ],
  UI.HeaderInfo: {
    TypeName: 'Provision Matrix Version', TypeNamePlural: 'Provision Matrix Versions',
    Title: { Value: versionCode }, Description: { Value: description }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Matrix Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#MatrixMain' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#MatrixAudit' },
    ]},
    { $Type: 'UI.ReferenceFacet', Target: 'rates/@UI.LineItem', Label: 'Provision Rates' },
  ],
  UI.FieldGroup#MatrixMain: { Data: [
    { Value: versionCode }, { Value: description }, { Value: isActive },
    { Value: effectiveFrom }, { Value: effectiveTo },
    { Value: approvedBy }, { Value: approvedAt }, { Value: approvalNotes },
  ]},
  UI.FieldGroup#MatrixAudit: { Data: [
    { Value: auditFirmConfirmed }, { Value: auditConfirmedBy },
    { Value: auditConfirmedAt }, { Value: auditConfirmationRef },
  ]},
);

annotate service.ProvisionRates with @UI.LineItem: [
  { Value: accountTypeCode, Label: 'Account Type' },
  { Value: agingBucket, Label: 'Aging Bucket' },
  { Value: provisionRatePct, Label: 'Rate (%)' },
  { Value: historicalLossRate, Label: 'Historical Rate (%)' },
  { Value: forwardLookingAdj, Label: 'Forward-Looking Adj' },
  { Value: rationale },
  { Value: minRate }, { Value: maxRate },
];

annotate service.ECLCalculationRuns with @(
  UI.LineItem: [
    { Value: periodYear }, { Value: periodMonth }, { Value: runDate },
    { Value: runType }, { Value: totalOpenAR, Label: 'Open AR (RM)' },
    { Value: totalProvisionRequired, Label: 'Provision Required (RM)' },
    { Value: netMovement, Label: 'Net Movement (RM)' },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'GL_POSTED',  Criticality: 3 },
          { Value: 'APPROVED',   Criticality: 3 },
          { Value: 'COMPLETED',  Criticality: 2 },
          { Value: 'RUNNING',    Criticality: 2 },
          { Value: 'ERROR',      Criticality: 1 },
        ]
      }
    },
    { Value: approvedBy }, { Value: approvedAt },
  ],
  UI.SelectionFields: [ status, periodYear, periodMonth, runType ],
  UI.HeaderInfo: {
    TypeName: 'ECL Calculation Run', TypeNamePlural: 'ECL Calculation Runs',
    Title: { Value: periodYear }, Description: { Value: periodMonth }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Run Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#RunMain' },
    ]},
    { $Type: 'UI.ReferenceFacet', Target: 'segments/@UI.LineItem', Label: 'Segment Results' },
  ],
  UI.FieldGroup#RunMain: { Data: [
    { Value: periodYear }, { Value: periodMonth }, { Value: runDate }, { Value: runType },
    { Value: totalOpenAR }, { Value: totalProvisionRequired }, { Value: priorPeriodProvision },
    { Value: netMovement }, { Value: status }, { Value: runDurationSeconds, Label: 'Duration (s)' },
    { Value: approvedBy }, { Value: approvedAt }, { Value: glBatchID, Label: 'GL Batch' },
    { Value: errorMessage },
  ]},
);

annotate service.ECLSegmentResults with @UI.LineItem: [
  { Value: accountTypeCode }, { Value: agingBucket }, { Value: accountCount, Label: 'Accounts' },
  { Value: openARAmount, Label: 'Open AR (RM)' }, { Value: provisionRatePct, Label: 'Rate' },
  { Value: provisionAmount, Label: 'Provision (RM)' },
  { Value: priorPeriodAmount, Label: 'Prior Period' }, { Value: movement, Label: 'Movement' },
  { Value: macroAdjFactor, Label: 'Macro Adj' },
];

annotate service.ForwardLookingFactors with @(
  UI.LineItem: [
    { Value: periodYear }, { Value: periodMonth }, { Value: dataSource },
    { Value: gdpGrowthPct }, { Value: unemploymentPct }, { Value: cpiPct },
    { Value: economicOutlook }, { Value: macroAdjFactor },
  ],
  UI.SelectionFields: [ periodYear, economicOutlook ],
  UI.HeaderInfo: {
    TypeName: 'Forward-Looking Factor', TypeNamePlural: 'Forward-Looking Factors',
    Title: { Value: periodYear }, Description: { Value: economicOutlook }
  },
);

annotate service.AuditorConfirmationLetters with @(
  UI.LineItem: [
    { Value: auditYear }, { Value: letterDate }, { Value: accountNumber },
    { Value: legalName }, { Value: confirmedBalance, Label: 'Confirmed Balance' },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'CONFIRMED',   Criticality: 3 }, { Value: 'SENT',        Criticality: 2 },
          { Value: 'DISPUTED',    Criticality: 1 }, { Value: 'NO_RESPONSE', Criticality: 1 },
        ]
      }
    },
    { Value: responseBalance, Label: 'Response Balance' },
    { Value: responseDifference, Label: 'Difference' },
  ],
  UI.SelectionFields: [ status, auditYear ],
  UI.HeaderInfo: {
    TypeName: 'Auditor Confirmation', TypeNamePlural: 'Auditor Confirmations',
    Title: { Value: accountNumber }, Description: { Value: legalName }
  },
);
