using sains.ar as ar from '../db/schema';
using sains.ar.agency as agy from '../db/schema-phase3-agency';

@requires: 'authenticated-user'
service ARService @(path:'/ar') {

  // ── CUSTOMER ACCOUNTS ──────────────────────────────────────────────────
  @Capabilities.SearchRestrictions.Searchable: true
  entity CustomerAccounts as projection on ar.CustomerAccount
    excluding { idNumber, auditTrail }
  actions {
    @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
    action closeAccount(reason: String(500)) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action activateVoidAccount(notes: String(500)) returns Boolean;

    @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff'])
    action requestDataExport() returns String;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action decryptIdNumber() returns String;

    @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
    action verifyBuyerTIN(tin: String(20)) returns {
      valid: Boolean; registeredName: String(150); message: String(255);
    };

    @(requires:['BILStaff','BILSupervisor','FinanceAdmin'])
    action voluntaryDisconnect(reconnectDate: Date) returns Boolean;

    @(requires:['BILStaff','BILSupervisor','FinanceAdmin'])
    action voluntaryReconnect() returns Boolean;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
  entity AccountNotes as projection on ar.AccountNote;

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
  entity AccountChangeRequests as projection on ar.AccountChangeRequest
  actions {
    @(requires:['FinanceSupervisor','BILSupervisor'])
    action approveChange() returns Boolean;

    @(requires:['FinanceSupervisor','BILSupervisor'])
    action rejectChange(reason: String(255)) returns Boolean;
  }

  // ── INVOICES ────────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','CounterStaff','Auditor','SystemProcess'])
  entity Invoices as projection on ar.Invoice
  actions {
    @(requires:['FinanceSupervisor','FinanceManager'])
    action reverseInvoice(reason: String(500)) returns Boolean;

    @(requires:['FinanceAdmin','FinanceSupervisor','SystemProcess'])
    action submitToEInvoice() returns String;

    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action cancelEInvoice(reason: String(255)) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action raiseCreditNote(reason: String(500), amount: Decimal(15,2)) returns UUID;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','CounterStaff','Auditor'])
  entity InvoiceLineItems as projection on ar.InvoiceLineItem;

  @(requires:['FinanceAdmin','FinanceSupervisor','BILStaff'])
  entity MeterReadHistory as projection on ar.MeterReadHistory;

  // ── PAYMENTS ────────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','CounterStaff','Auditor','SystemProcess'])
  entity Payments as projection on ar.Payment
  actions {
    @(requires:['FinanceSupervisor','FinanceManager'])
    action reversePayment(
      reversalType: String(20),
      reason: String(255)
    ) returns Boolean;

    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action manualAllocate(invoiceID: UUID, allocateAmount: Decimal(15,2)) returns Boolean;

    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action confirmChequeCleared() returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action markChequeBounced(reason: String(255)) returns Boolean;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','SystemProcess'])
  entity CollectionImportBatches as projection on ar.CollectionImportBatch
  actions {
    @(requires:['FinanceAdmin','FinanceSupervisor','CounterSupervisor'])
    action confirmBatch() returns Boolean;

    @(requires:['FinanceAdmin','SystemProcess','CounterSupervisor'])
    action processBatch() returns {
      processed: Integer;
      failed: Integer;
      suspense: Integer;
    };

    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action resolveSuspenseLine(
      lineID: UUID,
      targetAccountID: UUID,
      notes: String(500)
    ) returns Boolean;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','CounterSupervisor'])
  entity SuspensePayments as projection on ar.SuspensePayment
  actions {
    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action resolveToAccount(
      targetAccountID: UUID,
      notes: String(500)
    ) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action returnToSource(reason: String(255)) returns Boolean;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity BankStatementImports as projection on ar.BankStatementImport
  actions {
    @(requires:['FinanceAdmin','SystemProcess'])
    action runAutoMatch() returns { matched: Integer; unmatched: Integer; };

    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action manualMatch(lineID: UUID, paymentID: UUID) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action approveReconciliation() returns Boolean;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager'])
  entity BankStatementLines as projection on ar.BankStatementLine;

  // ── ADJUSTMENTS ─────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
  entity Adjustments as projection on ar.Adjustment
  actions {
    @(requires:['FinanceSupervisor','FinanceManager','BILSupervisor'])
    action approveAdjustment() returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager','BILSupervisor'])
    action rejectAdjustment(reason: String(255)) returns Boolean;

    @(requires:['FinanceAdmin','SystemProcess'])
    action postAdjustment() returns Boolean;
  }

  // ── DISPUTES ────────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
  entity Disputes as projection on ar.Dispute
  actions {
    @(requires:['FinanceSupervisor','BILSupervisor'])
    action resolveDispute(
      status: String(30),
      notes: String(1000),
      adjustmentID: UUID
    ) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action escalateToSPAN(spanRef: String(50)) returns Boolean;
  }

  // ── DEPOSITS ────────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff'])
  entity DepositRecords as projection on ar.DepositRecord
  actions {
    @(requires:['FinanceAdmin','BILStaff'])
    action initiateRefund(
      refundAmount: Decimal(15,2),
      refundMethod: String(30),
      bankAccountNumber: String(30)
    ) returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action approveRefund() returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action applyToBalance(reason: String(500)) returns Boolean;

    @(requires:['FinanceAdmin','SystemProcess'])
    action markDormant(noticeStage: Integer) returns Boolean;
  }

  // ── PAYMENT PLANS ───────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor'])
  entity PaymentPlans as projection on ar.PaymentPlan
  actions {
    @(requires:['FinanceSupervisor','FinanceManager','BILSupervisor','CollectionsSupervisor'])
    action approvePlan() returns Boolean;

    @(requires:['FinanceSupervisor','FinanceManager'])
    action voidPlan(reason: String(255)) returns Boolean;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','BILStaff','BILSupervisor'])
  entity PaymentPlanInstalments as projection on ar.PaymentPlanInstalment;

  // ── PROMISE TO PAY ──────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor','CounterStaff','CollectionsOfficer'])
  entity PromisesToPay as projection on ar.PromiseToPay
  actions {
    @(requires:['FinanceManager'])
    action approveExcessPTP() returns Boolean;

    @(requires:['FinanceAdmin','FinanceSupervisor','BILSupervisor','SystemProcess'])
    action markBroken() returns Boolean;

    @(requires:['FinanceAdmin','FinanceSupervisor','BILStaff','CounterStaff','SystemProcess'])
    action markHonoured() returns Boolean;
  }

  // ── WRITE-OFFS ──────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','CFO','Auditor'])
  entity WriteOffs as projection on ar.WriteOff
  actions {
    @(requires:['FinanceSupervisor'])
    action approveWriteOff_Supervisor() returns Boolean;

    @(requires:['FinanceManager'])
    action approveWriteOff_Manager() returns Boolean;

    @(requires:['CFO'])
    action approveWriteOff_CFO() returns Boolean;

    @(requires:['FinanceManager'])
    action submitForBoardApproval(notes: String(500)) returns Boolean;
  }

  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','Auditor'])
  entity WriteOffRecoveries as projection on ar.WriteOffRecovery;

  // ── FRAUD ALERTS ────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','ICTManager'])
  entity FraudAlerts as projection on ar.FraudAlert
  actions {
    @(requires:['FinanceManager','ICTManager'])
    action reviewAlert(
      actionTaken: String(30),
      notes: String(500)
    ) returns Boolean;

    @(requires:['FinanceManager'])
    action escalateAlert() returns Boolean;
  }

  // ── DUNNING ─────────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','FinanceManager','BILStaff','BILSupervisor','Auditor','CollectionsOfficer'])
  entity DunningHistories as projection on ar.DunningHistory
  actions {
    @(requires:['FinanceAdmin','BILStaff'])
    action recordPostalReturn() returns Boolean;
  };

  // ── DIRECT DEBIT ────────────────────────────────────────────────────────
  @(requires:['FinanceAdmin','FinanceSupervisor','BILStaff'])
  entity DirectDebitMandates as projection on ar.DirectDebitMandate;

  // ── JOB TRIGGERS (SystemProcess only) ──────────────────────────────────
  @(requires:['SystemProcess'])
  action triggerPTPComplianceCheck() returns {
    checked: Integer; honoured: Integer; broken: Integer; expired: Integer;
    plansChecked: Integer; plansBreach: Integer;
  };

  @(requires:['SystemProcess'])
  action triggerDunningBatch(date: Date) returns {
    processed: Integer; escalated: Integer; reset: Integer; errors: Integer;
  };

  @(requires:['SystemProcess'])
  action triggerGLPosting(date: Date) returns {
    processed: Integer; transactions: Integer;
  };

  @(requires:['SystemProcess','FinanceManager'])
  action triggerPeriodAccrual(year: Integer, month: Integer) returns {
    processed: Integer; accrualTransactions: Integer;
  };

  // ── AGENCY FILE PARSER ──────────────────────────────────────────────────
  @(requires:['FinanceAdmin','ICTManager','SystemAdmin'])
  entity AgencyFileFormats as projection on agy.AgencyFileFormat;

  @(requires:['FinanceAdmin','FinanceSupervisor','CounterSupervisor'])
  entity AgencyFileBatches as projection on agy.AgencyFileBatch
  actions {
    @(requires:['FinanceAdmin','FinanceSupervisor','CounterSupervisor'])
    action uploadAgencyFile(
      agencyCode: String(20),
      fileContent: LargeString,
      fileName: String(255),
      fileDate: Date
    ) returns {
      batchID     : UUID;
      parsedLines : Integer;
      failedLines : Integer;
    };

    @(requires:['FinanceAdmin','FinanceSupervisor'])
    action resolveAgencyBatch(batchID: UUID) returns {
      resolved : Integer;
      suspense : Integer;
    };
  }

  @(requires:['FinanceAdmin','FinanceSupervisor'])
  @readonly
  entity AgencyFileLines as projection on agy.AgencyFileLine;
}
