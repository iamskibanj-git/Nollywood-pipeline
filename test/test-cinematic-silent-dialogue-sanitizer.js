/**
 * Regression checks for cinematic prompt fake-silent dialogue normalization.
 *
 * Run: node test/test-cinematic-silent-dialogue-sanitizer.js
 */

const assert = require('assert');
const { PipelineOrchestrator } = require('../src/main/pipeline/orchestrator');

function main() {
  const logs = [];
  const orchestrator = new PipelineOrchestrator(null, null);
  orchestrator.log = (msg) => logs.push(msg);

  const badPrompt = `Inside Nneka's market stall from the reference image, afternoon light. All three figures present.

Shot 1 (WIDE, static): All three. @itohan_omonuwa_o1_botmf_0526 frame-left, lips moving silently before sound comes out. @nneka_osuagwu_o1_botmf_0526 center, @segun_balogun_o1_botmf_0526 right.
[@itohan_omonuwa_o1_botmf_0526, speaking in a barely audible spiritual Edo-accented English]: "God of my fathers, forgive me."

Shot 2 (MEDIUM, static): CUT TO @itohan_omonuwa_o1_botmf_0526. Her chin lifts. Voice is clear.
[@itohan_omonuwa_o1_botmf_0526, speaking in a voice-breaking-but-clear Edo-accented English]: "His name was Emakhu Osei. You buried him here."

Shot 3 (EXTREME CLOSE-UP, static): CUT TO @nneka_osuagwu_o1_botmf_0526. Her face is stone. Then - something beneath the stone gives way. Eyes do not blink. Mouth does not open. Total silence.
[@nneka_osuagwu_o1_botmf_0526, speaking in a silent Igbo-inflected English accent]: "..."`;

  const result = orchestrator._validateAndFixPromptRules(badPrompt, null, {}, 'ch1_sc3_c3');

  assert.match(result.prompt, /\[@nneka_osuagwu_o1_botmf_0526 has no dialogue\]/);
  assert(!/speaking in a silent Igbo-inflected English accent/.test(result.prompt), 'fake silent speaker tag should be removed');
  assert(!/:\s*"\.\.\."/ .test(result.prompt), 'ellipsis-only fake dialogue should be removed');
  assert(result.fixes.some(fix => /RULE0: Shot 3/.test(fix)), 'should report RULE0 fix for Shot 3');
  assert(logs.some(line => /fake silent dialogue/.test(line)), 'should log fake silent dialogue normalization');

  const goodPrompt = `Shot 1 (WIDE, static): CUT TO @ada.
[@ada, speaking in a sharp Nigerian English accent]: "I will not beg."

Shot 2 (MEDIUM, static): CUT TO @emeka.
[@emeka, speaking in a controlled Nigerian English accent]: "Then stand and answer me."

Shot 3 (CU, static): CUT TO @ada. Her eyes harden.
[@ada, speaking in a steady Nigerian English accent]: "I have already answered."`;

  const goodResult = orchestrator._validateAndFixPromptRules(goodPrompt, null, {}, 'good_clip');
  assert.strictEqual(goodResult.prompt, goodPrompt, 'real dialogue should pass through unchanged');
  assert(!goodResult.fixes.some(fix => /RULE0/.test(fix)), 'real dialogue should not trigger silent normalization');

  console.log('cinematic silent-dialogue sanitizer regression checks passed');
}

main();
