using CustomerPortalService as service from '../../srv/customer-portal-service';

annotate service.MyAccount with @(
  UI: {
    HeaderInfo: {
      TypeName: 'My Account',
      TypeNamePlural: 'My Accounts',
      Title: { Value: accountNumber },
      Description: { Value: legalName },
    },
    LineItem: [
      { Value: accountNumber, Label: 'Account Number' },
      { Value: legalName, Label: 'Name' },
      { Value: balanceOutstanding, Label: 'Outstanding (RM)' },
      { Value: accountStatus, Label: 'Status' },
      { Value: lastPaymentDate, Label: 'Last Payment' },
    ],
  }
);

annotate service.MyInvoices with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Invoice',
      TypeNamePlural: 'My Invoices',
      Title: { Value: invoiceNumber },
      Description: { Value: status },
    },
    LineItem: [
      { Value: invoiceNumber, Label: 'Invoice No' },
      { Value: invoiceDate, Label: 'Date' },
      { Value: dueDate, Label: 'Due Date' },
      { Value: totalAmount, Label: 'Amount (RM)' },
      { Value: amountOutstanding, Label: 'Outstanding (RM)' },
      { Value: status, Label: 'Status' },
    ],
  }
);

annotate service.MyPTPs with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Promise to Pay',
      TypeNamePlural: 'My Promises to Pay',
      Title: { Value: promisedPaymentDate },
    },
    LineItem: [
      { Value: promisedPaymentDate, Label: 'Promised Date' },
      { Value: promisedAmount, Label: 'Amount (RM)' },
      { Value: status, Label: 'Status' },
      { Value: customerReference, Label: 'Reference' },
    ],
  }
);

annotate service.MyDisputes with @(
  UI: {
    HeaderInfo: {
      TypeName: 'Dispute',
      TypeNamePlural: 'My Disputes',
      Title: { Value: disputeType },
    },
    LineItem: [
      { Value: disputeType, Label: 'Type' },
      { Value: description, Label: 'Description' },
      { Value: status, Label: 'Status' },
      { Value: resolvedAt, Label: 'Resolved' },
    ],
  }
);
