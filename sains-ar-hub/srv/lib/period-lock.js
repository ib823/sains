'use strict';

const cds = require('@sap/cds');
const logger = cds.log('period-lock');

/**
 * Check if a period is locked for the given posting date.
 * @param {string} postingDate - ISO date string (YYYY-MM-DD)
 * @returns {Promise<boolean>} true if the period is locked
 */
async function isPeriodLocked(postingDate) {
  if (!postingDate) return false;
  const [year, month] = String(postingDate).split('-').map(Number);
  if (!year || !month) return false;

  const db = await cds.connect.to('db');
  const lock = await db.run(
    SELECT.one.from('sains.ar.PeriodLock')
      .where({ periodYear: year, periodMonth: month, isLocked: true })
  );
  return !!lock;
}

/**
 * Lock a period. Prevents any new transactions from being posted to this period.
 * @param {number} year
 * @param {number} month
 * @param {string} userId
 */
async function lockPeriod(year, month, userId) {
  const db = await cds.connect.to('db');

  // Check if already locked
  const existing = await db.run(
    SELECT.one.from('sains.ar.PeriodLock')
      .where({ periodYear: year, periodMonth: month })
  );

  if (existing && existing.isLocked) {
    logger.warn(`Period ${year}-${month} is already locked`);
    return existing;
  }

  if (existing) {
    // Re-lock a previously unlocked period
    await db.run(
      UPDATE('sains.ar.PeriodLock').set({
        isLocked: true,
        lockedAt: new Date().toISOString(),
        lockedBy: userId,
        unlockedAt: null,
        unlockedBy: null,
        unlockReason: null,
      }).where({ ID: existing.ID })
    );
    logger.info(`Period ${year}-${month} re-locked by ${userId}`);
    return existing;
  }

  const id = cds.utils.uuid();
  await db.run(
    INSERT.into('sains.ar.PeriodLock').entries({
      ID: id,
      periodYear: year,
      periodMonth: month,
      lockedAt: new Date().toISOString(),
      lockedBy: userId,
      isLocked: true,
    })
  );
  logger.info(`Period ${year}-${month} locked by ${userId}`);
  return { ID: id };
}

/**
 * Unlock a period. Requires CFO-level justification.
 * @param {number} year
 * @param {number} month
 * @param {string} userId
 * @param {string} reason - mandatory unlock reason
 */
async function unlockPeriod(year, month, userId, reason) {
  if (!reason || reason.length < 10) {
    throw new Error('Unlock reason is mandatory and must be at least 10 characters');
  }

  const db = await cds.connect.to('db');
  const lock = await db.run(
    SELECT.one.from('sains.ar.PeriodLock')
      .where({ periodYear: year, periodMonth: month, isLocked: true })
  );

  if (!lock) {
    throw new Error(`Period ${year}-${month} is not locked`);
  }

  await db.run(
    UPDATE('sains.ar.PeriodLock').set({
      isLocked: false,
      unlockedAt: new Date().toISOString(),
      unlockedBy: userId,
      unlockReason: reason,
    }).where({ ID: lock.ID })
  );

  logger.info(`Period ${year}-${month} unlocked by ${userId}: ${reason}`);
  return lock;
}

module.exports = { isPeriodLocked, lockPeriod, unlockPeriod };
