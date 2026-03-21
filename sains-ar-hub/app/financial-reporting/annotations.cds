using ReportingService as service from '../../srv/reporting-service';

// ── BAD DEBT PROVISION — GAP CLOSED ───────────────────────────────────────

annotate service.BadDebtProvisions with @(
  UI.LineItem: [
    { Value: periodYear,      Label: '{i18n>year}' },
    { Value: periodMonth,     Label: '{i18n>month}' },
    { Value: accountType,     Label: '{i18n>accountType}' },
    { Value: agingBucket,     Label: '{i18n>agingBucket}' },
    { Value: openARAmount,    Label: '{i18n>openAR}' },
    { Value: provisionRate,   Label: '{i18n>rate}' },
    { Value: provisionAmount, Label: '{i18n>provision}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'POSTED',      Criticality: 3 },
          { Value: 'APPROVED',    Criticality: 2 },
          { Value: 'CALCULATED',  Criticality: 2 },
          { Value: 'REVERSED',    Criticality: 0 }
        ]
      }
    },
    { Value: approvedBy,      Label: '{i18n>approvedBy}' },
    { Value: glPostingRef,    Label: '{i18n>glRef}' },
  ],

  UI.SelectionFields: [ periodYear, periodMonth, accountType, agingBucket, status ],

  UI.HeaderInfo: {
    TypeName: '{i18n>provision}', TypeNamePlural: '{i18n>provisions}',
    Title: { Value: agingBucket }, Description: { Value: accountType }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>provisionDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#ProvisionMain',     Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#ProvisionPosting',  Label: '{i18n>sectionPosting}' },
      ]
    }
  ],

  UI.FieldGroup#ProvisionMain: {
    Data: [
      { Value: periodYear }, { Value: periodMonth }, { Value: accountType }, { Value: agingBucket },
      { Value: openARAmount }, { Value: provisionRate }, { Value: provisionAmount }, { Value: status },
    ]
  },

  UI.FieldGroup#ProvisionPosting: {
    Data: [
      { Value: approvedBy }, { Value: glPostingRef },
    ]
  }
);

// ── PERIOD CLOSE CHECKLIST — GAP CLOSED ───────────────────────────────────

annotate service.PeriodCloseChecklists with @(
  UI.LineItem: [
    { Value: periodYear,    Label: '{i18n>year}' },
    { Value: periodMonth,   Label: '{i18n>month}' },
    { Value: isYearEnd,     Label: '{i18n>yearEnd}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'CLOSED',       Criticality: 3 },
          { Value: 'APPROVED',     Criticality: 3 },
          { Value: 'COMPLETED',    Criticality: 2 },
          { Value: 'IN_PROGRESS',  Criticality: 2 }
        ]
      }
    },
    { Value: signedOffBy,   Label: '{i18n>signedOffBy}' },
    { Value: signedOffAt,   Label: '{i18n>signedOffAt}' },
  ],

  UI.SelectionFields: [ periodYear, periodMonth, status ],

  UI.HeaderInfo: {
    TypeName: '{i18n>periodClose}', TypeNamePlural: '{i18n>periodCloses}',
    Title: { Value: periodYear }, Description: { Value: periodMonth }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>checklistDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#ChecklistHeader', Label: '{i18n>sectionHeader}' },
      ]
    },
    { $Type: 'UI.ReferenceFacet', Target: 'steps/@UI.LineItem', Label: '{i18n>sectionSteps}' },
  ],

  UI.FieldGroup#ChecklistHeader: {
    Data: [
      { Value: periodYear }, { Value: periodMonth }, { Value: isYearEnd },
      { Value: status }, { Value: signedOffBy }, { Value: signedOffAt },
    ]
  }
);

// PeriodCloseStep sub-list — GAP CLOSED
annotate service.PeriodCloseSteps with @(
  UI.LineItem: [
    { Value: stepCode,           Label: '{i18n>step}' },
    { Value: stepName,           Label: '{i18n>description}' },
    { Value: dueByBusinessDay,   Label: '{i18n>dueDay}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'COMPLETED',             Criticality: 3 },
          { Value: 'IN_PROGRESS',           Criticality: 2 },
          { Value: 'PENDING',               Criticality: 2 },
          { Value: 'FAILED',                Criticality: 1 },
          { Value: 'SKIPPED_WITH_REASON',   Criticality: 0 }
        ]
      }
    },
    { Value: completedBy,        Label: '{i18n>completedBy}' },
    { Value: completedAt,        Label: '{i18n>completedAt}' },
    { Value: reviewedBy,         Label: '{i18n>reviewedBy}' },
    { Value: skipReason,         Label: '{i18n>skipReason}' },
  ]
);

// ── RECONCILIATION RECORDS ────────────────────────────────────────────────

annotate service.ReconciliationRecords with @(
  UI.LineItem: [
    { Value: reconciliationType,  Label: '{i18n>type}' },
    { Value: reconciliationDate,  Label: '{i18n>date}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'APPROVED',     Criticality: 3 },
          { Value: 'BALANCED',     Criticality: 3 },
          { Value: 'IN_PROGRESS',  Criticality: 2 },
          { Value: 'UNBALANCED',   Criticality: 1 },
          { Value: 'ESCALATED',    Criticality: 1 }
        ]
      }
    },
    { Value: systemBalance,       Label: '{i18n>systemBalance}' },
    { Value: externalBalance,     Label: '{i18n>externalBalance}' },
    { Value: difference,          Label: '{i18n>difference}' },
    { Value: withinTolerance,     Label: '{i18n>inTolerance}' },
    { Value: performedBy,         Label: '{i18n>performedBy}' },
    { Value: reviewedBy,          Label: '{i18n>reviewedBy}' },
  ],

  UI.SelectionFields: [ reconciliationType, status, reconciliationDate ],

  UI.HeaderInfo: {
    TypeName: '{i18n>reconciliation}', TypeNamePlural: '{i18n>reconciliations}',
    Title: { Value: reconciliationType }, Description: { Value: reconciliationDate }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>reconciliationDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#ReconMain',    Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#ReconSignOff', Label: '{i18n>sectionSignOff}' },
      ]
    }
  ],

  UI.FieldGroup#ReconMain: {
    Data: [
      { Value: reconciliationType }, { Value: reconciliationDate },
      { Value: status }, { Value: systemBalance }, { Value: externalBalance },
      { Value: difference }, { Value: withinTolerance }, { Value: toleranceAmount, Label: '{i18n>tolerance}' },
      { Value: notes, Label: '{i18n>notes}' },
    ]
  },

  UI.FieldGroup#ReconSignOff: {
    Data: [
      { Value: performedBy }, { Value: reviewedBy }, { Value: reviewedAt, Label: '{i18n>reviewedAt}' },
    ]
  }
);

// ── AUDIT TRAIL ───────────────────────────────────────────────────────────

annotate service.AuditTrail with @(
  UI.LineItem: [
    { Value: timestamp },
    { Value: userID,      Label: '{i18n>user}' },
    { Value: userRole,    Label: '{i18n>role}' },
    { Value: actionType,  Label: '{i18n>action}' },
    { Value: entityType,  Label: '{i18n>entity}' },
    { Value: sourceSystem,Label: '{i18n>source}' },
    { Value: ipAddress,   Label: '{i18n>ipAddress}' },
  ],
  UI.SelectionFields: [
    userID, actionType, entityType, sourceSystem, timestamp
  ]
);
