#!/usr/bin/env node
/**
 * Regression checks for YouTube Community post foundation.
 *
 * Run: node test/test-social-youtube-community-foundation.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SocialPostsController,
} = require('../src/main/social');
const {
  YOUTUBE_COMMUNITY_PLATFORM,
  YouTubeCommunityPostPublisher,
  buildYouTubeCommunityCaption,
  prepareYouTubeCommunityPostJob,
  prepareYouTubeCommunityMediaPaths,
  validateYouTubeCommunityPost,
} = require('../src/main/social/youtube-community-posts');

function makeImageFixture() {
  const file = path.join(os.tmpdir(), `yt-community-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
}

function testCaptionRewriteForYouTube() {
  const caption = buildYouTubeCommunityCaption({
    body: 'New Facebook Reel later today. Watch the Reel and tell us your thoughts.',
    hashtags: '["#FacebookReels", "#DramaFans"]',
  }, {
    title: 'A Mother Said No',
  });

  assert(!/Facebook/i.test(caption), 'caption should not keep Facebook wording');
  assert(!/\bReel\b/i.test(caption), 'caption should not keep singular Reel wording');
  assert.match(caption, /Short/i);
  assert.match(caption, /#AMotherSaidNo/);
}

function testValidationRequiresScheduleAndImageProof() {
  const okImage = makeImageFixture();
  try {
    const accepted = validateYouTubeCommunityPost({
      caption: 'A question for today. #Nollywood',
      mediaPaths: [okImage],
      scheduledDate: '2026-07-20',
      scheduledTime: '12:00',
    });
    assert.strictEqual(accepted.ok, true);

    const rejected = validateYouTubeCommunityPost({
      caption: '',
      mediaPaths: ['C:\\missing\\image.png'],
      scheduledDate: '',
      scheduledTime: '',
    });
    assert.strictEqual(rejected.ok, false);
    assert(rejected.errors.some(error => /caption is empty/i.test(error)));
    assert(rejected.errors.some(error => /scheduled_date is required/i.test(error)));
    assert(rejected.errors.some(error => /media file not found/i.test(error)));
  } finally {
    fs.unlinkSync(okImage);
  }
}

function testPrepareUpsertsCommunityJob() {
  const okImage = makeImageFixture();
  const calls = [];
  const store = {
    upsert(job) {
      calls.push(job);
      return { id: 99, ...job };
    },
  };

  try {
    const result = prepareYouTubeCommunityPostJob(store, {
      id: 12,
      project_id: 'project-1',
      short_id: 7,
      post_type: 'pre_short_teaser',
      title: 'Pre-Reel teaser',
      body: 'This Facebook Reel question should move to YouTube.',
      hashtags: '["#Nollywood"]',
      media_path: okImage,
      scheduled_date: '2026-07-20',
      scheduled_time: '15:00',
      status: 'content_done',
    }, {
      id: 'project-1',
      title: 'Test Movie',
    });

    assert.strictEqual(result.status, 'ready');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].platform, YOUTUBE_COMMUNITY_PLATFORM);
    assert.strictEqual(calls[0].social_post_id, 12);
    assert.strictEqual(calls[0].status, 'ready');
    assert.match(calls[0].body, /YouTube|Short/i);
    assert(!/Facebook Reel/i.test(calls[0].body));
  } finally {
    fs.unlinkSync(okImage);
  }
}

function testOversizedCommunityImageIsExported() {
  const source = path.join(os.tmpdir(), `yt-community-large-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  fs.writeFileSync(source, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(128, 1),
  ]));
  const written = [];
  try {
    const prep = prepareYouTubeCommunityMediaPaths([source], {
      maxImageBytes: 64,
      convertImage: (_inputPath, { outputPath }) => {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        written.push(outputPath);
        return { path: outputPath, strategy: 'unit-test' };
      },
    });
    assert.strictEqual(prep.errors.length, 0);
    assert.strictEqual(prep.conversions.length, 1);
    assert.strictEqual(prep.mediaPaths.length, 1);
    assert.notStrictEqual(prep.mediaPaths[0], source);
    assert.strictEqual(path.extname(prep.mediaPaths[0]).toLowerCase(), '.jpg');
    assert(fs.existsSync(prep.mediaPaths[0]));
  } finally {
    for (const file of [source, ...written]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
}

function testPreparePreservesScheduledCommunityJob() {
  let upsertCalled = false;
  const existing = {
    id: 51,
    social_post_id: 12,
    platform: YOUTUBE_COMMUNITY_PLATFORM,
    status: 'scheduled',
    scheduled_date: '2026-07-20',
    scheduled_time: '12:00',
    body: 'Already scheduled. #Nollywood',
    media_path: null,
    metadata_json: JSON.stringify({ mediaPaths: [] }),
    validation_json: JSON.stringify({ ok: true, errors: [], warnings: [], hashtags: ['#Nollywood'], mediaCount: 0 }),
    remote_post_id: 'already-remote',
    remote_url: 'https://studio.youtube.com/post/already-remote/edit',
  };
  const store = {
    getForPost: () => existing,
    upsert: () => {
      upsertCalled = true;
      throw new Error('scheduled job should not be upserted');
    },
  };
  const result = prepareYouTubeCommunityPostJob(store, {
    id: 12,
    project_id: 'project-1',
    title: 'Already scheduled source',
    body: 'Updated source copy should not overwrite remote proof.',
    scheduled_date: '2026-07-20',
    scheduled_time: '12:00',
    status: 'scheduled',
  }, { id: 'project-1', title: 'Project' });
  assert.strictEqual(result.preserved, true);
  assert.strictEqual(result.status, 'scheduled');
  assert.strictEqual(result.job.remote_post_id, 'already-remote');
  assert.strictEqual(upsertCalled, false);
}
function testPrepareClearsStaleScheduledCompanionError() {
  let updated = null;
  const existing = {
    id: 52,
    social_post_id: 12,
    platform: YOUTUBE_COMMUNITY_PLATFORM,
    status: 'scheduled',
    scheduled_date: '2026-07-20',
    scheduled_time: '21:00',
    body: 'Already scheduled. #Nollywood',
    media_path: null,
    metadata_json: JSON.stringify({
      mediaPaths: [],
      companionErrors: ['Matching scheduled YouTube Short job not found for short 7'],
    }),
    validation_json: JSON.stringify({
      ok: false,
      errors: ['Matching scheduled YouTube Short job not found for short 7'],
      warnings: [],
      hashtags: ['#Nollywood'],
      mediaCount: 0,
    }),
    remote_post_id: 'already-remote',
    remote_url: 'https://studio.youtube.com/post/already-remote/edit',
    error_message: 'Matching scheduled YouTube Short job not found for short 7',
  };
  const store = {
    getForPost: () => existing,
    update: (_id, fields) => {
      updated = { ...existing, ...fields };
      return updated;
    },
    upsert: () => {
      throw new Error('scheduled job should not be upserted');
    },
  };
  const result = prepareYouTubeCommunityPostJob(store, {
    id: 12,
    project_id: 'project-1',
    title: 'Already scheduled source',
    body: 'Source copy.',
    scheduled_date: '2026-07-20',
    scheduled_time: '21:00',
    status: 'scheduled',
  }, { id: 'project-1', title: 'Project' }, {
    companionProof: {
      companionOfPlatform: 'youtube_shorts',
      shortId: 7,
      shortPublishJobId: 88,
      shortRemotePostId: 'yt-short-123',
      shortScheduledDate: '2026-07-20',
      shortScheduledTime: '18:00',
      communityScheduledTime: '21:00',
      offsetMinutes: 180,
    },
  });

  assert.strictEqual(result.preserved, true);
  assert(updated, 'scheduled job should be annotated with cleared companion proof');
  assert.strictEqual(updated.error_message, null);
  const validation = typeof updated.validation_json === 'string' ? JSON.parse(updated.validation_json) : updated.validation_json;
  const metadata = typeof updated.metadata_json === 'string' ? JSON.parse(updated.metadata_json) : updated.metadata_json;
  assert.strictEqual(validation.ok, true);
  assert.deepStrictEqual(validation.errors, []);
  assert.strictEqual(validation.companionProof.shortRemotePostId, 'yt-short-123');
  assert.strictEqual(metadata.companion.shortRemotePostId, 'yt-short-123');
  assert.strictEqual(metadata.companionErrors, undefined);
}
function testPrepareBlocksWithoutScheduledYouTubeShortCompanion() {
  const image = makeImageFixture();
  const jobs = [];
  const socialPublishJobs = {
    listForProject: () => jobs,
    getForPost: () => null,
    upsert: job => {
      const row = { id: jobs.length + 1, ...job };
      jobs.push(row);
      return row;
    },
  };
  const controller = new SocialPostsController({
    backup: () => {},
    getProject: () => ({ id: 'project-1', title: 'Project' }),
    getSocialPostsForProject: () => [{
      id: 21,
      project_id: 'project-1',
      short_id: 7,
      post_type: 'post_short_recap',
      title: 'Post recap',
      body: 'What did you think of the Short?',
      hashtags: '["#Nollywood"]',
      media_path: image,
      scheduled_date: '2026-07-20',
      scheduled_time: '21:00',
      status: 'content_done',
    }],
    getShortPublishJob: () => null,
  }, {
    log: () => {},
    socialPublishJobs,
  });

  try {
    const result = controller.prepareYouTubeCommunityPosts('project-1');
    assert.strictEqual(result.ready, 0);
    assert.strictEqual(result.blocked, 1);
    assert.strictEqual(result.companionSummary.blocked, 1);
    assert.strictEqual(jobs[0].status, 'blocked');
    assert.match(jobs[0].error_message, /Matching scheduled YouTube Short job not found/);
  } finally {
    fs.unlinkSync(image);
  }
}

function testPrepareAllowsScheduledYouTubeShortCompanion() {
  const image = makeImageFixture();
  const jobs = [];
  const socialPublishJobs = {
    listForProject: () => jobs,
    getForPost: () => null,
    upsert: job => {
      const row = { id: jobs.length + 1, ...job };
      jobs.push(row);
      return row;
    },
  };
  const controller = new SocialPostsController({
    backup: () => {},
    getProject: () => ({ id: 'project-1', title: 'Project' }),
    getSocialPostsForProject: () => [{
      id: 22,
      project_id: 'project-1',
      short_id: 7,
      post_type: 'post_short_recap',
      title: 'Post recap',
      body: 'What did you think of the Short?',
      hashtags: '["#Nollywood"]',
      media_path: image,
      scheduled_date: '2026-07-20',
      scheduled_time: '21:00',
      status: 'content_done',
    }],
    getShortPublishJob: () => ({
      id: 88,
      short_id: 7,
      platform: 'youtube_shorts',
      status: 'scheduled',
      scheduled_date: '2026-07-20',
      scheduled_time: '18:00',
      remote_post_id: 'yt-short-123',
      remote_url: 'https://youtube.com/shorts/yt-short-123',
    }),
  }, {
    log: () => {},
    socialPublishJobs,
  });

  try {
    const result = controller.prepareYouTubeCommunityPosts('project-1');
    assert.strictEqual(result.ready, 1);
    assert.strictEqual(result.blocked, 0);
    assert.strictEqual(result.companionSummary.ready, 1);
    assert.strictEqual(jobs[0].status, 'ready');
    const metadata = typeof jobs[0].metadata_json === 'string' ? JSON.parse(jobs[0].metadata_json) : jobs[0].metadata_json;
    assert.strictEqual(metadata.companion.shortPublishJobId, 88);
    assert.strictEqual(metadata.companion.shortRemotePostId, 'yt-short-123');
    assert.strictEqual(metadata.companion.offsetMinutes, 180);
  } finally {
    fs.unlinkSync(image);
  }
}
async function testPublisherRequiresScheduleConfirmation() {
  const image = makeImageFixture();
  let scheduleCalled = false;
  const publisher = new YouTubeCommunityPostPublisher({
    log: () => {},
    studioUploaderFactory: () => ({
      launch: async () => ({ channelProof: { verified: true } }),
      scheduleCommunityPost: async () => {
        scheduleCalled = true;
        return { success: true, scheduled: true };
      },
      close: async () => {},
    }),
  });

  try {
    await assert.rejects(
      () => publisher.schedulePost({
        caption: 'A scheduled YouTube Community post. #Nollywood',
        mediaPaths: [image],
        scheduledDate: '2026-07-20',
        scheduledTime: '12:00',
      }, {}),
      /YOUTUBE_COMMUNITY_SCHEDULE_REQUIRES_CONFIRMATION/
    );
    assert.strictEqual(scheduleCalled, false);

    const result = await publisher.schedulePost({
      caption: 'A scheduled YouTube Community post. #Nollywood',
      mediaPaths: [image],
      scheduledDate: '2026-07-20',
      scheduledTime: '12:00',
    }, { confirmSchedule: true });
    assert.strictEqual(result.success, true);
    assert.strictEqual(scheduleCalled, true);
  } finally {
    fs.unlinkSync(image);
  }
}

function testImageUploaderHardeningIsPresent() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'social', 'youtube-community-posts.js'), 'utf8');
  assert(source.includes("waitForEvent('filechooser'"), 'image upload should use the Image button/filechooser path');
  assert(source.includes('_readCommunityImageAttachmentProof'), 'image upload should require attachment proof');
  assert(source.includes('YOUTUBE_COMMUNITY_IMAGE_ATTACHMENT_PROOF_NOT_FOUND'), 'missing image attachment proof should be a hard failure');
  assert(source.includes("scrollIntoView({ block: 'center'"), 'offscreen Community controls should be scrolled into view before clicking');
}
async function testControllerSchedulesCommunityJobThroughPublisher() {
  const jobs = [{
    id: 77,
    social_post_id: 12,
    platform: YOUTUBE_COMMUNITY_PLATFORM,
    status: 'ready',
    body: 'A prepared caption. #Nollywood',
    media_path: null,
    metadata_json: JSON.stringify({
      mediaPaths: [],
      companion: {
        companionOfPlatform: 'youtube_shorts',
        shortId: 7,
        shortPublishJobId: 88,
        shortRemotePostId: 'yt-short-123',
        shortScheduledDate: '2026-07-20',
        shortScheduledTime: '18:00',
      },
    }),
    scheduled_date: '2026-07-20',
    scheduled_time: '12:00',
  }];
  let markedScheduled = false;
  const socialPublishJobs = {
    listForProject: () => jobs,
    getById: id => jobs.find(job => Number(job.id) === Number(id)),
    getPending: () => jobs,
    update: (id, fields) => Object.assign(jobs[0], fields),
    markScheduled: (id, proof) => {
      markedScheduled = true;
      Object.assign(jobs[0], {
        status: 'scheduled',
        remote_post_id: proof.remote_post_id,
        proof_json: JSON.stringify(proof.proof),
      });
      return jobs[0];
    },
    markFailed: (id, errorMessage) => Object.assign(jobs[0], { status: 'upload_failed', error_message: errorMessage }),
  };
  let payloadSeen = null;
  const controller = new SocialPostsController({
    backup: () => {},
    getProject: () => ({ id: 'project-1', title: 'Project' }),
    getSocialPostsForProject: () => [],
  }, {
    log: () => {},
    socialPublishJobs,
    youtubeCommunityPublisherFactory: () => ({
      schedulePost: async (payload, options) => {
        payloadSeen = { payload, options };
        return {
          success: true,
          scheduled: true,
          remotePostId: 'community-123',
          remoteUrl: 'https://www.youtube.com/post/community-123',
        };
      },
      close: async () => {},
    }),
  });

  await assert.rejects(
    () => controller.scheduleYouTubeCommunityPostJob(77, {}),
    /YOUTUBE_COMMUNITY_SCHEDULE_REQUIRES_CONFIRMATION/
  );

  const result = await controller.scheduleYouTubeCommunityPostJob(77, { confirmSchedule: true });
  assert.strictEqual(result.success, true);
  assert.strictEqual(markedScheduled, true);
  assert.strictEqual(jobs[0].status, 'scheduled');
  assert.strictEqual(jobs[0].remote_post_id, 'community-123');
  assert.strictEqual(payloadSeen.options.confirmSchedule, true);
  assert.strictEqual(payloadSeen.payload.scheduledDate, '2026-07-20');
}

async function testControllerBlocksOrphanCommunityJobBeforePublisher() {
  const jobs = [{
    id: 78,
    social_post_id: 12,
    platform: YOUTUBE_COMMUNITY_PLATFORM,
    status: 'ready',
    body: 'A prepared caption. #Nollywood',
    media_path: null,
    metadata_json: JSON.stringify({ mediaPaths: [] }),
    scheduled_date: '2026-07-20',
    scheduled_time: '21:00',
  }];
  let publisherCalled = false;
  const socialPublishJobs = {
    listForProject: () => jobs,
    getById: id => jobs.find(job => Number(job.id) === Number(id)),
    getPending: () => jobs,
    update: (id, fields) => Object.assign(jobs[0], fields),
    markScheduled: () => {
      throw new Error('orphan job must not be scheduled');
    },
    markFailed: (id, errorMessage) => Object.assign(jobs[0], { status: 'upload_failed', error_message: errorMessage }),
  };
  const controller = new SocialPostsController({
    backup: () => {},
    queryOne: () => null,
    getProject: () => ({ id: 'project-1', title: 'Project' }),
    getSocialPostsForProject: () => [],
  }, {
    log: () => {},
    socialPublishJobs,
    youtubeCommunityPublisherFactory: () => ({
      schedulePost: async () => {
        publisherCalled = true;
        return { success: true };
      },
      close: async () => {},
    }),
  });

  const result = await controller.scheduleYouTubeCommunityPostJob(78, { confirmSchedule: true });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(publisherCalled, false);
  assert.strictEqual(jobs[0].status, 'blocked');
  assert.match(jobs[0].error_message, /YOUTUBE_COMMUNITY_COMPANION_SHORT_NOT_READY/);
}
async function main() {
  testCaptionRewriteForYouTube();
  testValidationRequiresScheduleAndImageProof();
  testPrepareUpsertsCommunityJob();
  testOversizedCommunityImageIsExported();
  testPreparePreservesScheduledCommunityJob();
  testPrepareClearsStaleScheduledCompanionError();
  testPrepareBlocksWithoutScheduledYouTubeShortCompanion();
  testPrepareAllowsScheduledYouTubeShortCompanion();
  await testPublisherRequiresScheduleConfirmation();
  await testControllerSchedulesCommunityJobThroughPublisher();
  await testControllerBlocksOrphanCommunityJobBeforePublisher();
  testImageUploaderHardeningIsPresent();
  console.log('test-social-youtube-community-foundation passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
