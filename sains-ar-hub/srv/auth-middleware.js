'use strict';

/**
 * Keycloak → CDS Role Mapping Middleware
 *
 * Maps Keycloak JWT token claims to CDS req.user.roles[] format.
 * Registered in ar-service.js bootstrap handler via:
 *   cds.on('bootstrap', app => app.use(authMiddleware));
 *
 * This middleware is no-op on BTP (XSUAA handles role mapping natively).
 * It activates only when Keycloak JWT format is detected (realm_access claim present).
 *
 * Token format — Keycloak:
 *   token.realm_access.roles[]  → CDS req.user.roles[]
 *   token.resource_access[clientId].roles[] → merged into req.user.roles[]
 *   token.preferred_username    → req.user.id
 *   token.sains_account_numbers → req.user.attr.sains_account_numbers
 *                                  (customer portal only)
 *
 * Token format — XSUAA (BTP):
 *   Already handled by @sap/xssec — this middleware passes through unchanged.
 */
module.exports = (req, res, next) => {
  try {
    // Only act if authInfo is present (CDS has already parsed the token)
    if (!req.authInfo) {
      next();
      return;
    }

    // Detect Keycloak token by presence of realm_access claim
    // XSUAA tokens do not have realm_access
    const token = req.authInfo.token
      || req.authInfo.getTokenInfo?.()?.getPayload?.()
      || {};

    if (!token.realm_access) {
      // Not a Keycloak token — XSUAA or other IdP, pass through unchanged
      next();
      return;
    }

    // Build role array from Keycloak claims
    const realmRoles = token.realm_access?.roles || [];
    const resourceRoles = Object.values(token.resource_access || {})
      .flatMap(r => r.roles || []);
    const allRoles = [...new Set([...realmRoles, ...resourceRoles])];

    // Apply to CDS request user
    req.user = req.user || {};
    req.user.roles = allRoles;
    req.user.id = token.preferred_username || token.sub || req.user.id || 'unknown';

    // Preserve existing attr or create it
    req.user.attr = req.user.attr || {};

    // Customer portal account numbers claim
    // Set by Keycloak custom claim mapper during customer authentication
    const accountNumbers = token.sains_account_numbers
      || token['sains_account_numbers'];
    if (accountNumbers) {
      req.user.attr.sains_account_numbers = Array.isArray(accountNumbers)
        ? accountNumbers
        : [accountNumbers];
    }

  } catch (err) {
    // Never block a request due to middleware error — log and continue
    const cds = require('@sap/cds');
    cds.log('auth-middleware').error(`Role mapping error: ${err.message}`);
  }

  next();
};
