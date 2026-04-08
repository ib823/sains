'use strict';

const cds = require('@sap/cds');
const path = require('path');

let adapter;
let db;

beforeAll(async () => {
  cds.root = path.resolve(__dirname, '../..');
  await cds.deploy(path.join(cds.root, 'db')).to('sqlite::memory:');
  db = await cds.connect.to('db');
  adapter = require('../../srv/external/staging-db-adapter');
});

describe('staging-db-adapter (unit)', () => {

  test('pollStagingDB returns { polled: false } when config is not active', async () => {
    // The seeded StagingDBConfig has isActive = false
    const result = await adapter.pollStagingDB(new Date('2026-01-01'));
    expect(result.polled).toBe(false);
    expect(typeof result.reason).toBe('string');
  });

  test('processStagingRecords resolves a record matching an existing accountNumber', async () => {
    // Reuse a seeded CustomerAccount (loaded from db/data/sains.ar-CustomerAccount.csv)
    const seeded = await db.run(
      SELECT.one.from('sains.ar.CustomerAccount').columns('ID', 'accountNumber')
    );
    expect(seeded).toBeTruthy();
    const accountID = seeded.ID;
    const accountNumber = seeded.accountNumber;

    const stagingID = `STG-${Date.now()}`;
    await db.run(INSERT.into('sains.ar.staging.StagingPaymentRecord').entries({
      ID: cds.utils.uuid(),
      stagingID,
      channelCode: 'CIMB',
      accountReference: accountNumber,
      amount: 123.45,
      paymentDate: '2026-04-01',
      processingStatus: 'RECEIVED',
      rawData: '{}',
    }));

    const result = await adapter.processStagingRecords();
    expect(result.processed).toBeGreaterThanOrEqual(1);
    expect(result.resolved).toBeGreaterThanOrEqual(1);

    // Verify the record was updated
    const updated = await db.run(
      SELECT.one.from('sains.ar.staging.StagingPaymentRecord').where({ stagingID })
    );
    expect(updated.processingStatus).toBe('RESOLVED');
    expect(updated.resolvedAccountID).toBe(accountID);
  });

  test('getStagingHealthStatus returns a structured health object', async () => {
    const health = await adapter.getStagingHealthStatus();
    expect(health).toHaveProperty('isActive');
    expect(health).toHaveProperty('configured');
    expect(health).toHaveProperty('countsByStatus');
    expect(typeof health.countsByStatus).toBe('object');
  });
});
