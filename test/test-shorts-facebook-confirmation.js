/**
 * Regression checks for Shorts Facebook schedule confirmation.
 *
 * Run: node test/test-shorts-facebook-confirmation.js
 */

const assert = require('assert');
const { FacebookUploader } = require('../src/main/shorts/facebook-uploader');

function makeUploader() {
  const logs = [];
  const uploader = Object.create(FacebookUploader.prototype);
  uploader.log = message => logs.push(message);
  uploader.nowProvider = () => new Date(2026, 6, 1, 12, 0, 0);
  uploader.page = {
    waitForTimeout: async () => {},
  };
  uploader._logs = logs;
  return uploader;
}

async function testRowCountIncreaseIsNotConfirmation() {
  const uploader = makeUploader();
  uploader._getScheduledPostRows = async () => [
    { text: 'Scheduled July 1, 2026 at 6:00 PM Existing reel' },
    { text: 'Scheduled July 14, 2026 at 6:00 PM Different reel' },
  ];

  const confirmed = await uploader._checkScheduledRowsForMatch(
    'The unique July 14 caption that must appear before local status changes',
    '2026-07-14',
    '18:00',
    1,
    'test'
  );

  assert.strictEqual(confirmed, false);
  assert(
    uploader._logs.some(line => /row count increased/.test(line) && /no caption proof/.test(line)),
    'row count increase should be logged as diagnostic only'
  );
}

async function testCaptionDateTimeRowConfirms() {
  const uploader = makeUploader();
  uploader._getScheduledPostRows = async () => [
    {
      text: 'Scheduled July 14, 2026 at 6:00 PM The unique July 14 caption that must appear before local status changes',
    },
  ];

  const confirmed = await uploader._checkScheduledRowsForMatch(
    'The unique July 14 caption that must appear before local status changes',
    '2026-07-14',
    '18:00',
    0,
    'test'
  );

  assert.strictEqual(confirmed, true);
  assert(
    uploader._logs.some(line => /caption\+date\+time/.test(line)),
    'confirmation should record caption/date/time proof when visible'
  );
}

async function testConfirmationWaitChecksInPlaceBeforeRefresh() {
  const uploader = makeUploader();
  const calls = [];
  uploader._waitForScheduleSubmissionSettle = async () => {
    calls.push({ type: 'settle' });
  };
  uploader._pollScheduledRowsForMatch = async options => {
    calls.push({ type: 'poll', phase: options.phase, reloadEveryMs: options.reloadEveryMs });
    return options.phase === 'post-refresh confirmation';
  };
  uploader._confirmReelInCalendar = async () => {
    throw new Error('calendar should not run when Content Library confirms');
  };

  await uploader._waitForReelScheduleConfirmation(
    'The unique July 14 caption that must appear before local status changes',
    1,
    { scheduledDate: '2026-07-14', scheduledTime: '18:00' }
  );

  assert.deepStrictEqual(calls, [
    { type: 'settle' },
    { type: 'poll', phase: 'in-place confirmation', reloadEveryMs: 0 },
    { type: 'poll', phase: 'post-refresh confirmation', reloadEveryMs: 15000 },
  ]);
}

async function testMissingCaptionProofFails() {
  const uploader = makeUploader();
  uploader._waitForScheduleSubmissionSettle = async () => {};
  uploader._pollScheduledRowsForMatch = async () => false;
  uploader._confirmReelInCalendar = async () => false;

  await assert.rejects(
    () => uploader._waitForReelScheduleConfirmation(
      'The unique July 14 caption that must appear before local status changes',
      1,
      { scheduledDate: '2026-07-14', scheduledTime: '18:00' }
    ),
    /settle, refresh, and Calendar/
  );
}

async function testCalendarFallbackConfirmsAfterContentLibraryMiss() {
  const uploader = makeUploader();
  const calls = [];
  let calendarArgs = null;
  uploader._waitForScheduleSubmissionSettle = async () => {
    calls.push({ type: 'settle' });
  };
  uploader._pollScheduledRowsForMatch = async options => {
    calls.push({ type: 'poll', phase: options.phase });
    return false;
  };
  uploader._confirmReelInCalendar = async options => {
    calendarArgs = options;
    return true;
  };

  await uploader._waitForReelScheduleConfirmation(
    'The unique July 14 caption that must appear before local status changes',
    1,
    { scheduledDate: '2026-07-14', scheduledTime: '18:00' }
  );

  assert.deepStrictEqual(calls, [
    { type: 'settle' },
    { type: 'poll', phase: 'in-place confirmation' },
    { type: 'poll', phase: 'post-refresh confirmation' },
  ]);
  assert.strictEqual(calendarArgs.phase, 'calendar fallback confirmation');
  assert.strictEqual(calendarArgs.scheduledDate, '2026-07-14');
  assert.strictEqual(calendarArgs.scheduledTime, '18:00');
}

async function testPreSubmitCalendarRecoverySkipsUpload() {
  const uploader = new FacebookUploader({
    nowProvider: () => new Date(2026, 6, 1, 12, 0, 0),
    log: () => {},
  });
  let reloaded = 0;
  uploader.page = {
    waitForTimeout: async () => {},
    screenshot: async () => {},
  };
  uploader._reloadScheduledLibrary = async () => {
    reloaded += 1;
  };
  uploader._dismissPopups = async () => {};
  uploader._hasScheduledReel = async () => false;
  uploader._confirmReelInCalendar = async options => {
    assert.strictEqual(options.phase, 'pre-submit calendar recovery');
    assert.strictEqual(options.scheduledDate, '2026-07-14');
    assert.strictEqual(options.scheduledTime, '18:00');
    return true;
  };
  uploader._getScheduledPostRows = async () => {
    throw new Error('should not read baseline after Calendar recovery');
  };
  uploader._retryStep = async () => {
    throw new Error('should not start upload after Calendar recovery');
  };

  const result = await uploader.scheduleReel({
    filePath: __filename,
    description: 'Existing Reel caption that Calendar can prove',
    scheduledDate: '2026-07-14',
    scheduledTime: '18:00',
  });

  assert.deepStrictEqual(result, { success: true, recovered: true });
  assert.strictEqual(reloaded, 1, 'should only load Scheduled tab before recovery');
}

async function testCalendarMatcherRequiresCaptionAndTime() {
  const uploader = makeUploader();
  const good = uploader._calendarDialogMatchesExpectedReel({
    dialogText: 'Edit reel Unique July caption that proves the correct post',
    candidate: { text: '6:00 PM' },
    expectedDescription: 'Unique July caption that proves the correct post with more copy',
    scheduledDate: '2026-07-14',
    scheduledTime: '18:00',
    headerText: 'Tuesday, Jul 14, 2026',
  });
  assert.strictEqual(good.matched, true);

  const timeOnly = uploader._calendarDialogMatchesExpectedReel({
    dialogText: 'Edit reel Some other caption',
    candidate: { text: '6:00 PM' },
    expectedDescription: 'Unique July caption that proves the correct post with more copy',
    scheduledDate: '2026-07-14',
    scheduledTime: '18:00',
    headerText: 'Tuesday, Jul 14, 2026',
  });
  assert.strictEqual(timeOnly.matched, false);
  assert(/missing-caption/.test(timeOnly.proof));

  const captionOnly = uploader._calendarDialogMatchesExpectedReel({
    dialogText: 'Edit reel Unique July caption that proves the correct post',
    candidate: { text: '3:00 PM' },
    expectedDescription: 'Unique July caption that proves the correct post with more copy',
    scheduledDate: '2026-07-14',
    scheduledTime: '18:00',
    headerText: 'Tuesday, Jul 14, 2026',
  });
  assert.strictEqual(captionOnly.matched, false);
  assert(/missing-time/.test(captionOnly.proof));
}

async function main() {
  await testRowCountIncreaseIsNotConfirmation();
  await testCaptionDateTimeRowConfirms();
  await testConfirmationWaitChecksInPlaceBeforeRefresh();
  await testMissingCaptionProofFails();
  await testCalendarFallbackConfirmsAfterContentLibraryMiss();
  await testPreSubmitCalendarRecoverySkipsUpload();
  await testCalendarMatcherRequiresCaptionAndTime();
  console.log('test-shorts-facebook-confirmation passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
