using sains.ar as ar from '../db/schema';

@requires: ['FinanceAdmin','FinanceSupervisor','FinanceManager','CFO','Auditor','ReportViewer']
service ReportingService @(path:'/reporting') {

  function getDSOReport(periodYear: Integer, periodMonth: Integer) returns {
    dso: Decimal(10,2);
    annualBilledRevenue: Decimal(15,2);
    totalOpenAR: Decimal(15,2);
    asOfDate: Date;
  };

  function getCollectionEfficiencyReport(
    periodYear: Integer, periodMonth: Integer
  ) returns array of {
    accountType: String(10);
    totalBilled: Decimal(15,2);
    totalCollected: Decimal(15,2);
    efficiencyRate: Decimal(5,4);
  };

  function getBadDebtProvisionReport(periodYear: Integer, periodMonth: Integer)
  returns array of {
    accountType: String(10);
    agingBucket: String(20);
    openARAmount: Decimal(15,2);
    provisionRate: Decimal(5,4);
    provisionAmount: Decimal(15,2);
  };

  function getMFRS15DisaggregationReport(periodYear: Integer, periodMonth: Integer)
  returns array of {
    revenueCategory: String(50);
    subCategory: String(50);
    amount: Decimal(15,2);
  };

  function getSPANKPIReport(periodYear: Integer, periodMonth: Integer) returns {
    collectionEfficiencyRate: Decimal(5,4);
    dso: Decimal(10,2);
    badDebtRatio: Decimal(5,4);
    billingAccuracyRate: Decimal(5,4);
    delinquencyRate: Decimal(5,4);
    dunningDistribution: array of {
      level: Integer;
      accountCount: Integer;
      totalAmount: Decimal(15,2);
    };
  };

  function getCustomerStatement(
    accountID: UUID,
    fromDate: Date,
    toDate: Date
  ) returns {
    accountNumber: String(20);
    customerName: String(150);
    statementDate: Date;
    openingBalance: Decimal(15,2);
    closingBalance: Decimal(15,2);
    depositHeld: Decimal(15,2);
    overdueAmount: Decimal(15,2);
    accountStatus: String(20);
    transactions: array of {
      transactionDate: Date;
      description: String(255);
      debitAmount: Decimal(15,2);
      creditAmount: Decimal(15,2);
      runningBalance: Decimal(15,2);
      reference: String(50);
      transactionType: String(20);
    };
  };

  function getReconciliationStatus(reconciliationDate: Date) returns array of {
    reconciliationType: String(30);
    status: String(20);
    difference: Decimal(15,2);
    withinTolerance: Boolean;
  };

  function getDunningDistributionReport(asOfDate: Date) returns array of {
    level: Integer;
    accountCount: Integer;
    totalOverdueAmount: Decimal(15,2);
  };

  @(requires:['FinanceManager','CFO','Auditor'])
  function generateAuditorConfirmationLetters(
    sampleAccountIDs: array of UUID,
    periodEndDate: Date
  ) returns array of {
    accountID: UUID;
    accountNumber: String(20);
    customerName: String(150);
    serviceAddress: String(255);
    balanceAsAtDate: Decimal(15,2);
    letterText: LargeString;
  };

  function getDepositSufficiencyReviewReport(reviewYear: Integer) returns array of {
    accountID: UUID;
    accountNumber: String(20);
    accountType: String(10);
    currentDepositAmount: Decimal(15,2);
    avgMonthlyBill6Months: Decimal(15,2);
    requiredDeposit: Decimal(15,2);
    shortfall: Decimal(15,2);
    topUpRequired: Boolean;
  };

  function getSuspenseReport(asOfDate: Date) returns {
    totalSuspenseBalance: Decimal(15,2);
    pendingCount: Integer;
    oldestDaysInSuspense: Integer;
    items: array of {
      id: UUID;
      sourceChannel: String(30);
      amount: Decimal(15,2);
      paymentDate: Date;
      daysInSuspense: Integer;
      status: String(20);
    };
  };

  @readonly entity AuditTrail as projection on ar.AuditTrailEntry;
  @readonly entity ReconciliationRecords as projection on ar.ReconciliationRecord;
  @readonly entity PeriodCloseChecklists as projection on ar.PeriodCloseChecklist;
  @readonly entity PeriodCloseSteps as projection on ar.PeriodCloseStep;
}
