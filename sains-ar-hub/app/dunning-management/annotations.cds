using ARService as service from '../../srv/ar-service';

// ── CUSTOMER ACCOUNTS — DUNNING LIST VIEW ─────────────────────────────────

annotate service.CustomerAccounts with @(
  UI.LineItem #dunning: [
    { Value: accountNumber,          Label: '{i18n>accountNumber}' },
    { Value: legalName,              Label: '{i18n>customerName}' },
    {
      Value: dunningLevel, Label: '{i18n>dunningLevel}',
      Criticality: {
        $Path: 'dunningLevel',
        Mapping: [
          { Value: 0, Criticality: 3 },
          { Value: 1, Criticality: 2 },
          { Value: 2, Criticality: 2 },
          { Value: 3, Criticality: 1 },
          { Value: 4, Criticality: 1 }
        ]
      }
    },
    { Value: dunningLevelDate,       Label: '{i18n>dunningLevelDate}' },
    { Value: balanceOutstanding,     Label: '{i18n>balanceOutstanding}', @UI.Importance: #High },
    { Value: accountType.name,       Label: '{i18n>accountType}' },
    { Value: branchCode,             Label: '{i18n>branch}' },
    { Value: isDisputed,             Label: '{i18n>disputed}' },
    { Value: isPaymentPlan,          Label: '{i18n>paymentPlan}' },
    { Value: isHardship,             Label: '{i18n>hardship}' },
    { Value: isLegalAction,          Label: '{i18n>legal}' },
  ],

  UI.SelectionFields #dunning: [
    dunningLevel, accountType_code, branchCode,
    isDisputed, isPaymentPlan, isHardship,
    isLegalAction, accountStatus
  ]
);

// ── DUNNING HISTORY — GAP CLOSED ──────────────────────────────────────────

annotate service.DunningHistories with @(
  UI.LineItem: [
    { Value: account.accountNumber,  Label: '{i18n>accountNumber}' },
    { Value: account.legalName,      Label: '{i18n>customerName}' },
    { Value: dunningLevel,           Label: '{i18n>dunningLevel}' },
    { Value: triggeredDate,          Label: '{i18n>triggeredDate}' },
    { Value: noticeType,             Label: '{i18n>noticeType}' },
    { Value: overdueDays,            Label: '{i18n>overdueDays}' },
    { Value: overdueAmount,          Label: '{i18n>overdueAmount}' },
    { Value: emailSentAt,            Label: '{i18n>emailSent}' },
    { Value: smsSentAt,              Label: '{i18n>smsSent}' },
    { Value: postalDispatchedAt,     Label: '{i18n>postalDispatched}' },
    { Value: resolvedAt,             Label: '{i18n>resolvedAt}' },
    { Value: resolutionType,         Label: '{i18n>resolution}' },
  ],

  UI.SelectionFields: [
    dunningLevel, noticeType, triggeredDate, account_ID
  ],

  UI.HeaderInfo: {
    TypeName: '{i18n>dunningHistory}', TypeNamePlural: '{i18n>dunningHistories}',
    Title: { Value: noticeType }, Description: { Value: triggeredDate }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>dunningDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#DunningMain',     Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#DunningDelivery', Label: '{i18n>sectionDelivery}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#DunningOutcome',  Label: '{i18n>sectionOutcome}' },
      ]
    }
  ],

  UI.FieldGroup#DunningMain: {
    Data: [
      { Value: dunningLevel }, { Value: triggeredDate }, { Value: noticeType },
      { Value: overdueDays },  { Value: overdueAmount },
    ]
  },

  UI.FieldGroup#DunningDelivery: {
    Data: [
      { Value: emailSentAt },  { Value: emailDelivered, Label: '{i18n>delivered}' },
      { Value: emailBounced,   Label: '{i18n>bounced}' },
      { Value: smsSentAt },    { Value: smsDelivered,   Label: '{i18n>delivered}' },
      { Value: postalDispatchedAt }, { Value: postalReference, Label: '{i18n>postalRef}' },
      { Value: postalReturnedAt,   Label: '{i18n>postalReturned}' },
    ]
  },

  UI.FieldGroup#DunningOutcome: {
    Data: [
      { Value: resolvedAt }, { Value: resolutionType },
    ]
  }
);

// ── PROMISE TO PAY ────────────────────────────────────────────────────────

annotate service.PromisesToPay with @(
  UI.LineItem: [
    { Value: account.accountNumber,   Label: '{i18n>accountNumber}' },
    { Value: account.legalName,       Label: '{i18n>customerName}' },
    { Value: promisedDate,            Label: '{i18n>promisedBy}' },
    { Value: promisedAmount,          Label: '{i18n>promisedAmount}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'HONOURED',   Criticality: 3 },
          { Value: 'ACTIVE',     Criticality: 2 },
          { Value: 'BROKEN',     Criticality: 1 },
          { Value: 'EXPIRED',    Criticality: 0 },
          { Value: 'SUPERSEDED', Criticality: 0 }
        ]
      }
    },
    { Value: channel },
    { Value: recordedBy,              Label: '{i18n>recordedBy}' },
    { Value: countThisYear,           Label: '{i18n>ptpCount}' },
    { Value: requiresEscalation,      Label: '{i18n>escalationRequired}' },
  ],

  UI.SelectionFields: [ status, channel, account_ID ],

  UI.HeaderInfo: {
    TypeName: '{i18n>ptp}', TypeNamePlural: '{i18n>ptps}',
    Title: { Value: promisedDate }, Description: { Value: account.legalName }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>ptpDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#PTPMain',        Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#PTPEscalation',  Label: '{i18n>sectionEscalation}' },
      ]
    }
  ],

  UI.FieldGroup#PTPMain: {
    Data: [
      { Value: promisedDate }, { Value: promisedAmount }, { Value: status }, { Value: channel },
      { Value: notes,             Label: '{i18n>notes}' },
      { Value: recordedBy },      { Value: dunningLevelAtPTP, Label: '{i18n>dunningAtPTP}' },
      { Value: countThisYear },   { Value: resolvedAt, Label: '{i18n>resolvedAt}' },
    ]
  },

  UI.FieldGroup#PTPEscalation: {
    Data: [
      { Value: requiresEscalation },
      { Value: escalationApprovedBy, Label: '{i18n>escalationApprovedBy}' },
    ]
  }
);

// ── PAYMENT PLANS ─────────────────────────────────────────────────────────

annotate service.PaymentPlans with @(
  UI.LineItem: [
    { Value: account.accountNumber,   Label: '{i18n>accountNumber}' },
    { Value: account.legalName,       Label: '{i18n>customerName}' },
    {
      Value: planStatus, Label: '{i18n>planStatus}',
      Criticality: {
        $Path: 'planStatus',
        Mapping: [
          { Value: 'ACTIVE',            Criticality: 2 },
          { Value: 'COMPLETED',         Criticality: 3 },
          { Value: 'VOIDED',            Criticality: 0 },
          { Value: 'BREACHED',          Criticality: 1 },
          { Value: 'PENDING_APPROVAL',  Criticality: 2 }
        ]
      }
    },
    { Value: outstandingAtStart,      Label: '{i18n>openingBalance}' },
    { Value: totalInstalments,        Label: '{i18n>instalments}' },
    { Value: instalmentAmount,        Label: '{i18n>instalmentAmount}' },
    { Value: startDate },
    { Value: endDate },
    { Value: breachCount,             Label: '{i18n>breaches}' },
    { Value: approvedBy,              Label: '{i18n>approvedBy}' },
  ],

  UI.SelectionFields: [ planStatus, account_ID, startDate ],

  UI.HeaderInfo: {
    TypeName: '{i18n>paymentPlan}', TypeNamePlural: '{i18n>paymentPlans}',
    Title: { Value: planStatus }, Description: { Value: account.legalName }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>planDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#PlanMain',    Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#PlanVoid',    Label: '{i18n>sectionVoid}' },
      ]
    },
    { $Type: 'UI.ReferenceFacet', Target: 'instalments/@UI.LineItem', Label: '{i18n>sectionInstalments}' },
  ],

  UI.FieldGroup#PlanMain: {
    Data: [
      { Value: planStatus }, { Value: outstandingAtStart },
      { Value: totalInstalments }, { Value: instalmentAmount },
      { Value: startDate }, { Value: endDate },
      { Value: approvedBy }, { Value: approvalDate, Label: '{i18n>approvalDate}' },
      { Value: breachCount }, { Value: completedAt, Label: '{i18n>completedAt}' },
    ]
  },

  UI.FieldGroup#PlanVoid: {
    Data: [
      { Value: voidedAt,     Label: '{i18n>voidedAt}' },
      { Value: voidedReason, Label: '{i18n>voidedReason}' },
    ]
  }
);

// PaymentPlanInstalment sub-list — GAP CLOSED
annotate service.PaymentPlanInstalments with @(
  UI.LineItem: [
    { Value: instalmentNumber,  Label: '{i18n>instalment}' },
    { Value: dueDate },
    { Value: amount,            Label: '{i18n>amount}' },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'PAID',    Criticality: 3 },
          { Value: 'PENDING', Criticality: 2 },
          { Value: 'MISSED',  Criticality: 1 },
          { Value: 'WAIVED',  Criticality: 0 }
        ]
      }
    },
    { Value: paidDate },
    { Value: paidAmount,        Label: '{i18n>paidAmount}' },
  ]
);

// ── WRITE-OFFS — GAP CLOSED ────────────────────────────────────────────────

annotate service.WriteOffs with @(
  UI.LineItem: [
    { Value: account.accountNumber,  Label: '{i18n>accountNumber}' },
    { Value: account.legalName,      Label: '{i18n>customerName}' },
    { Value: invoiceNumber,          Label: '{i18n>invoiceNumber}' },
    { Value: writeOffAmount,         Label: '{i18n>writeOffAmount}' },
    { Value: writeOffDate,           Label: '{i18n>writeOffDate}' },
    { Value: approvalLevel,          Label: '{i18n>approvalLevel}' },
    { Value: approvedBy,             Label: '{i18n>approvedBy}' },
    { Value: approvalDate,           Label: '{i18n>approvalDate}' },
  ],

  UI.SelectionFields: [ approvalLevel, writeOffDate, account_ID ],

  UI.HeaderInfo: {
    TypeName: '{i18n>writeOff}', TypeNamePlural: '{i18n>writeOffs}',
    Title: { Value: invoiceNumber }, Description: { Value: account.legalName }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>writeOffDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#WriteOffMain',     Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#WriteOffApproval', Label: '{i18n>sectionApproval}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#WriteOffHistory',  Label: '{i18n>sectionHistory}' },
      ]
    },
    { $Type: 'UI.ReferenceFacet', Target: 'recoveries/@UI.LineItem', Label: '{i18n>sectionRecoveries}' },
  ],

  UI.FieldGroup#WriteOffMain: {
    Data: [
      { Value: invoiceNumber }, { Value: writeOffAmount },
      { Value: writeOffDate },  { Value: reason, Label: '{i18n>reason}' },
    ]
  },

  UI.FieldGroup#WriteOffApproval: {
    Data: [
      { Value: approvalLevel }, { Value: approvedBy },
      { Value: approvalDate },  { Value: boardResolutionRef, Label: '{i18n>boardResolution}' },
    ]
  },

  UI.FieldGroup#WriteOffHistory: {
    Data: [
      { Value: collectionHistory, Label: '{i18n>collectionHistory}' },
      { Value: glPostingRef,      Label: '{i18n>glRef}' },
    ]
  }
);

// WriteOffRecovery sub-list — GAP CLOSED
annotate service.WriteOffRecoveries with @(
  UI.LineItem: [
    { Value: recoveryDate,   Label: '{i18n>date}' },
    { Value: recoveryAmount, Label: '{i18n>amount}' },
    { Value: glPostingRef,   Label: '{i18n>glRef}' },
  ]
);

// ── FRAUD ALERTS ──────────────────────────────────────────────────────────

annotate service.FraudAlerts with @(
  UI.LineItem: [
    { Value: account.accountNumber,  Label: '{i18n>accountNumber}' },
    { Value: account.legalName,      Label: '{i18n>customerName}' },
    { Value: alertPattern,           Label: '{i18n>pattern}' },
    {
      Value: alertSeverity, Label: '{i18n>severity}',
      Criticality: {
        $Path: 'alertSeverity',
        Mapping: [
          { Value: 'HIGH',   Criticality: 1 },
          { Value: 'MEDIUM', Criticality: 2 },
          { Value: 'LOW',    Criticality: 3 }
        ]
      }
    },
    {
      Value: status, Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'CLEARED',       Criticality: 3 },
          { Value: 'UNDER_REVIEW',  Criticality: 2 },
          { Value: 'OPEN',          Criticality: 1 },
          { Value: 'ESCALATED',     Criticality: 1 }
        ]
      }
    },
    { Value: triggeredByUser,        Label: '{i18n>triggeredBy}' },
    { Value: assignedTo,             Label: '{i18n>assignedTo}' },
    { Value: createdAt,              Label: '{i18n>alertTime}' },
  ],

  UI.SelectionFields: [ status, alertSeverity, alertPattern ],

  UI.HeaderInfo: {
    TypeName: '{i18n>fraudAlert}', TypeNamePlural: '{i18n>fraudAlerts}',
    Title: { Value: alertPattern }, Description: { Value: account.legalName }
  },

  UI.Facets: [
    { $Type: 'UI.CollectionFacet', Label: '{i18n>alertDetails}',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#AlertMain',   Label: '{i18n>sectionMain}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#AlertReview', Label: '{i18n>sectionReview}' },
      ]
    }
  ],

  UI.FieldGroup#AlertMain: {
    Data: [
      { Value: alertPattern }, { Value: alertSeverity }, { Value: alertDescription, Label: '{i18n>description}' },
      { Value: triggeredByAction, Label: '{i18n>triggerAction}' }, { Value: triggeredByUser },
      { Value: status }, { Value: assignedTo },
    ]
  },

  UI.FieldGroup#AlertReview: {
    Data: [
      { Value: reviewedBy,   Label: '{i18n>reviewedBy}' },
      { Value: reviewedAt,   Label: '{i18n>reviewedAt}' },
      { Value: actionTaken,  Label: '{i18n>actionTaken}' },
      { Value: reviewNotes,  Label: '{i18n>notes}' },
    ]
  }
);
