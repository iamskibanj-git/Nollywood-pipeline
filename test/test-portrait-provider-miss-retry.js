/**
 * Regression checks for portrait provider-miss retry policy.
 *
 * Run: node test/test-portrait-provider-miss-retry.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function main() {
  const root = path.join(__dirname, '..');
  const higgsfieldSource = fs.readFileSync(path.join(root, 'src/main/automation/higgsfield.js'), 'utf8');
  const orchestratorSource = fs.readFileSync(path.join(root, 'src/main/pipeline/orchestrator.js'), 'utf8');

  assert(
    higgsfieldSource.includes('err.retryableProviderMiss = true') &&
      higgsfieldSource.includes('err.generationSubmitted = true') &&
      higgsfieldSource.includes('err.recoveryMatched = false'),
    'image timeout with no recovered asset must be classified as a retryable provider miss'
  );

  assert(
    orchestratorSource.includes('MAX_PORTRAIT_PROVIDER_MISS_RETRIES = 2'),
    'portrait provider-miss retry budget must be explicit and bounded'
  );

  assert(
    orchestratorSource.includes('err.retryableProviderMiss && !err.detectedCdnUrl && !fs.existsSync(portraitPath)'),
    'portrait provider miss must only retry when no stale CDN URL and no local output file exist'
  );

  assert(
    orchestratorSource.includes('db.resetAsset(asset.id)') &&
      orchestratorSource.includes("db.logEvent(projectId, 'provider_miss_retry'") &&
      orchestratorSource.includes('incompletePortraits.splice(incompletePortraits.indexOf(asset) + 1, 0, asset)'),
    'portrait provider miss must reset and requeue the same asset instead of failing immediately'
  );

  assert(
    higgsfieldSource.includes('IMAGE_SETTINGS_MISMATCH') &&
      !/IMAGE_SETTINGS_MISMATCH[\s\S]{0,300}retryableProviderMiss/.test(higgsfieldSource),
    'pre-generation image settings mismatches must not be classified as provider misses'
  );

  console.log('portrait provider-miss retry regression checks passed');
}

main();
