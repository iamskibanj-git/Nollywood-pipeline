/**
 * Regression checks for YouTube Shorts publish-job preparation.
 *
 * Run: node test/test-shorts-youtube-job-prep.js
 */

const assert = require('assert');
const {
  buildYouTubeShortMetadata,
  buildYouTubeHashtags,
  prepareYouTubeShortPublishJob,
} = require('../src/main/shorts');

const SHORT = {
  id: 101,
  project_id: 'project-1',
  short_number: 1,
  title: 'The Letter Changed Everything #fbreels',
  description: 'Will she reveal the family secret?\n\nFollow for the next episode.\n\n#nollywood #fbreels #betrayal',
  hashtags: '["#nollywood","#fbreels","#betrayal"]',
  file_path: 'C:\\tmp\\short_001.mp4',
  duration_seconds: 58,
  scheduled_date: '2026-07-15',
  scheduled_time: '18:00',
};

const PROJECT = {
  id: 'project-1',
  title: 'She Chose Wealth Over Blood',
};

function makeDb() {
  const calls = [];
  return {
    calls,
    upsertShortPublishJob(job) {
      calls.push(job);
      return { id: 9001, ...job };
    },
  };
}

function testYouTubeHashtagsRemoveFacebookOnlyTags() {
  const tags = buildYouTubeHashtags('["#Nollywood", "#fbreels", "#FamilyDrama"]', ['#Shorts']);
  assert(tags.includes('#shorts'));
  assert(tags.includes('#nollywood'));
  assert(tags.includes('#familydrama'));
  assert(!tags.includes('#fbreels'));
}

function testMetadataIsYouTubeShaped() {
  const metadata = buildYouTubeShortMetadata(SHORT, PROJECT);
  assert.strictEqual(metadata.settings.aiDisclosure, true);
  assert.strictEqual(metadata.settings.visibility, 'private');
  assert(metadata.title.length <= 100);
  assert(!/#fbreels/i.test(metadata.title));
  assert(!/#fbreels/i.test(metadata.description));
  assert(metadata.description.includes('#shorts'));
  assert(metadata.description.length <= 5000);
}

function testReadyJobPersistsMetadataAndValidation() {
  const db = makeDb();
  const result = prepareYouTubeShortPublishJob(db, SHORT, PROJECT, {
    videoInfo: {
      fileExists: true,
      durationSeconds: 58,
      width: 1080,
      height: 1920,
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 'ready');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(db.calls.length, 1);

  const job = db.calls[0];
  assert.strictEqual(job.short_id, 101);
  assert.strictEqual(job.platform, 'youtube_shorts');
  assert.strictEqual(job.status, 'ready');
  assert.strictEqual(job.scheduled_date, null);
  assert.strictEqual(job.scheduled_time, null);
  assert(Array.isArray(job.hashtags_json));
  assert.strictEqual(job.metadata_json.settings.aiDisclosure, true);
  assert(!/#fbreels/i.test(job.description));
  assert(!/#reels/i.test(job.description));
  assert.strictEqual(job.description.split(/\r?\n/).filter(line => line.trim().startsWith('#')).length, 1);
  assert.strictEqual(job.validation_json.ok, true);
  assert.strictEqual(job.error_message, null);
}

function testScheduledVisibilityRequiresExplicitDate() {
  const db = makeDb();
  const result = prepareYouTubeShortPublishJob(db, SHORT, PROJECT, {
    visibility: 'scheduled',
    videoInfo: {
      fileExists: true,
      durationSeconds: 58,
      width: 1080,
      height: 1920,
    },
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'blocked');
  assert(result.errors.some(error => /explicit scheduledDate/.test(error)));
  assert.strictEqual(db.calls[0].status, 'blocked');
  assert.strictEqual(db.calls[0].scheduled_date, null);
  assert.strictEqual(db.calls[0].scheduled_time, null);
}

function testCurrentThreeMinuteShortsDurationIsAllowed() {
  const db = makeDb();
  const result = prepareYouTubeShortPublishJob(db, SHORT, PROJECT, {
    videoInfo: {
      fileExists: true,
      durationSeconds: 75,
      width: 1080,
      height: 1920,
    },
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.status, 'ready');
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(db.calls[0].status, 'ready');
  assert.strictEqual(db.calls[0].error_message, null);
}

function testOverThreeMinuteShortIsBlocked() {
  const db = makeDb();
  const result = prepareYouTubeShortPublishJob(db, SHORT, PROJECT, {
    videoInfo: {
      fileExists: true,
      durationSeconds: 181,
      width: 1080,
      height: 1920,
    },
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'blocked');
  assert(result.errors.some(error => /exceeds 180 seconds/.test(error)));
  assert.strictEqual(db.calls[0].status, 'blocked');
  assert.match(db.calls[0].error_message, /exceeds 180 seconds/);
}

function testLandscapeVideoIsBlocked() {
  const db = makeDb();
  const result = prepareYouTubeShortPublishJob(db, SHORT, PROJECT, {
    videoInfo: {
      fileExists: true,
      durationSeconds: 58,
      width: 1920,
      height: 1080,
    },
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'blocked');
  assert(result.errors.some(error => /vertical or square/.test(error)));
}

function testMissingVideoIsBlocked() {
  const db = makeDb();
  const result = prepareYouTubeShortPublishJob(db, { ...SHORT, file_path: 'C:\\missing.mp4' }, PROJECT, {
    videoInfo: {
      fileExists: false,
      durationSeconds: 58,
      width: 1080,
      height: 1920,
    },
  });

  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.status, 'blocked');
  assert(result.errors.some(error => /Video file not found/.test(error)));
}

function main() {
  testYouTubeHashtagsRemoveFacebookOnlyTags();
  testMetadataIsYouTubeShaped();
  testReadyJobPersistsMetadataAndValidation();
  testScheduledVisibilityRequiresExplicitDate();
  testCurrentThreeMinuteShortsDurationIsAllowed();
  testOverThreeMinuteShortIsBlocked();
  testLandscapeVideoIsBlocked();
  testMissingVideoIsBlocked();
  console.log('test-shorts-youtube-job-prep passed');
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
