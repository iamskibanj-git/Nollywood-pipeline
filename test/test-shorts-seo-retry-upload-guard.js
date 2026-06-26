/**
 * Regression checks for Shorts SEO retry and upload readiness gates.
 *
 * Run: node test/test-shorts-seo-retry-upload-guard.js
 */

const assert = require('assert');
const db = require('../src/main/database/db');
const { ShortsController, FacebookUploader } = require('../src/main/shorts');

async function testSeoRetryForAssembledShorts() {
  const originals = {
    backup: db.backup,
    queryOne: db.queryOne,
    getAssets: db.getAssets,
  };

  try {
    db.backup = () => {};
    db.queryOne = () => ({ id: 'project-1', title: 'Project One', project_dir: 'C:\\tmp\\project-one' });
    db.getAssets = () => [
      { id: 10, prompt_used: 'clip 10' },
      { id: 11, prompt_used: 'clip 11' },
    ];

    const controller = new ShortsController(null, { ffmpegPath: 'ffmpeg', log: () => {} });
    let assembledQueryCount = 0;
    let updatedSeo = null;
    controller.scheduler.getPlannedShorts = () => [];
    controller.scheduler.getAssembledShortsNeedingSEO = () => {
      assembledQueryCount++;
      return [{ id: 501, short_number: 27, source_clips: '[10,11]', file_path: 'short_027.mp4', status: 'assembled' }];
    };
    controller.scheduler.generateSEO = async plan => {
      assert.strictEqual(plan.shortNumber, 27);
      assert.deepStrictEqual(plan.clips.map(c => c.id), [10, 11]);
      return { title: 'Recovered title', description: 'Recovered description', hashtags: ['#Nollywood'] };
    };
    controller.scheduler.updateShortSEO = (shortId, seo) => {
      updatedSeo = { shortId, seo };
    };
    controller.scheduler.markShortSEOFailed = () => {
      throw new Error('SEO retry should not fail');
    };
    controller.scheduler.getShortsForProject = () => [{ id: 501, status: 'seo_done' }];

    const result = await controller.assembleShorts('project-1');

    assert.strictEqual(assembledQueryCount, 2, 'controller should check assembled rows before and after planned assembly');
    assert.strictEqual(result.assembled, 0);
    assert.strictEqual(result.seoRecovered, 1);
    assert.strictEqual(result.seoFailed, 0);
    assert.strictEqual(updatedSeo.shortId, 501);
    assert.strictEqual(updatedSeo.seo.title, 'Recovered title');
  } finally {
    db.backup = originals.backup;
    db.queryOne = originals.queryOne;
    db.getAssets = originals.getAssets;
  }
}

async function testUploadRefusesIncompleteShortsBeforeBrowserLaunch() {
  const controller = new ShortsController(null, { ffmpegPath: 'ffmpeg', log: () => {} });
  let launched = false;
  controller.scheduler.getIncompleteShortsBeforeUpload = () => [
    { id: 1, short_number: 27, status: 'assembled' },
    { id: 2, short_number: 28, status: 'planned' },
    { id: 3, short_number: 29, status: 'pending' },
  ];
  controller.uploader = {
    close: async () => { launched = true; },
  };

  await assert.rejects(
    () => controller.uploadAll('project-1'),
    error => {
      assert.match(error.message, /SHORTS_NOT_READY/);
      assert.match(error.message, /1 pending short/);
      assert.match(error.message, /1 planned short/);
      assert.match(error.message, /1 assembled short/);
      return true;
    }
  );

  assert.strictEqual(launched, false, 'upload guard should fire before touching browser/uploader');
}

async function testFacebookScheduleWindowBoundary() {
  const now = new Date(2026, 5, 25, 12, 0, 0);
  assert.strictEqual(FacebookUploader.getScheduleWindow(now).maxDate, '2026-07-24');
  assert.strictEqual(FacebookUploader.isWithinScheduleWindow('2026-07-24', now), true);
  assert.strictEqual(FacebookUploader.isWithinScheduleWindow('2026-07-25', now), false);

  const uploader = new FacebookUploader({ nowProvider: () => now, log: () => {} });
  const result = await uploader.scheduleReel({
    filePath: 'C:\\does-not-exist\\short_025.mp4',
    description: 'future short',
    scheduledDate: '2026-07-25',
    scheduledTime: '18:00',
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.deferred, true);
  assert.match(result.error, /FACEBOOK_SCHEDULE_WINDOW/);
  assert.match(result.error, /max schedule date 2026-07-24/);
}

async function testUploadDefersFutureShortsBeforeBrowserLaunch() {
  const originals = {
    backup: db.backup,
    queryOne: db.queryOne,
  };

  try {
    let backupCalled = false;
    db.backup = () => { backupCalled = true; };
    db.queryOne = (sql) => {
      if (/scheduled_date <=/.test(sql)) return { cnt: 0 };
      return { cnt: 7 };
    };

    let factoryCalled = false;
    const controller = new ShortsController(null, {
      ffmpegPath: 'ffmpeg',
      log: () => {},
      nowProvider: () => new Date(2026, 5, 25, 12, 0, 0),
      uploaderFactory: () => {
        factoryCalled = true;
        return { launch: async () => {}, close: async () => {} };
      },
    });
    controller.scheduler.getIncompleteShortsBeforeUpload = () => [];

    const result = await controller.uploadAll('project-1');

    assert.strictEqual(result.uploaded, 0);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.deferred, 7);
    assert.strictEqual(result.maxScheduleDate, '2026-07-24');
    assert.strictEqual(factoryCalled, false, 'future-only batch should not launch Facebook');
    assert.strictEqual(backupCalled, false, 'future-only batch should not create an upload backup');
  } finally {
    db.backup = originals.backup;
    db.queryOne = originals.queryOne;
  }
}

async function testUploadSkipsDeferredRowsButUploadsCurrentWindow() {
  const originals = {
    backup: db.backup,
    queryOne: db.queryOne,
  };

  try {
    db.backup = () => {};
    db.queryOne = (sql) => {
      if (/scheduled_date <=/.test(sql)) return { cnt: 1 };
      return { cnt: 2 };
    };

    let launched = false;
    let closed = false;
    let scheduled = null;
    const fakeUploader = {
      launch: async () => { launched = true; },
      close: async () => { closed = true; },
      scheduleReel: async short => {
        scheduled = short;
        return { success: true };
      },
    };

    const controller = new ShortsController(null, {
      ffmpegPath: 'ffmpeg',
      log: () => {},
      nowProvider: () => new Date(2026, 5, 25, 12, 0, 0),
      uploaderFactory: () => fakeUploader,
    });

    let uploadQueryCount = 0;
    let uploadedId = null;
    controller.scheduler.getIncompleteShortsBeforeUpload = () => [];
    controller.scheduler.getNextPendingUpload = (_projectId, _excludeIds, options = {}) => {
      assert.strictEqual(options.maxScheduledDate, '2026-07-24');
      uploadQueryCount++;
      if (uploadQueryCount > 1) return null;
      return {
        id: 24,
        short_number: 24,
        file_path: 'short_024.mp4',
        description: 'ready short',
        hashtags: '[]',
        scheduled_date: '2026-07-24',
        scheduled_time: '18:00',
      };
    };
    controller.scheduler.markUploaded = id => { uploadedId = id; };
    controller.scheduler.markFailed = () => {
      throw new Error('deferred rows should not be marked failed by this upload session');
    };
    controller.scheduler.getUnscheduledShorts = () => [{ short_number: 25, status: 'upload_failed' }];

    const result = await controller.uploadAll('project-1');

    assert.strictEqual(launched, true);
    assert.strictEqual(closed, true);
    assert.strictEqual(uploadedId, 24);
    assert.strictEqual(scheduled.scheduledDate, '2026-07-24');
    assert.strictEqual(result.uploaded, 1);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.deferred, 1);
    assert.strictEqual(result.maxScheduleDate, '2026-07-24');
  } finally {
    db.backup = originals.backup;
    db.queryOne = originals.queryOne;
  }
}

async function main() {
  await testSeoRetryForAssembledShorts();
  await testUploadRefusesIncompleteShortsBeforeBrowserLaunch();
  await testFacebookScheduleWindowBoundary();
  await testUploadDefersFutureShortsBeforeBrowserLaunch();
  await testUploadSkipsDeferredRowsButUploadsCurrentWindow();
  console.log('test-shorts-seo-retry-upload-guard passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
