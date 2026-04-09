'use strict';

/**
 * Validates that critical environment variables are set and not TBC placeholders.
 * Called on server startup. In production, missing required vars cause a startup failure.
 * In development, they produce warnings.
 */

const TBC_PATTERN = /\/\*\s*TBC:/;

function isTBCPlaceholder(value) {
  return !value || TBC_PATTERN.test(value);
}

/**
 * Validate environment configuration on startup.
 * @param {Object} options
 * @param {boolean} options.strict - If true (production), throw on missing required vars.
 *                                   If false (development), only warn.
 */
function validateEnvironment(options = {}) {
  const logger = require('@sap/cds').log('env-validation');
  // Strict mode = real BTP production (VCAP_SERVICES always present on Cloud Foundry).
  // NODE_ENV=production alone (fly.io, Railway, Render) is treated as staging — warn, don't throw.
  const isProduction = options.strict
    ?? (!!process.env.VCAP_SERVICES);

  const results = { errors: [], warnings: [] };

  // ── CRITICAL: Required for core functionality ─────────────────────────
  const requiredInProduction = [
    { name: 'MYINVOIS_CLIENT_ID',     description: 'LHDN MyInvois OAuth Client ID' },
    { name: 'MYINVOIS_CLIENT_SECRET', description: 'LHDN MyInvois OAuth Client Secret' },
    { name: 'SAINS_TIN',             description: 'SAINS Tax Identification Number' },
    { name: 'SAINS_REGISTRATION_NUMBER', description: 'SAINS Company Registration Number' },
    { name: 'FPX_SELLER_EXCHANGE_ID', description: 'FPX Seller Exchange ID from PayNet' },
    { name: 'DUITNOW_MERCHANT_ID',    description: 'DuitNow Merchant ID from PayNet' },
    { name: 'DUITNOW_WEBHOOK_SECRET', description: 'DuitNow webhook HMAC secret' },
    { name: 'FPX_WEBHOOK_SECRET',     description: 'FPX webhook verification secret' },
    { name: 'ENCRYPTION_KEY',         description: 'AES-256 encryption key for PII' },
  ];

  // ── HIGH: Required for payment integrations ───────────────────────────
  const highPriority = [
    { name: 'JOMPAY_BILLER_CODE',    description: 'JomPAY Biller Code from PayNet' },
    { name: 'EMANDATE_MERCHANT_ID',  description: 'eMandate Merchant ID' },
    { name: 'WHATSAPP_API_TOKEN',    description: 'WhatsApp Business API token' },
  ];

  // ── MEDIUM: Required for external integrations ────────────────────────
  const mediumPriority = [
    { name: 'MYINVOIS_BASE_URL',     description: 'LHDN MyInvois API URL' },
    { name: 'APP_URL',               description: 'Application URL for scheduled jobs' },
  ];

  for (const v of requiredInProduction) {
    if (isTBCPlaceholder(process.env[v.name])) {
      if (isProduction) {
        results.errors.push(`MISSING REQUIRED: ${v.name} — ${v.description}`);
      } else {
        results.warnings.push(`[dev] ${v.name} not set — ${v.description}`);
      }
    }
  }

  for (const v of highPriority) {
    if (isTBCPlaceholder(process.env[v.name])) {
      results.warnings.push(`${v.name} not set — ${v.description}`);
    }
  }

  for (const v of mediumPriority) {
    if (isTBCPlaceholder(process.env[v.name])) {
      results.warnings.push(`${v.name} not set — ${v.description}`);
    }
  }

  // Log results
  for (const w of results.warnings) {
    logger.warn(w);
  }
  for (const e of results.errors) {
    logger.error(e);
  }

  if (results.errors.length > 0 && isProduction) {
    throw new Error(
      `Environment validation failed — ${results.errors.length} required variable(s) missing:\n` +
      results.errors.map(e => `  - ${e}`).join('\n') +
      '\nSet these environment variables or bind the required BTP services before deploying.'
    );
  }

  if (results.warnings.length > 0) {
    logger.warn(`${results.warnings.length} environment variable(s) not configured — some integrations will use placeholders`);
  }

  return results;
}

module.exports = { validateEnvironment, isTBCPlaceholder };
