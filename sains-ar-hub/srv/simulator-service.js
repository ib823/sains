'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');

const logger = cds.log('simulator');

module.exports = async function () {
  const db = await cds.connect.to('db');
  const srv = this;

  // ════════════════════════════════════════════════════════════════════════
  // iWRS SIMULATOR — Simulate water billing system sending events to AR Hub
  // ════════════════════════════════════════════════════════════════════════

  srv.on('simulateAccountCreated', async (req) => {
    const d = req.data;
    const start = Date.now();

    // Build iWRS-format payload (as iWRS would send it)
    const iwrsPayload = {
      event_type: 'ACCOUNT_CREATED',
      acc_no: d.accountNumber,
      cust_name: d.customerName,
      id_no: d.idNumber,
      id_type: d.idType || 'IC',
      acc_type: d.accountType || 'DOM',
      addr_1: d.address1,
      addr_city: d.city || 'Seremban',
      addr_postcode: d.postcode || '70000',
      phone_1: d.phone,
      email: d.email,
      branch_code: d.branchCode || 'SRB',
      tariff_code: d.tariffCode || 'DOM_A',
      meter_ref: d.meterRef || `MR-${Date.now().toString().slice(-5)}`,
      open_date: new Date().toISOString().substring(0, 10),
    };

    // Forward to the iWRS integration service endpoint
    let response;
    try {
      const iwrsSrv = await cds.connect.to('IWRSIntegrationService');
      response = await iwrsSrv.send('receiveAccountEvent', iwrsPayload);
    } catch (err) {
      // If the integration service isn't available, call the handler directly
      try {
        const iwrsAdapter = require('./external/iwrs-adapter');
        response = await iwrsAdapter.processAccountEvent(iwrsPayload);
      } catch (adapterErr) {
        response = { success: false, error: adapterErr.message };
      }
    }

    await _logEvent(db, {
      system: 'IWRS',
      direction: 'INBOUND',
      eventType: 'ACCOUNT_CREATED',
      status: response?.success ? 'ACCEPTED' : 'FAILED',
      requestPayload: JSON.stringify(iwrsPayload),
      responsePayload: JSON.stringify(response),
      accountNumber: d.accountNumber,
      processingMs: Date.now() - start,
      errorMessage: response?.error || null,
    });

    return JSON.stringify({ success: true, result: response });
  });

  srv.on('simulateInvoiceGenerated', async (req) => {
    const d = req.data;
    const start = Date.now();

    const iwrsPayload = {
      event_type: 'INVOICE_GENERATED',
      acc_no: d.accountNumber,
      bill_no: d.invoiceNumber || `INV-${new Date().toISOString().substring(0, 7).replace('-', '')}-${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`,
      bill_date: d.invoiceDate || new Date().toISOString().substring(0, 10),
      due_date: d.dueDate || (() => { const dt = new Date(); dt.setDate(dt.getDate() + 21); return dt.toISOString().substring(0, 10); })(),
      period_from: (() => { const dt = new Date(); dt.setMonth(dt.getMonth() - 1); return dt.toISOString().substring(0, 10); })(),
      period_to: new Date().toISOString().substring(0, 10),
      total_amount: d.totalAmount || 45.60,
      tax_total: d.taxAmount || 0,
      consumption_m3: d.consumptionM3 || 15,
      meter_prev: d.meterReadPrevious || 1000,
      meter_curr: d.meterReadCurrent || 1015,
      read_type: 'A',
      line_items: [
        { charge_code: 'WATER', desc: 'Water Consumption', qty: d.consumptionM3 || 15, unit_price: 0.57, amount: d.totalAmount || 45.60, tax_amt: d.taxAmount || 0 },
      ],
    };

    let response;
    try {
      const iwrsSrv = await cds.connect.to('IWRSIntegrationService');
      response = await iwrsSrv.send('receiveInvoiceEvent', iwrsPayload);
    } catch (err) {
      try {
        const iwrsAdapter = require('./external/iwrs-adapter');
        response = await iwrsAdapter.processInvoiceEvent(iwrsPayload);
      } catch (adapterErr) {
        response = { success: false, error: adapterErr.message };
      }
    }

    await _logEvent(db, {
      system: 'IWRS',
      direction: 'INBOUND',
      eventType: 'INVOICE_GENERATED',
      status: response?.success ? 'ACCEPTED' : 'FAILED',
      requestPayload: JSON.stringify(iwrsPayload),
      responsePayload: JSON.stringify(response),
      accountNumber: d.accountNumber,
      amount: d.totalAmount,
      processingMs: Date.now() - start,
    });

    return JSON.stringify({ success: true, result: response });
  });

  srv.on('simulateCounterPayment', async (req) => {
    const d = req.data;
    const start = Date.now();

    const iwrsPayload = {
      event_type: 'PAYMENT_RECEIVED',
      acc_no: d.accountNumber,
      receipt_no: d.receiptNumber || `RCP-${Date.now()}`,
      pay_date: new Date().toISOString().substring(0, 10),
      pay_time: new Date().toISOString().substring(11, 19),
      channel_code: d.channel || 'COUNTER_CASH',
      amount: d.amount,
      cashier_id: d.cashierID || 'COUNTER01',
      counter_code: 'SRB-C1',
      branch_code: 'SRB',
    };

    let response;
    try {
      const iwrsSrv = await cds.connect.to('IWRSIntegrationService');
      response = await iwrsSrv.send('receivePaymentEvent', iwrsPayload);
    } catch (err) {
      try {
        const iwrsAdapter = require('./external/iwrs-adapter');
        response = await iwrsAdapter.processPaymentEvent(iwrsPayload);
      } catch (adapterErr) {
        response = { success: false, error: adapterErr.message };
      }
    }

    await _logEvent(db, {
      system: 'IWRS',
      direction: 'INBOUND',
      eventType: 'COUNTER_PAYMENT',
      status: response?.success ? 'ACCEPTED' : 'FAILED',
      requestPayload: JSON.stringify(iwrsPayload),
      responsePayload: JSON.stringify(response),
      accountNumber: d.accountNumber,
      amount: d.amount,
      processingMs: Date.now() - start,
    });

    return JSON.stringify({ success: true, result: response });
  });

  // ════════════════════════════════════════════════════════════════════════
  // BANK STATEMENT SIMULATOR — Generate sample MT940 files
  // ════════════════════════════════════════════════════════════════════════

  srv.on('generateMT940', async (req) => {
    const { bankName, statementDate, transactionCount } = req.data;
    const count = transactionCount || 5;
    const date = statementDate || new Date().toISOString().substring(0, 10);
    const shortDate = date.replace(/-/g, '').substring(2); // YYMMDD

    // Get random accounts with outstanding balances for realistic transactions
    const accounts = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('accountNumber', 'legalName', 'balanceOutstanding')
        .where({ accountStatus: 'ACTIVE' })
        .limit(count)
    );

    // Build MT940 content
    let mt940 = '';
    mt940 += `:20:STMT${shortDate}\r\n`;
    mt940 += `:25:${bankName || 'MAYBANK'}0001234567\r\n`;
    mt940 += `:28C:1/1\r\n`;
    mt940 += `:60F:C${shortDate}MYR100000,00\r\n`;

    let totalCredit = 0;
    const txns = [];
    for (let i = 0; i < Math.min(count, accounts.length); i++) {
      const acc = accounts[i];
      const amt = Math.min(acc.balanceOutstanding || 50, 500).toFixed(2);
      totalCredit += parseFloat(amt);
      mt940 += `:61:${shortDate}${shortDate}C${amt.replace('.', ',')}NTRF${acc.accountNumber}\r\n`;
      mt940 += `:86:SAINS WATER BILL PAYMENT ${acc.accountNumber} ${acc.legalName}\r\n`;
      txns.push({ accountNumber: acc.accountNumber, amount: parseFloat(amt) });
    }

    const closingBalance = (100000 + totalCredit).toFixed(2).replace('.', ',');
    mt940 += `:62F:C${shortDate}MYR${closingBalance}\r\n`;
    mt940 += `-\r\n`;

    await _logEvent(db, {
      system: 'BANK',
      direction: 'INBOUND',
      eventType: 'MT940_GENERATED',
      status: 'SENT',
      requestPayload: JSON.stringify({ bankName, statementDate: date, transactionCount: count }),
      responsePayload: JSON.stringify({ fileName: `${bankName || 'MAYBANK'}_${shortDate}.mt940`, transactions: txns }),
      amount: totalCredit,
      processingMs: 0,
    });

    return JSON.stringify({
      success: true,
      mt940Content: mt940,
      fileName: `${bankName || 'MAYBANK'}_${shortDate}.mt940`,
      transactionCount: txns.length,
      totalAmount: totalCredit,
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // LHDN MYINVOIS SIMULATOR — Accept e-invoice submissions
  // ════════════════════════════════════════════════════════════════════════

  srv.on('simulateEInvoiceResponse', async (req) => {
    const { submissionBatchID, responseType } = req.data;
    const start = Date.now();

    // Update the submission batch status based on simulated response
    const batch = await db.run(
      SELECT.one.from('sains.ar.einvoice.EInvoiceSubmissionBatch').where({ ID: submissionBatchID })
    );

    if (!batch) return JSON.stringify({ success: false, error: 'Batch not found' });

    const lhdnUUID = uuidv4();
    const now = new Date().toISOString();

    if (responseType === 'ACCEPTED' || responseType === 'PARTIAL') {
      await db.run(
        UPDATE('sains.ar.einvoice.EInvoiceSubmissionBatch').set({
          status: responseType === 'ACCEPTED' ? 'FULLY_ACCEPTED' : 'PARTIALLY_ACCEPTED',
          lhdnSubmissionUID: lhdnUUID,
          acceptedAt: now,
        }).where({ ID: submissionBatchID })
      );

      // Update individual lines
      const lines = await db.run(
        SELECT.from('sains.ar.einvoice.EInvoiceSubmissionLine').where({ batch_ID: submissionBatchID })
      );
      for (const line of lines) {
        const accepted = responseType === 'ACCEPTED' || Math.random() > 0.3;
        await db.run(
          UPDATE('sains.ar.einvoice.EInvoiceSubmissionLine').set({
            status: accepted ? 'ACCEPTED' : 'REJECTED',
            lhdnUUID: accepted ? uuidv4() : null,
            cancelDeadline: accepted ? new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString() : null,
          }).where({ ID: line.ID })
        );
      }
    } else {
      await db.run(
        UPDATE('sains.ar.einvoice.EInvoiceSubmissionBatch').set({
          status: 'REJECTED',
          lhdnSubmissionUID: lhdnUUID,
        }).where({ ID: submissionBatchID })
      );
    }

    await _logEvent(db, {
      system: 'LHDN',
      direction: 'INBOUND',
      eventType: 'EINVOICE_RESPONSE',
      status: responseType,
      requestPayload: JSON.stringify({ submissionBatchID, responseType }),
      responsePayload: JSON.stringify({ lhdnUUID, submissionUID: lhdnUUID }),
      processingMs: Date.now() - start,
    });

    return JSON.stringify({ success: true, lhdnUUID, responseType });
  });

  // ════════════════════════════════════════════════════════════════════════
  // DUITNOW QR PAYMENT SIMULATOR
  // ════════════════════════════════════════════════════════════════════════

  srv.on('simulateDuitNowPayment', async (req) => {
    const { accountNumber, amount, transactionID } = req.data;
    const start = Date.now();

    const txnId = transactionID || `DN-${Date.now()}`;

    // Build webhook payload as PayNet would send it
    const webhookPayload = {
      merchantID: 'SAINS-001',
      billRef: accountNumber,
      amount: parseFloat(amount).toFixed(2),
      payerRef: `PAYER-${Date.now()}`,
      transDateTime: new Date().toISOString(),
      transactionID: txnId,
      status: 'SUCCESS',
    };

    // Call DuitNow adapter's webhook handler
    let response;
    try {
      const duitnowAdapter = require('./external/duitnow-adapter');
      response = await duitnowAdapter.processWebhookNotification(webhookPayload);
    } catch (err) {
      response = { success: false, error: err.message };
    }

    await _logEvent(db, {
      system: 'PAYNET_DUITNOW',
      direction: 'INBOUND',
      eventType: 'QR_PAYMENT',
      status: response?.success !== false ? 'ACCEPTED' : 'FAILED',
      requestPayload: JSON.stringify(webhookPayload),
      responsePayload: JSON.stringify(response),
      accountNumber,
      amount: parseFloat(amount),
      processingMs: Date.now() - start,
    });

    return JSON.stringify({ success: true, transactionID: txnId, result: response });
  });

  // ════════════════════════════════════════════════════════════════════════
  // FPX PAYMENT SIMULATOR
  // ════════════════════════════════════════════════════════════════════════

  srv.on('simulateFPXPayment', async (req) => {
    const { sellerOrderNo, amount, buyerBankId, status } = req.data;
    const start = Date.now();
    const fpxStatus = status || '00'; // 00 = approved

    // Build FPX IPN callback payload
    const ipnPayload = {
      fpx_msgType: 'AR',
      fpx_msgToken: 'extended',
      fpx_sellerOrderNo: sellerOrderNo,
      fpx_sellerExId: 'SAINS-FPX',
      fpx_txnStatus: fpxStatus,
      fpx_debitAuthCode: fpxStatus === '00' ? `AUTH-${Date.now()}` : '',
      fpx_debitAuthNo: fpxStatus === '00' ? String(Date.now()).slice(-8) : '',
      fpx_creditAuthCode: '',
      fpx_creditAuthNo: '',
      fpx_buyerBankId: buyerBankId || 'MBB0227',
      fpx_txnAmount: parseFloat(amount).toFixed(2),
      fpx_checkSum: 'SIMULATOR_BYPASS',
    };

    // Call FPX adapter's IPN handler
    let response;
    try {
      const fpxAdapter = require('./external/fpx-adapter');
      response = await fpxAdapter.processIPNNotification(ipnPayload, true); // true = skip signature check in simulator
    } catch (err) {
      response = { success: false, error: err.message };
    }

    await _logEvent(db, {
      system: 'PAYNET_FPX',
      direction: 'INBOUND',
      eventType: 'FPX_IPN',
      status: fpxStatus === '00' ? 'ACCEPTED' : 'REJECTED',
      requestPayload: JSON.stringify(ipnPayload),
      responsePayload: JSON.stringify(response),
      amount: parseFloat(amount),
      processingMs: Date.now() - start,
    });

    return JSON.stringify({ success: fpxStatus === '00', result: response });
  });

  // ════════════════════════════════════════════════════════════════════════
  // JOMPAY BATCH SIMULATOR — Generate reconciliation CSV
  // ════════════════════════════════════════════════════════════════════════

  srv.on('generateJomPAYFile', async (req) => {
    const { batchDate, transactionCount } = req.data;
    const count = transactionCount || 5;
    const date = batchDate || new Date().toISOString().substring(0, 10);
    const dateCompact = date.replace(/-/g, '');

    // Get random active accounts for realistic transactions
    const accounts = await db.run(
      SELECT.from('sains.ar.CustomerAccount')
        .columns('accountNumber', 'legalName', 'balanceOutstanding')
        .where({ accountStatus: 'ACTIVE', balanceOutstanding: { '>': 0 } })
        .limit(count)
    );

    // Build CSV content (PayNet JomPAY standard format)
    let csv = 'DATE,TIME,BILL_REF,PAYER_NAME,PAYER_BANK,AMOUNT,JOMPAY_REF,FPX_TOKEN\n';
    const lines = [];

    for (let i = 0; i < Math.min(count, accounts.length); i++) {
      const acc = accounts[i];
      const amt = Math.min(acc.balanceOutstanding || 50, 300).toFixed(2);
      const time = `${String(8 + i).padStart(2, '0')}${String(Math.floor(Math.random() * 60)).padStart(2, '0')}00`;
      const jompayRef = `JP${dateCompact}${String(i + 1).padStart(6, '0')}`;
      const fpxToken = `FPX${Date.now()}${i}`;

      csv += `${dateCompact},${time},${acc.accountNumber},${acc.legalName},MBB,${amt},${jompayRef},${fpxToken}\n`;
      lines.push({ accountNumber: acc.accountNumber, amount: parseFloat(amt), jompayRef });
    }

    await _logEvent(db, {
      system: 'PAYNET_JOMPAY',
      direction: 'INBOUND',
      eventType: 'JOMPAY_FILE_GENERATED',
      status: 'SENT',
      requestPayload: JSON.stringify({ batchDate: date, transactionCount: count }),
      responsePayload: JSON.stringify({ lines }),
      processingMs: 0,
    });

    return JSON.stringify({
      success: true,
      csvContent: csv,
      fileName: `SAINS_JOMPAY_${dateCompact}.csv`,
      transactionCount: lines.length,
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // EMANDATE SIMULATOR
  // ════════════════════════════════════════════════════════════════════════

  srv.on('simulateMandateRegistered', async (req) => {
    const { mandateRef, bankCode, status } = req.data;
    const mandateStatus = status || 'ACTIVE';

    // Update the eMandate record in AR Hub
    const mandate = await db.run(
      SELECT.one.from('sains.ar.payment.eMandate').where({ mandateRef })
    );

    if (mandate) {
      await db.run(
        UPDATE('sains.ar.payment.eMandate').set({
          status: mandateStatus,
          mandateID: `PAYNET-MD-${Date.now()}`,
          bankCode: bankCode || 'MBB0227',
          registeredAt: new Date().toISOString(),
        }).where({ mandateRef })
      );
    }

    await _logEvent(db, {
      system: 'PAYNET_EMANDATE',
      direction: 'INBOUND',
      eventType: 'MANDATE_REGISTERED',
      status: mandateStatus,
      requestPayload: JSON.stringify({ mandateRef, bankCode, status: mandateStatus }),
      responsePayload: JSON.stringify({ mandateRef, mandateID: `PAYNET-MD-${Date.now()}` }),
    });

    return JSON.stringify({ success: true, mandateRef, status: mandateStatus });
  });

  srv.on('simulateDebitResult', async (req) => {
    const { mandateID, amount, returnCode } = req.data;
    const code = returnCode || 'SUCCESS';

    await _logEvent(db, {
      system: 'PAYNET_EMANDATE',
      direction: 'INBOUND',
      eventType: 'DEBIT_RESULT',
      status: code === 'SUCCESS' ? 'ACCEPTED' : 'REJECTED',
      requestPayload: JSON.stringify({ mandateID, amount, returnCode: code }),
      responsePayload: JSON.stringify({ transactionId: `DD-${Date.now()}`, returnCode: code }),
      amount: parseFloat(amount),
    });

    return JSON.stringify({ success: code === 'SUCCESS', returnCode: code });
  });

  // ════════════════════════════════════════════════════════════════════════
  // METIS WORK ORDER SIMULATOR
  // ════════════════════════════════════════════════════════════════════════

  srv.on('simulateWorkOrderCompleted', async (req) => {
    const { workOrderRef, completionDate, completionType } = req.data;
    const start = Date.now();

    // Find the MetisWorkOrder in AR Hub
    const wo = await db.run(
      SELECT.one.from('sains.ar.integration.MetisWorkOrder').where({ metisWorkOrderRef: workOrderRef })
    );

    if (!wo) {
      // Try by internal reference
      const woByInternal = await db.run(
        SELECT.one.from('sains.ar.integration.MetisWorkOrder').where({ ID: workOrderRef })
      );
      if (!woByInternal) {
        return JSON.stringify({ success: false, error: `Work order ${workOrderRef} not found` });
      }
    }

    const targetWO = wo || await db.run(
      SELECT.one.from('sains.ar.integration.MetisWorkOrder').where({ ID: workOrderRef })
    );

    // Call the iWRS integration service to process completion
    const completionPayload = {
      workOrderRef: targetWO.metisWorkOrderRef || workOrderRef,
      completionDate: completionDate || new Date().toISOString().substring(0, 10),
      completionType: completionType || 'DISCONNECTED',
    };

    let response;
    try {
      const iwrsSrv = await cds.connect.to('IWRSIntegrationService');
      response = await iwrsSrv.send('receiveMetisCompletion', completionPayload);
    } catch (err) {
      response = { success: false, error: err.message };
    }

    await _logEvent(db, {
      system: 'METIS',
      direction: 'INBOUND',
      eventType: `WORK_ORDER_${completionType || 'COMPLETED'}`,
      status: response?.success ? 'ACCEPTED' : 'FAILED',
      requestPayload: JSON.stringify(completionPayload),
      responsePayload: JSON.stringify(response),
      processingMs: Date.now() - start,
    });

    return JSON.stringify({ success: true, result: response });
  });

  // ════════════════════════════════════════════════════════════════════════
  // DASHBOARD SUMMARY
  // ════════════════════════════════════════════════════════════════════════

  srv.on('getDashboardSummary', async () => {
    const [total] = await db.run(SELECT.from('sains.simulator.EventLog').columns('count(*) as count'));
    const [iwrs] = await db.run(SELECT.from('sains.simulator.EventLog').where({ system: 'IWRS' }).columns('count(*) as count'));
    const [payment] = await db.run(SELECT.from('sains.simulator.EventLog').where({ system: { like: 'PAYNET%' } }).columns('count(*) as count'));
    const [einvoice] = await db.run(SELECT.from('sains.simulator.EventLog').where({ system: 'LHDN' }).columns('count(*) as count'));
    const [gl] = await db.run(SELECT.from('sains.simulator.GLPostingLog').columns('count(*) as count'));
    const [notif] = await db.run(SELECT.from('sains.simulator.NotificationInbox').columns('count(*) as count'));

    const lastEvent = await db.run(
      SELECT.one.from('sains.simulator.EventLog').columns('createdAt').orderBy({ createdAt: 'desc' })
    );

    return {
      totalEvents: total?.count || 0,
      iwrsEvents: iwrs?.count || 0,
      paymentEvents: payment?.count || 0,
      einvoiceEvents: einvoice?.count || 0,
      glPostings: gl?.count || 0,
      notifications: notif?.count || 0,
      lastEventAt: lastEvent?.createdAt || null,
    };
  });

  // ════════════════════════════════════════════════════════════════════════
  // HELPER: Log simulator events
  // ════════════════════════════════════════════════════════════════════════

  async function _logEvent(db, event) {
    try {
      await db.run(INSERT.into('sains.simulator.EventLog').entries({
        ID: uuidv4(),
        ...event,
      }));
    } catch (err) {
      logger.warn(`Failed to log simulator event: ${err.message}`);
    }
  }
};
