/**
 * Regression checks for Publish custom-thumbnail character resolution.
 *
 * Run: node test/test-publish-character-resolution.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ThumbnailGenerator } = require('../src/main/publish/thumbnailGenerator');

async function main() {
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

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-thumb-reuse-'));
  fs.writeFileSync(path.join(outputDir, 'key-art-custom.png'), Buffer.alloc(2048, 1));
  fs.writeFileSync(path.join(outputDir, 'title-card.png'), Buffer.alloc(2048, 2));

  const generateCalls = [];
  const fakeAutomation = {
    page: { url: () => 'https://higgsfield.ai/ai/image?model=nano-banana-pro' },
    isLoggedIn: async () => true,
    generateImage: async (opts) => {
      generateCalls.push({
        output: path.basename(opts.outputPath),
        references: (opts.references || []).map(ref => path.basename(ref)),
      });
      fs.writeFileSync(opts.outputPath, Buffer.alloc(2048, 3));
      return { model: 'test' };
    },
  };

  const retryThumbGen = new ThumbnailGenerator(fakeAutomation, {});
  const retryResult = await retryThumbGen.generateCustomThumbnail({
    title: 'Retry Title',
    tagline: '',
    characterElementName: 'nneka_osuagwu_botmf_0526',
    expression: 'intense determined',
    outputDir,
    placement: 'lower-third',
  });
  assert.deepStrictEqual(
    generateCalls.map(call => call.output),
    ['thumbnail-custom.png'],
    'missing-final retry should reuse existing key art and title card'
  );
  assert.deepStrictEqual(
    generateCalls[0].references,
    ['key-art-custom.png', 'title-card.png'],
    'composite should still submit both intermediate references'
  );
  assert.strictEqual(path.basename(retryResult.thumbnailPath), 'thumbnail-custom.png');

  console.log('publish character resolution regression checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
