using iWRSIntegrationService as service from '../../srv/iwrs-integration-service';

// ── iWRS Event Log ─────────────────────────────────────────────────────────

annotate service.iWRSEventLogs with @(
  UI: {
    HeaderInfo: {
      TypeName: 'iWRS Event',
      TypeNamePlural: 'iWRS Events',
      Title: { Value: eventType },
      Description: { Value: accountNumber },
    },
    SelectionFields: [ processingStatus, eventType, createdAt ],
    LineItem: [
      { Value: createdAt, Label: 'Received At' },
      { Value: eventType, Label: 'Event Type' },
      { Value: eventSource, Label: 'Pattern' },
      { Value: accountNumber, Label: 'Account' },
      { Value: iWRSReference, Label: 'iWRS Reference' },
      { Value: processingStatus, Label: 'Status', Criticality: processingStatusCriticality },
      { Value: processingDurationMs, Label: 'Duration (ms)' },
      { Value: processingError, Label: 'Error' },
    ],
  }
);

annotate service.iWRSEventLogs with {
  processingStatusCriticality: Integer @Core.Computed;
};

// ── Metis Work Orders ──────────────────────────────────────────────────────

annotate service.MetisWorkOrders with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Metis Work Order',
      TypeNamePlural: 'Metis Work Orders',
      Title: { Value: metisWorkOrderRef },
      Description: { Value: workOrderType },
    },
    SelectionFields: [ status, workOrderType, authorisedAt ],
    LineItem: [
      { Value: account.accountNumber, Label: 'Account' },
      { Value: workOrderType, Label: 'Type' },
      { Value: metisWorkOrderRef, Label: 'Metis Ref' },
      { Value: authorisedBy, Label: 'Authorised By' },
      { Value: authorisedAt, Label: 'Authorised At' },
      { Value: requestedDate, Label: 'Requested Date' },
      { Value: status, Label: 'Status', Criticality: statusCriticality },
      { Value: completedAt, Label: 'Completed' },
    ],
  }
);

annotate service.MetisWorkOrders with {
  statusCriticality: Integer @Core.Computed;
};
