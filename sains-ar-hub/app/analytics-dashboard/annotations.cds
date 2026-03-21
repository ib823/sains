using AnalyticsService as service from '../../srv/analytics-service';

// ── AR KPI SNAPSHOTS ──────────────────────────────────────────────────────

annotate service.ARKPISnapshots with @(
  UI.LineItem: [
    { Value: snapshotDate,          Label: 'Date' },
    { Value: totalOpenAR,           Label: 'Open AR (RM)' },
    { Value: totalOverdueAR,        Label: 'Overdue AR (RM)' },
    { Value: dso,                   Label: 'DSO (Days)' },
    { Value: cei,                   Label: 'CEI' },
    { Value: collectionEfficiency,  Label: 'Collection Efficiency' },
    { Value: dunningL3L4Count,      Label: 'L3/L4 Accounts' },
    { Value: digitalPaymentRatio,   Label: 'Digital Payment %' },
    { Value: billingAccuracyRate,   Label: 'Billing Accuracy' },
    { Value: badDebtRatio,          Label: 'Bad Debt Ratio' },
  ],
  UI.SelectionFields: [ snapshotDate, branchCode, accountTypeCode ],
  UI.HeaderInfo: {
    TypeName: 'AR KPI Snapshot', TypeNamePlural: 'AR KPI Snapshots',
    Title: { Value: snapshotDate }, Description: { Value: branchCode }
  },
);

// ── CONSUMPTION ANOMALIES ─────────────────────────────────────────────────

annotate service.ConsumptionAnomalies with @(
  UI.LineItem: [
    { Value: account.accountNumber,  Label: 'Account' },
    { Value: account.legalName,      Label: 'Customer' },
    { Value: meterReadDate,          Label: 'Read Date' },
    { Value: actualConsumption,      Label: 'Actual (m\u00B3)' },
    { Value: expectedConsumption,    Label: 'Expected (m\u00B3)' },
    { Value: zScore,                 Label: 'Z-Score' },
    { Value: anomalyType,            Label: 'Type' },
    {
      Value: fraudProbability, Label: 'Fraud Probability',
      Criticality: {
        $Path: 'fraudProbability',
        Mapping: []
      }
    },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'OPEN',                    Criticality: 1 },
          { Value: 'UNDER_REVIEW',             Criticality: 2 },
          { Value: 'RESOLVED_LEGITIMATE',      Criticality: 3 },
          { Value: 'RESOLVED_BILLING_ERROR',   Criticality: 2 },
          { Value: 'RESOLVED_METER_FAULT',     Criticality: 2 },
          { Value: 'RESOLVED_TAMPERING',       Criticality: 1 },
          { Value: 'DISMISSED',                Criticality: 0 },
        ]
      }
    },
    { Value: billHeld, Label: 'Bill Held' },
  ],
  UI.SelectionFields: [ anomalyType, status, billHeld, meterReadDate ],
  UI.HeaderInfo: {
    TypeName: 'Consumption Anomaly', TypeNamePlural: 'Consumption Anomalies',
    Title: { Value: anomalyType }, Description: { Value: account.legalName }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Anomaly Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#AnomalyMain' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#AnomalyResolution' },
    ]}
  ],
  UI.FieldGroup#AnomalyMain: { Data: [
    { Value: meterReadDate }, { Value: actualConsumption }, { Value: expectedConsumption },
    { Value: zScore }, { Value: anomalyType }, { Value: anomalyScore, Label: 'Anomaly Score' },
    { Value: fraudProbability }, { Value: detectionMethod, Label: 'Method' },
    { Value: billHeld }, { Value: status },
  ]},
  UI.FieldGroup#AnomalyResolution: { Data: [
    { Value: reviewedBy }, { Value: reviewedAt }, { Value: resolution },
    { Value: relatedInvoiceID, Label: 'Related Invoice' },
  ]},
);

// ── SPAN KPI REPORTS ──────────────────────────────────────────────────────

annotate service.SPANKPIReports with @(
  UI.LineItem: [
    { Value: reportingYear }, { Value: reportingMonth }, { Value: reportType },
    { Value: totalConnections, Label: 'Connections' },
    { Value: totalBilled, Label: 'Billed (RM)' },
    { Value: totalCollected, Label: 'Collected (RM)' },
    { Value: collectionRatio, Label: 'Collection Ratio' },
    { Value: billingAccuracyPct, Label: 'Billing Accuracy' },
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'SUBMITTED', Criticality: 3 }, { Value: 'APPROVED',  Criticality: 3 },
          { Value: 'REVIEWED',  Criticality: 2 }, { Value: 'DRAFT',     Criticality: 2 },
          { Value: 'REJECTED',  Criticality: 1 },
        ]
      }
    },
    { Value: submittedAt, Label: 'Submitted' },
  ],
  UI.SelectionFields: [ status, reportingYear, reportType ],
  UI.HeaderInfo: {
    TypeName: 'SPAN KPI Report', TypeNamePlural: 'SPAN KPI Reports',
    Title: { Value: reportingYear }, Description: { Value: reportingMonth }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'KPI Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SPANFinancial' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SPANOperational' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SPANSubmission' },
    ]}
  ],
  UI.FieldGroup#SPANFinancial: { Data: [
    { Value: totalBilled }, { Value: totalCollected }, { Value: collectionRatio },
    { Value: outstandingDebt, Label: 'Outstanding Debt' },
    { Value: badDebtWrittenOff, Label: 'Bad Debt Written Off' }, { Value: badDebtProvision },
  ]},
  UI.FieldGroup#SPANOperational: { Data: [
    { Value: totalConnections }, { Value: estimatedReads, Label: 'Estimated Reads' },
    { Value: actualReads }, { Value: billingAccuracyPct },
    { Value: complaintsReceived }, { Value: complaintsResolved }, { Value: avgComplaintDays },
    { Value: disconnectionCount }, { Value: reconnectionCount },
  ]},
  UI.FieldGroup#SPANSubmission: { Data: [
    { Value: generatedAt }, { Value: approvedBy }, { Value: approvedAt },
    { Value: submittedAt }, { Value: submissionRef }, { Value: rejectionReason },
  ]},
);

// ── FRAUD DENSITY ZONES ───────────────────────────────────────────────────

annotate service.FraudDensityZones with @(
  UI.LineItem: [
    { Value: zoneCode }, { Value: zoneName }, { Value: calculationDate },
    { Value: totalAccounts }, { Value: anomalyFlagCount }, { Value: confirmedFraudCount },
    { Value: fraudDensityPct, Label: 'Fraud Density' },
    {
      Value: riskLevel, Label: 'Risk',
      Criticality: {
        $Path: 'riskLevel',
        Mapping: [
          { Value: 'HIGH',   Criticality: 1 },
          { Value: 'MEDIUM', Criticality: 2 },
          { Value: 'LOW',    Criticality: 3 },
        ]
      }
    },
    { Value: lastInspectionDate, Label: 'Last Inspection' },
  ],
  UI.SelectionFields: [ riskLevel, calculationDate ],
  UI.HeaderInfo: {
    TypeName: 'Fraud Density Zone', TypeNamePlural: 'Fraud Density Zones',
    Title: { Value: zoneName }, Description: { Value: riskLevel }
  },
);
