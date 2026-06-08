/**
 * Regression checks for dialogue-aware scene prop contracts.
 *
 * Run: node test/test-scene-prop-contract.js
 */

const assert = require('assert');
const { buildScenePropContract, formatScenePropContract } = require('../src/main/pipeline/orchestrator');

function propNames(contract) {
  return contract.requiredProps.map(p => p.prop);
}

function main() {
  const paperScene = {
    lines: [
      { line_number: 1, speaker_id: 'zaram_danladi', dialogue: 'This date is wrong, Mama.' },
      { line_number: 2, speaker_id: 'zaram_danladi', dialogue: 'Baba died in March. This paper says February.' },
    ],
  };
  const paperContract = buildScenePropContract(paperScene);
  assert(propNames(paperContract).includes('debt_document'), 'date/paper dialogue should require a Nigerian debt/legal paper');
  assert.strictEqual(paperContract.requiredProps[0].holder, 'zaram_danladi');
  assert.match(paperContract.requiredProps[0].culturalDescription, /Nigerian|A4|stamped/i);
  assert.match(formatScenePropContract(paperContract, { forVision: true }), /never floating/);

  const vagueScene = {
    lines: [
      { line_number: 1, speaker_id: 'ada', dialogue: 'Take this and leave my house.' },
    ],
  };
  const vagueContract = buildScenePropContract(vagueScene);
  assert.strictEqual(vagueContract.requiredProps.length, 0, 'vague "take this" should not invent a required prop');

  const clarifiedScene = {
    props_in_scene: ['brown envelope'],
    lines: [
      { line_number: 1, speaker_id: 'ada', dialogue: 'Take this and leave my house.' },
    ],
  };
  const clarifiedContract = buildScenePropContract(clarifiedScene);
  assert(propNames(clarifiedContract).includes('envelope'), 'vague handoff with props_in_scene should require that prop');

  const phoneCueScene = {
    kling_clips: [
      { clip_id: 'ch1_sc1_c1', visual_beat: 'Ada checks her phone and reads the message.' },
    ],
  };
  const phoneContract = buildScenePropContract(phoneCueScene);
  assert.strictEqual(phoneContract.requiredProps.length, 0, 'visual phone cue should not force regeneration by itself');
  assert(phoneContract.mediumConfidenceMentions.some(p => p.prop === 'phone'), 'visual phone cue should still inform the prompt');

  const emptyContract = buildScenePropContract({ lines: [{ dialogue: 'I will not beg you.' }] });
  assert.strictEqual(emptyContract.requiredProps.length, 0, 'ordinary dialogue should not require props');
  assert.strictEqual(formatScenePropContract(emptyContract), '', 'empty contracts should format to an empty string');

  console.log('scene prop contract regression checks passed');
}

main();
