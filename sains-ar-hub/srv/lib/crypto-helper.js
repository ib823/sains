'use strict';

const forge = require('node-forge');
const cds = require('@sap/cds');

// IC numbers (MyKad / BRN) are sensitive personal data under PDPA 2010.
// Stored as AES-256-CBC encrypted ciphertext. Reversible encryption —
// not one-way hash — because Finance Supervisor+ must be able to verify
// the original IC number for account authentication disputes.
//
// Key storage: BTP Credential Store service bound as 'credstore'.
// Key rotation: handled outside this module — rotating the key requires
// re-encrypting all IC numbers in a scheduled migration job.

let _encryptionKey = null;

async function getEncryptionKey() {
  if (_encryptionKey) return _encryptionKey;
  if (process.env.NODE_ENV !== 'production') {
    // Development only — 32-byte zero key. NEVER ship this to production.
    _encryptionKey = Buffer.from('a'.repeat(64), 'hex');
    cds.log('crypto').warn('DEV PLACEHOLDER KEY IN USE — NOT FOR PRODUCTION');
    return _encryptionKey;
  }
  // Production: retrieve IC_ENCRYPTION_KEY from BTP Credential Store
  // TBC: implement retrieval from VCAP_SERVICES.credstore[0] REST API
  throw new Error('/* TBC: retrieve IC_ENCRYPTION_KEY from BTP Credential Store */');
}

async function encryptICNumber(plaintext) {
  const key = await getEncryptionKey();
  const iv = forge.random.getBytesSync(16);
  const cipher = forge.cipher.createCipher('AES-CBC',
    forge.util.createBuffer(key.toString('binary')));
  cipher.start({ iv: forge.util.createBuffer(iv) });
  cipher.update(forge.util.createBuffer(plaintext, 'utf8'));
  cipher.finish();
  const combined = iv + cipher.output.getBytes();
  return forge.util.encode64(combined);
}

async function decryptICNumber(ciphertext) {
  if (!ciphertext) return null;
  const key = await getEncryptionKey();
  const combined = forge.util.decode64(ciphertext);
  const iv = combined.substring(0, 16);
  const encrypted = combined.substring(16);
  const decipher = forge.cipher.createDecipher('AES-CBC',
    forge.util.createBuffer(key.toString('binary')));
  decipher.start({ iv: forge.util.createBuffer(iv) });
  decipher.update(forge.util.createBuffer(encrypted));
  decipher.finish();
  return decipher.output.toString();
}

// Returns masked display string. Never returns plaintext or ciphertext.
function maskICNumber() {
  return 'XXXXXX-XX-XXXX';
}

module.exports = { encryptICNumber, decryptICNumber, maskICNumber };
