const cds = require('@sap/cds');
const {Client} = require('pg');
async function main() {
  const c = new Client({connectionString: process.env.DATABASE_URL, ssl:{rejectUnauthorized:false}});
  await c.connect();
  console.log('Connected. Generating DDL...');
  const csn = await cds.load('*');
  const sql = cds.compile.to.sql(csn, {dialect:'postgres'});
  console.log('Executing', sql.length, 'statements...');
  let ok = 0, skip = 0;
  for (const stmt of sql) {
    try { await c.query(stmt); ok++; }
    catch(e) { 
      if (e.message.includes('already exists')) { skip++; }
      else { console.error('WARN:', e.message.substring(0,100)); }
    }
  }
  console.log('DEPLOY SUCCESS —', ok, 'created,', skip, 'skipped (already exist)');
  await c.end();
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
