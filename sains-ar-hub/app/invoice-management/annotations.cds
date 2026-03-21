using ARService as service from '../../srv/ar-service';

annotate service.Invoices with @(
  UI.LineItem: [
    { Value: invoiceNumber,           Label: '{i18n>invoiceNumber}' },
    { Value: account.accountNumber,   Label: '{i18n>accountNumber}' },
    { Value: account.legalName,       Label: '{i18n>customerName}' },
    { Value: invoiceDate,             Label: '{i18n>invoiceDate}' },
    { Value: dueDate,                 Label: '{i18n>dueDate}' },
    { Value: invoiceType,             Label: '{i18n>invoiceType}' },
    {
      Value: status,
      Label: '{i18n>status}',
      Criticality: {
        $Path: 'status',
        Mapping: [
          { Value: 'OPEN',         Criticality: 2 },
          { Value: 'PARTIAL',      Criticality: 2 },
          { Value: 'CLEARED',      Criticality: 3 },
          { Value: 'REVERSED',     Criticality: 0 },
          { Value: 'CANCELLED',    Criticality: 0 },
          { Value: 'DISPUTED',     Criticality: 1 },
          { Value: 'HELD',         Criticality: 1 },
          { Value: 'HELD_NO_TIN',  Criticality: 1 }
        ]
      }
    },
    { Value: totalAmount,             Label: '{i18n>total}',          @UI.Importance: #High },
    { Value: amountOutstanding,       Label: '{i18n>outstanding}',    @UI.Importance: #High },
    {
      Value: einvoiceStatus,
      Label: '{i18n>einvoiceStatus}',
      Criticality: {
        $Path: 'einvoiceStatus',
        Mapping: [
          { Value: 'ACCEPTED',          Criticality: 3 },
          { Value: 'SUBMITTED',         Criticality: 2 },
          { Value: 'REJECTED',          Criticality: 1 },
          { Value: 'HELD_NO_TIN',       Criticality: 1 },
          { Value: 'PENDING',           Criticality: 2 },
          { Value: 'CANCELLED',         Criticality: 0 },
          { Value: 'NOT_REQUIRED',      Criticality: 0 }
        ]
      }
    },
    { Value: sourceSystem,            Label: '{i18n>source}' },
  ],

  UI.SelectionFields: [
    status, invoiceType, einvoiceStatus, sourceSystem,
    account_ID, invoiceDate, dueDate
  ],

  UI.PresentationVariant: {
    SortOrder: [{ Property: invoiceDate, Descending: true }],
    Visualizations: [ '@UI.LineItem' ]
  },

  UI.HeaderInfo: {
    TypeName:       '{i18n>invoice}',
    TypeNamePlural: '{i18n>invoices}',
    Title:          { Value: invoiceNumber },
    Description:    { Value: account.legalName }
  },

  UI.Facets: [
    {
      $Type: 'UI.CollectionFacet', Label: '{i18n>sectionInvoiceDetails}', ID: 'InvoiceDetails',
      Facets: [
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#InvoiceHeader',  Label: '{i18n>sectionHeader}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#InvoiceAmounts', Label: '{i18n>sectionAmounts}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#InvoiceMeter',   Label: '{i18n>sectionMeter}' },
        { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#InvoiceEInvoice',Label: '{i18n>sectionEInvoice}' },
      ]
    },
    { $Type: 'UI.ReferenceFacet', Target: 'lineItems/@UI.LineItem', Label: '{i18n>sectionLineItems}' },
  ],

  UI.FieldGroup#InvoiceHeader: {
    Data: [
      { Value: invoiceNumber },
      { Value: invoiceDate },
      { Value: dueDate },
      { Value: billingPeriodFrom,   Label: '{i18n>periodFrom}' },
      { Value: billingPeriodTo,     Label: '{i18n>periodTo}' },
      { Value: isPartialPeriod,     Label: '{i18n>isPartialPeriod}' },
      { Value: partialPeriodDays,   Label: '{i18n>partialPeriodDays}' },
      { Value: invoiceType,         Label: '{i18n>invoiceType}' },
      { Value: status },
      { Value: sourceSystem,        Label: '{i18n>source}' },
    ]
  },

  UI.FieldGroup#InvoiceAmounts: {
    Data: [
      { Value: totalAmount,         Label: '{i18n>total}' },
      { Value: taxAmount,           Label: '{i18n>taxAmount}' },
      { Value: taxRateApplied,      Label: '{i18n>taxRate}' },
      { Value: amountCleared,       Label: '{i18n>cleared}' },
      { Value: amountOutstanding,   Label: '{i18n>outstanding}' },
    ]
  },

  UI.FieldGroup#InvoiceMeter: {
    Data: [
      { Value: consumptionM3,       Label: '{i18n>consumption}' },
      { Value: meterReadPrevious,   Label: '{i18n>meterReadPrevious}' },
      { Value: meterReadCurrent,    Label: '{i18n>meterReadCurrent}' },
      { Value: meterReadType,       Label: '{i18n>meterReadType}' },
    ]
  },

  UI.FieldGroup#InvoiceEInvoice: {
    Data: [
      { Value: einvoiceRequired,        Label: '{i18n>einvoiceRequired}' },
      { Value: einvoiceStatus,          Label: '{i18n>einvoiceStatus}' },
      { Value: einvoiceUUID,            Label: '{i18n>einvoiceUUID}' },
      { Value: einvoiceSubmittedAt,     Label: '{i18n>einvoiceSubmittedAt}' },
      { Value: einvoiceCancelDeadline,  Label: '{i18n>einvoiceCancelDeadline}' },
      { Value: einvoiceSequenceNo,      Label: '{i18n>einvoiceSequenceNo}' },
    ]
  }
);

annotate service.InvoiceLineItems with @(
  UI.LineItem: [
    { Value: lineSequence,         Label: '{i18n>lineNo}' },
    { Value: chargeType.name,      Label: '{i18n>chargeType}' },
    { Value: description },
    { Value: quantity },
    { Value: unitPrice,            Label: '{i18n>unitPrice}' },
    { Value: lineAmount,           Label: '{i18n>amount}' },
    { Value: taxCategory,          Label: '{i18n>taxCategory}' },
    { Value: taxAmount,            Label: '{i18n>tax}' },
  ]
);
