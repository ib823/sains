'use strict';
const { describe, test, expect } = require('@jest/globals');
const { PAYMENT_CHANNEL } = require('../../srv/lib/constants');

describe('Phase 3 — Constants Updates', () => {

  describe('PAYMENT_CHANNEL', () => {
    test('contains all Phase 3 channel codes', () => {
      expect(PAYMENT_CHANNEL.DUITNOW_QR).toBe('DUITNOW_QR');
      expect(PAYMENT_CHANNEL.JOMPAY).toBe('JOMPAY');
      expect(PAYMENT_CHANNEL.EMANDATE).toBe('EMANDATE');
      expect(PAYMENT_CHANNEL.FPX).toBe('FPX');
    });

    test('contains all counter payment channels', () => {
      expect(PAYMENT_CHANNEL.COUNTER_CASH).toBe('COUNTER_CASH');
      expect(PAYMENT_CHANNEL.COUNTER_CHEQUE).toBe('COUNTER_CHEQUE');
      expect(PAYMENT_CHANNEL.COUNTER_CARD).toBe('COUNTER_CARD');
    });

    test('contains remaining channels', () => {
      expect(PAYMENT_CHANNEL.AGENT_COLLECTION).toBe('AGENT_COLLECTION');
      expect(PAYMENT_CHANNEL.BAYARAN_PUKAL).toBe('BAYARAN_PUKAL');
      expect(PAYMENT_CHANNEL.MANUAL_EFT).toBe('MANUAL_EFT');
      expect(PAYMENT_CHANNEL.SYSTEM_TRANSFER).toBe('SYSTEM_TRANSFER');
    });

    test('PORTAL_FPX is removed (Rule 6)', () => {
      expect(PAYMENT_CHANNEL.PORTAL_FPX).toBeUndefined();
    });

    test('PORTAL_CARD is removed (Rule 6)', () => {
      expect(PAYMENT_CHANNEL.PORTAL_CARD).toBeUndefined();
    });

    test('DIRECT_DEBIT is replaced by EMANDATE', () => {
      expect(PAYMENT_CHANNEL.DIRECT_DEBIT).toBeUndefined();
      expect(PAYMENT_CHANNEL.EMANDATE).toBe('EMANDATE');
    });

    test('is frozen (immutable)', () => {
      expect(Object.isFrozen(PAYMENT_CHANNEL)).toBe(true);
    });
  });
});
