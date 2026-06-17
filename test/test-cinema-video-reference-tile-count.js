/**
 * Regression checks for Cinema Studio 3.5 composer reference tile counting.
 *
 * Run: node test/test-cinema-video-reference-tile-count.js
 */

const assert = require('assert');
const { CinemaVideoAutomation } = require('../src/main/automation/cinema-video-automation');

function main() {
  const automation = new CinemaVideoAutomation({
    automation: { page: null },
    logger: () => {},
  });

  const validElements = new Set([
    'sewa_o1_scwob_0615',
    'barrister_tunde_o2_scwob_0615',
    'amara_o1_scwob_0615',
  ]);

  assert.strictEqual(
    automation._expectedComposerReferenceTileCount('Empty room, no character references.', validElements),
    1,
    'start frame alone should expect one composer tile'
  );

  assert.strictEqual(
    automation._expectedComposerReferenceTileCount(
      '[@sewa_o1_scwob_0615, speaking]: "I know." @sewa_o1_scwob_0615 turns away.',
      validElements
    ),
    2,
    'repeated mentions of the same element should add one distinct element tile'
  );

  assert.strictEqual(
    automation._expectedComposerReferenceTileCount(
      '[@sewa_o1_scwob_0615, speaking] faces @barrister_tunde_o2_scwob_0615 while @amara_o1_scwob_0615 watches.',
      validElements
    ),
    4,
    'three distinct valid elements plus the start frame should expect four tiles'
  );

  assert.strictEqual(
    automation._expectedComposerReferenceTileCount(
      '@village_road and @invalid_location stay descriptive, while @sewa_o1_scwob_0615 speaks.',
      validElements
    ),
    2,
    'invalid/location refs should not inflate the expected composer tile count'
  );

  console.log('cinema video reference tile count regression checks passed');
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
