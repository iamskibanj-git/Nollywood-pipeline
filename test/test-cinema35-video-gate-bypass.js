/**
 * Regression checks for temporary Cinema Studio 3.5 video gate bypass.
 *
 * Run: node test/test-cinema35-video-gate-bypass.js
 */

const assert = require('assert');
const { PipelineOrchestrator } = require('../src/main/pipeline/orchestrator');

async function main() {
  const logs = [];
  const orchestrator = new PipelineOrchestrator(null, null);
  orchestrator.log = (msg) => logs.push(msg);

  assert.strictEqual(orchestrator._shouldSkipCinemaPromptPreview('cinema-studio-3.5'), true);
  assert.strictEqual(orchestrator._shouldSkipCinemaPromptPreview('kling'), false);

  orchestrator._autoApproveCinema35ClipReview = true;
  const cinemaDecision = await orchestrator.waitForApproval('clip-review');
  assert.strictEqual(cinemaDecision, 'continue');
  assert(!orchestrator._approvalResolvers['clip-review'], 'Cinema 3.5 clip-review should not register a pending resolver');
  assert(logs.some(line => /per-clip review gate disabled/.test(line)), 'Cinema 3.5 bypass should be logged');

  orchestrator._autoApproveCinema35ClipReview = false;
  const klingWait = orchestrator.waitForApproval('clip-review');
  assert(orchestrator._approvalResolvers['clip-review'], 'Kling clip-review should still wait for operator approval');
  orchestrator.approveClipReview('continue');
  const klingDecision = await klingWait;
  assert.strictEqual(klingDecision, 'continue');

  console.log('cinema 3.5 video gate bypass regression checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
