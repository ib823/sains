'use strict';

/**
 * Valid invoice status transitions.
 * Any transition not listed here will be rejected.
 */
const VALID_INVOICE_TRANSITIONS = Object.freeze({
  OPEN:        ['PARTIAL', 'CLEARED', 'DISPUTED', 'REVERSED', 'CANCELLED', 'HELD', 'HELD_NO_TIN'],
  PARTIAL:     ['CLEARED', 'DISPUTED', 'REVERSED'],
  CLEARED:     ['REVERSED'],
  DISPUTED:    ['OPEN', 'PARTIAL', 'CLEARED', 'REVERSED'],
  REVERSED:    [], // terminal
  CANCELLED:   [], // terminal
  HELD:        ['OPEN'],
  HELD_NO_TIN: ['OPEN'],
});

/**
 * Validate an invoice status transition.
 * @param {string} currentStatus
 * @param {string} newStatus
 * @throws {Error} if the transition is invalid
 */
function validateInvoiceTransition(currentStatus, newStatus) {
  if (currentStatus === newStatus) return; // no-op
  const allowed = VALID_INVOICE_TRANSITIONS[currentStatus];
  if (!allowed) {
    throw new Error(`Unknown invoice status: ${currentStatus}`);
  }
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid invoice status transition: ${currentStatus} → ${newStatus}. Allowed: ${allowed.join(', ') || 'none (terminal state)'}`);
  }
}

module.exports = { validateInvoiceTransition, VALID_INVOICE_TRANSITIONS };
