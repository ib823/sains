'use strict';
const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');
const { validateEnvironment, isTBCPlaceholder } = require('../../srv/lib/env-validation');

describe('Environment Validation — Unit Tests', () => {

  const savedEnv = {};
  const trackedVars = [
    'MYINVOIS_CLIENT_ID', 'MYINVOIS_CLIENT_SECRET', 'SAINS_TIN',
    'SAINS_REGISTRATION_NUMBER', 'FPX_SELLER_EXCHANGE_ID', 'DUITNOW_MERCHANT_ID',
    'DUITNOW_WEBHOOK_SECRET', 'FPX_WEBHOOK_SECRET', 'ENCRYPTION_KEY',
    'NODE_ENV', 'VCAP_SERVICES',
  ];

  beforeEach(() => {
    trackedVars.forEach(v => {
      savedEnv[v] = process.env[v];
      delete process.env[v];
    });
  });

  afterEach(() => {
    trackedVars.forEach(v => {
      if (savedEnv[v] !== undefined) process.env[v] = savedEnv[v];
      else delete process.env[v];
    });
  });

  describe('isTBCPlaceholder', () => {
    test('detects TBC placeholder strings', () => {
      expect(isTBCPlaceholder('/* TBC: some config */')).toBe(true);
      expect(isTBCPlaceholder('/*  TBC: another */')).toBe(true);
    });

    test('returns true for null/undefined/empty', () => {
      expect(isTBCPlaceholder(null)).toBe(true);
      expect(isTBCPlaceholder(undefined)).toBe(true);
      expect(isTBCPlaceholder('')).toBe(true);
    });

    test('returns false for real values', () => {
      expect(isTBCPlaceholder('abc123')).toBe(false);
      expect(isTBCPlaceholder('my-secret-key')).toBe(false);
    });
  });

  describe('validateEnvironment — development mode', () => {
    test('returns warnings (not errors) in dev mode when vars missing', () => {
      const result = validateEnvironment({ strict: false });
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    test('returns no warnings when all required vars are set', () => {
      process.env.MYINVOIS_CLIENT_ID = 'test-id';
      process.env.MYINVOIS_CLIENT_SECRET = 'test-secret';
      process.env.SAINS_TIN = 'test-tin';
      process.env.SAINS_REGISTRATION_NUMBER = 'test-reg';
      process.env.FPX_SELLER_EXCHANGE_ID = 'test-fpx';
      process.env.DUITNOW_MERCHANT_ID = 'test-dn';
      process.env.DUITNOW_WEBHOOK_SECRET = 'test-ws';
      process.env.FPX_WEBHOOK_SECRET = 'test-fps';
      process.env.ENCRYPTION_KEY = 'test-enc';
      process.env.JOMPAY_BILLER_CODE = 'test-jp';
      process.env.EMANDATE_MERCHANT_ID = 'test-em';
      process.env.WHATSAPP_API_TOKEN = 'test-wa';
      process.env.MYINVOIS_BASE_URL = 'https://test.api';
      process.env.APP_URL = 'https://test.app';

      const result = validateEnvironment({ strict: false });
      expect(result.warnings.length).toBe(0);
      expect(result.errors.length).toBe(0);
    });
  });

  describe('validateEnvironment — production mode', () => {
    test('throws when required vars missing in production', () => {
      expect(() => validateEnvironment({ strict: true }))
        .toThrow('Environment validation failed');
    });

    test('does not throw when all required vars are set in production', () => {
      process.env.MYINVOIS_CLIENT_ID = 'prod-id';
      process.env.MYINVOIS_CLIENT_SECRET = 'prod-secret';
      process.env.SAINS_TIN = 'prod-tin';
      process.env.SAINS_REGISTRATION_NUMBER = 'prod-reg';
      process.env.FPX_SELLER_EXCHANGE_ID = 'prod-fpx';
      process.env.DUITNOW_MERCHANT_ID = 'prod-dn';
      process.env.DUITNOW_WEBHOOK_SECRET = 'prod-ws';
      process.env.FPX_WEBHOOK_SECRET = 'prod-fps';
      process.env.ENCRYPTION_KEY = 'prod-enc';

      expect(() => validateEnvironment({ strict: true })).not.toThrow();
    });
  });
});
