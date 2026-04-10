'use strict';

const cds = require('@sap/cds');
const axios = require('axios');
const crypto = require('crypto');
const forge = require('node-forge');
const { logSystemAction } = require('../lib/audit-logger');

const logger = cds.log('myinvois-adapter');

// Module-scope cache for the signing key/certificate.
// Dev: a self-signed cert is generated lazily on first call and reused.
// Prod: certificate loaded from BTP Credential Store via CERT_KEYSTORE_REF.
let _signingMaterial = null;

const MYINVOIS_CONFIG = {
  BASE_URL: process.env.MYINVOIS_BASE_URL
    || 'https://api.myinvois.hasil.gov.my',  // Production URL from LHDN SDK
  CLIENT_ID: process.env.MYINVOIS_CLIENT_ID
    || 'SAINS-MYINVOIS-SANDBOX-001', // MOCK: replace with production credentials from LHDN MyInvois registration
  CLIENT_SECRET: process.env.MYINVOIS_CLIENT_SECRET
    || 'mock-secret-replace-on-registration', // MOCK: replace with production credentials from LHDN MyInvois registration
  SAINS_TIN: process.env.SAINS_TIN
    || 'C20654321090', // MOCK: replace with production credentials from LHDN MyInvois registration
  SAINS_REGISTRATION_NUMBER: process.env.SAINS_REGISTRATION_NUMBER
    || '200001234567', // MOCK: replace with production credentials from LHDN MyInvois registration
  SAINS_SST_NUMBER: process.env.SAINS_SST_NUMBER
    || 'W10-2345-67890123', // MOCK: replace with production credentials from LHDN MyInvois registration
  SAINS_LEGAL_NAME: 'Syarikat Air Negeri Sembilan Sdn Bhd',
  SAINS_ADDRESS: {
    addressLine0: 'Wisma SAINS, Jalan Sungai Ujong', // MOCK: replace with production credentials from LHDN MyInvois registration
    addressLine1: '70000 Seremban, Negeri Sembilan', // MOCK: replace with production credentials from LHDN MyInvois registration
    addressLine2: '',
    postalZone: '70100',
    cityName: 'Seremban',
    state: '08',      // Negeri Sembilan LHDN state code
    countryCode: 'MYS',
    countrySubentityCode: 'MY-NS',
  },
  CERT_KEYSTORE_REF: 'sains-einvoice-signing-cert', // MOCK: replace with production credentials from LHDN MyInvois registration
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
          "Contact": [{ "Telephone": [{ "_": "+60677654321" }], // MOCK: confirm SAINS customer service phone with operations team
                         "ElectronicMail": [{ "_": "billing@sains.com.my" }] }], // MOCK: confirm SAINS billing email with operations team
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
  try {
    const material = await _getSigningMaterial();

    // 1. Build the canonical representation of the document for hashing.
    //    SANDBOX NOTE: LHDN production requires XML C14N exclusive canonicalization.
    //    For sandbox/POC we use deterministic JSON (sorted keys, no UBLExtensions).
    //    Production refinement: serialize to UBL XML and apply XML-DSIG C14N.
    const documentForHashing = { ...document };
    delete documentForHashing.UBLExtensions;
    delete documentForHashing._signatureStatus;
    const canonicalDocument = _canonicalJSON(documentForHashing);

    // 2. SHA-256 digest of the canonical document → DigestValue (base64).
    const digest = crypto.createHash('sha256').update(canonicalDocument, 'utf8').digest('base64');

    // 3. Build SignedInfo and serialize it for signing.
    const signedInfo = {
      SignatureMethod: { Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256' },
      Reference: [{
        URI: '',
        DigestMethod: { Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256' },
        DigestValue: digest,
      }],
    };
    const canonicalSignedInfo = _canonicalJSON(signedInfo);

    // 4. RSA-SHA256 signature over the serialized SignedInfo → SignatureValue (base64).
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(canonicalSignedInfo, 'utf8');
    const signatureValue = signer.sign(material.privateKeyPem, 'base64');

    // 5. Build the UBL Signature block with embedded X.509 KeyInfo.
    const signatureBlock = {
      UBLExtensions: [{
        UBLExtension: [{
          ExtensionURI: 'urn:oasis:names:specification:ubl:dsig:enveloped:xades',
          ExtensionContent: {
            UBLDocumentSignatures: {
              SignatureInformation: {
                ID: 'urn:oasis:names:specification:ubl:signature:1',
                ReferencedSignatureID: 'urn:oasis:names:specification:ubl:signature:Invoice',
                Signature: {
                  Id: 'signature',
                  SignedInfo: signedInfo,
                  SignatureValue: signatureValue,
                  KeyInfo: {
                    X509Data: {
                      X509Certificate: material.certBase64,
                      X509SubjectName: material.subjectDN,
                      X509IssuerSerial: {
                        X509IssuerName: material.issuerDN,
                        X509SerialNumber: material.serialNumber,
                      },
                    },
                  },
                },
              },
            },
          },
        }],
      }],
    };

    return {
      ...document,
      ...signatureBlock,
      _signatureStatus: material.isSelfSigned ? 'SIGNED_SELF_SIGNED_DEV' : 'SIGNED',
    };
  } catch (err) {
    logger.error(`signDocument failed: ${err.message}`);
    throw err;
  }
}

/**
 * Resolve the signing certificate + private key.
 * Production: load from BTP Credential Store via CERT_KEYSTORE_REF.
 * Dev: generate a self-signed RSA-2048 cert lazily and cache it.
 */
async function _getSigningMaterial() {
  if (_signingMaterial) return _signingMaterial;

  const keyRef = MYINVOIS_CONFIG.CERT_KEYSTORE_REF;
  const credstoreConfigured = keyRef && !keyRef.startsWith('/*') && _hasCredstoreBinding();

  if (credstoreConfigured) {
    // PRODUCTION PATH — load PEM cert + private key from BTP Credential Store.
    // The credential is expected to contain { certificate: <PEM>, privateKey: <PEM> }.
    const cred = await _fetchCredstoreEntry(keyRef);
    _signingMaterial = _materialFromPem(cred.certificate, cred.privateKey, false);
    logger.info('e-invoice signing: loaded production certificate from BTP Credential Store');
    return _signingMaterial;
  }

  // SANDBOX/DEV PATH — generate a self-signed certificate on first use.
  logger.warn('Using self-signed certificate for e-invoice signing — NOT valid for LHDN production submission');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    { name: 'commonName', value: 'SAINS AR Hub Dev' },
    { name: 'organizationName', value: MYINVOIS_CONFIG.SAINS_LEGAL_NAME },
    { name: 'countryName', value: 'MY' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const privateKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  _signingMaterial = _materialFromPem(certPem, privateKeyPem, true);
  return _signingMaterial;
}

function _materialFromPem(certPem, privateKeyPem, isSelfSigned) {
  const cert = forge.pki.certificateFromPem(certPem);
  const certDer = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const certBase64 = forge.util.encode64(certDer);
  const subjectDN = cert.subject.attributes.map(a => `${a.shortName || a.name}=${a.value}`).join(',');
  const issuerDN = cert.issuer.attributes.map(a => `${a.shortName || a.name}=${a.value}`).join(',');
  return {
    privateKeyPem,
    certBase64,
    subjectDN,
    issuerDN,
    serialNumber: cert.serialNumber,
    isSelfSigned,
  };
}

function _hasCredstoreBinding() {
  try {
    const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
    return Array.isArray(vcap.credstore) && vcap.credstore.length > 0;
  } catch {
    return false;
  }
}

async function _fetchCredstoreEntry(keyName) {
  // Production-only path. Real implementation reads VCAP_SERVICES.credstore[0].credentials
  // and calls the SAP Credential Store REST API. Implemented inline here so the function
  // signature stays callable; full retry/cache layering can be added in Phase 2.
  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const binding = vcap.credstore[0].credentials;
  const tokenResp = await axios.post(`${binding.url}/oauth/token`, 'grant_type=client_credentials', {
    auth: { username: binding.username, password: binding.password },
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const resp = await axios.get(
    `${binding.url}/api/v1/credentials/sains-ar-hub/${keyName}`,
    { headers: { Authorization: `Bearer ${tokenResp.data.access_token}` } }
  );
  return resp.data; // expected shape: { certificate, privateKey }
}

function _canonicalJSON(obj) {
  // Deterministic JSON: keys sorted recursively, no whitespace.
  // Sandbox-acceptable substitute for XML C14N.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(_canonicalJSON).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonicalJSON(obj[k])).join(',') + '}';
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
