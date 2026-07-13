/**
 * Regression checks for YouTube Studio live-proof guardrails.
 *
 * Run: node test/test-shorts-youtube-uploader-guards.js
 */

const assert = require('assert');
const { YouTubeStudioUploader } = require('../src/main/shorts');

const DASHBOARD_URL = 'https://studio.youtube.com/channel/UCObQBiWc7kI4Q1PPpQZiuxA';

async function testDuplicateDraftFailsClosedByDefault() {
  const uploader = makeUploader();
  uploader._inspectMatchingShortDrafts = async () => ({
    skipped: false,
    matchCount: 1,
    matches: [{ text: '0:31 She Knows What Youre Hiding Draft Edit draft', thumbnailIds: ['uQGmdxd0TeM'] }],
  });

  await assert.rejects(
    () => uploader.uploadShortDraft(
      { filePath: __filename, title: 'She Knows What Youre Hiding' },
      { confirmDraftUpload: true }
    ),
    /YOUTUBE_DUPLICATE_DRAFTS_FOUND/
  );
}

async function testDuplicateDraftResumeRequiresSingleMatch() {
  const uploader = makeUploader();
  uploader._inspectMatchingShortDrafts = async () => ({
    skipped: false,
    matchCount: 2,
    matches: [
      { text: '0:31 She Knows Draft Edit draft', thumbnailIds: ['draft-a'] },
      { text: '0:31 She Knows Draft Edit draft', thumbnailIds: ['draft-b'] },
    ],
  });

  await assert.rejects(
    () => uploader.uploadShortDraft(
      { filePath: __filename, title: 'She Knows What Youre Hiding' },
      { confirmDraftUpload: true, existingDraftPolicy: 'resume' }
    ),
    /YOUTUBE_DUPLICATE_DRAFTS_AMBIGUOUS/
  );
}

async function testSingleDuplicateDraftCanResume() {
  const uploader = makeUploader();
  const duplicateProof = {
    skipped: false,
    matchCount: 1,
    matches: [{ text: '0:31 She Knows Draft Edit draft', thumbnailIds: ['uQGmdxd0TeM'] }],
  };
  uploader._inspectMatchingShortDrafts = async () => duplicateProof;
  uploader._resumeMatchingShortDraft = async (payload, options, proof) => {
    assert.strictEqual(payload.title, 'She Knows What Youre Hiding');
    assert.strictEqual(options.existingDraftPolicy, 'resume');
    assert.deepStrictEqual(proof, duplicateProof);
    return { success: true, resumedExistingDraft: true, fileSelected: false };
  };

  const result = await uploader.uploadShortDraft(
    { filePath: __filename, title: 'She Knows What Youre Hiding' },
    { confirmDraftUpload: true, existingDraftPolicy: 'resume' }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.resumedExistingDraft, true);
  assert.strictEqual(result.fileSelected, false);
}

async function testInvalidTimeBlocksFinalScheduleClick() {
  const uploader = makeUploader();
  uploader._readScheduleDateTimeProof = async () => ({
    visibleDate: 'Jul 12, 2026',
    timeValue: '7/18/2026',
    invalidTimeVisible: true,
    sampledText: 'Invalid Time',
  });

  await assert.rejects(
    () => uploader._clickFinalScheduleAndVerify({}, {}),
    /YOUTUBE_INVALID_TIME_BEFORE_FINAL_SCHEDULE/
  );
}


async function testDeleteRequiresConfirmation() {
  const uploader = makeUploader();

  await assert.rejects(
    () => uploader.deleteShortByRemoteId({ remoteVideoId: 'uQGmdxd0TeM' }, {}),
    /YOUTUBE_DELETE_REQUIRES_CONFIRMATION/
  );
}

async function testDeleteRequiresExactlyOneRemoteRow() {
  const uploader = makeUploader();
  uploader._readShortsContentRowsByRemoteId = async () => ({
    matchCount: 2,
    matches: [{ thumbnailIds: ['uQGmdxd0TeM'] }, { thumbnailIds: ['uQGmdxd0TeM'] }],
  });

  await assert.rejects(
    () => uploader.deleteShortByRemoteId(
      { remoteVideoId: 'uQGmdxd0TeM' },
      { confirmDelete: true }
    ),
    /YOUTUBE_DELETE_REMOTE_ROW_MATCH_FAILED/
  );
}

async function testDeleteVerifiesRemoteRowDisappears() {
  const uploader = makeUploader();
  const reads = [
    { matchCount: 1, matches: [{ thumbnailIds: ['uQGmdxd0TeM'], text: 'Scheduled row' }] },
    { matchCount: 0, matches: [], bodySample: 'No content available' },
  ];
  uploader._readShortsContentRowsByRemoteId = async remoteVideoId => ({
    remoteVideoId,
    ...reads.shift(),
  });
  uploader._openShortRowOptionsByRemoteId = async remoteVideoId => ({ remoteVideoId, opened: true });
  uploader._clickShortRowDeleteMenuItem = async () => ({ clicked: true });
  uploader._readShortDeleteDialogProof = async () => ({ visible: true, dialogs: [{ text: 'Permanently delete this video?' }] });
  uploader._confirmDeleteForever = async () => ({ clicked: true, checkboxClicked: true });

  const result = await uploader.deleteShortByRemoteId(
    { remoteVideoId: 'uQGmdxd0TeM' },
    { confirmDelete: true }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.deleted, true);
  assert.strictEqual(result.remoteVideoId, 'uQGmdxd0TeM');
  assert.strictEqual(result.before.matchCount, 1);
  assert.strictEqual(result.after.matchCount, 0);
}

async function testUploadSurfaceConfirmationDoesNotWriteProofByDefault() {
  const uploader = makeUploader({
    url: 'https://studio.youtube.com/video/PvmGLH0nw-8/edit',
    bodyText: 'Video scheduled Your video has been scheduled Close',
  });

  const proof = await uploader._readScheduleConfirmationProof(
    { title: 'She Knows What Youre Hiding' },
    { verifyInContentTab: false }
  );

  assert.strictEqual(proof.confirmed, false);
  assert.strictEqual(proof.source, 'upload-surface-only');
  assert.strictEqual(proof.remoteVideoId, null);
}

async function testShortsContentRowIsRequiredForScheduleProof() {
  const uploader = makeUploader({
    url: 'https://studio.youtube.com/upload',
    bodyText: 'Video scheduled Your video has been scheduled Close',
  });
  uploader._readShortsContentScheduleProof = async () => ({
    confirmed: true,
    finalUrl: 'https://studio.youtube.com/channel/UCObQBiWc7kI4Q1PPpQZiuxA/videos/short',
    remoteUrl: 'https://studio.youtube.com/video/uQGmdxd0TeM/edit',
    remoteVideoId: 'uQGmdxd0TeM',
    bodySample: '0:31 She Knows What Youre Hiding Scheduled Jul 12, 2026',
    scheduledRow: { text: '0:31 She Knows What Youre Hiding Scheduled Jul 12, 2026' },
  });

  const proof = await uploader._readScheduleConfirmationProof(
    { title: 'She Knows What Youre Hiding' },
    { verifyInContentTab: true }
  );

  assert.strictEqual(proof.confirmed, true);
  assert.strictEqual(proof.source, 'shorts-content-tab');
  assert.strictEqual(proof.remoteVideoId, 'uQGmdxd0TeM');
}

function makeUploader(overrides = {}) {
  const uploader = new YouTubeStudioUploader({
    page: makeFakeStudioPage(overrides),
    dashboardUrl: DASHBOARD_URL,
    loginWaitMs: 20,
    log: () => {},
  });
  uploader.channelProof = { verified: true };
  return uploader;
}

function makeFakeStudioPage(overrides = {}) {
  const url = overrides.url || DASHBOARD_URL;
  const bodyText = overrides.bodyText || 'Channel dashboard Content Upload videos';
  return {
    url() {
      return url;
    },
    async title() {
      return overrides.title || 'Channel dashboard - YouTube Studio';
    },
    async waitForTimeout() {},
    locator(selector) {
      if (selector === 'body') {
        return {
          innerText: async () => bodyText,
          count: async () => 1,
        };
      }
      return {
        count: async () => 0,
      };
    },
    getByRole() {
      return {
        count: async () => 0,
        first() {
          return this;
        },
        click: async () => {
          throw new Error('unexpected click');
        },
      };
    },
  };
}

async function main() {
  await testDuplicateDraftFailsClosedByDefault();
  await testDuplicateDraftResumeRequiresSingleMatch();
  await testSingleDuplicateDraftCanResume();
  await testInvalidTimeBlocksFinalScheduleClick();
  await testUploadSurfaceConfirmationDoesNotWriteProofByDefault();
  await testShortsContentRowIsRequiredForScheduleProof();
  await testDeleteRequiresConfirmation();
  await testDeleteRequiresExactlyOneRemoteRow();
  await testDeleteVerifiesRemoteRowDisappears();
  console.log('test-shorts-youtube-uploader-guards passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
