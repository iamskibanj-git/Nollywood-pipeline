/**
 * Regression checks for Shorts calendar start-date planning.
 *
 * Run: node test/test-shorts-start-date.js
 */

const assert = require('assert');
const db = require('../src/main/database/db');
const { ShortsController } = require('../src/main/shorts');
const { ShortsScheduler } = require('../src/main/shorts/shorts-scheduler');

function makeScheduler({ count = 4, duration = 20 } = {}) {
  const scheduler = new ShortsScheduler(null, { ffmpegPath: 'ffmpeg', log: () => {} });
  scheduler.getAvailableClips = () => Array.from({ length: count }, (_, index) => ({ id: index + 1 }));
  scheduler._probeClipDurations = clips => {
    for (const clip of clips) clip._duration = duration;
  };
  return scheduler;
}

function flattenClipIds(calendar) {
  return calendar.flatMap(entry => entry.clipIds);
}

function expectedIds(count) {
  return Array.from({ length: count }, (_, index) => index + 1);
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

    const fullJulyPlan = makeScheduler({ count: 136, duration: 15 }).planCalendar('project-1', {
      mode: 'chronological',
      startDate: '2026-07-01',
      calendarDays: 31,
    });
    assert.strictEqual(fullJulyPlan.stats.groupingMode, 'calendar-window');
    assert.strictEqual(fullJulyPlan.stats.requestedCalendarDays, 31);
    assert.strictEqual(fullJulyPlan.stats.totalShorts, 31);
    assert.strictEqual(fullJulyPlan.stats.startDate, '2026-07-01');
    assert.strictEqual(fullJulyPlan.stats.endDate, '2026-07-31');
    assert.strictEqual(fullJulyPlan.stats.calendarDays, 31);
    assert.strictEqual(fullJulyPlan.calendar[0].scheduledDate, '2026-07-01');
    assert.strictEqual(fullJulyPlan.calendar[30].scheduledDate, '2026-07-31');
    assert.deepStrictEqual(flattenClipIds(fullJulyPlan.calendar), expectedIds(136));
    assert.strictEqual(fullJulyPlan.calendar.filter(entry => entry.clipIds.length === 5).length, 12);
    assert.strictEqual(fullJulyPlan.calendar.filter(entry => entry.clipIds.length === 4).length, 19);

    const tooFewPlan = makeScheduler({ count: 20, duration: 15 }).planCalendar('project-1', {
      mode: 'chronological',
      startDate: '2026-07-01',
      calendarDays: 31,
    });
    assert.strictEqual(tooFewPlan.stats.groupingMode, 'duration-target');
    assert.ok(tooFewPlan.stats.totalShorts < 31);
    assert.notStrictEqual(tooFewPlan.stats.endDate, '2026-07-31');
    assert.deepStrictEqual(flattenClipIds(tooFewPlan.calendar), expectedIds(20));

    const tooManyPlan = makeScheduler({ count: 310, duration: 15 }).planCalendar('project-1', {
      mode: 'chronological',
      startDate: '2026-07-01',
      calendarDays: 31,
    });
    assert.strictEqual(tooManyPlan.stats.groupingMode, 'duration-target');
    assert.ok(tooManyPlan.stats.totalShorts > 31);
    assert.strictEqual(tooManyPlan.stats.startDate, '2026-07-01');
    assert.strictEqual(tooManyPlan.stats.endDate, '2026-07-31');
    assert.deepStrictEqual(flattenClipIds(tooManyPlan.calendar), expectedIds(310));

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
