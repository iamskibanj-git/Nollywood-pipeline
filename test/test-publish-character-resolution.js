/**
 * Regression checks for Publish custom-thumbnail character resolution.
 *
 * Run: node test/test-publish-character-resolution.js
 */

const assert = require('assert');
const { ThumbnailGenerator } = require('../src/main/publish/thumbnailGenerator');

function main() {
  const thumbGen = new ThumbnailGenerator(null, {});
  const script = {
    character_bible: [
      { id: 'character_1', name: 'Nneka Osuagwu', element_name_hint: 'nneka_osuagwu' },
      { id: 'character_2', name: 'Segun Balogun', element_name_hint: 'segun_balogun' },
      { id: 'character_3', name: 'Itohan Omonuwa', element_name_hint: 'itohan_omonuwa' },
    ],
    chapters: [{
      scenes: [{
        lines: [
          { speaker_id: '@segun_balogun' },
          { speaker_id: 'segun_balogun' },
          { speaker_id: '@nneka_osuagwu' },
        ],
      }],
    }],
  };

  const cinematicCharacters = thumbGen.getCharactersForThumbnail(script, {
    elementSuffix: '_legacy_0526',
    cinematicElementNames: {
      nneka_osuagwu: 'nneka_osuagwu_o1_botmf_0526',
      '@segun_balogun': 'segun_balogun_o1_botmf_0526',
    },
    outfitElements: {
      itohan_omonuwa: {
        o1: 'itohan_omonuwa_o1_botmf_0526',
      },
    },
  });

  const byHint = Object.fromEntries(cinematicCharacters.map(c => [c.elementNameHint, c]));
  assert.strictEqual(byHint.nneka_osuagwu.elementName, 'nneka_osuagwu_o1_botmf_0526');
  assert.strictEqual(byHint.segun_balogun.elementName, 'segun_balogun_o1_botmf_0526');
  assert.strictEqual(byHint.itohan_omonuwa.elementName, 'itohan_omonuwa_o1_botmf_0526');
  assert.strictEqual(byHint.segun_balogun.dialogueCount, 2);

  const legacyCharacters = thumbGen.getCharactersForThumbnail(script, '_botmf_0526');
  const legacyByHint = Object.fromEntries(legacyCharacters.map(c => [c.elementNameHint, c]));
  assert.strictEqual(legacyByHint.nneka_osuagwu.elementName, 'nneka_osuagwu_botmf_0526');

  console.log('publish character resolution regression checks passed');
}

main();
