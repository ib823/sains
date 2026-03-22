'use strict';
const { describe, test, expect } = require('@jest/globals');
const { XMLParser } = require('fast-xml-parser');

describe('Bank Statement — CAMT.053 Parser', () => {

  const sampleCAMT053 = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
  <BkToCstmrStmt>
    <Stmt>
      <Acct><Id><Othr><Id>SAINS-MBB-001</Id></Othr></Id></Acct>
      <Bal>
        <Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="MYR">10000.00</Amt>
      </Bal>
      <Bal>
        <Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp>
        <Amt Ccy="MYR">15000.00</Amt>
      </Bal>
      <Ntry>
        <Amt Ccy="MYR">500.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-20</Dt></BookgDt>
        <ValDt><Dt>2026-03-20</Dt></ValDt>
        <NtryRef>REF-001</NtryRef>
        <NtryDtls><TxDtls><RmtInf><Ustrd>Water bill ACC001</Ustrd></RmtInf></TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="MYR">250.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-20</Dt></BookgDt>
        <ValDt><Dt>2026-03-20</Dt></ValDt>
        <NtryRef>REF-002</NtryRef>
      </Ntry>
      <Ntry>
        <Amt Ccy="MYR">100.00</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <Sts>BOOK</Sts>
        <BookgDt><Dt>2026-03-20</Dt></BookgDt>
        <NtryRef>DEBIT-001</NtryRef>
      </Ntry>
      <FrToDt><ToDtTm>2026-03-20T23:59:59</ToDtTm></FrToDt>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

  test('fast-xml-parser is installed and loadable', () => {
    expect(XMLParser).toBeDefined();
  });

  test('parses CAMT.053 XML structure correctly', () => {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['Ntry', 'TxDtls'].includes(name),
    });
    const doc = parser.parse(sampleCAMT053);
    const stmt = doc?.Document?.BkToCstmrStmt?.Stmt;

    expect(stmt).toBeDefined();
    expect(stmt.Acct.Id.Othr.Id).toBe('SAINS-MBB-001');
  });

  test('extracts credit entries from CAMT.053', () => {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['Ntry', 'TxDtls'].includes(name),
    });
    const doc = parser.parse(sampleCAMT053);
    const entries = doc.Document.BkToCstmrStmt.Stmt.Ntry;

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBe(3);

    const credits = entries.filter(e => e.CdtDbtInd === 'CRDT');
    expect(credits.length).toBe(2);
    expect(Number(credits[0].Amt['#text'] || credits[0].Amt)).toBe(500);
  });

  test('extracts opening and closing balances', () => {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['Ntry', 'TxDtls', 'Bal'].includes(name),
    });
    const doc = parser.parse(sampleCAMT053);
    const balances = doc.Document.BkToCstmrStmt.Stmt.Bal;

    expect(Array.isArray(balances)).toBe(true);
    const opBal = balances.find(b => b.Tp?.CdOrPrtry?.Cd === 'OPBD');
    const clBal = balances.find(b => b.Tp?.CdOrPrtry?.Cd === 'CLBD');
    expect(Number(opBal.Amt['#text'] || opBal.Amt)).toBe(10000);
    expect(Number(clBal.Amt['#text'] || clBal.Amt)).toBe(15000);
  });

  test('extracts remittance information from entries', () => {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['Ntry', 'TxDtls'].includes(name),
    });
    const doc = parser.parse(sampleCAMT053);
    const firstEntry = doc.Document.BkToCstmrStmt.Stmt.Ntry[0];
    const txDetails = firstEntry.NtryDtls?.TxDtls;

    expect(txDetails).toBeDefined();
    const txArr = Array.isArray(txDetails) ? txDetails : [txDetails];
    const remit = txArr[0]?.RmtInf?.Ustrd;
    expect(remit).toBe('Water bill ACC001');
  });

  test('identifies debit entries correctly', () => {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (name) => ['Ntry', 'TxDtls'].includes(name),
    });
    const doc = parser.parse(sampleCAMT053);
    const entries = doc.Document.BkToCstmrStmt.Stmt.Ntry;
    const debits = entries.filter(e => e.CdtDbtInd === 'DBIT');
    expect(debits.length).toBe(1);
    expect(debits[0].NtryRef).toBe('DEBIT-001');
  });
});
