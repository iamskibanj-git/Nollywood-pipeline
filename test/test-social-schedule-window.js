/**
 * Regression checks for Engagement post scheduling around Facebook's schedule window.
 *
 * Run: node test/test-social-schedule-window.js
 */

const assert = require('assert');
const { SocialPostsController } = require('../src/main/social');
const { SocialFacebookUploader } = require('../src/main/social/social-facebook-uploader');

const PROJECT_ID = 'project-1';
const NOW = new Date(2026, 5, 25, 12, 0, 0);

function makePost(id, date, status = 'content_done') {
  return {
    id,
    project_id: PROJECT_ID,
    post_type: 'pre_short_teaser',
    status,
    scheduled_date: date,
    scheduled_time: '15:00',
    title: `Post ${id}`,
    body: `Caption for engagement post ${id}.`,
    hashtags: '[]',
    media_path: `C:\\tmp\\post_${id}.png`,
  };
}

function makeDb(posts, hooks = {}) {
  return {
    backup: hooks.backup || (() => {}),
    getPendingSocialUploads: () => posts.filter(p => p.status === 'content_done' || p.status === 'upload_failed'),
    getSocialPostsForProject: () => posts,
    markSocialPostScheduled: hooks.markScheduled || ((id, facebookPostId = null) => {
      const post = posts.find(p => p.id === id);
      if (post) {
        post.status = 'scheduled';
        post.facebook_post_id = facebookPostId;
      }
    }),
    markSocialPostFailed: hooks.markFailed || ((id, errorMessage) => {
      const post = posts.find(p => p.id === id);
      if (post) {
        post.status = 'upload_failed';
        post.error_message = errorMessage;
      }
    }),
  };
}

async function testUploaderDefersBeforeFileCheck() {
  const uploader = new SocialFacebookUploader({
    nowProvider: () => NOW,
    log: () => {},
  });

  const result = await uploader.scheduleImagePost({
    mediaPath: 'C:\\does-not-exist\\future.png',
    caption: 'Future engagement post.',
    scheduledDate: '2026-07-25',
    scheduledTime: '15:00',
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.deferred, true);
  assert.match(result.error, /FACEBOOK_SCHEDULE_WINDOW/);
  assert.match(result.error, /max schedule date 2026-07-24/);
}

async function testFutureOnlyBatchDoesNotLaunchFacebook() {
  const posts = [makePost(25, '2026-07-25')];
  let backupCalled = false;
  let factoryCalled = false;
  const db = makeDb(posts, {
    backup: () => { backupCalled = true; },
    markScheduled: () => {
      throw new Error('future-only engagement batch should not schedule posts');
    },
    markFailed: () => {
      throw new Error('deferred engagement posts should not be marked failed');
    },
  });

  const controller = new SocialPostsController(db, {
    nowProvider: () => NOW,
    log: () => {},
    uploaderFactory: () => {
      factoryCalled = true;
      return { launch: async () => {}, close: async () => {}, scheduleImagePost: async () => ({ success: true }) };
    },
  });

  const result = await controller.scheduleAll(PROJECT_ID);

  assert.strictEqual(result.uploaded, 0);
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(result.deferred, 1);
  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.maxScheduleDate, '2026-07-24');
  assert.strictEqual(posts[0].status, 'content_done');
  assert.strictEqual(factoryCalled, false, 'future-only batch should not launch Facebook');
  assert.strictEqual(backupCalled, false, 'future-only batch should not create an upload backup');
}

async function testMixedBatchSkipsDeferredRows() {
  const posts = [
    makePost(24, '2026-07-24'),
    makePost(25, '2026-07-25'),
  ];
  let backupCalled = false;
  let launched = false;
  let closed = false;
  const scheduledPayloads = [];
  const scheduledIds = [];
  const db = makeDb(posts, {
    backup: () => { backupCalled = true; },
    markScheduled: id => {
      scheduledIds.push(id);
      const post = posts.find(p => p.id === id);
      if (post) post.status = 'scheduled';
    },
    markFailed: () => {
      throw new Error('deferred engagement posts should not be marked failed');
    },
  });

  const fakeUploader = {
    launch: async () => { launched = true; },
    close: async () => { closed = true; },
    scheduleImagePost: async payload => {
      scheduledPayloads.push(payload);
      return { success: true };
    },
  };

  const controller = new SocialPostsController(db, {
    nowProvider: () => NOW,
    log: () => {},
    uploaderFactory: () => fakeUploader,
  });

  const result = await controller.scheduleAll(PROJECT_ID);

  assert.strictEqual(backupCalled, true);
  assert.strictEqual(launched, true);
  assert.strictEqual(closed, true);
  assert.deepStrictEqual(scheduledIds, [24]);
  assert.strictEqual(scheduledPayloads.length, 1);
  assert.strictEqual(scheduledPayloads[0].scheduledDate, '2026-07-24');
  assert.strictEqual(posts[1].status, 'content_done');
  assert.strictEqual(result.uploaded, 1);
  assert.strictEqual(result.failed, 0);
  assert.strictEqual(result.deferred, 1);
  assert.strictEqual(result.total, 2);
  assert.strictEqual(result.maxScheduleDate, '2026-07-24');
}

async function testConfirmationUsesSettleAndRefreshPhases() {
  const uploader = new SocialFacebookUploader({ log: () => {} });
  let settleArgs = null;
  const pollCalls = [];

  uploader._waitForImageScheduleSubmissionSettle = async (...args) => {
    settleArgs = args;
  };
  uploader._pollSocialScheduledRowsForMatch = async options => {
    pollCalls.push(options);
    return pollCalls.length === 2;
  };

  await uploader._waitForScheduleConfirmation('Caption body for match', 3, {
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    alreadySettledMs: 30000,
  });

  assert.deepStrictEqual(settleArgs, ['Caption body for match', 30000]);
  assert.strictEqual(pollCalls.length, 2);
  assert.strictEqual(pollCalls[0].phase, 'in-place confirmation');
  assert.strictEqual(pollCalls[0].reloadEveryMs, 0);
  assert.strictEqual(pollCalls[1].phase, 'post-refresh confirmation');
  assert.ok(pollCalls[1].reloadEveryMs > 0);
  assert.strictEqual(pollCalls[1].baselineCount, 3);
}

async function main() {
  await testUploaderDefersBeforeFileCheck();
  await testFutureOnlyBatchDoesNotLaunchFacebook();
  await testMixedBatchSkipsDeferredRows();
  await testConfirmationUsesSettleAndRefreshPhases();
  console.log('test-social-schedule-window passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
