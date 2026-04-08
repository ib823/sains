'use strict';

const { downloadReconciliationFile } = require('../../srv/external/jompay-adapter');

describe('jompay-adapter — downloadReconciliationFile (unit)', () => {
  const SAVED_HOST = process.env.JOMPAY_SFTP_HOST;

  beforeEach(() => {
    delete process.env.JOMPAY_SFTP_HOST;
  });

  afterAll(() => {
    if (SAVED_HOST) process.env.JOMPAY_SFTP_HOST = SAVED_HOST;
  });

  test('does not throw when SFTP is not configured (graceful degradation)', async () => {
    // Use a date unlikely to have a local sample
    await expect(
      downloadReconciliationFile(new Date('2099-01-01'))
    ).resolves.toBeDefined();
  });

  test('returns a structured { found, reason } result with no SFTP config', async () => {
    const result = await downloadReconciliationFile(new Date('2099-01-01'));
    expect(result).toHaveProperty('found');
    expect(result.found).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(typeof result.reason).toBe('string');
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result).toHaveProperty('fileDate');
  });
});
