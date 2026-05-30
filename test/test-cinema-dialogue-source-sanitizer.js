/**
 * Regression checks for source-level Cinema dialogue sanitization.
 *
 * Run: node test/test-cinema-dialogue-source-sanitizer.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { PipelineOrchestrator } = require('../src/main/pipeline/orchestrator');

const root = path.join(__dirname, '..');
const automationSource = fs.readFileSync(path.join(root, 'src/main/automation/cinema-video-automation.js'), 'utf8');
const orchestratorSource = fs.readFileSync(path.join(root, 'src/main/pipeline/orchestrator.js'), 'utf8');
const dbSource = fs.readFileSync(path.join(root, 'src/main/database/db.js'), 'utf8');

assert(!automationSource.includes('_detectCinemaRefundedFailure'), 'Cinema automation should not use visible refunded-failure panel detection');
assert(!orchestratorSource.includes('CINEMA_REFUNDED_FAILURE'), 'orchestrator should not branch on ambiguous refunded UI state');
assert(!orchestratorSource.includes('sanitized_after_refund'), 'orchestrator should not persist refund-specific retry prompt state');
assert(!dbSource.includes('resetVideoClipForRegeneration'), 'DB should not expose refund-specific regeneration helper');

const orchestrator = new PipelineOrchestrator(null, null);
const prompt = [
  'Shot 1 (MEDIUM, static): @bature_o1_tbdfn_0528 stands still.',
  '[@bature_o1_tbdfn_0528, speaking in a whispered Nigerian English accent]: "Allah ya kiyaye. Something is very wrong here."',
  'NO SUBTITLES.',
].join('\n');

const result = orchestrator._sanitizeCinemaDialogueForPrompt(prompt);
assert(result.replacements > 0, 'sanitizer should report dialogue replacements');
assert(!/Allah/i.test(result.prompt), 'sanitizer should remove the suspected religious trigger from dialogue');
assert(result.prompt.includes('@bature_o1_tbdfn_0528'), 'sanitizer must preserve element references outside dialogue');
assert(result.prompt.includes('"Heaven help me. Something is very wrong here."'), 'sanitizer should preserve dialogue intent');

console.log('cinema dialogue source sanitizer regression checks passed');
