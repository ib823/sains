using ARService as service from '../../srv/ar-service';

// ── LIST REPORT ────────────────────────────────────────────────────────────

annotate service.CustomerAccounts with @(
  UI.LineItem: [
    { Value: accountNumber,             Label: '{i18n>accountNumber}' },
    { Value: legalName,                 Label: '{i18n>legalName}' },
    { Value: accountType.name,          Label: '{i18n>accountType}' },
    {
      Value: accountStatus,
      Label: '{i18n>accountStatus}',
      Criticality: {
        $Path: 'accountStatus',
        Mapping: [
          { Value: 'ACTIVE',           Criticality: 3 },
          { Value: 'RESTRICTED',       Criticality: 2 },
          { Value: 'LEGAL',            Criticality: 1 },
          { Value: 'TEMP_DISCONNECTED',Criticality: 2 },
          { Value: 'VOID',             Criticality: 0 },
          { Value: 'CLOSED',           Criticality: 0 },
          { Value: 'TERMINATED',       Criticality: 1 }
        ]
      }
    },
    {
      Value: dunningLevel,
      Label: '{i18n>dunningLevel}',
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
    { Value: balanceOutstanding,        Label: '{i18n>balanceOutstanding}', @UI.Importance: #High },
    { Value: balanceDeposit,            Label: '{i18n>balanceDeposit}' },
    { Value: branchCode,                Label: '{i18n>branchCode}' },
    { Value: primaryPhone,              Label: '{i18n>primaryPhone}' },
    { Value: isHardship,                Label: '{i18n>isHardship}' },
    { Value: isDisputed,                Label: '{i18n>isDisputed}' },
  ],

  UI.SelectionFields: [
    accountStatus, accountType_code, branchCode,
    dunningLevel, isHardship, isDisputed,
    isPaymentPlan, isWrittenOff, isLegalAction
  ],

  UI.PresentationVariant: {
    SortOrder: [{ Property: balanceOutstanding, Descending: true }],
    Visualizations: [ '@UI.LineItem' ]
  }
);

// ── OBJECT PAGE ────────────────────────────────────────────────────────────

annotate service.CustomerAccounts with @(
  UI.HeaderInfo: {
    TypeName:       '{i18n>customerAccount}',
    TypeNamePlural: '{i18n>customerAccounts}',
    Title:          { Value: legalName },
    Description:    { Value: accountNumber }
  },

  UI.HeaderFacets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#StatusSummary',   Label: '{i18n>status}' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#BalanceSummary',  Label: '{i18n>financialSummary}' }
  ],

  UI.FieldGroup#StatusSummary: {
    Label: '{i18n>status}',
    Data: [
      { Value: accountStatus },
      { Value: dunningLevel,          Label: '{i18n>dunningLevel}' },
      { Value: riskCategory.name,     Label: '{i18n>riskCategory}' },
      { Value: isHardship,            Label: '{i18n>isHardship}' },
      { Value: isDisputed,            Label: '{i18n>isDisputed}' },
      { Value: isPaymentPlan,         Label: '{i18n>isPaymentPlan}' },
      { Value: isLegalAction,         Label: '{i18n>isLegalAction}' },
    ]
  },

  UI.FieldGroup#BalanceSummary: {
    Label: '{i18n>financialSummary}',
    Data: [
      { Value: balanceOutstanding,      Label: '{i18n>balanceOutstanding}' },
      { Value: balanceDeposit,          Label: '{i18n>balanceDeposit}' },
      { Value: balanceCreditOnAccount,  Label: '{i18n>balanceCreditOnAccount}' },
    ]
  },

  UI.Facets: [
    // ── Account Details ──────────────────────────────────────────────────
    {
      $Type: 'UI.CollectionFacet',
      Label: '{i18n>sectionAccountDetails}',
      ID: 'AccountDetails',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Identity',    Label: '{i18n>sectionIdentity}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Service',     Label: '{i18n>sectionServiceAddress}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Corr',        Label: '{i18n>sectionCorrAddress}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Contact',     Label: '{i18n>sectionContact}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Portal',      Label: '{i18n>sectionPortal}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Technical',   Label: '{i18n>sectionTechnical}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#LHDN',        Label: '{i18n>sectionLHDN}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#Ownership',   Label: '{i18n>sectionOwnership}' },
      ]
    },
    // ── Transactions ─────────────────────────────────────────────────────
    { $Type: 'UI.ReferenceFacet', Target: 'invoices/@UI.LineItem',           Label: '{i18n>sectionInvoices}' },
    { $Type: 'UI.ReferenceFacet', Target: 'payments/@UI.LineItem',           Label: '{i18n>sectionPayments}' },
    { $Type: 'UI.ReferenceFacet', Target: 'adjustments/@UI.LineItem',        Label: '{i18n>sectionAdjustments}' },
    { $Type: 'UI.ReferenceFacet', Target: 'deposits/@UI.LineItem',           Label: '{i18n>sectionDeposits}' },
    { $Type: 'UI.ReferenceFacet', Target: 'paymentPlans/@UI.LineItem',       Label: '{i18n>sectionPaymentPlans}' },
    { $Type: 'UI.ReferenceFacet', Target: 'disputes/@UI.LineItem',           Label: '{i18n>sectionDisputes}' },
    { $Type: 'UI.ReferenceFacet', Target: 'dunningHistory/@UI.LineItem',     Label: '{i18n>sectionDunningHistory}' },
    // ── Account Management ───────────────────────────────────────────────
    { $Type: 'UI.ReferenceFacet', Target: 'notes/@UI.LineItem',              Label: '{i18n>sectionNotes}' },
    { $Type: 'UI.ReferenceFacet', Target: 'changeRequests/@UI.LineItem',     Label: '{i18n>sectionChangeRequests}' },
    { $Type: 'UI.ReferenceFacet', Target: 'meterReadHistory/@UI.LineItem',   Label: '{i18n>sectionMeterReads}' },
  ]
);

annotate service.CustomerAccounts with @(
  UI.FieldGroup#Identity: {
    Data: [
      { Value: legalName },
      { Value: idNumberMasked,        Label: '{i18n>idNumberMasked}' },
      { Value: holderType,            Label: '{i18n>holderType}' },
      { Value: accountType.name,      Label: '{i18n>accountType}' },
      { Value: tariffBand.name,       Label: '{i18n>tariffBand}' },
      { Value: billingBasis.name,     Label: '{i18n>billingBasis}' },
      { Value: accountOpenDate,       Label: '{i18n>accountOpenDate}' },
      { Value: accountCloseDate,      Label: '{i18n>accountCloseDate}' },
      { Value: branchCode,            Label: '{i18n>branchCode}' },
    ]
  },

  UI.FieldGroup#Service: {
    Data: [
      { Value: serviceAddress1,       Label: '{i18n>address1}' },
      { Value: serviceAddress2,       Label: '{i18n>address2}' },
      { Value: serviceCity,           Label: '{i18n>city}' },
      { Value: serviceState,          Label: '{i18n>state}' },
      { Value: servicePostcode,       Label: '{i18n>postcode}' },
    ]
  },

  UI.FieldGroup#Corr: {
    Data: [
      { Value: corrSameAsService,     Label: '{i18n>corrSameAsService}' },
      { Value: corrAddress1,          Label: '{i18n>address1}' },
      { Value: corrAddress2,          Label: '{i18n>address2}' },
      { Value: corrCity,              Label: '{i18n>city}' },
      { Value: corrState,             Label: '{i18n>state}' },
      { Value: corrPostcode,          Label: '{i18n>postcode}' },
    ]
  },

  UI.FieldGroup#Contact: {
    Data: [
      { Value: primaryPhone,          Label: '{i18n>primaryPhone}' },
      { Value: secondaryPhone,        Label: '{i18n>secondaryPhone}' },
      { Value: emailAddress,          Label: '{i18n>emailAddress}' },
      { Value: eBillingEnrolled,      Label: '{i18n>eBillingEnrolled}' },
      { Value: eBillingEnrolledDate,  Label: '{i18n>eBillingEnrolledDate}' },
      { Value: paperBillingElected,   Label: '{i18n>paperBillingElected}' },
    ]
  },

  UI.FieldGroup#Portal: {
    Data: [
      { Value: portalRegistered,      Label: '{i18n>portalRegistered}' },
      { Value: portalRegisteredDate,  Label: '{i18n>portalRegisteredDate}' },
      { Value: portalAuthMethod,      Label: '{i18n>portalAuthMethod}' },
    ]
  },

  UI.FieldGroup#Technical: {
    Data: [
      { Value: meterReference,        Label: '{i18n>meterReference}' },
      { Value: connectionSizeMM,      Label: '{i18n>connectionSize}' },
      { Value: lastVerificationDate,  Label: '{i18n>lastVerification}' },
      { Value: isVoluntaryDisconnected, Label: '{i18n>isVoluntaryDisconnected}' },
      { Value: voluntaryDisconnectedDate, Label: '{i18n>voluntaryDisconnectedDate}' },
      { Value: voluntaryReconnectDueDate, Label: '{i18n>voluntaryReconnectDue}' },
    ]
  },

  UI.FieldGroup#LHDN: {
    Data: [
      { Value: buyerTIN,              Label: '{i18n>buyerTIN}' },
      { Value: buyerTINVerified,      Label: '{i18n>buyerTINVerified}' },
      { Value: buyerTINVerifiedDate,  Label: '{i18n>buyerTINVerifiedDate}' },
      { Value: buyerSSTNumber,        Label: '{i18n>buyerSSTNumber}' },
    ]
  },

  UI.FieldGroup#Ownership: {
    Data: [
      { Value: ownerName,             Label: '{i18n>ownerName}' },
      { Value: ownerPhone,            Label: '{i18n>ownerPhone}' },
      { Value: ownerEmail,            Label: '{i18n>ownerEmail}' },
      { Value: ownerTripartiteAgreement, Label: '{i18n>ownerTripartite}' },
    ]
  }
);

// ── SUB-LIST ANNOTATIONS ───────────────────────────────────────────────────

annotate service.AccountNotes with @UI.LineItem: [
  { Value: noteDate,    Label: '{i18n>date}' },
  { Value: noteType,    Label: '{i18n>type}' },
  { Value: noteText,    Label: '{i18n>note}' },
  { Value: createdBy,   Label: '{i18n>createdBy}' },
  { Value: isInternal,  Label: '{i18n>internal}' },
];

annotate service.AccountChangeRequests with @UI.LineItem: [
  { Value: fieldChanged,    Label: '{i18n>fieldChanged}' },
  { Value: status,          Label: '{i18n>status}' },
  { Value: requestedAt,     Label: '{i18n>requestedAt}' },
  { Value: requestedBy,     Label: '{i18n>requestedBy}' },
  { Value: approvedBy,      Label: '{i18n>approvedBy}' },
  { Value: approvedAt,      Label: '{i18n>approvedAt}' },
  { Value: changeReason,    Label: '{i18n>reason}' },
  { Value: rejectionReason, Label: '{i18n>rejectionReason}' },
];

annotate service.MeterReadHistory with @UI.LineItem: [
  { Value: readDate,       Label: '{i18n>date}' },
  { Value: readType,       Label: '{i18n>type}' },
  { Value: readingM3,      Label: '{i18n>reading}' },
  { Value: consumptionM3,  Label: '{i18n>consumption}' },
  { Value: sourceSystem,   Label: '{i18n>source}' },
  { Value: meterSerial,    Label: '{i18n>meterSerial}' },
];
