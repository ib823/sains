'use strict';

const cds = require('@sap/cds');
const dayjs = require('dayjs');
const logger = cds.log('data-retention');

/**
 * Run data retention policy scan.
 * Archives or purges data based on retention rules.
 * MOCK: archive moves to separate status. Production should use BTP Object Store or HANA warm storage.
 */
async function runRetentionPolicyScan() {
  const db = await cds.connect.to('db');
  const today = dayjs();
  let archived = 0, purged = 0;

  // Rule 1: AuditTrailEntry — archive entries older than 7 years (mark as ARCHIVED, don't delete)
  const auditCutoff = today.subtract(7, 'year').format('YYYY-MM-DD');
  const oldAudits = await db.run(
    SELECT.from('sains.ar.AuditTrailEntry')
      .where({ timestamp: { '<': auditCutoff } })
      .limit(10000)
  );
  // MOCK: in production, move to cold storage. For POC, just count.
  archived += oldAudits.length;
  logger.info(`Retention: ${oldAudits.length} audit entries older than 7 years identified for archival`);

  // Rule 2: Simulator data — purge entries older than 90 days
  const simCutoff = today.subtract(90, 'day').format('YYYY-MM-DD');
  try {
    const simPurged = await db.run(
      DELETE.from('sains.simulator.EventLog').where({ createdAt: { '<': simCutoff } })
    );
    purged += Number(simPurged || 0);
    logger.info(`Retention: purged ${simPurged || 0} simulator events older than 90 days`);
  } catch (err) {
    logger.warn(`Simulator purge skipped: ${err.message}`);
  }

  // Rule 3: iWRS processed events — purge PROCESSED entries older than 2 years
  const iwrsCutoff = today.subtract(2, 'year').format('YYYY-MM-DD');
  try {
    const iwrsPurged = await db.run(
      DELETE.from('sains.ar.integration.iWRSEventLog')
        .where({ processingStatus: 'PROCESSED', createdAt: { '<': iwrsCutoff } })
    );
    purged += Number(iwrsPurged || 0);
    logger.info(`Retention: purged ${iwrsPurged || 0} processed iWRS events older than 2 years`);
  } catch (err) {
    logger.warn(`iWRS purge skipped: ${err.message}`);
  }

  return { archived, purged };
}

module.exports = { runRetentionPolicyScan };
