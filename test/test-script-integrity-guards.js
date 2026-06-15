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

function makeOversizedClipDraft() {
  return {
    character_bible: [{ id: 'character_1', element_name_hint: 'ada' }],
    chapters: [{
      chapter_number: 1,
      scenes: [{
        scene_number: 1,
        characters_present: ['ada'],
        lines: [
          { line_number: 1, speaker_id: '@ada', dialogue: 'One' },
          { line_number: 2, speaker_id: '@ada', dialogue: 'Two' },
          { line_number: 3, speaker_id: '@ada', dialogue: 'Three' },
          { line_number: 4, speaker_id: '@ada', dialogue: 'Four' },
        ],
        kling_clips: [{
          clip_id: 'ch1_sc1_c1',
          duration_seconds: 15,
          line_refs: [1, 2, 3, 4],
          multi_shot_prompt: 'Real prompt that should be repaired',
        }],
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

async function main() {
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

  const repairEngine = makeEngine();
  repairEngine.model = 'test-model';
  repairEngine._streamWithRetry = async () => JSON.stringify({
    kling_clips: [
      {
        clip_id: 'ch1_sc1_c1',
        duration_seconds: 15,
        line_refs: [1, 2, 3],
        visual_beat: 'Ada grips the table edge',
        multi_shot_prompt: 'Shot 1 (WIDE): @ada stands at the table.\n[@ada, speaking in tense Nigerian English accent]: "One."\n\nShot 2 (MEDIUM): @ada grips the edge.\n[@ada, speaking in tense Nigerian English accent]: "Two."\n\nShot 3 (CLOSE-UP): @ada keeps her eyes steady.\n[@ada, speaking in tense Nigerian English accent]: "Three."',
      },
      {
        clip_id: 'ch1_sc1_c2',
        duration_seconds: 15,
        line_refs: [4],
        visual_beat: 'Ada steps back',
        multi_shot_prompt: 'Shot 1 (WIDE): @ada remains beside the table.\n[@ada, speaking in quiet Nigerian English accent]: "Four."\n\nShot 2 (MEDIUM): @ada steps back slowly.\n[@ada, speaking in quiet Nigerian English accent]: "Four."\n\nShot 3 (CLOSE-UP): @ada exhales through her nose.\n[@ada, speaking in quiet Nigerian English accent]: "Four."',
      },
    ],
  });

  const draft = makeOversizedClipDraft();
  const diagnostics = repairEngine._inspectScriptCompleteness(draft, makeStoryBrief({ targetClips: 1 }));
  assert.strictEqual(diagnostics.oversizedClips.length, 1);
  const repaired = await repairEngine._repairOversizedClipLineRefs(draft, makeStoryBrief({ targetClips: 1 }), diagnostics);
  const repairedClips = repaired.chapters[0].scenes[0].kling_clips;
  assert.strictEqual(repairedClips.length, 2);
  assert.ok(repairedClips.every(c => c.line_refs.length <= 3));
  assert.deepStrictEqual(repairedClips.flatMap(c => c.line_refs), [1, 2, 3, 4]);

  const badRepairEngine = makeEngine();
  badRepairEngine.model = 'test-model';
  badRepairEngine._streamWithRetry = async () => JSON.stringify({
    kling_clips: [{
      clip_id: 'ch1_sc1_c1',
      duration_seconds: 10,
      line_refs: [1, 2, 3, 4],
      multi_shot_prompt: 'Shot 1: @ada speaks.\nShot 2: @ada reacts.\nShot 3: @ada waits.\nShot 4: @ada leaves.',
    }],
  });
  const badDraft = makeOversizedClipDraft();
  const badDiagnostics = badRepairEngine._inspectScriptCompleteness(badDraft, makeStoryBrief({ targetClips: 1 }));
  await assert.rejects(
    () => badRepairEngine._repairOversizedClipLineRefs(badDraft, makeStoryBrief({ targetClips: 1 }), badDiagnostics),
    /duration_seconds must be 15|missing visual_beat|has 4 line_refs|exactly 3 shots/
  );

  console.log('script integrity guard regression checks passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
