/**
 * Regression checks for Shorts calendar start-date planning.
 *
 * Run: node test/test-shorts-start-date.js
 */

const assert = require('assert');
const db = require('../src/main/database/db');
const { ShortsController } = require('../src/main/shorts');
const { ShortsScheduler } = require('../src/main/shorts/shorts-scheduler');

function makeScheduler() {
  const scheduler = new ShortsScheduler(null, { ffmpegPath: 'ffmpeg', log: () => {} });
  scheduler.getAvailableClips = () => [
    { id: 1 },
    { id: 2 },
    { id: 3 },
    { id: 4 },
  ];
  scheduler._probeClipDurations = clips => {
    for (const clip of clips) clip._duration = 20;
  };
  return scheduler;
}

function main() {
  const originalQueryOne = db.queryOne;

  try {
    const controller = new ShortsController(null, { ffmpegPath: 'ffmpeg', log: () => {} });
    let forwardedOptions = null;
    controller.scheduler.planCalendar = (_projectId, options) => {
      forwardedOptions = options;
      return { calendar: [] };
    };
    controller.scheduler.savePlan = () => {};

    controller.planCalendar('project-1', {
      mode: 'chronological',
      startDate: '2026-07-01',
      calendarDays: 31,
    });

    assert.deepStrictEqual(forwardedOptions, {
      mode: 'chronological',
      startDate: '2026-07-01',
      calendarDays: 31,
    });

    db.queryOne = () => {
      throw new Error('explicit startDate should not query prior shorts');
    };
    const julyPlan = makeScheduler().planCalendar('project-1', {
      mode: 'standalone_impact',
      startDate: '2026-07-01',
      calendarDays: 31,
    });
    assert.strictEqual(julyPlan.stats.startDate, '2026-07-01');
    assert.strictEqual(julyPlan.calendar[0].scheduledDate, '2026-07-01');

    let capturedSql = '';
    db.queryOne = sql => {
      capturedSql = sql;
      return { scheduled_date: '2026-07-31' };
    };
    const appendedPlan = makeScheduler().planCalendar('project-1', {
      mode: 'standalone_impact',
      calendarDays: 31,
    });
    assert.match(capturedSql, /status <> 'planned'/);
    assert.strictEqual(appendedPlan.stats.startDate, '2026-08-01');
    assert.strictEqual(appendedPlan.calendar[0].scheduledDate, '2026-08-01');

    assert.throws(
      () => makeScheduler().planCalendar('project-1', { startDate: '2026-02-31', calendarDays: 31 }),
      /Invalid startDate/
    );

    console.log('test-shorts-start-date passed');
  } finally {
    db.queryOne = originalQueryOne;
  }
}

main();
