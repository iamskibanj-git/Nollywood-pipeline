/**
 * Regression checks for reference upload retry classification.
 *
 * Run: node test/test-reference-upload-retry-classifier.js
 */

const assert = require('assert');
const { HiggsFieldAutomation } = require('../src/main/automation/higgsfield');

async function main() {
  const automation = Object.create(HiggsFieldAutomation.prototype);

  assert.strictEqual(
    automation._isRetryableReferenceUploadError(new Error(
      'REFERENCE_UPLOAD_UNCONFIRMED: Reference 1/1 (portrait.png) did not register on backend within 90s. No successful upload response AND no CDN URL swap. Aborting.'
    )),
    true,
    'backend registration miss should be retryable'
  );

  assert.strictEqual(
    automation._isRetryableReferenceUploadError(new Error(
      'REFERENCE_UPLOAD_FAILED: Could not upload reference 2/2 (title-card.png). All trusted-click approaches failed. Aborting to prevent generation without face consistency.'
    )),
    true,
    'trusted-click reference upload failure should be retryable before Generate'
  );

  assert.strictEqual(
    automation._isRetryableReferenceUploadError(new Error(
      'REFERENCE_GATE_FAILED: Expected 2 reference thumbnails but only 1 visible in UI.'
    )),
    true,
    'visible thumbnail gate failure should be retryable before Generate'
  );

  assert.strictEqual(
    automation._isRetryableReferenceUploadError(new Error(
      'REFERENCE_REGRESSION: After 30s extra wait, only 1/2 reference slots still filled.'
    )),
    true,
    'post-upload reference regression should be retryable before Generate'
  );

  assert.strictEqual(
    automation._isRetryableReferenceUploadError(new Error(
      'Reference did not register on backend within 90s'
    )),
    true,
    'short backend registration miss should be retryable'
  );

  assert.strictEqual(
    automation._isRetryableReferenceUploadError(new Error(
      'IMAGE_GENERATION_TIMEOUT: job timed out after Generate'
    )),
    false,
    'post-generate timeout should not use reference-upload retry path'
  );

  assert.strictEqual(
    automation._isRetryableReferenceUploadError(new Error(
      'SESSION_EXPIRED: Please log into Higgsfield AI'
    )),
    false,
    'session recovery remains handled by orchestrator session retry'
  );

  const completeProofAutomation = Object.create(HiggsFieldAutomation.prototype);
  completeProofAutomation.selectors = { imageGeneration: {} };
  let completeProofCleared = false;
  let completeProofReuploaded = false;
  completeProofAutomation.page = {
    evaluate: async () => 1,
    waitForTimeout: async () => {},
  };
  completeProofAutomation.clearImageReferences = async () => { completeProofCleared = true; };
  completeProofAutomation.uploadImageReferences = async () => {
    completeProofReuploaded = true;
    return { successCount: 0, expectedCount: 2, complete: false, confirmedRefs: [] };
  };

  const completeProofResult = await completeProofAutomation.verifyReferenceThumbnails(2, [
    'key-art-custom.png',
    'title-card.png',
  ], {
    successCount: 2,
    expectedCount: 2,
    complete: true,
    confirmedRefs: [
      { basename: 'key-art-custom.png' },
      { basename: 'title-card.png' },
    ],
  });
  assert.strictEqual(
    completeProofResult,
    1,
    'complete backend proof should allow a flaky 1/2 UI thumbnail count'
  );
  assert.strictEqual(
    completeProofCleared,
    false,
    'complete backend proof must not trigger destructive reference clearing'
  );
  assert.strictEqual(
    completeProofReuploaded,
    false,
    'complete backend proof must not reupload and risk replacing title-card with portrait'
  );

  const incompleteProofAutomation = Object.create(HiggsFieldAutomation.prototype);
  incompleteProofAutomation.selectors = { imageGeneration: {} };
  let incompleteProofCleared = false;
  let incompleteProofReuploaded = false;
  incompleteProofAutomation.page = {
    evaluate: async () => 1,
    waitForTimeout: async () => {},
  };
  incompleteProofAutomation.clearImageReferences = async () => { incompleteProofCleared = true; };
  incompleteProofAutomation.uploadImageReferences = async () => {
    incompleteProofReuploaded = true;
    return { successCount: 1, expectedCount: 2, complete: false, confirmedRefs: [{ basename: 'key-art-custom.png' }] };
  };

  await assert.rejects(
    () => incompleteProofAutomation.verifyReferenceThumbnails(2, [
      'key-art-custom.png',
      'title-card.png',
    ], {
      successCount: 1,
      expectedCount: 2,
      complete: false,
      confirmedRefs: [{ basename: 'key-art-custom.png' }],
    }),
    /REFERENCE_GATE_FAILED/,
    'incomplete backend proof should keep the hard pre-generate reference gate'
  );
  assert.strictEqual(
    incompleteProofCleared,
    true,
    'incomplete proof should still clear before a controlled retry'
  );
  assert.strictEqual(
    incompleteProofReuploaded,
    true,
    'incomplete proof should still retry upload once'
  );

  console.log('reference upload retry classifier regression checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
