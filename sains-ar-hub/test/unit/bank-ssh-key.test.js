'use strict';

// Reset the module between tests so the in-module key cache is cleared.
function freshAdapter() {
  delete require.cache[require.resolve('../../srv/external/bank-statement-adapter')];
  return require('../../srv/external/bank-statement-adapter');
}

describe('bank-statement-adapter — _loadBankSSHKey (unit)', () => {
  const ENV_VAR = 'BANK_SSH_KEY_TEST';
  const RAW_PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nmock-ssh-key-content\n-----END OPENSSH PRIVATE KEY-----';

  beforeEach(() => {
    process.env[ENV_VAR] = RAW_PEM;
  });

  afterEach(() => {
    delete process.env[ENV_VAR];
  });

  test('returns the key when BANK_SSH_KEY_<bankCode> env var is set', async () => {
    const { _loadBankSSHKey } = freshAdapter();
    const key = await _loadBankSSHKey(null, 'TEST');
    expect(typeof key).toBe('string');
    expect(key).toContain('BEGIN');
    expect(key).toContain('mock-ssh-key-content');
  });

  test('caches the key on the second call (does not re-resolve)', async () => {
    const { _loadBankSSHKey } = freshAdapter();
    const first = await _loadBankSSHKey(null, 'TEST');
    delete process.env[ENV_VAR]; // remove the source
    const second = await _loadBankSSHKey(null, 'TEST');
    expect(second).toBe(first);
  });

  test('throws a clear error when no key source is available', async () => {
    delete process.env[ENV_VAR];
    const { _loadBankSSHKey } = freshAdapter();
    await expect(_loadBankSSHKey(null, 'NOSOURCE')).rejects.toThrow(
      /SSH key for bank NOSOURCE not configured/
    );
  });
});
