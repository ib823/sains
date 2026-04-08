using sains.ar as ar from '../db/schema';

@requires: ['SiBMAServiceAccount','SystemProcess']
service SiBMAService @(path:'/sibma') {

  // ── ACCOUNT BALANCE ──────────────────────────────────────────────────────
  function getAccountBalance(accountNumber: String) returns {
    accountNumber          : String;
    balanceOutstanding     : Decimal(15,2);
    balanceDeposit         : Decimal(15,2);
    balanceCreditOnAccount : Decimal(15,2);
    lastPaymentDate        : Date;
    lastPaymentAmount      : Decimal(15,2);
    dunningLevel           : Integer;
    accountStatus          : String;
  };

  // ── TRANSACTION HISTORY ──────────────────────────────────────────────────
  type TransactionRow {
    date         : Date;
    type         : String;
    reference    : String;
    description  : String;
    debitAmount  : Decimal(15,2);
    creditAmount : Decimal(15,2);
    balance      : Decimal(15,2);
  }

  function getTransactionHistory(
    accountNumber: String,
    fromDate: Date,
    toDate: Date
  ) returns array of TransactionRow;

  // ── PAYMENTS BY INVOICE ──────────────────────────────────────────────────
  type InvoicePaymentRow {
    paymentDate : Date;
    amount      : Decimal(15,2);
    channel     : String;
    reference   : String;
    status      : String;
  }

  function getPaymentsByInvoice(invoiceNumber: String) returns array of InvoicePaymentRow;

  // ── ACCOUNT STATEMENT ────────────────────────────────────────────────────
  function getAccountStatement(
    accountNumber: String,
    asAtDate: Date
  ) returns {
    accountNumber  : String;
    legalName      : String;
    statementDate  : Date;
    openingBalance : Decimal(15,2);
    transactions   : array of TransactionRow;
    closingBalance : Decimal(15,2);
  };
}
