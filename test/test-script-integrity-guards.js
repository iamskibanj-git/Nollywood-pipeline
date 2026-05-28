/**
 * Regression checks for script integrity guards that prevent bad cinematic
 * prompts from reaching paid video generation.
 *
 * Run: node test/test-script-integrity-guards.js
 */

const assert = require('assert');
const { ScriptEngine } = require('../src/main/pipeline/script-engine');

function makeEngine() {
  return Object.create(ScriptEngine.prototype);
}

function makeStoryBrief(overrides = {}) {
  return {
    chapters: 1,
    generatorMode: 'cinematic',
    storyDriven: true,
    targetClips: 6,
    ...overrides,
  };
}

function makeScriptWithClips(count) {
  const clips = [];
  const lines = [];
  for (let i = 1; i <= count; i++) {
    lines.push({ id: i, speaker_id: 'character_1', dialogue: `Line ${i}` });
    clips.push({
      clip_id: `ch1_sc1_c${i}`,
      duration_seconds: 15,
      line_refs: [i],
      multi_shot_prompt: `Shot 1. [@ada, speaking in Nigerian English]: "Line ${i}"`,
    });
  }

  return {
    character_bible: [{ id: 'character_1', element_name_hint: 'ada' }],
    chapters: [{
      chapter_number: 1,
      scenes: [{
        scene_number: 1,
        characters_present: ['character_1'],
        lines,
        kling_clips: clips,
      }],
    }],
  };
}

function assertThrowsMessage(fn, pattern) {
  assert.throws(fn, err => {
    assert.match(err.message, pattern);
    return true;
  });
}

function main() {
  const engine = makeEngine();

  assertThrowsMessage(() => {
    engine._validateScriptCompleteness({
      character_bible: [{ id: 'character_1', element_name_hint: 'ada' }],
      chapters: [{
        chapter_number: 1,
        scenes: [{
          scene_number: 1,
          characters_present: ['character_1'],
          lines: [
            { id: 1, dialogue: 'One' },
            { id: 2, dialogue: 'Two' },
            { id: 3, dialogue: 'Three' },
            { id: 4, dialogue: 'Four' },
          ],
          kling_clips: [{
            clip_id: 'ch1_sc1_c1',
            duration_seconds: 15,
            line_refs: [1, 2, 3, 4],
            multi_shot_prompt: 'Real prompt that should not be auto-split',
          }],
        }],
      }],
    }, makeStoryBrief({ targetClips: 2 }));
  }, /exceed the 3-line limit/);

  assertThrowsMessage(() => {
    engine._validateScriptCompleteness(
      makeScriptWithClips(117),
      makeStoryBrief({ chapters: 1, targetClips: 164 })
    );
  }, /minimum 80%/);

  console.log('script integrity guard regression checks passed');
}

main();
