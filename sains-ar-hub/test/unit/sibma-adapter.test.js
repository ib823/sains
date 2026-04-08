'use strict';

const cds = require('@sap/cds');
const path = require('path');

let sibma;

beforeAll(async () => {
  cds.root = path.resolve(__dirname, '../..');
  await cds.deploy(path.join(cds.root, 'db')).to('sqlite::memory:');
  delete process.env.SIBMA_API_URL;
  sibma = require('../../srv/external/sibma-adapter');
});

describe('sibma-adapter (unit)', () => {

  test('pushPaymentConfirmation logs to simulator inbox in dev mode', async () => {
    const result = await sibma.pushPaymentConfirmation('99999900001', {
      paymentDate: '2026-04-01',
      amount: 250.00,
      channel: 'FPX',
      paymentReference: 'TESTREF',
    });
    expect(result.sent).toBe(true);
    expect(result.dev).toBe(true);

    const db = await cds.connect.to('db');
    const inbox = await db.run(
      SELECT.from('sains.simulator.NotificationInbox')
        .where({ channel: 'SIBMA_OUTBOUND', subject: 'PAYMENT_CONFIRMATION' })
    );
    expect(inbox.length).toBeGreaterThanOrEqual(1);
  });

  test('pushBalanceUpdate returns { sent: true, dev: true } when SIBMA_API_URL not configured', async () => {
    const result = await sibma.pushBalanceUpdate('99999900002', {
      balanceOutstanding: 100,
      balanceDeposit: 200,
      lastPaymentDate: '2026-04-01',
      lastPaymentAmount: 50,
    }, 'TEST_TRIGGER');
    expect(result.sent).toBe(true);
    expect(result.dev).toBe(true);
  });

  test('processRetryQueue returns zeros when queue is empty', async () => {
    const result = await sibma.processRetryQueue();
    expect(result).toEqual({ retried: 0, succeeded: 0, deadLettered: 0 });
  });
});
