/**
 * Regression checks for home-page default project settings.
 *
 * Run: node test/test-home-default-project-settings.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
  'utf8'
);

function selectedValueFor(selectId) {
  const selectMatch = html.match(new RegExp(`<select[^>]*id="${selectId}"[\\s\\S]*?</select>`));
  assert(selectMatch, `Missing select #${selectId}`);

  const optionMatch = selectMatch[0].match(/<option\s+value="([^"]+)"\s+selected>/);
  assert(optionMatch, `Missing selected option for #${selectId}`);
  return optionMatch[1];
}

function main() {
  const expectedDefaults = {
    'duration-preset': '30min',
    'cinematic-video-engine-preset': 'cinema-studio-3.5',
    'aspect-preset': '9:16',
    'mode-preset': 'cinematic',
    'duration-preset-fresh': '30min',
    'cinematic-video-engine-preset-fresh': 'cinema-studio-3.5',
    'aspect-preset-fresh': '9:16',
    'mode-preset-fresh': 'cinematic',
  };

  for (const [selectId, expectedValue] of Object.entries(expectedDefaults)) {
    assert.strictEqual(selectedValueFor(selectId), expectedValue, `Wrong default for #${selectId}`);
  }

  assert(
    html.includes("videoEngine === 'cinema-studio-3.5' ? 'Cinema Studio 3.5' : 'Kling 3.0'"),
    'Duration summary should reflect the selected cinematic video engine'
  );

  console.log('home default project settings regression checks passed');
}

main();
