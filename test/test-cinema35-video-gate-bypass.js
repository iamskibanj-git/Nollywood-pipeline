/**
 * Regression checks for Cinema Studio 3.5 clip-review safety.
 *
 * Run: node test/test-cinema35-video-gate-bypass.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PipelineOrchestrator } = require('../src/main/pipeline/orchestrator');

async function main() {
  const logs = [];
  const orchestrator = new PipelineOrchestrator(null, null);
  orchestrator.log = (msg) => logs.push(msg);

  assert.strictEqual(orchestrator._shouldSkipCinemaPromptPreview('cinema-studio-3.5'), true);
  assert.strictEqual(orchestrator._shouldSkipCinemaPromptPreview('kling'), false);

  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/pipeline/orchestrator.js'), 'utf8');
  assert(
    source.includes('const TEMP_AUTO_APPROVE_CINEMA35_CLIP_REVIEW = false;'),
    'Cinema 3.5 clip review must not use the old blanket auto-approve flag'
  );
  assert(
    source.includes('Auto-approved clip review') && source.includes('DB asset not persisted done'),
    'Cinema 3.5 auto-approve must be gated by local file and persisted DB proof'
  );
  assert(
    source.includes("freshAsset.status !== 'done'") && source.includes('fs.statSync(clipPath)'),
    'Cinema 3.5 auto-approve must verify both DB status and local file existence'
  );

  orchestrator._autoApproveCinema35ClipReview = false;
  const klingWait = orchestrator.waitForApproval('clip-review');
  assert(orchestrator._approvalResolvers['clip-review'], 'clip-review should wait for operator approval unless the safe local-file policy handles it inside the video loop');
  orchestrator.approveClipReview('continue');
  const klingDecision = await klingWait;
  assert.strictEqual(klingDecision, 'continue');

  console.log('cinema 3.5 clip-review safety regression checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
