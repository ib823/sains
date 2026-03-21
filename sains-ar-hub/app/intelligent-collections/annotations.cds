using IntelligentCollectionsService as service from '../../srv/intelligent-collections-service';

// ── CUSTOMER SEGMENTS ─────────────────────────────────────────────────────

annotate service.CustomerSegments with @(
  UI.LineItem: [
    { Value: account.accountNumber, Label: 'Account' },
    { Value: account.legalName, Label: 'Customer' },
    {
      Value: segmentCode, Label: 'Segment',
      Criticality: {
        $Path: 'segmentCode',
        Mapping: [
          { Value: 'LOW_RISK',    Criticality: 3 },
          { Value: 'MEDIUM_RISK', Criticality: 2 },
          { Value: 'HIGH_RISK',   Criticality: 1 },
          { Value: 'VULNERABLE',  Criticality: 1 },
          { Value: 'GOVT_EXEMPT', Criticality: 0 },
        ]
      }
    },
    { Value: dunningPathCode, Label: 'Dunning Path' },
    { Value: propensityScore, Label: 'Propensity' },
    { Value: riskScore, Label: 'Risk' },
    { Value: paymentBehaviourCode, Label: 'Behaviour' },
    { Value: daysToPay_avg90, Label: 'Avg Days Pay (90d)' },
    { Value: scoreDate, Label: 'Scored' },
    { Value: expiresAt, Label: 'Rescore Date' },
  ],
  UI.SelectionFields: [ segmentCode, dunningPathCode, vulnerabilityFlag, scoreDate ],
  UI.HeaderInfo: {
    TypeName: 'Customer Segment', TypeNamePlural: 'Customer Segments',
    Title: { Value: segmentCode }, Description: { Value: account.legalName }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Segment Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SegmentScores' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SegmentBehaviour' },
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#SegmentOverride' },
    ]}
  ],
  UI.FieldGroup#SegmentScores: { Data: [
    { Value: segmentCode }, { Value: dunningPathCode },
    { Value: propensityScore }, { Value: riskScore },
    { Value: scoreDate }, { Value: expiresAt }, { Value: modelVersion },
  ]},
  UI.FieldGroup#SegmentBehaviour: { Data: [
    { Value: paymentBehaviourCode }, { Value: daysToPay_avg90 }, { Value: daysToPay_avg365 },
    { Value: paymentChannelPref }, { Value: ptpComplianceRate }, { Value: affordabilityRating },
    { Value: vulnerabilityFlag }, { Value: vulnerabilityCategory },
  ]},
  UI.FieldGroup#SegmentOverride: { Data: [
    { Value: overrideBy }, { Value: overrideReason },
  ]},
);

// ── VULNERABILITY RECORDS ─────────────────────────────────────────────────

annotate service.VulnerabilityRecords with @(
  UI.LineItem: [
    { Value: account.accountNumber, Label: 'Account' },
    { Value: account.legalName, Label: 'Customer' },
    { Value: category, Label: 'Category' },
    {
      Value: severity, Label: 'Severity',
      Criticality: {
        $Path: 'severity',
        Mapping: [
          { Value: 'CRITICAL', Criticality: 1 },
          { Value: 'HIGH',     Criticality: 1 },
          { Value: 'MEDIUM',   Criticality: 2 },
          { Value: 'LOW',      Criticality: 2 },
        ]
      }
    },
    { Value: isActive, Label: 'Active' },
    { Value: reviewDate, Label: 'Review Date' },
    { Value: registeredBy, Label: 'Registered By' },
    { Value: registeredAt, Label: 'Registered At' },
  ],
  UI.SelectionFields: [ category, severity, isActive ],
  UI.HeaderInfo: {
    TypeName: 'Vulnerability Record', TypeNamePlural: 'Vulnerability Records',
    Title: { Value: category }, Description: { Value: account.legalName }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Vulnerability Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#VulnMain' },
    ]}
  ],
  UI.FieldGroup#VulnMain: { Data: [
    { Value: category }, { Value: severity }, { Value: isActive },
    { Value: verificationDocument, Label: 'Document Ref' },
    { Value: registeredBy }, { Value: registeredAt }, { Value: reviewDate },
    { Value: deactivatedAt, Label: 'Deactivated At' }, { Value: deactivationReason, Label: 'Deactivation Reason' },
  ]},
);

// ── EARLY INTERVENTION ALERTS ─────────────────────────────────────────────

annotate service.EarlyInterventionAlerts with @(
  UI.LineItem: [
    { Value: account.accountNumber, Label: 'Account' },
    { Value: account.legalName, Label: 'Customer' },
    { Value: alertType, Label: 'Alert Type' },
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
    {
      Value: status, Label: 'Status',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'RESOLVED',  Criticality: 3 },
          { Value: 'ACTIONED',  Criticality: 2 },
          { Value: 'OPEN',      Criticality: 1 },
          { Value: 'DISMISSED', Criticality: 0 },
        ]
      }
    },
    { Value: alertDate, Label: 'Detected' },
    { Value: assignedTo, Label: 'Assigned To' },
  ],
  UI.SelectionFields: [ riskLevel, status, alertType, alertDate ],
  UI.HeaderInfo: {
    TypeName: 'Early Intervention Alert', TypeNamePlural: 'Early Intervention Alerts',
    Title: { Value: alertType }, Description: { Value: account.legalName }
  },
  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: 'Alert Details', Facets: [
      { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#AlertMain' },
    ]}
  ],
  UI.FieldGroup#AlertMain: { Data: [
    { Value: alertType }, { Value: riskLevel }, { Value: alertDate }, { Value: status },
    { Value: signalDescription, Label: 'Signal Description' },
    { Value: assignedTo }, { Value: actionTaken }, { Value: actionDate }, { Value: resolvedAt },
  ]},
);
