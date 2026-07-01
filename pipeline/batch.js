import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipelineConfig } from './config.js';
import { openPipelineDb } from './db.js';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pipelineDir);

const rawArgs = process.argv.slice(2);
if (hasFlag(rawArgs, '--help') || hasFlag(rawArgs, '-h')) {
  printHelp();
  process.exit(0);
}

const execute = hasFlag(rawArgs, '--execute') || hasFlag(rawArgs, '--live');
const live = hasFlag(rawArgs, '--live');
const planPath = path.resolve(parseArgValue(rawArgs, '--plan') || pipelineConfig.files.weeklyPlan);
const userDataDir = parseArgValue(rawArgs, '--user-data-dir') || '.browser-profile';
const facebookLoginWaitSec = readInteger(parseArgValue(rawArgs, '--facebook-login-wait-sec') || parseArgValue(rawArgs, '--login-wait-sec'), 120);
const higgsfieldLoginWaitSec = readInteger(parseArgValue(rawArgs, '--higgsfield-login-wait-sec'), 240);
const captionRetryLimit = readInteger(parseArgValue(rawArgs, '--caption-retries'), 3);
const postWallClockMs = readMinutes(parseArgValue(rawArgs, '--post-wall-clock-min'), 45);
const batchWallClockMs = readMinutes(parseArgValue(rawArgs, '--batch-wall-clock-min'), 0);

const runId = await resolveRunId(parseArgValue(rawArgs, '--run-id') || parseArgValue(rawArgs, '--run') || 'latest');
if (!runId) throw new Error('No run found in how-to content DB.');

const plan = readPlan(planPath);
const slots = selectPlanSlots(plan, rawArgs);
if (slots.length === 0) throw new Error('No ready slots matched the batch filters.');

console.log(`${execute ? live ? 'Live' : 'Execute' : 'Dry-run'} batch for run ${runId}`);
console.log(`Plan: ${path.relative(pipelineDir, planPath)}`);
console.log(`Selected ${slots.length} ready slot(s).`);
for (const slot of slots) {
  console.log(`- ${slot.scheduled_date} ${slot.scheduled_time} ${slot.facebook_page_name} #${slot.post_id}: ${slot.topic}`);
}
if (!execute) {
  console.log('');
  console.log('No changes made. Add --execute to run generation/QA/dry scheduling, or --live to include final Facebook scheduling.');
  process.exit(0);
}

const batchStarted = Date.now();
const results = [];
for (const slot of slots) {
  if (batchWallClockMs > 0 && Date.now() - batchStarted > batchWallClockMs) {
    console.warn(`Batch wall-clock budget reached after ${results.length} slot(s).`);
    break;
  }
  const result = await processSlot({ runId, slot });
  results.push(result);
  if (result.status === 'failed' && result.stopBatch) break;
}

console.log('');
console.log('Batch summary');
for (const result of results) {
  console.log(`- #${result.post_id} ${result.status}${result.message ? `: ${result.message}` : ''}`);
}
if (results.some(result => result.status !== 'scheduled' && result.status !== 'prepared')) {
  process.exitCode = 1;
}

async function processSlot({ runId, slot }) {
  const postId = Number(slot.post_id);
  const postStarted = Date.now();
  let captionAttempts = 0;
  let imageAttempts = 0;
  let qaLoops = 0;
  const repeatedQaReasons = new Map();

  console.log('');
  console.log(`=== ${slot.scheduled_date} ${slot.scheduled_time} ${slot.facebook_page_name} #${postId} ===`);

  while (true) {
    if (postWallClockMs > 0 && Date.now() - postStarted > postWallClockMs) {
      await markBatchEvent(runId, postId, 'batch_post_wall_clock_exhausted', 'Post wall-clock budget exhausted', { slot });
      return { post_id: postId, status: 'failed', message: 'post wall-clock budget exhausted' };
    }

    const post = await getPost(postId);
    if (!post) return { post_id: postId, status: 'failed', message: 'post not found' };
    if (post.status === 'scheduled') {
      return { post_id: postId, status: 'scheduled', message: 'already scheduled' };
    }
    if (['duplicate', 'rejected', 'deleted'].includes(post.status)) {
      return { post_id: postId, status: 'skipped', message: `post status is ${post.status}` };
    }

    try {
      if (post.status === 'queued') {
        runStage('approve', ['review.js', 'approve', '--id', String(postId), '--note', `weekly batch ${slot.scheduled_date} ${slot.scheduled_time}`]);
        continue;
      }
      if (post.status === 'review_needed') {
        if (/^Batch skipped:/i.test(post.error_message || '')) {
          return { post_id: postId, status: 'skipped', message: post.error_message };
        }
        const qa = await latestQa(postId);
        if (!qa) {
          return { post_id: postId, status: 'skipped', message: 'review_needed without QA repair data' };
        }
        const repairResult = await repairAfterQaFailure({
          runId,
          postId,
          post,
          qa,
          slot,
          repeatedQaReasons,
          imageAttempts,
          captionAttempts,
          qaLoops,
        });
        if (repairResult) return repairResult;
        continue;
      }
      if (post.status === 'approved') {
        imageAttempts += 1;
        runStage('image', ['image.js', '--live', '--id', String(postId), '--login-wait-sec', String(higgsfieldLoginWaitSec)]);
        continue;
      }
      if (post.status === 'image_done') {
        captionAttempts += 1;
        runStage('content', ['content.js', '--generate', '--id', String(postId)]);
        continue;
      }
      if (post.status === 'content_done') {
        qaLoops += 1;
        const qaOk = runStage('qa', ['qa.js', '--run', '--id', String(postId)], { allowFailure: true });
        if (qaOk) continue;
        const repairResult = await repairAfterQaFailure({
          runId,
          postId,
          post: await getPost(postId),
          qa,
          slot,
          repeatedQaReasons,
          imageAttempts,
          captionAttempts,
          qaLoops,
        });
        if (repairResult) return repairResult;
        continue;
      }
      if (post.status === 'qa_done') {
        runStage('facebook-context', [
          'facebook.js',
          '--dry-run',
          '--niche',
          post.niche_id,
          '--user-data-dir',
          userDataDir,
          '--login-wait-sec',
          String(facebookLoginWaitSec),
        ]);
        runStage('facebook-prepare', [
          'facebook.js',
          '--prepare',
          '--id',
          String(postId),
          '--date',
          slot.scheduled_date,
          '--time',
          slot.scheduled_time,
        ]);
        runStage('facebook-dry-run', ['facebook.js', '--schedule-dry-run', '--id', String(postId)]);
        if (!live) {
          return { post_id: postId, status: 'prepared', message: `${slot.scheduled_date} ${slot.scheduled_time}` };
        }
        runStage('facebook-live', [
          'facebook.js',
          '--live',
          '--id',
          String(postId),
          '--user-data-dir',
          userDataDir,
          '--login-wait-sec',
          String(facebookLoginWaitSec),
        ]);
        const scheduled = await getPost(postId);
        if (scheduled?.status === 'scheduled') {
          return { post_id: postId, status: 'scheduled', message: `${scheduled.scheduled_date} ${scheduled.scheduled_time}` };
        }
        return { post_id: postId, status: 'failed', message: `expected scheduled, got ${scheduled?.status || 'missing'}`, stopBatch: true };
      }
      return { post_id: postId, status: 'failed', message: `unsupported status ${post.status}` };
    } catch (error) {
      const fresh = await getPost(postId);
      if (fresh?.status === 'image_done' && /content/i.test(error.message || '')) {
        if (captionAttempts >= captionRetryLimit) {
          return skipPostForNextCandidate(runId, postId, `content retry budget exhausted: ${fresh.error_message || error.message}`);
        }
        await resetForCaptionRepair(runId, fresh, { recommended_fix: fresh.error_message || error.message });
        continue;
      }
      const message = error?.message || String(error);
      await markBatchEvent(runId, postId, 'batch_stage_failed', message, { slot, status: fresh?.status || null });
      return { post_id: postId, status: 'failed', message, stopBatch: isExternalFailure(message) };
    }
  }
}

async function repairAfterQaFailure({
  runId,
  postId,
  post,
  qa,
  slot,
  repeatedQaReasons,
  imageAttempts,
  captionAttempts,
  qaLoops,
}) {
  const repair = classifyQaRepair(qa, post);
  const reasonKey = normalizeReasonKey(qa);
  const seen = (repeatedQaReasons.get(reasonKey) || 0) + 1;
  repeatedQaReasons.set(reasonKey, seen);
  await markBatchEvent(runId, postId, 'batch_qa_repair_needed', qaSummary(qa), {
    slot,
    repair,
    repeatedReasonCount: seen,
    imageAttempts,
    captionAttempts,
    qaLoops,
  });
  if (repair.action === 'image') {
    await mutateImagePromptForRepair(runId, post, qa, { repeatedReasonCount: seen });
    return null;
  }
  if (repair.action === 'caption') {
    if (captionAttempts >= captionRetryLimit) {
      return skipPostForNextCandidate(runId, postId, `caption retry budget exhausted: ${qaSummary(qa)}`);
    }
    await resetForCaptionRepair(runId, post, qa);
    return null;
  }
  if (repair.action === 'both') {
    await mutateImagePromptForRepair(runId, post, qa, { repeatedReasonCount: seen });
    return null;
  }
  return skipPostForNextCandidate(runId, postId, `non-repairable QA: ${qaSummary(qa)}`);
}

function runStage(label, args, { allowFailure = false } = {}) {
  console.log(`\n[batch:${label}] node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: pipelineDir,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status === 0) return true;
  if (allowFailure) return false;
  throw new Error(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}

function classifyQaRepair(qa, post) {
  const text = [
    qa?.verdict,
    qa?.recommended_fix,
    qa?.reasons_json,
    qa?.image_findings_json,
    qa?.caption_findings_json,
    qa?.safety_findings_json,
    post?.error_message,
  ].filter(Boolean).join('\n').toLowerCase();
  const image = /\b(image|visual|photo|picture|label|logo|watermark|text overlay|readable|brand|microsoft|artifact|crop|frame|ui|duplicate|mismatch|off-topic|blur|distorted)\b/.test(text);
  const caption = /\b(caption|copy|hook|step|safety|claim|guarantee|privacy|pricing|medical|financial|legal|cta|placeholder|too short|overclaim|unsafe wording)\b/.test(text);
  const topic = /\b(topic itself|stale|current claim|unsupported current|unsafe topic|skip candidate|not suitable)\b/.test(text);
  if (topic) return { action: 'skip' };
  if (image && caption) return { action: 'both' };
  if (image) return { action: 'image' };
  if (caption) return { action: 'caption' };
  return { action: 'caption' };
}

async function mutateImagePromptForRepair(runId, post, qa, { repeatedReasonCount = 1 } = {}) {
  const feedback = qaSummary(qa);
  const strategy = repeatedReasonCount >= 2
    ? 'Switch strategy: use a simple clean scene with one or two generic unlabeled props on a neutral background, no screens unless essential, no social-media frames, no brand-like colors, no text.'
    : 'Repair the image using this QA feedback.';
  const prompt = [
    post.image_prompt,
    strategy,
    feedback,
    'Hard requirements: no readable words, labels, logos, app icons, UI chrome, social media frames, watermarks, brand-like color layouts, duplicate props, or printed text. Keep it realistic, editorial, square, and directly matched to the caption topic.',
  ].join(' ');
  const now = isoNow();
  await withDb(db => {
    db.backup(`pre-batch-image-repair-${post.id}`);
    db.run(
      `UPDATE posts
       SET status = 'approved', image_prompt = ?, caption = NULL, quality_verdict = NULL,
           error_message = NULL, updated_at = ?
       WHERE id = ?`,
      [cleanPrompt(prompt), now, post.id]
    );
    db.logEvent(runId, 'batch_image_repair', {
      stage: 'batch',
      nicheId: post.niche_id,
      message: feedback,
      data: { postId: post.id, repeatedReasonCount, prompt: cleanPrompt(prompt) },
    });
  });
}

async function resetForCaptionRepair(runId, post, qa) {
  const feedback = qaSummary(qa);
  const now = isoNow();
  await withDb(db => {
    db.backup(`pre-batch-caption-repair-${post.id}`);
    db.run(
      `UPDATE posts
       SET status = 'image_done', caption = NULL, quality_verdict = NULL,
           error_message = ?, updated_at = ?
       WHERE id = ?`,
      [`Caption repair feedback: ${feedback}`, now, post.id]
    );
    db.logEvent(runId, 'batch_caption_repair', {
      stage: 'batch',
      nicheId: post.niche_id,
      message: feedback,
      data: { postId: post.id },
    });
  });
}

async function skipPostForNextCandidate(runId, postId, message) {
  const post = await getPost(postId);
  const now = isoNow();
  await withDb(db => {
    db.run(
      `UPDATE posts
       SET status = 'review_needed', error_message = ?, updated_at = ?
       WHERE id = ?`,
      [`Batch skipped: ${message}`, now, postId]
    );
    if (post) {
      db.logEvent(runId, 'batch_post_skipped', {
        stage: 'batch',
        nicheId: post.niche_id,
        message,
        data: { postId },
      });
    }
  });
  return { post_id: postId, status: 'skipped', message };
}

async function latestQa(postId) {
  return withDb(db => db.queryOne(
    `SELECT *
     FROM post_quality_checks
     WHERE post_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [postId]
  ));
}

async function getPost(postId) {
  return withDb(db => db.queryOne(`SELECT * FROM posts WHERE id = ?`, [Number(postId)]));
}

async function markBatchEvent(runId, postId, eventType, message, data = {}) {
  const post = await getPost(postId);
  await withDb(db => {
    db.logEvent(runId, eventType, {
      stage: 'batch',
      nicheId: post?.niche_id || null,
      message,
      data: { postId, ...data },
    });
  });
}

function qaSummary(qa) {
  if (!qa) return 'No QA row found.';
  const reasons = parseJson(qa.reasons_json, []);
  const reasonText = Array.isArray(reasons) && reasons.length ? reasons.join('; ') : '';
  return cleanText([reasonText, qa.recommended_fix, qa.error_message].filter(Boolean).join(' ')).slice(0, 1200);
}

function normalizeReasonKey(qa) {
  return qaSummary(qa).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 180);
}

function selectPlanSlots(plan, argv) {
  const day = parseArgValue(argv, '--day') || parseArgValue(argv, '--date');
  const dayIndex = readInteger(parseArgValue(argv, '--day-index'), 0);
  const niche = parseArgValue(argv, '--niche');
  const postId = readInteger(parseArgValue(argv, '--id') || parseArgValue(argv, '--post-id'), 0);
  const limit = readInteger(parseArgValue(argv, '--limit'), 0);
  let slots = Array.isArray(plan.calendar) ? plan.calendar : [];
  slots = slots.filter(slot => slot.plan_status === 'ready');
  if (day) slots = slots.filter(slot => slot.scheduled_date === day);
  if (dayIndex > 0) slots = slots.filter(slot => Number(slot.day_index) === dayIndex);
  if (niche) slots = slots.filter(slot => String(slot.niche_id).toLowerCase() === niche.toLowerCase());
  if (postId > 0) slots = slots.filter(slot => Number(slot.post_id) === postId);
  slots.sort((a, b) => (
    String(a.scheduled_date).localeCompare(String(b.scheduled_date)) ||
    String(a.scheduled_time).localeCompare(String(b.scheduled_time)) ||
    String(a.niche_id).localeCompare(String(b.niche_id))
  ));
  if (limit > 0) slots = slots.slice(0, limit);
  return slots;
}

function readPlan(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Weekly plan not found: ${filePath}. Run npm.cmd run weekly -- --dry-run first.`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function resolveRunId(value) {
  return withDb(db => {
    if (value && value !== 'latest') {
      const found = db.queryOne(`SELECT id FROM runs WHERE id = ?`, [value]);
      if (!found) throw new Error(`Run not found: ${value}`);
      return value;
    }
    const latest = db.queryOne(`SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT 1`);
    return latest?.id || null;
  });
}

async function withDb(fn) {
  const store = await openPipelineDb({
    config: pipelineConfig,
    logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
  });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

function isExternalFailure(message) {
  return /\b(login|session|facebook|context|schedule confirmation|higgsfield|spawn|browser|navigation|timeout)\b/i.test(message || '');
}

function cleanPrompt(value) {
  return cleanText(value).replace(/\s+/g, ' ').slice(0, 1200);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function readMinutes(value, fallbackMinutes) {
  const minutes = readInteger(value, fallbackMinutes);
  return minutes <= 0 ? 0 : minutes * 60 * 1000;
}

function readInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed));
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function parseArgValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

function isoNow() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`How-to weekly batch runner

Usage:
  npm.cmd run batch -- --day 2026-07-02 --limit 8
  npm.cmd run batch -- --execute --day 2026-07-02 --limit 8
  npm.cmd run batch -- --live --day 2026-07-02 --limit 8 --user-data-dir .browser-profile

Modes:
  default      Print selected ready slots only.
  --execute   Run approve -> image -> content -> QA -> Facebook context -> prepare -> schedule dry-run.
  --live      Same as --execute, plus final Facebook live scheduling.

Filters:
  --day YYYY-MM-DD
  --day-index N
  --niche fix-it
  --id 123
  --limit N

Repair policy:
  Image QA failures regenerate without a fixed retry cap while within --post-wall-clock-min.
  Caption QA failures retry up to --caption-retries, then the post is skipped for review.
`);
}
