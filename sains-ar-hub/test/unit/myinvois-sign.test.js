'use strict';

const { signDocument } = require('../../srv/external/myinvois-adapter');

describe('MyInvois — signDocument (unit)', () => {
  test('signs a document and adds a UBLExtensions block with X509 KeyInfo', async () => {
    const document = {
      Invoice: [{
        ID: [{ _: 'INV-0001' }],
        IssueDate: [{ _: '2026-04-08' }],
        DocumentCurrencyCode: [{ _: 'MYR' }],
      }],
    };

    const signed = await signDocument(document);

    // Original fields preserved
    expect(signed.Invoice).toEqual(document.Invoice);

    // UBLExtensions added
    expect(Array.isArray(signed.UBLExtensions)).toBe(true);
    expect(signed.UBLExtensions.length).toBe(1);

    const ext = signed.UBLExtensions[0].UBLExtension[0];
    expect(ext.ExtensionURI).toMatch(/xades/);

    const sig = ext.ExtensionContent.UBLDocumentSignatures.SignatureInformation.Signature;

    // SignatureValue: non-empty base64
    expect(typeof sig.SignatureValue).toBe('string');
    expect(sig.SignatureValue.length).toBeGreaterThan(0);
    expect(/^[A-Za-z0-9+/=]+$/.test(sig.SignatureValue)).toBe(true);

    // X509Certificate: non-empty base64
    const x509 = sig.KeyInfo.X509Data;
    expect(typeof x509.X509Certificate).toBe('string');
    expect(x509.X509Certificate.length).toBeGreaterThan(0);
    expect(/^[A-Za-z0-9+/=]+$/.test(x509.X509Certificate)).toBe(true);

    // Signature status reflects dev (self-signed) certificate
    expect(signed._signatureStatus).toBe('SIGNED_SELF_SIGNED_DEV');
  });
});
