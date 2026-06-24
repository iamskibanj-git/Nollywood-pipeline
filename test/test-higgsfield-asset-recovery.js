/**
 * Regression checks for prompt-matched Higgsfield Asset Library recovery.
 *
 * Run: node test/test-higgsfield-asset-recovery.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { HiggsFieldAutomation } = require('../src/main/automation/higgsfield');

function main() {
  const automation = Object.create(HiggsFieldAutomation.prototype);
  const uuid = 'c36924fb-8a96-44c1-b521-5b69e6914ca2';

  const encodedDetectedUrl =
    'https://images.higgs.ai/?default=1&output=webp&url=https%3A%2F%2Fd8j0ntlcm91z4.cloudfront.net%2Fuser_abc%2Fhf_20260624_200510_c36924fb-8a96-44c1-b521-5b69e6914ca2_min.webp&w=1920&q=85';
  assert.strictEqual(
    automation._extractAssetUuidFromUrl(encodedDetectedUrl),
    uuid,
    'encoded detected CDN URL should yield the generation UUID'
  );

  assert.strictEqual(
    automation._extractAssetUuidFromUrl(`https://higgsfield.ai/asset/image/${uuid}`),
    uuid,
    'direct Asset Library detail URL should yield the asset UUID'
  );

  assert.strictEqual(
    automation._extractAssetUuidFromUrl('https://higgsfield.ai/asset/image'),
    null,
    'asset grid URL without UUID should not invent an ID'
  );

  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/automation/higgsfield.js'), 'utf8');
  assert(
    source.includes('detectedUrl,') &&
      source.includes('Detected CDN URL contains asset/job UUID') &&
      source.includes('_recoverImageAssetByUuid'),
    'strict prompt-matched download should try direct detail recovery from detected URL before grid scan'
  );
  assert(
    source.includes("figure[data-asset-id]") &&
      source.includes("[data-asset-id]") &&
      source.includes('a[href*="/asset/${assetType}/"]') &&
      source.includes("document.querySelectorAll('img[src]')"),
    'asset recovery should scan figure, generic data-asset-id, asset links, and image-src candidates'
  );
  assert(
    source.includes('Broad asset scan found no tiles') &&
      source.includes('Math.min(60000') &&
      source.includes('_downloadImageUrlToPath'),
    'post-spend recovery should have patient broad scan and matched-CDN fallback after prompt proof'
  );

  console.log('higgsfield asset recovery regression checks passed');
}

main();
