'use strict';

const cds = require('@sap/cds');
const path = require('path');

let bp;
let db;

beforeAll(async () => {
  cds.root = path.resolve(__dirname, '../..');
  await cds.deploy(path.join(cds.root, 'db')).to('sqlite::memory:');
  db = await cds.connect.to('db');
  bp = require('../../srv/external/bayaran-pukal-adapter');
});

describe('bayaran-pukal-adapter (unit)', () => {

  test('detects agency code from filename pattern', () => {
    expect(bp._detectAgencyCode('AG_20260401.txt', '')).toBe('BP_AG');
    expect(bp._detectAgencyCode('TNB_DAILY_20260401.csv', '')).toBe('BP_TNB');
    expect(bp._detectAgencyCode('IWK-2026-04-01.txt', '')).toBe('BP_IWK');
    expect(bp._detectAgencyCode('FAMA_BULK.txt', '')).toBe('BP_FAMA');
    // Falls back to inline content marker
    expect(bp._detectAgencyCode('mystery.txt', 'Header AG bulk payments\n')).toBe('BP_AG');
    // Unknown returns null
    expect(bp._detectAgencyCode('random.txt', 'no marker')).toBeNull();
  });

  test('flags duplicate payment references within a parsed batch', async () => {
    // The seeded BP_AG AgencyFileFormat uses '|' as the field delimiter.
    const fileContent =
      '10000000001|100.00|01/04/2026|DUPREF\n' +
      '10000000002|200.00|01/04/2026|DUPREF\n' + // duplicate ref
      '10000000003|300.00|01/04/2026|UNIQUE1\n';

    const result = await bp.processBayaranPukalFile(fileContent, 'AG_20260401.txt', new Date('2026-04-01'));
    expect(result.agencyCode).toBe('BP_AG');
    expect(Array.isArray(result.duplicates)).toBe(true);
    expect(result.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(result.duplicates[0].paymentReference).toBe('DUPREF');
  });
});
