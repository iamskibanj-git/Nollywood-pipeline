/**
 * Regression checks for high-risk cinematic shot target repairs.
 *
 * Run: node test/test-cinematic-shot-target-repair.js
 */

const assert = require('assert');
const { PipelineOrchestrator } = require('../src/main/pipeline/orchestrator');

function main() {
  const orchestrator = new PipelineOrchestrator(null, null);
  const elemMap = {
    sewa: 'sewa_o1_abjc_0615',
    rotimi: 'rotimi_o1_abjc_0615',
    amara: 'amara_o1_abjc_0615',
  };

  const prompt = `Inside @amara_o1_abjc_0615's apartment from the reference image, evening light.

Shot 1 (WIDE ESTABLISHING, static): @sewa_o1_abjc_0615 frame-left, @rotimi_o1_abjc_0615 frame-right.
[@sewa_o1_abjc_0615, speaking in tense Nigerian English accent]: "I came here for the truth."

Shot 2 (MEDIUM, static): CUT TO @rotimi_o1_abjc_0615. Her eyes harden, shoulders squared.
[@sewa_o1_abjc_0615, speaking in wounded Nigerian English accent]: "You sold my mother for a contract."

Shot 3 (CU, static): CLOSE-UP ON @sewa_o1_abjc_0615. Her mouth barely moves.
[@sewa_o1_abjc_0615, speaking in cold Nigerian English accent]: "Answer me."`;

  const result = orchestrator._repairCinematicShotTargets(prompt, 'ch1_sc1_c2', elemMap);

  assert.match(result.prompt, /Inside Amara's apartment from the reference image/);
  assert.doesNotMatch(result.prompt, /@amara_o1_abjc_0615's apartment/);
  assert.match(result.prompt, /Shot 1 .*@sewa_o1_abjc_0615 frame-left, @rotimi_o1_abjc_0615 frame-right/s);
  assert.match(result.prompt, /Shot 2 \(MEDIUM, static\): CUT TO @sewa_o1_abjc_0615\./);
  assert.match(result.prompt, /\[@sewa_o1_abjc_0615, speaking in wounded Nigerian English accent\]: "You sold my mother for a contract\."/);
  assert.match(result.prompt, /Shot 3 \(CU, static\): CLOSE-UP ON @sewa_o1_abjc_0615\./);
  assert(result.fixes.some(f => /possessive location/.test(f)), 'should report possessive location fix');
  assert(result.fixes.some(f => /Shot 2: retargeted/.test(f)), 'should report Shot 2 target repair');

  const softReferencePrompt = `Shot 2 (MEDIUM, static): CUT TO @sewa_o1_abjc_0615. Her stare stays on Rotimi's empty chair.
[@sewa_o1_abjc_0615, speaking in quiet Nigerian English accent]: "He left before morning."`;
  const softResult = orchestrator._repairCinematicShotTargets(softReferencePrompt, 'soft_ref', elemMap);
  assert.strictEqual(softResult.prompt, softReferencePrompt, 'soft non-target reference should not be rewritten');

  console.log('cinematic shot-target repair regression checks passed');
}

main();
