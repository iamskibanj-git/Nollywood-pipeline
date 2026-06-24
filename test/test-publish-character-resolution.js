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

  assert.deepStrictEqual(
    thumbGen._buildThumbnailTitleLines('She Chose Wealth Over Blood \u2014 Abuja Changed Her | Nigerian AI Film'),
    ['She Chose Wealth Over Blood', 'Abuja Changed Her'],
    'publish title overlay should strip production suffix and split on the story dash'
  );
  assert.strictEqual(
    thumbGen._stripThumbnailProductionSuffix('She Chose Wealth Over Blood \u2014 Abuja Changed Her | Nigerian AI Film'),
    'She Chose Wealth Over Blood \u2014 Abuja Changed Her',
    'production suffix should not leak into local title overlay'
  );

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

  const localOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-thumb-local-'));
  fs.writeFileSync(path.join(localOutputDir, 'key-art-custom.png'), Buffer.alloc(2048, 4));
  const capturedHtml = [];
  const renderedPaths = [];
  const localAutomation = {
    page: {
      context: () => ({
        newPage: async () => ({
          setViewportSize: async () => {},
          setContent: async (html) => { capturedHtml.push(html); },
          evaluate: async () => {},
          screenshot: async (opts) => {
            renderedPaths.push(path.basename(opts.path));
            fs.writeFileSync(opts.path, Buffer.alloc(2048, 5));
          },
          close: async () => {},
        }),
      }),
    },
    generateImage: async () => {
      throw new Error('local thumbnail composite should not call generateImage');
    },
  };
  const localThumbGen = new ThumbnailGenerator(localAutomation, {});
  const localResult = await localThumbGen.generateCustomThumbnail({
    title: 'She Chose Wealth Over Blood \u2014 Abuja Changed Her | Nigerian AI Film',
    tagline: '',
    characterElementName: 'sewa_o1_scwob_0615',
    expression: 'ice-cold unreadable',
    outputDir: localOutputDir,
    placement: 'auto',
  });
  assert.deepStrictEqual(
    renderedPaths,
    ['title-card.png', 'thumbnail-custom.png'],
    'local publish path should render exact title card and final thumbnail without AI composite'
  );
  assert.ok(capturedHtml.some(html => html.includes('She Chose Wealth Over Blood')));
  assert.ok(capturedHtml.some(html => html.includes('Abuja Changed Her')));
  assert.ok(!capturedHtml.some(html => html.includes('Nigerian AI Film')));
  assert.strictEqual(path.basename(localResult.thumbnailPath), 'thumbnail-custom.png');

  console.log('publish character resolution regression checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
