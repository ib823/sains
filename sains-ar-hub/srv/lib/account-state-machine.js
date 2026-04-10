'use strict';

/**
 * Valid account status transitions.
 * Any transition not listed here will be rejected.
 */
const VALID_TRANSITIONS = Object.freeze({
  ACTIVE:             ['RESTRICTED', 'TEMP_DISCONNECTED', 'VOID', 'CLOSED'],
  RESTRICTED:         ['ACTIVE', 'TEMP_DISCONNECTED', 'LEGAL'],
  TEMP_DISCONNECTED:  ['ACTIVE', 'TERMINATED', 'LEGAL'],
  TERMINATED:         ['CLOSED'],
  CLOSED:             [], // terminal state
  LEGAL:              ['ACTIVE', 'TERMINATED', 'CLOSED'],
  VOID:               ['ACTIVE'],
});

/**
 * Validate an account status transition.
 * @param {string} currentStatus
 * @param {string} newStatus
 * @throws {Error} if the transition is invalid
 */
function validateTransition(currentStatus, newStatus) {
  if (currentStatus === newStatus) return; // no-op
  const allowed = VALID_TRANSITIONS[currentStatus];
  if (!allowed) {
    throw new Error(`Unknown account status: ${currentStatus}`);
  }
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid account status transition: ${currentStatus} → ${newStatus}. Allowed: ${allowed.join(', ') || 'none (terminal state)'}`);
  }
}

module.exports = { validateTransition, VALID_TRANSITIONS };
