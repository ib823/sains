'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const crypto = require('crypto');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('myinvois-adapter');

const MYINVOIS_CONFIG = {
  BASE_URL: process.env.MYINVOIS_BASE_URL
    || 'https://api.myinvois.hasil.gov.my',  // Production URL from LHDN SDK
  CLIENT_ID: process.env.MYINVOIS_CLIENT_ID
    || '/* TBC: SAINS MyInvois Client ID from LHDN MyInvois portal */',
  CLIENT_SECRET: process.env.MYINVOIS_CLIENT_SECRET
    || '/* TBC: SAINS MyInvois Client Secret — store in BTP Credential Store */',
  SAINS_TIN: process.env.SAINS_TIN
    || '/* TBC: SAINS Tax Identification Number */',
  SAINS_REGISTRATION_NUMBER: process.env.SAINS_REGISTRATION_NUMBER
    || '/* TBC: SAINS Company Registration Number */',
  SAINS_SST_NUMBER: process.env.SAINS_SST_NUMBER
    || '/* TBC: SAINS SST Registration Number */',
  SAINS_LEGAL_NAME: 'Syarikat Air Negeri Sembilan Sdn Bhd',
  SAINS_ADDRESS: {
    addressLine0: '/* TBC: SAINS registered address line 1 */',
    addressLine1: '/* TBC: SAINS registered address line 2 */',
    addressLine2: '',
    postalZone: '70100',
    cityName: 'Seremban',
    state: '08',      // Negeri Sembilan LHDN state code
    countryCode: 'MYS',
    countrySubentityCode: 'MY-NS',
  },
  CERT_KEYSTORE_REF: '/* TBC: BTP Credential Store key name for SAINS digital certificate */',
  // Rate limiting: 100 requests per minute
  RATE_LIMIT_PER_MINUTE: 100,
  MAX_INVOICES_PER_SUBMISSION: 100,
  MAX_SUBMISSION_SIZE_BYTES: 5 * 1024 * 1024,  // 5 MB
  MAX_INVOICE_SIZE_BYTES: 300 * 1024,           // 300 KB
  CANCELLATION_WINDOW_HOURS: 72,
  B2C_PLACEHOLDER_TIN: 'EI00000000010',
  B2C_PLACEHOLDER_NAME: 'General Public',
};

// Token cache — reuse for up to 50 minutes (token valid 60 min)
// Uses a pending-promise pattern to prevent concurrent duplicate token requests
let _tokenCache = null;
let _tokenExpiry = null;
let _tokenPending = null;

/**
 * Get OAuth2 access token for LHDN MyInvois API.
 * Tokens are cached for 50 minutes (LHDN tokens valid for 60 minutes).
 * Concurrent callers share a single in-flight token request.
 */
async function getAccessToken() {
  if (_tokenCache && _tokenExpiry && new Date() < _tokenExpiry) {
    return _tokenCache;
  }

  // If a token request is already in-flight, wait for it instead of issuing a duplicate
  if (_tokenPending) {
    return _tokenPending;
  }

  _tokenPending = _fetchToken();
  try {
    return await _tokenPending;
  } finally {
    _tokenPending = null;
  }
}

async function _fetchToken() {
  try {
    const response = await axios.post(
      `${MYINVOIS_CONFIG.BASE_URL}/connect/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: MYINVOIS_CONFIG.CLIENT_ID,
        client_secret: MYINVOIS_CONFIG.CLIENT_SECRET,
        scope: 'InvoicingAPI',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
      }
    );

    _tokenCache = response.data.access_token;
    _tokenExpiry = new Date(Date.now() + 50 * 60 * 1000); // 50 minutes
    return _tokenCache;

  } catch (error) {
    // Clear cache on error so next call retries
    _tokenCache = null;
    _tokenExpiry = null;
    const msg = error.response?.data?.error_description || error.message;
    throw new Error(`MyInvois token error: ${msg}`);
  }
}

/**
 * Build a LHDN MyInvois UBL 2.1 JSON document for an AR Hub invoice.
 * Implements the full mandatory field set from LHDN SDK documentation.
 *
 * @param {Object} invoice     - ar.Invoice with line items expanded
 * @param {Object} account     - ar.CustomerAccount
 * @param {Array}  lineItems   - ar.InvoiceLineItem records
 * @param {String} documentUUID - Caller-supplied UUID for this document
 * @returns {Object} LHDN UBL JSON document
 */
function buildInvoiceDocument(invoice, account, lineItems, documentUUID) {
  const invoiceDate = invoice.invoiceDate;
  const invoiceTime = '00:00:00Z'; // SAINS bills do not have a specific time
  const currencyCode = 'MYR';
  const taxCurrencyCode = 'MYR';

  // Determine buyer details
  const isB2C = !account.buyerTINVerified || account.accountType_code === 'DOM';
  const buyerTIN = isB2C ? MYINVOIS_CONFIG.B2C_PLACEHOLDER_TIN : (account.buyerTIN || MYINVOIS_CONFIG.B2C_PLACEHOLDER_TIN);
  const buyerName = isB2C ? MYINVOIS_CONFIG.B2C_PLACEHOLDER_NAME : account.legalName;
  const buyerIDType = account.holderType === 'COMPANY' ? 'BRN' : 'NRIC';
  const buyerIDValue = account.idNumberMasked || '000000000000';

  // Invoice type code: 01 = Invoice, 02 = Credit Note, 03 = Debit Note
  const invoiceTypeCode = invoice.invoiceType === 'CREDIT_NOTE' ? '02'
    : invoice.invoiceType === 'DEBIT_NOTE' ? '03' : '01';

  // Calculate totals
  const taxExclusiveAmount = lineItems.reduce((s, l) =>
    s + Number(l.lineAmount) - Number(l.taxAmount || 0), 0);
  const totalTaxAmount = lineItems.reduce((s, l) => s + Number(l.taxAmount || 0), 0);
  const totalPayableAmount = Number(invoice.totalAmount);
  const totalDiscountAmount = lineItems.reduce((s, l) => s + Number(l.discountAmount || 0), 0);

  const doc = {
    "_D": "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
    "_A": "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
    "_B": "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
    "Invoice": [{
      "ID": [{ "_": invoice.invoiceNumber }],
      "IssueDate": [{ "_": invoiceDate }],
      "IssueTime": [{ "_": invoiceTime }],
      "InvoiceTypeCode": [{ "_": invoiceTypeCode, "listVersionID": "1.0" }],
      "DocumentCurrencyCode": [{ "_": currencyCode }],
      "TaxCurrencyCode": [{ "_": taxCurrencyCode }],
      "UUID": [{ "_": documentUUID }],
      "InvoicePeriod": [{
        "StartDate": [{ "_": invoice.billingPeriodFrom || invoiceDate }],
        "EndDate": [{ "_": invoice.billingPeriodTo || invoiceDate }],
        "Description": [{ "_": "Billing Period" }],
      }],
      "AccountingSupplierParty": [{
        "Party": [{
          "IndustryClassificationCode": [{ "_": "36000", "name": "Water collection, treatment and supply" }],
          "PartyIdentification": [
            { "ID": [{ "_": MYINVOIS_CONFIG.SAINS_TIN, "schemeID": "TIN" }] },
            { "ID": [{ "_": MYINVOIS_CONFIG.SAINS_REGISTRATION_NUMBER, "schemeID": "BRN" }] },
            { "ID": [{ "_": MYINVOIS_CONFIG.SAINS_SST_NUMBER, "schemeID": "SST" }] },
          ],
          "PartyName": [{ "Name": [{ "_": MYINVOIS_CONFIG.SAINS_LEGAL_NAME }] }],
          "PostalAddress": [{
            "AddressLine": [
              { "Line": [{ "_": MYINVOIS_CONFIG.SAINS_ADDRESS.addressLine0 }] },
              { "Line": [{ "_": MYINVOIS_CONFIG.SAINS_ADDRESS.addressLine1 }] },
              { "Line": [{ "_": MYINVOIS_CONFIG.SAINS_ADDRESS.addressLine2 }] },
            ],
            "PostalZone": [{ "_": MYINVOIS_CONFIG.SAINS_ADDRESS.postalZone }],
            "CityName": [{ "_": MYINVOIS_CONFIG.SAINS_ADDRESS.cityName }],
            "CountrySubentityCode": [{ "_": MYINVOIS_CONFIG.SAINS_ADDRESS.countrySubentityCode }],
            "Country": [{ "IdentificationCode": [{ "_": MYINVOIS_CONFIG.SAINS_ADDRESS.countryCode }] }],
          }],
          "PartyLegalEntity": [{ "RegistrationName": [{ "_": MYINVOIS_CONFIG.SAINS_LEGAL_NAME }] }],
          "Contact": [{ "Telephone": [{ "_": "/* TBC: SAINS customer service phone */" }],
                         "ElectronicMail": [{ "_": "/* TBC: SAINS billing email */" }] }],
        }],
      }],
      "AccountingCustomerParty": [{
        "Party": [{
          "PartyIdentification": [
            { "ID": [{ "_": buyerTIN, "schemeID": "TIN" }] },
            { "ID": [{ "_": buyerIDValue, "schemeID": buyerIDType }] },
          ],
          "PartyName": [{ "Name": [{ "_": buyerName }] }],
          "PostalAddress": [{
            "AddressLine": [
              { "Line": [{ "_": account.serviceAddress1 || 'N/A' }] },
              { "Line": [{ "_": account.serviceAddress2 || '' }] },
            ],
            "PostalZone": [{ "_": account.servicePostcode || '00000' }],
            "CityName": [{ "_": account.serviceCity || 'N/A' }],
            "CountrySubentityCode": [{ "_": 'MY-NS' }],
            "Country": [{ "IdentificationCode": [{ "_": 'MYS' }] }],
          }],
          "PartyLegalEntity": [{ "RegistrationName": [{ "_": buyerName }] }],
          "Contact": [{
            "Telephone": [{ "_": account.primaryPhone || 'N/A' }],
            "ElectronicMail": [{ "_": account.emailAddress || 'N/A' }],
          }],
        }],
      }],
      "TaxTotal": [{
        "TaxAmount": [{ "_": totalTaxAmount.toFixed(2), "currencyID": currencyCode }],
        "TaxSubtotal": [{
          "TaxableAmount": [{ "_": taxExclusiveAmount.toFixed(2), "currencyID": currencyCode }],
          "TaxAmount": [{ "_": totalTaxAmount.toFixed(2), "currencyID": currencyCode }],
          "TaxCategory": [{
            "ID": [{ "_": totalTaxAmount === 0 ? "E" : "S" }],
            "TaxExemptionReason": [{ "_": totalTaxAmount === 0 ? "Exempt Supply" : "" }],
            "TaxScheme": [{ "ID": [{ "_": "OTH", "schemeID": "UN/ECE 5153", "schemeAgencyID": "6" }] }],
          }],
        }],
      }],
      "LegalMonetaryTotal": [{
        "LineExtensionAmount": [{ "_": taxExclusiveAmount.toFixed(2), "currencyID": currencyCode }],
        "TaxExclusiveAmount": [{ "_": taxExclusiveAmount.toFixed(2), "currencyID": currencyCode }],
        "TaxInclusiveAmount": [{ "_": totalPayableAmount.toFixed(2), "currencyID": currencyCode }],
        "AllowanceTotalAmount": [{ "_": totalDiscountAmount.toFixed(2), "currencyID": currencyCode }],
        "PayableAmount": [{ "_": totalPayableAmount.toFixed(2), "currencyID": currencyCode }],
      }],
      "InvoiceLine": lineItems.map((line, idx) => ({
        "ID": [{ "_": String(idx + 1) }],
        "InvoicedQuantity": [{ "_": Number(line.quantity || 1).toFixed(4), "unitCode": line.unitCode || 'C62' }],
        "LineExtensionAmount": [{ "_": (Number(line.lineAmount) - Number(line.taxAmount || 0)).toFixed(2), "currencyID": currencyCode }],
        "AllowanceCharge": line.discountAmount > 0 ? [{
          "ChargeIndicator": [{ "_": false }],
          "Amount": [{ "_": Number(line.discountAmount).toFixed(2), "currencyID": currencyCode }],
        }] : [],
        "TaxTotal": [{
          "TaxAmount": [{ "_": Number(line.taxAmount || 0).toFixed(2), "currencyID": currencyCode }],
          "TaxSubtotal": [{
            "TaxableAmount": [{ "_": (Number(line.lineAmount) - Number(line.taxAmount || 0)).toFixed(2), "currencyID": currencyCode }],
            "TaxAmount": [{ "_": Number(line.taxAmount || 0).toFixed(2), "currencyID": currencyCode }],
            "TaxCategory": [{
              "ID": [{ "_": line.taxCategory || 'E' }],
              "TaxScheme": [{ "ID": [{ "_": "OTH", "schemeID": "UN/ECE 5153", "schemeAgencyID": "6" }] }],
            }],
          }],
        }],
        "Item": [{
          "Description": [{ "_": (line.description || line.chargeType_code || 'Water Service').substring(0, 200) }],
          "CommodityClassification": [{ "ItemClassificationCode": [{ "_": "9800", "listID": "CLASS" }] }],
        }],
        "Price": [{
          "PriceAmount": [{ "_": Number(line.unitPrice || line.lineAmount).toFixed(8), "currencyID": currencyCode }],
        }],
        "ItemPriceExtension": [{
          "Amount": [{ "_": Number(line.lineAmount).toFixed(2), "currencyID": currencyCode }],
        }],
      })),
    }],
  };

  return doc;
}

/**
 * Sign a document with SAINS digital certificate.
 * LHDN requires SHA256withRSA digital signature.
 * Certificate obtained from MCMC-licensed CA (Pos Digicert / MSC Trustgate).
 *
 * @param {Object} document - UBL JSON document
 * @returns {Object} Signed document
 */
async function signDocument(document) {
  // TBC: Implement digital signature using node-forge or pkijs library
  // Steps:
  // 1. Load SAINS private key and certificate from BTP Credential Store
  // 2. Canonicalize the document (remove whitespace, sort keys)
  // 3. Compute SHA256 hash of canonical document
  // 4. Sign hash with RSA private key (SHA256withRSA)
  // 5. Add UBL digital signature block to document
  //
  // Reference: LHDN SDK Section 5 — Digital Signature Implementation

  logger.warn('Digital signature: TBC — implement with SAINS certificate after CA registration');
  return {
    ...document,
    _signatureStatus: 'TBC_PENDING_CERTIFICATE',
    // TBC: Add UBLExtensions > UBLExtension > ExtensionContent > Signature block
  };
}

/**
 * Submit documents to LHDN MyInvois API.
 * Maximum 100 documents per submission, 5 MB total.
 * Implements exponential backoff for rate limit errors (HTTP 429).
 *
 * @param {Array} documents - Array of { uuid, document } objects
 * @returns {{ submissionUID, acceptedDocuments, rejectedDocuments }}
 */
async function submitDocuments(documents) {
  if (documents.length === 0) throw new Error('No documents to submit');
  if (documents.length > MYINVOIS_CONFIG.MAX_INVOICES_PER_SUBMISSION) {
    throw new Error(`Exceeds max ${MYINVOIS_CONFIG.MAX_INVOICES_PER_SUBMISSION} documents per submission`);
  }

  const token = await getAccessToken();

  const payload = {
    documents: documents.map(d => ({
      format: 'JSON',
      documentHash: _sha256(JSON.stringify(d.document)),
      codeNumber: d.uuid,
      document: Buffer.from(JSON.stringify(d.document)).toString('base64'),
    })),
  };

  // Check payload size
  const payloadSize = JSON.stringify(payload).length;
  if (payloadSize > MYINVOIS_CONFIG.MAX_SUBMISSION_SIZE_BYTES) {
    throw new Error(`Submission size ${payloadSize} bytes exceeds 5MB limit`);
  }

  let attempt = 0;
  const maxAttempts = 5;
  const baseDelayMs = 1000;

  while (attempt < maxAttempts) {
    try {
      const response = await axios.post(
        `${MYINVOIS_CONFIG.BASE_URL}/api/v1.0/documentsubmissions/`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );

      return {
        submissionUID: response.data.submissionUid,
        acceptedDocuments: response.data.acceptedDocuments || [],
        rejectedDocuments: response.data.rejectedDocuments || [],
      };

    } catch (error) {
      const status = error.response?.status;

      if (status === 429) {
        // Rate limit: exponential backoff
        const delayMs = baseDelayMs * Math.pow(2, attempt);
        logger.warn(`LHDN rate limit hit, retrying in ${delayMs}ms (attempt ${attempt + 1})`);
        await _sleep(delayMs);
        attempt++;
        // Refresh token on retry
        _tokenCache = null;
        const newToken = await getAccessToken();
        error.config.headers['Authorization'] = `Bearer ${newToken}`;
        continue;
      }

      const msg = error.response?.data?.error?.message || error.message;
      logger.error(`LHDN submission failed (status ${status}): ${msg}`);
      throw new Error(`LHDN submission failed: ${msg}`);
    }
  }

  throw new Error('LHDN submission failed after maximum retries (rate limit)');
}

/**
 * Cancel a previously accepted e-invoice.
 * Only possible within 72 hours of the LHDN validation timestamp.
 * After 72 hours, a Credit Note must be issued instead.
 *
 * @param {String} lhdnUUID - LHDN-assigned document UUID
 * @param {String} reason   - Cancellation reason
 * @returns {{ success, errorMessage }}
 */
async function cancelDocument(lhdnUUID, reason) {
  const token = await getAccessToken();

  try {
    await axios.put(
      `${MYINVOIS_CONFIG.BASE_URL}/api/v1.0/documents/state/${lhdnUUID}/state`,
      {
        status: 'cancelled',
        reason: reason.substring(0, 500),
      },
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    return { success: true, errorMessage: null };

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    logger.error(`LHDN cancellation failed for ${lhdnUUID}: ${msg}`);
    return { success: false, errorMessage: msg };
  }
}

/**
 * Check if an invoice is still within the 72-hour cancellation window.
 *
 * @param {DateTime} validationDate - LHDN validation timestamp
 * @returns {Boolean}
 */
function isWithinCancellationWindow(validationDate) {
  const validatedAt = new Date(validationDate);
  const windowCloses = new Date(validatedAt.getTime() +
    MYINVOIS_CONFIG.CANCELLATION_WINDOW_HOURS * 60 * 60 * 1000);
  return new Date() < windowCloses;
}

/**
 * Get the cancellation deadline for a validated invoice.
 */
function getCancellationDeadline(validationDate) {
  const validatedAt = new Date(validationDate);
  return new Date(validatedAt.getTime() +
    MYINVOIS_CONFIG.CANCELLATION_WINDOW_HOURS * 60 * 60 * 1000);
}

/**
 * Build a consolidated B2C e-invoice for all domestic transactions in a period.
 * Uses placeholder TIN EI00000000010 and buyer name 'General Public'.
 *
 * @param {Date}  periodYear
 * @param {Number} periodMonth
 * @param {Array}  invoices    - All B2C invoices for the period
 * @returns {Object} UBL JSON document
 */
function buildConsolidatedB2CDocument(periodYear, periodMonth, invoices, documentUUID) {
  const periodStr = `${periodYear}-${String(periodMonth).padStart(2,'0')}`;
  const invoiceDate = new Date(periodYear, periodMonth - 1,
    new Date(periodYear, periodMonth, 0).getDate()  // Last day of month
  ).toISOString().substring(0, 10);

  const totalAmount = invoices.reduce((s, i) => s + Number(i.totalAmount), 0);
  const totalTax = invoices.reduce((s, i) => s + Number(i.taxAmount || 0), 0);
  const taxExclusive = totalAmount - totalTax;

  return buildInvoiceDocument(
    {
      invoiceNumber: `CONSOL-B2C-${periodStr}`,
      invoiceDate,
      billingPeriodFrom: `${periodStr}-01`,
      billingPeriodTo: invoiceDate,
      invoiceType: 'STANDARD',
      totalAmount,
      taxAmount: totalTax,
    },
    {
      buyerTINVerified: false,
      accountType_code: 'DOM',
      legalName: MYINVOIS_CONFIG.B2C_PLACEHOLDER_NAME,
      holderType: 'INDIVIDUAL',
      idNumberMasked: '000000000000',
      serviceAddress1: 'N/A',
      servicePostcode: '00000',
      serviceCity: 'N/A',
      primaryPhone: 'N/A',
      emailAddress: 'N/A',
    },
    [
      {
        description: `Consolidated Water Service Charges — ${periodStr}`,
        quantity: invoices.length,
        unitCode: 'C62',
        lineAmount: totalAmount,
        taxAmount: totalTax,
        taxCategory: 'E',
        unitPrice: totalAmount / Math.max(invoices.length, 1),
        discountAmount: 0,
      },
    ],
    documentUUID
  );
}

function _sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
  getAccessToken,
  buildInvoiceDocument,
  signDocument,
  submitDocuments,
  cancelDocument,
  isWithinCancellationWindow,
  getCancellationDeadline,
  buildConsolidatedB2CDocument,
  MYINVOIS_CONFIG,
};
