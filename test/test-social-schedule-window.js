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

async function testConfirmationUsesCalendarFirst() {
  const uploader = new SocialFacebookUploader({ log: () => {} });
  let settleArgs = null;
  let calendarArgs = null;

  uploader._waitForImageScheduleSubmissionSettle = async (...args) => {
    settleArgs = args;
  };
  uploader._confirmImagePostInCalendar = async options => {
    calendarArgs = options;
    return true;
  };
  uploader._pollSocialScheduledRowsForMatch = async () => {
    throw new Error('Content Library fallback should not run when Calendar confirms');
  };

  await uploader._waitForScheduleConfirmation('Caption body for match', 3, {
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    alreadySettledMs: 30000,
  });

  assert.deepStrictEqual(settleArgs, ['Caption body for match', 30000]);
  assert.strictEqual(calendarArgs.expectedCaption, 'Caption body for match');
  assert.strictEqual(calendarArgs.scheduledDate, '2026-07-24');
  assert.strictEqual(calendarArgs.scheduledTime, '15:00');
  assert.strictEqual(calendarArgs.phase, 'calendar confirmation');
}

async function testConfirmationFallsBackToContentLibraryAfterCalendarMiss() {
  const uploader = new SocialFacebookUploader({ log: () => {} });
  const pollCalls = [];
  let reloaded = false;

  uploader._waitForImageScheduleSubmissionSettle = async () => {};
  uploader._confirmImagePostInCalendar = async () => false;
  uploader._reloadScheduledLibrary = async () => { reloaded = true; };
  uploader._pollSocialScheduledRowsForMatch = async options => {
    pollCalls.push(options);
    return pollCalls.length === 2;
  };

  await uploader._waitForScheduleConfirmation('Caption body for match', 3, {
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    alreadySettledMs: 30000,
  });

  assert.strictEqual(reloaded, true);
  assert.strictEqual(pollCalls.length, 2);
  assert.strictEqual(pollCalls[0].phase, 'in-place confirmation');
  assert.strictEqual(pollCalls[0].reloadEveryMs, 0);
  assert.strictEqual(pollCalls[1].phase, 'post-refresh confirmation');
  assert.ok(pollCalls[1].reloadEveryMs > 0);
  assert.strictEqual(pollCalls[1].baselineCount, 3);
}

async function testUploadFailedPreSubmitCalendarRecoverySkipsCreate() {
  const uploader = new SocialFacebookUploader({
    nowProvider: () => NOW,
    log: () => {},
  });
  let createOpened = false;
  let calendarArgs = null;
  uploader.page = {
    goto: async () => {},
    waitForTimeout: async () => {},
  };
  uploader._waitForPageReady = async () => {};
  uploader._dismissPopups = async () => {};
  uploader._dismissLeavePageGuard = async () => {};
  uploader._confirmImagePostInCalendar = async options => {
    calendarArgs = options;
    return true;
  };
  uploader._openCreatePostDialog = async () => {
    createOpened = true;
    throw new Error('should not create duplicate post');
  };

  const result = await uploader.scheduleImagePost({
    mediaPath: __filename,
    caption: 'Caption for existing Facebook post.',
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    status: 'upload_failed',
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.recovered, true);
  assert.strictEqual(createOpened, false);
  assert.strictEqual(calendarArgs.phase, 'pre-submit calendar recovery');
}

async function testCalendarDialogRequiresCaptionAndTimeProof() {
  const uploader = new SocialFacebookUploader({ log: () => {} });
  const matching = uploader._calendarDialogMatchesExpectedPost({
    dialogText: 'She sent money. He wanted her presence. #NollywoodDrama',
    candidate: { text: '3:00 PM' },
    expectedCaption: 'She sent money. He wanted her presence.',
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    headerText: 'Friday, Jul 24, 2026',
  });
  assert.strictEqual(matching.matched, true);

  const timeOnly = uploader._calendarDialogMatchesExpectedPost({
    dialogText: 'A different post caption entirely.',
    candidate: { text: '3:00 PM' },
    expectedCaption: 'She sent money. He wanted her presence.',
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    headerText: 'Friday, Jul 24, 2026',
  });
  assert.strictEqual(timeOnly.matched, false);
  assert.match(timeOnly.proof, /missing-caption/);

  const captionOnly = uploader._calendarDialogMatchesExpectedPost({
    dialogText: 'She sent money. He wanted her presence.',
    candidate: { text: '4:00 PM' },
    expectedCaption: 'She sent money. He wanted her presence.',
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    headerText: 'Friday, Jul 24, 2026',
  });
  assert.strictEqual(captionOnly.matched, false);
  assert.match(captionOnly.proof, /missing-time/);
}

async function testCalendarDialogWaitsForHydratedCaption() {
  const uploader = new SocialFacebookUploader({ log: () => {} });
  let waits = 0;
  const reads = [
    'Edit post Public Add to your post',
    'Edit post Public Add to your post 3:00 PM',
    'Edit post She sent money. He wanted her presence. #NollywoodDrama',
  ];
  uploader.page = {
    waitForTimeout: async () => {
      waits += 1;
    },
  };
  uploader._readCalendarPostDialogText = async () => reads.shift() || reads[reads.length - 1] || '';

  const proof = await uploader._waitForCalendarPostDialogMatch({
    candidate: { text: '3:00 PM' },
    expectedCaption: 'She sent money. He wanted her presence.',
    scheduledDate: '2026-07-24',
    scheduledTime: '15:00',
    headerText: 'Friday, Jul 24, 2026',
  });

  assert.strictEqual(proof.match.matched, true);
  assert.strictEqual(proof.attempts, 3);
  assert.strictEqual(waits, 2);
}

async function main() {
  await testUploaderDefersBeforeFileCheck();
  await testFutureOnlyBatchDoesNotLaunchFacebook();
  await testMixedBatchSkipsDeferredRows();
  await testConfirmationUsesCalendarFirst();
  await testConfirmationFallsBackToContentLibraryAfterCalendarMiss();
  await testUploadFailedPreSubmitCalendarRecoverySkipsCreate();
  await testCalendarDialogRequiresCaptionAndTimeProof();
  await testCalendarDialogWaitsForHydratedCaption();
  console.log('test-social-schedule-window passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
