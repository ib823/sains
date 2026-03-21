'use strict';

const cds = require('@sap/cds');
const { v4: uuidv4 } = require('uuid');

const logger = cds.log('audit-logger');

/**
 * Log a user-initiated action to the audit trail.
 *
 * @param {Object} req         - CDS request object
 * @param {String} actionType  - Action type identifier
 * @param {String} entityType  - Target entity type
 * @param {UUID}   entityID    - Target entity ID
 * @param {Object} [beforeState] - State before action
 * @param {Object} [afterState]  - State after action
 * @param {UUID}   [accountID]   - Associated account ID
 */
async function logAction(req, actionType, entityType, entityID, beforeState, afterState, accountID) {
  try {
    const db = await cds.connect.to('db');
    const { AuditTrailEntry } = db.entities('sains.ar');

    const entry = {
      ID: uuidv4(),
      account_ID: accountID || null,
      timestamp: new Date().toISOString(),
      userID: req.user?.id || 'SYSTEM',
      userRole: _extractRole(req),
      actionType,
      entityType,
      entityID,
      beforeState: beforeState ? JSON.stringify(createStateSnapshot(beforeState)) : null,
      afterState: afterState ? JSON.stringify(createStateSnapshot(afterState)) : null,
      sourceSystem: 'BTP_INTERNAL',
      authorisedBy: req.user?.id || null,
      authorisedAt: new Date().toISOString(),
      sessionID: req.headers?.['x-session-id'] || null,
      ipAddress: req.headers?.['x-forwarded-for'] || req.headers?.['remote-address'] || null,
    };

    await db.run(INSERT.into(AuditTrailEntry).entries(entry));
    logger.info(`Audit: ${actionType} on ${entityType}(${entityID}) by ${entry.userID}`);
  } catch (error) {
    logger.error(`Audit log failed for ${actionType}: ${error.message}`);
    // Audit logging failure must not break the business transaction
  }
}

/**
 * Log a system-initiated action (no user request context).
 */
async function logSystemAction(actionType, entityType, entityID, details, accountID) {
  try {
    const db = await cds.connect.to('db');
    const { AuditTrailEntry } = db.entities('sains.ar');

    const entry = {
      ID: uuidv4(),
      account_ID: accountID || null,
      timestamp: new Date().toISOString(),
      userID: 'SYSTEM',
      userRole: 'SystemProcess',
      actionType,
      entityType,
      entityID,
      beforeState: null,
      afterState: details ? JSON.stringify(createStateSnapshot(details)) : null,
      sourceSystem: 'BTP_INTERNAL',
    };

    await db.run(INSERT.into(AuditTrailEntry).entries(entry));
  } catch (error) {
    logger.error(`System audit log failed for ${actionType}: ${error.message}`);
  }
}

/**
 * Create a snapshot of an entity state for audit purposes.
 * Redacts the `idNumber` field, replacing with '***REDACTED***'.
 *
 * @param {Object} state - Entity state object
 * @returns {Object} Redacted copy
 */
function createStateSnapshot(state) {
  if (!state) return null;
  const snapshot = { ...state };

  // Redact IC number — PDPA compliance
  if ('idNumber' in snapshot) {
    snapshot.idNumber = '***REDACTED***';
  }

  // Deep redact in nested objects
  for (const key of Object.keys(snapshot)) {
    if (snapshot[key] && typeof snapshot[key] === 'object' && !Array.isArray(snapshot[key])) {
      if ('idNumber' in snapshot[key]) {
        snapshot[key] = { ...snapshot[key], idNumber: '***REDACTED***' };
      }
    }
  }

  return snapshot;
}

function _extractRole(req) {
  if (!req.user) return 'UNKNOWN';
  const roles = ['CFO', 'FinanceManager', 'FinanceSupervisor', 'FinanceAdmin',
    'BILSupervisor', 'BILStaff', 'CounterStaff', 'ICTManager', 'Auditor', 'SystemProcess'];
  for (const role of roles) {
    if (req.user.is(role)) return role;
  }
  return req.user.id || 'authenticated-user';
}

module.exports = { logAction, logSystemAction, createStateSnapshot };
