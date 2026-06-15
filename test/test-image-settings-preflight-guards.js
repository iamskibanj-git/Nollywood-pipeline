/**
 * Regression checks for image-generation settings preflight.
 *
 * Run: node test/test-image-settings-preflight-guards.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function main() {
  const root = path.join(__dirname, '..');
  const orchestratorSource = fs.readFileSync(path.join(root, 'src/main/pipeline/orchestrator.js'), 'utf8');
  const higgsfieldSource = fs.readFileSync(path.join(root, 'src/main/automation/higgsfield.js'), 'utf8');

  assert(
    orchestratorSource.includes("const portraitAspect = this.state.aspectRatio || '9:16';"),
    'master portrait generation must use project/global aspect ratio'
  );
  assert(
    orchestratorSource.includes("const portraitAspect = (this.state.project?.brief?.aspect_ratio === '9:16') ? '9:16' : '16:9';"),
    'portrait retry/rerender generation must use project/global aspect ratio'
  );

  assert(
    higgsfieldSource.includes('readVisibleImageSettings'),
    'image generation must read visible Nano Banana setting chips'
  );
  assert(
    higgsfieldSource.includes('setVisibleImageDropdown'),
    'image generation must be able to set settings through visible dropdown controls'
  );
  assert(
    higgsfieldSource.includes('ensureImageAspect') && higgsfieldSource.includes('ensureImageResolution'),
    'image generation must actively ensure both aspect and resolution before submit'
  );
  assert(
    higgsfieldSource.includes('Native aspect <select> unavailable or not confirmed'),
    'image generation must fall back when native selects disappear from the UI'
  );
  assert(
    higgsfieldSource.includes("kind === 'resolution' && textUpper.startsWith(targetUpper)"),
    'image resolution option matching must handle labels like 2KUnlimited'
  );
  assert(
    higgsfieldSource.includes('final image settings wrong before Generate'),
    'image generation must re-check final settings immediately before Generate'
  );
  assert(
    !higgsfieldSource.includes('generation will proceed but output aspect may not match'),
    'image generation must not warn-and-proceed on unconfirmed aspect'
  );

  console.log('image settings preflight guard regression checks passed');
}

main();
