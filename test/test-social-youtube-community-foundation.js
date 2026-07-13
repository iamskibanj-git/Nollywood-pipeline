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

async function testControllerSchedulesCommunityJobThroughPublisher() {
  const jobs = [{
    id: 77,
    social_post_id: 12,
    platform: YOUTUBE_COMMUNITY_PLATFORM,
    status: 'ready',
    body: 'A prepared caption. #Nollywood',
    media_path: null,
    metadata_json: JSON.stringify({ mediaPaths: [] }),
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

async function main() {
  testCaptionRewriteForYouTube();
  testValidationRequiresScheduleAndImageProof();
  testPrepareUpsertsCommunityJob();
  await testPublisherRequiresScheduleConfirmation();
  await testControllerSchedulesCommunityJobThroughPublisher();
  console.log('test-social-youtube-community-foundation passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
