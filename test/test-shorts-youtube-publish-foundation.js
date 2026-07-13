/**
 * Regression checks for the Shorts multi-platform publish foundation.
 *
 * Run: node test/test-shorts-youtube-publish-foundation.js
 */

const assert = require('assert');
const {
  FacebookShortPublisherAdapter,
  YouTubeShortPublisherAdapter,
  YouTubeStudioUploader,
  extractYouTubeStudioChannelId,
  getShortPlatformProfile,
  normalizeShortPlatform,
  validateShortMetadataForPlatform,
} = require('../src/main/shorts');

const DASHBOARD_URL = 'https://studio.youtube.com/channel/UCObQBiWc7kI4Q1PPpQZiuxA';

async function testFacebookAdapterDelegatesToExistingUploader() {
  let launched = false;
  let closed = false;
  let seenOptions = null;
  let scheduledPayload = null;

  const adapter = new FacebookShortPublisherAdapter({
    uploaderOptions: { marker: 'legacy-facebook-options' },
    uploaderFactory: options => {
      seenOptions = options;
      return {
        launch: async () => { launched = true; },
        close: async () => { closed = true; },
        scheduleReel: async payload => {
          scheduledPayload = payload;
          return { success: true, facebookPostId: 'fb-123' };
        },
      };
    },
  });

  await adapter.launch();
  const result = await adapter.scheduleShort({
    filePath: 'C:\\tmp\\short_001.mp4',
    description: 'Caption body',
    scheduledDate: '2026-07-14',
    scheduledTime: '18:00',
    status: 'seo_done',
  });
  await adapter.close();

  assert.strictEqual(launched, true);
  assert.strictEqual(closed, true);
  assert.deepStrictEqual(seenOptions, { marker: 'legacy-facebook-options' });
  assert.deepStrictEqual(scheduledPayload, {
    filePath: 'C:\\tmp\\short_001.mp4',
    description: 'Caption body',
    scheduledDate: '2026-07-14',
    scheduledTime: '18:00',
    status: 'seo_done',
  });
  assert.deepStrictEqual(result, { success: true, facebookPostId: 'fb-123' });
}

function testYouTubeProfileAliasesAndLimits() {
  assert.strictEqual(normalizeShortPlatform('youtube'), 'youtube_shorts');
  assert.strictEqual(normalizeShortPlatform('fb'), 'facebook_reels');

  const profile = getShortPlatformProfile('youtube');
  assert.strictEqual(profile.platform, 'youtube_shorts');
  assert.strictEqual(profile.maxDurationSeconds, 180);
  assert.strictEqual(profile.titleMaxChars, 100);
  assert.strictEqual(profile.requiresAiDisclosureDecision, true);
}

function testYouTubeValidationAcceptsSafeInitialProofShape() {
  const validation = validateShortMetadataForPlatform({
    title: 'She Found the Letter',
    description: 'A tense Nollywood drama moment. #shorts #nollywood',
    durationSeconds: 58,
    width: 1080,
    height: 1920,
    aiDisclosure: true,
  }, 'youtube');

  assert.strictEqual(validation.ok, true);
  assert.deepStrictEqual(validation.errors, []);
  assert.deepStrictEqual(validation.warnings, []);
}

function testYouTubeValidationRejectsRiskyMetadata() {
  const validation = validateShortMetadataForPlatform({
    title: 'x'.repeat(101),
    description: 'y'.repeat(5001),
    durationSeconds: 181,
    width: 1920,
    height: 1080,
  }, 'youtube_shorts');

  assert.strictEqual(validation.ok, false);
  assert(validation.errors.some(error => /title exceeds 100/.test(error)));
  assert(validation.errors.some(error => /description exceeds 5000/.test(error)));
  assert(validation.errors.some(error => /exceeds 180 seconds/.test(error)));
  assert(validation.errors.some(error => /vertical or square/.test(error)));
  assert(validation.errors.some(error => /AI altered\/generated disclosure/.test(error)));
}

function testYouTubeValidationAcceptsCurrentThreeMinuteShorts() {
  const validation = validateShortMetadataForPlatform({
    title: 'The Secret Meeting',
    description: 'A dramatic turning point. #shorts #nollywood',
    durationSeconds: 75,
    width: 1080,
    height: 1920,
    aiDisclosure: true,
  }, 'youtube_shorts');

  assert.strictEqual(validation.ok, true);
  assert.deepStrictEqual(validation.errors, []);
  assert.deepStrictEqual(validation.warnings, []);
}

async function testYouTubeDryRunAdapterBlocksScheduling() {
  const logs = [];
  const adapter = new YouTubeShortPublisherAdapter({ log: message => logs.push(message) });
  const launchResult = await adapter.launch();
  const scheduleResult = await adapter.scheduleShort({
    title: 'She Found the Letter',
    description: 'A tense Nollywood drama moment. #shorts #nollywood',
    durationSeconds: 58,
    width: 1080,
    height: 1920,
    aiDisclosure: true,
  });

  assert.strictEqual(launchResult.success, true);
  assert.strictEqual(launchResult.dryRun, true);
  assert.strictEqual(scheduleResult.success, false);
  assert.strictEqual(scheduleResult.dryRun, true);
  assert.strictEqual(scheduleResult.blocked, true);
  assert.match(scheduleResult.error, /YOUTUBE_DRY_RUN_ONLY/);
  assert(logs.some(line => /Dry-run publisher initialized/.test(line)));
}

async function testYouTubeStudioChannelProofPassesWithExpectedDashboard() {
  const page = makeFakeStudioPage({
    url: DASHBOARD_URL,
    title: 'Channel dashboard - YouTube Studio',
    bodyText: 'Channel dashboard Content Analytics Comments',
    ytcpAppCount: 1,
    createButtonCount: 1,
  });
  const verifier = new YouTubeStudioUploader({
    page,
    dashboardUrl: DASHBOARD_URL,
    loginWaitMs: 20,
    log: () => {},
  });

  const result = await verifier.launch();

  assert.strictEqual(page.gotoUrl, DASHBOARD_URL);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.channelProof.verified, true);
  assert.strictEqual(result.channelProof.expectedChannelId, 'UCObQBiWc7kI4Q1PPpQZiuxA');
  assert.strictEqual(result.channelProof.channelIdMatched, true);
}

async function testYouTubeStudioUploadEntryInspectionIsNoFileDryRun() {
  const page = makeFakeStudioPage({
    url: DASHBOARD_URL,
    title: 'Channel dashboard - YouTube Studio',
    bodyText: 'Channel dashboard Content Analytics Comments',
    ytcpAppCount: 1,
    createButtonCount: 2,
  });
  const verifier = new YouTubeStudioUploader({
    page,
    dashboardUrl: DASHBOARD_URL,
    loginWaitMs: 20,
    log: () => {},
  });

  await verifier.launch();
  const inspection = await verifier.inspectUploadWizard();

  assert.strictEqual(inspection.success, true);
  assert.strictEqual(inspection.dryRun, true);
  assert.strictEqual(inspection.noFileSelected, true);
  assert.strictEqual(inspection.entryProof.hasCreateEntry, true);
  assert.strictEqual(inspection.entryProof.createButtonCount, 2);
  assert.strictEqual(inspection.wizardProof, null);
}
async function testYouTubeStudioChannelProofRejectsLoginPage() {
  const page = makeFakeStudioPage({
    url: 'https://accounts.google.com/ServiceLogin',
    title: 'Sign in - Google Accounts',
    bodyText: 'Sign in to continue to YouTube Studio Use your Google Account',
    ytcpAppCount: 0,
    createButtonCount: 0,
  });
  const verifier = new YouTubeStudioUploader({
    page,
    dashboardUrl: DASHBOARD_URL,
    loginWaitMs: 1,
    log: () => {},
  });

  await assert.rejects(
    () => verifier.launch(),
    error => {
      assert.match(error.message, /YOUTUBE_CHANNEL_CONTEXT_NOT_VERIFIED/);
      assert.match(error.message, /loginRequired/);
      return true;
    }
  );
}

async function testYouTubeAdapterRunsChannelVerifierSeparately() {
  let factoryOptions = null;
  const adapter = new YouTubeShortPublisherAdapter({
    dashboardUrl: DASHBOARD_URL,
    userDataDir: '.browser-profile-youtube',
    loginWaitMs: 1234,
    log: () => {},
    studioUploaderFactory: options => {
      factoryOptions = options;
      return {
        launch: async () => ({
          success: true,
          dryRun: true,
          channelProof: { verified: true, expectedChannelId: 'UCObQBiWc7kI4Q1PPpQZiuxA' },
        }),
        close: async () => {},
      };
    },
  });

  const proof = await adapter.verifyChannelContext();
  const scheduleResult = await adapter.scheduleShort({
    title: 'She Found the Letter',
    description: 'A tense Nollywood drama moment. #shorts #nollywood',
    durationSeconds: 58,
    width: 1080,
    height: 1920,
    aiDisclosure: true,
  });
  await adapter.close();

  assert.strictEqual(factoryOptions.dashboardUrl, DASHBOARD_URL);
  assert.strictEqual(factoryOptions.userDataDir, '.browser-profile-youtube');
  assert.strictEqual(factoryOptions.loginWaitMs, 1234);
  assert.strictEqual(proof.channelProof.verified, true);
  assert.strictEqual(scheduleResult.channelProof.verified, true);
  assert.match(scheduleResult.error, /YOUTUBE_DRY_RUN_ONLY/);
}


async function testYouTubeAdapterDeletesRemoteShort() {
  let factoryOptions = null;
  let deletePayload = null;
  let deleteOptions = null;
  let closed = false;
  const adapter = new YouTubeShortPublisherAdapter({
    dashboardUrl: DASHBOARD_URL,
    userDataDir: '.browser-profile-youtube',
    loginWaitMs: 777,
    log: () => {},
    studioUploaderFactory: options => {
      factoryOptions = options;
      return {
        launch: async () => ({
          success: true,
          channelProof: { verified: true, expectedChannelId: 'UCObQBiWc7kI4Q1PPpQZiuxA' },
        }),
        deleteShortByRemoteId: async (payload, options) => {
          deletePayload = payload;
          deleteOptions = options;
          return {
            success: true,
            deleted: true,
            remoteVideoId: payload.remoteVideoId,
            channelProof: { verified: true, expectedChannelId: 'UCObQBiWc7kI4Q1PPpQZiuxA' },
          };
        },
        close: async () => { closed = true; },
      };
    },
  });

  const result = await adapter.deleteShort(
    { remoteVideoId: 'uQGmdxd0TeM' },
    { confirmDelete: true }
  );
  await adapter.close();

  assert.strictEqual(factoryOptions.dashboardUrl, DASHBOARD_URL);
  assert.strictEqual(factoryOptions.userDataDir, '.browser-profile-youtube');
  assert.strictEqual(factoryOptions.loginWaitMs, 777);
  assert.deepStrictEqual(deletePayload, { remoteVideoId: 'uQGmdxd0TeM' });
  assert.strictEqual(deleteOptions.confirmDelete, true);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.deleted, true);
  assert.strictEqual(result.remoteVideoId, 'uQGmdxd0TeM');
  assert.strictEqual(adapter.channelProof.verified, true);
  assert.strictEqual(closed, true);
}

async function testYouTubeAdapterRunsUploadWizardInspectorSeparately() {
  let factoryOptions = null;
  let inspectOptions = null;
  let closed = false;
  const adapter = new YouTubeShortPublisherAdapter({
    dashboardUrl: DASHBOARD_URL,
    userDataDir: '.browser-profile-youtube',
    loginWaitMs: 4321,
    log: () => {},
    studioUploaderFactory: options => {
      factoryOptions = options;
      return {
        launch: async () => ({
          success: true,
          dryRun: true,
          channelProof: { verified: true, expectedChannelId: 'UCObQBiWc7kI4Q1PPpQZiuxA' },
        }),
        inspectUploadWizard: async options => {
          inspectOptions = options;
          return {
            success: true,
            dryRun: true,
            noFileSelected: true,
            channelProof: { verified: true, expectedChannelId: 'UCObQBiWc7kI4Q1PPpQZiuxA' },
            entryProof: { hasCreateEntry: true, createButtonCount: 1 },
            wizardProof: null,
          };
        },
        close: async () => { closed = true; },
      };
    },
  });

  const inspection = await adapter.inspectUploadWizard({ openWizard: false, jobId: 1 });
  await adapter.close();

  assert.strictEqual(factoryOptions.dashboardUrl, DASHBOARD_URL);
  assert.strictEqual(factoryOptions.userDataDir, '.browser-profile-youtube');
  assert.strictEqual(factoryOptions.loginWaitMs, 4321);
  assert.strictEqual(inspectOptions.openWizard, false);
  assert.strictEqual(inspectOptions.jobId, 1);
  assert.strictEqual(inspection.success, true);
  assert.strictEqual(inspection.noFileSelected, true);
  assert.strictEqual(inspection.entryProof.hasCreateEntry, true);
  assert.strictEqual(adapter.channelProof.verified, true);
  assert.strictEqual(closed, true);
}
function testExtractYouTubeStudioChannelId() {
  assert.strictEqual(extractYouTubeStudioChannelId(DASHBOARD_URL), 'UCObQBiWc7kI4Q1PPpQZiuxA');
  assert.strictEqual(extractYouTubeStudioChannelId('https://studio.youtube.com/'), null);
}

function makeFakeStudioPage({ url, title, bodyText, ytcpAppCount, createButtonCount }) {
  return {
    gotoUrl: null,
    async goto(nextUrl) {
      this.gotoUrl = nextUrl;
    },
    url() {
      return url;
    },
    async title() {
      return title;
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
        count: async () => selector === 'ytcp-app' ? ytcpAppCount : 0,
      };
    },
    getByRole(role, options) {
      const matchesCreate = role === 'button' && options && options.name && options.name.test('Create');
      return {
        count: async () => matchesCreate ? createButtonCount : 0,
      };
    },
  };
}

async function main() {
  await testFacebookAdapterDelegatesToExistingUploader();
  testYouTubeProfileAliasesAndLimits();
  testYouTubeValidationAcceptsSafeInitialProofShape();
  testYouTubeValidationRejectsRiskyMetadata();
  testYouTubeValidationAcceptsCurrentThreeMinuteShorts();
  await testYouTubeDryRunAdapterBlocksScheduling();
  await testYouTubeStudioChannelProofPassesWithExpectedDashboard();
  await testYouTubeStudioUploadEntryInspectionIsNoFileDryRun();
  await testYouTubeStudioChannelProofRejectsLoginPage();
  await testYouTubeAdapterRunsChannelVerifierSeparately();
  await testYouTubeAdapterRunsUploadWizardInspectorSeparately();
  await testYouTubeAdapterDeletesRemoteShort();
  testExtractYouTubeStudioChannelId();
  console.log('test-shorts-youtube-publish-foundation passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});