/**
 * Regression checks for reference upload retry classification.
 *
 * Run: node test/test-reference-upload-retry-classifier.js
 */

const assert = require('assert');
const { HiggsFieldAutomation } = require('../src/main/automation/higgsfield');

function main() {
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

  console.log('reference upload retry classifier regression checks passed');
}

main();
