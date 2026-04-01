/**
 * Simulator data model — POC only.
 * Captures all simulated external system events for the demo dashboard.
 * NOT deployed to production BTP.
 */
namespace sains.simulator;

using { cuid, managed } from '@sap/cds/common';

/**
 * Central event log for all simulator activity.
 */
entity EventLog : cuid, managed {
  system       : String(30);     // IWRS, LHDN, PAYNET_DUITNOW, PAYNET_FPX, PAYNET_JOMPAY, PAYNET_EMANDATE, METIS, SAP_GL, BANK, WHATSAPP, EMAIL, SMS
  direction    : String(10);     // INBOUND (external→AR Hub), OUTBOUND (AR Hub→external)
  eventType    : String(50);     // e.g., ACCOUNT_CREATED, INVOICE_GENERATED, PAYMENT_WEBHOOK, GL_POSTING
  status       : String(20);     // SENT, RECEIVED, ACCEPTED, REJECTED, FAILED
  requestPayload  : LargeString; // JSON of the request
  responsePayload : LargeString; // JSON of the response
  accountNumber   : String(20);  // For quick filtering
  amount          : Decimal(15,2);
  errorMessage    : String(500);
  processingMs    : Integer;     // Processing time in milliseconds
}

/**
 * Captures GL journal entries that AR Hub posts to "SAP".
 * In POC, sap-core-api.js returns mock success — this log captures what was sent.
 */
entity GLPostingLog : cuid, managed {
  batchID          : String(36);
  documentNumber   : String(20);
  companyCode      : String(10);
  documentDate     : Date;
  postingDate      : Date;
  documentType     : String(5);
  totalDebitAmount : Decimal(15,2);
  totalCreditAmount: Decimal(15,2);
  lineCount        : Integer;
  payload          : LargeString;  // Full OData V2 JSON payload
  status           : String(20);   // ACCEPTED, REJECTED
}

/**
 * Captures all outbound notifications (email, SMS, WhatsApp, postal).
 */
entity NotificationInbox : cuid, managed {
  channel      : String(20);      // EMAIL, SMS, WHATSAPP, POSTAL, SYSTEM_ALERT
  recipient    : String(200);
  subject      : String(500);
  body         : LargeString;
  templateName : String(100);     // For WhatsApp templates
  status       : String(20);      // SENT, DELIVERED, FAILED
  accountNumber: String(20);
  relatedEntity: String(100);     // e.g., "Invoice:INV-202601-00001"
}
