/**
 * Regression checks for Shorts SEO retry and upload readiness gates.
 *
 * Run: node test/test-shorts-seo-retry-upload-guard.js
 */

const assert = require('assert');
const db = require('../src/main/database/db');
const { ShortsController } = require('../src/main/shorts');

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

async function main() {
  await testSeoRetryForAssembledShorts();
  await testUploadRefusesIncompleteShortsBeforeBrowserLaunch();
  console.log('test-shorts-seo-retry-upload-guard passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
