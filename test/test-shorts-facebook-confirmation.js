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

  await assert.rejects(
    () => uploader._waitForReelScheduleConfirmation(
      'The unique July 14 caption that must appear before local status changes',
      1,
      { scheduledDate: '2026-07-14', scheduledTime: '18:00' }
    ),
    /matching scheduled Reel row did not appear/
  );
}

async function main() {
  await testRowCountIncreaseIsNotConfirmation();
  await testCaptionDateTimeRowConfirms();
  await testConfirmationWaitChecksInPlaceBeforeRefresh();
  await testMissingCaptionProofFails();
  console.log('test-shorts-facebook-confirmation passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
