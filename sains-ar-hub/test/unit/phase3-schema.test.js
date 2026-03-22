'use strict';
const { describe, test, expect } = require('@jest/globals');
const { execSync } = require('child_process');

describe('Phase 3 — Schema Compilation', () => {

  test('schema-phase3-integration.cds compiles without errors', () => {
    const output = execSync('npx cds compile db/schema-phase3-integration.cds --to sql 2>&1', {
      encoding: 'utf8', cwd: process.cwd(), timeout: 30000,
    });
    expect(output).not.toContain('[ERROR]');
  });

  test('phase3 schema produces 4 entities as SQL tables', () => {
    const output = execSync('npx cds compile db/schema-phase3-integration.cds --to sql 2>&1', {
      encoding: 'utf8', cwd: process.cwd(), timeout: 30000,
    });
    const tableCount = (output.match(/CREATE TABLE/g) || []).length;
    expect(tableCount).toBeGreaterThanOrEqual(4);
  });

  test('all db/ schemas compile together without errors', () => {
    const output = execSync('npx cds compile db/ --to sql 2>&1', {
      encoding: 'utf8', cwd: process.cwd(), timeout: 30000,
    });
    expect(output).not.toContain('[ERROR]');
  });

  test('iwrs-integration-service.cds compiles without errors', () => {
    const output = execSync('npx cds compile srv/iwrs-integration-service.cds 2>&1', {
      encoding: 'utf8', cwd: process.cwd(), timeout: 30000,
    });
    expect(output).not.toContain('[ERROR]');
  });

  test('customer-portal-service.cds compiles without errors', () => {
    const output = execSync('npx cds compile srv/customer-portal-service.cds 2>&1', {
      encoding: 'utf8', cwd: process.cwd(), timeout: 30000,
    });
    expect(output).not.toContain('[ERROR]');
  });

  test('full db/ + srv/ compiles without errors', () => {
    const output = execSync('npx cds compile db/ srv/ --to hana 2>&1', {
      encoding: 'utf8', cwd: process.cwd(), timeout: 60000,
    });
    const errorCount = (output.match(/\[ERROR\]/g) || []).length;
    expect(errorCount).toBe(0);
  });
});
