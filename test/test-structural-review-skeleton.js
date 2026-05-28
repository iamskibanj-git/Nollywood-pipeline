/**
 * Regression checks for the structural-review skeleton used by the grader.
 *
 * Run: node test/test-structural-review-skeleton.js
 */

const assert = require('assert');
const { ScriptEngine } = require('../src/main/pipeline/script-engine');

function main() {
  const engine = Object.create(ScriptEngine.prototype);
  const script = {
    title: 'Test',
    character_bible: [{ id: 'character_1', description_label: 'Ada', role: 'protagonist' }],
    chapters: [{
      chapter_number: 1,
      chapter_title: 'Opening',
      scenes: [{
        scene_number: 1,
        location: 'Market',
        location_element_hint: 'market_stall',
        characters_present: ['character_1'],
        blocking: {
          frame_left: '@ada stands beside the table',
          frame_center: '',
          frame_right: '',
          notes: 'Afternoon light',
        },
        lines: [
          { line_number: 1, speaker_id: 'character_1', dialogue: 'I came back today.', tone: 'steady' },
          { line_number: 2, speaker_id: 'character_1', dialogue: 'You cannot hide again.', tone: 'sharp' },
        ],
        kling_clips: [{
          clip_id: 'ch1_sc1_c1',
          duration_seconds: 15,
          line_refs: [1, 2],
          multi_shot_prompt: 'Shot 1 (WIDE): @ada stands beside the table. [@ada, speaking in Nigerian English]: "I came back today."\nShot 2 (MEDIUM): Her hand tightens.\nShot 3 (CLOSE-UP): Her eyes do not blink. [@ada, speaking in Nigerian English]: "You cannot hide again."',
        }],
      }],
    }],
  };

  const skeleton = engine._buildStructuralReviewSkeleton(
    script,
    'long-form',
    { generatorMode: 'cinematic', storyDriven: true, targetClips: 1 },
    'cinematic'
  );

  const scene = skeleton.chapters[0].scenes[0];
  assert.strictEqual(scene.clip_count, 1);
  assert.deepStrictEqual(scene.blocking.frame_left, '@ada stands beside the table');
  assert.ok(Array.isArray(scene.kling_clips), 'story-driven review skeleton must include compact kling_clips');
  assert.strictEqual(scene.kling_clips[0].clip_id, 'ch1_sc1_c1');
  assert.deepStrictEqual(scene.kling_clips[0].line_refs, [1, 2]);
  assert.strictEqual(scene.kling_clips[0].shot_count, 3);
  assert.strictEqual(scene.kling_clips[0].shot1_has_dialogue, true);
  assert.ok(scene.kling_clips[0].prompt_preview.includes('Shot 1'));
  assert.strictEqual(scene.kling_clips[0].multi_shot_prompt, undefined);

  console.log('structural review skeleton regression checks passed');
}

main();
