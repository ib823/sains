'use strict';

const { _parseDelimitedFile, _parseAmount } = require('../../srv/external/agency-file-parser');

describe('agency-file-parser — _parseDelimitedFile (unit)', () => {

  const baseConfig = {
    fileType: 'CSV',
    delimiter: ',',
    hasHeaderRow: true,
    encoding: 'UTF-8',
    dateFormat: 'YYYY-MM-DD',
    amountFormat: 'DECIMAL_DOT',
    accountRefColumn: 'accountRef',
    amountColumn: 'amount',
    paymentDateColumn: 'paymentDate',
    paymentRefColumn: 'paymentRef',
    payerNameColumn: null,
    bankRefColumn: null,
    skipRowsTop: 0,
    skipRowsBottom: 0,
    totalLinePattern: null,
  };

  test('parses a simple CSV with header row correctly', () => {
    const content =
      'accountRef,amount,paymentDate,paymentRef\n' +
      '10000000001,150.00,2026-04-01,REF001\n' +
      '10000000002,275.50,2026-04-02,REF002\n';

    const result = _parseDelimitedFile(baseConfig, content);
    expect(result).toHaveLength(2);
    expect(result[0].accountReference).toBe('10000000001');
    expect(result[0].amount).toBe(150);
    expect(result[0].paymentDate).toBe('2026-04-01');
    expect(result[0].status).toBe('PARSED');
    expect(result[1].amount).toBe(275.5);
  });

  test('parses a CSV without header row using positional indices', () => {
    const cfg = {
      ...baseConfig,
      hasHeaderRow: false,
      accountRefColumn: '0',
      amountColumn: '1',
      paymentDateColumn: '2',
      paymentRefColumn: '3',
    };
    const content =
      '10000000001,42.00,2026-04-01,REFA\n' +
      '10000000002,99.99,2026-04-02,REFB\n';

    const result = _parseDelimitedFile(cfg, content);
    expect(result).toHaveLength(2);
    expect(result[0].accountReference).toBe('10000000001');
    expect(result[0].amount).toBe(42);
    expect(result[1].paymentReference).toBe('REFB');
  });

  test('handles DECIMAL_COMMA amount format', () => {
    const cfg = { ...baseConfig, amountFormat: 'DECIMAL_COMMA' };
    const content =
      'accountRef,amount,paymentDate,paymentRef\n' +
      '10000000001,1234,56,2026-04-01,REF1\n';
    // Note: comma is BOTH the field delimiter AND the decimal separator; switch delimiter to ;
    const cfg2 = { ...cfg, delimiter: ';' };
    const content2 =
      'accountRef;amount;paymentDate;paymentRef\n' +
      '10000000001;1234,56;2026-04-01;REF1\n';

    const result = _parseDelimitedFile(cfg2, content2);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBeCloseTo(1234.56, 2);
  });

  test('handles CENTS amount format', () => {
    const cfg = { ...baseConfig, amountFormat: 'CENTS' };
    const content =
      'accountRef,amount,paymentDate,paymentRef\n' +
      '10000000001,123456,2026-04-01,REF1\n';

    const result = _parseDelimitedFile(cfg, content);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(1234.56);
  });

  test('marks lines with missing required fields as FAILED', () => {
    const content =
      'accountRef,amount,paymentDate,paymentRef\n' +
      ',100.00,2026-04-01,REF1\n' +              // missing accountRef
      '10000000002,,2026-04-02,REF2\n' +          // missing amount
      '10000000003,50.00,not-a-date,REF3\n';      // bad date

    const result = _parseDelimitedFile(baseConfig, content);
    expect(result).toHaveLength(3);
    for (const r of result) {
      expect(r.status).toBe('FAILED');
      expect(r.parseError).toMatch(/Missing\/unparseable/);
    }
  });

  test('_parseAmount supports all formats', () => {
    expect(_parseAmount('1234.56', 'DECIMAL_DOT')).toBeCloseTo(1234.56);
    expect(_parseAmount('1234,56', 'DECIMAL_COMMA')).toBeCloseTo(1234.56);
    expect(_parseAmount('123456', 'CENTS')).toBe(1234.56);
  });
});
