import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { pipelineConfig } from './config.js';
import { resolveAnthropicApiKey } from './credentials.js';
import { openPipelineDb } from './db.js';
import { cleanTextBlock, validateCaptionForScheduling } from './content-quality.js';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pipelineDir);

const QA_SYSTEM_PROMPT = `You are the final production QA reviewer for a network of practical Facebook how-to pages.

Review one post using the topic, caption, and generated image.
Be strict but practical: this is a scheduled public Facebook post, not a draft.

Return ONLY one valid JSON object, no markdown fences:
{
  "verdict": "pass" | "review_needed" | "blocked",
  "score": 0-100,
  "reasons": ["short reason"],
  "image_findings": {
    "matches_topic": true,
    "no_text_overlay": true,
    "no_watermark": true,
    "no_obvious_artifacts": true,
    "safe_visual": true,
    "notes": "string"
  },
  "caption_findings": {
    "useful": true,
    "actionable": true,
    "aligns_with_image": true,
    "not_placeholder": true,
    "notes": "string"
  },
  "safety_findings": {
    "risk_level": "low" | "medium" | "high",
    "concerns": ["string"],
    "notes": "string"
  },
  "recommended_fix": "string or null"
}

Verdict rules:
- pass only when the image matches the topic, the image has no obvious text/watermark/artifacts, the caption is genuinely useful, and the advice is safe enough for a general audience.
- review_needed or blocked for any fake social media post frame, phone/tablet screen mockup framing the subject, visible profile/avatar placeholder, like/comment/share icons, app chrome, device bezel border, or UI scaffold around the image. A production Facebook image should be the image itself, not a screenshot/post mockup inside another interface.
- review_needed for minor visual mismatch, weak usefulness, unclear safety, dubious claims, or advice that may need a human read.
- blocked for unsafe instructions, high-stakes medical/legal/financial claims, off-topic image, offensive/sexual/gory content, visible watermark/text-heavy image, fake social/app UI wrapper, or obvious AI failure.`;

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'and', 'are', 'can', 'for', 'from', 'how', 'into',
  'most', 'that', 'the', 'this', 'to', 'use', 'using', 'what', 'when', 'where', 'with',
  'without', 'you', 'your',
]);

const VISION_CONVERT_BYTES = 3 * 1024 * 1024;
const VISION_BASE64_MAX = 5 * 1024 * 1024;

const rawArgs = process.argv.slice(2);
if (hasFlag(rawArgs, '--help') || hasFlag(rawArgs, '-h')) {
  printHelp();
  process.exit(0);
}

const dryRun = hasFlag(rawArgs, '--dry-run');
const run = hasFlag(rawArgs, '--run') || hasFlag(rawArgs, '--check') || hasFlag(rawArgs, '--generate');
if (dryRun && run) {
  console.error('Use either --dry-run or --run, not both.');
  process.exit(1);
}
if (!dryRun && !run) {
  console.error('Choose --dry-run or --run. Use --help for examples.');
  process.exit(1);
}

const db = await openPipelineDb({
  config: pipelineConfig,
  logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
});

try {
  const runId = resolveRunId(db, parseArgValue(rawArgs, '--run-id') || 'latest');
  if (!runId) throw new Error('No run found in how-to content DB.');

  const posts = selectPosts(db, runId, rawArgs);
  if (posts.length === 0) throw new Error('No posts selected for QA.');
  guardBulkSelection(posts, rawArgs, dryRun ? 'QA dry-run' : 'QA run');

  if (dryRun) {
    const result = await runQaDryRun(db, runId, posts, rawArgs);
    console.log(`QA dry-run prepared: ${result.items.length} post(s).`);
    for (const item of result.items.slice(0, 10)) {
      console.log(`#${item.post_id} ${item.niche_id} ${item.local_ok ? 'local-ok' : 'local-fail'}: ${item.topic}`);
    }
  } else {
    const result = await runQa(db, runId, posts, rawArgs);
    console.log(`QA complete: ${result.passed} passed, ${result.review_needed} review_needed, ${result.blocked} blocked, ${result.failed} failed.`);
    if (result.review_needed || result.blocked || result.failed) process.exitCode = 1;
  }
} finally {
  db.close();
}

async function runQaDryRun(db, runId, posts, argv) {
  const model = parseArgValue(argv, '--model') || pipelineConfig.qa.model;
  const now = isoNow();
  const items = [];
  db.backup(`pre-qa-dry-run-${runId}`);
  for (const post of posts) {
    const local = await buildLocalChecks(post);
    const prompt = buildQaPrompt(post, local);
    upsertQualityCheck(db, {
      runId,
      post,
      model,
      status: 'dry_run',
      dryRun: true,
      imagePath: cleanText(post.image_path),
      captionHash: hashCaption(post.caption),
      prompt,
      localChecks: local,
      responseJson: null,
      verdict: local.ok ? 'local_ok' : 'local_failed',
      score: local.ok ? 0 : null,
      reasons: local.reasons,
      imageFindings: {},
      captionFindings: {},
      safetyFindings: {},
      recommendedFix: null,
      errorMessage: null,
      startedAt: now,
      completedAt: now,
    });
    db.logEvent(runId, 'qa_dry_run_prepared', {
      stage: 'qa',
      nicheId: post.niche_id,
      message: `Prepared QA check for post ${post.id}`,
      data: { postId: post.id, rank: post.rank, local },
    });
    items.push({
      post_id: post.id,
      niche_id: post.niche_id,
      rank: post.rank,
      topic: post.topic,
      image_path: post.image_path,
      local_ok: local.ok,
      local_checks: local,
    });
  }
  db.save();
  return { items };
}

async function runQa(db, runId, posts, argv) {
  const invalidStatuses = posts.filter(post => post.status !== 'content_done');
  if (invalidStatuses.length && !hasFlag(argv, '--allow-status-override')) {
    throw new Error(`QA only runs from content_done by default. Invalid selected posts: ${invalidStatuses.map(post => `#${post.id}:${post.status}`).join(', ')}. Use --allow-status-override only for a deliberate audit.`);
  }

  const apiKey = resolveAnthropicApiKey({ logger: { info() {}, warn() {}, error() {} } });
  if (!apiKey) {
    throw new Error('Claude/Anthropic API key required. Set ANTHROPIC_API_KEY or save a Claude key in the existing Electron app settings.');
  }

  const client = new Anthropic({ apiKey });
  const model = parseArgValue(argv, '--model') || pipelineConfig.qa.model;
  const stats = { passed: 0, review_needed: 0, blocked: 0, failed: 0 };
  db.backup(`pre-qa-run-${runId}`);

  for (const post of posts) {
    const startedAt = isoNow();
    const originalStatus = post.status;
    const local = await buildLocalChecks(post);
    const prompt = buildQaPrompt(post, local);
    upsertQualityCheck(db, {
      runId,
      post,
      model,
      status: 'running',
      dryRun: false,
      imagePath: cleanText(post.image_path),
      captionHash: hashCaption(post.caption),
      prompt,
      localChecks: local,
      responseJson: null,
      verdict: null,
      score: null,
      reasons: local.reasons,
      imageFindings: {},
      captionFindings: {},
      safetyFindings: {},
      recommendedFix: null,
      errorMessage: null,
      startedAt,
      completedAt: null,
    });
    db.run(
      `UPDATE posts
       SET status = 'qa_generating', error_message = NULL, updated_at = ?
       WHERE id = ?`,
      [startedAt, post.id]
    );
    db.save();

    try {
      let review = null;
      if (!local.ok) {
        review = localFailureReview(local);
      } else {
        const image = await readImageForClaude(post.image_path);
        const response = await client.messages.create({
          model,
          max_tokens: Number(pipelineConfig.qa.maxTokens || 1400),
          temperature: Number(pipelineConfig.qa.temperature || 0.1),
          system: QA_SYSTEM_PROMPT,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: image.mediaType,
                  data: image.base64,
                },
              },
            ],
          }],
        });
        review = normalizeQaResponse(parseQaResponse(extractText(response)), local);
      }

      const completedAt = isoNow();
      const status = statusFromVerdict(review.verdict);
      upsertQualityCheck(db, {
        runId,
        post,
        model,
        status,
        dryRun: false,
        imagePath: cleanText(post.image_path),
        captionHash: hashCaption(post.caption),
        prompt,
        localChecks: local,
        responseJson: review.response_json,
        verdict: review.verdict,
        score: review.score,
        reasons: review.reasons,
        imageFindings: review.image_findings,
        captionFindings: review.caption_findings,
        safetyFindings: review.safety_findings,
        recommendedFix: review.recommended_fix,
        errorMessage: null,
        startedAt,
        completedAt,
      });

      const postStatus = review.verdict === 'pass' ? 'qa_done' : 'review_needed';
      const reviewNote = review.verdict === 'pass'
        ? null
        : `QA ${review.verdict}: ${review.reasons.slice(0, 3).join('; ')}`;
      db.run(
        `UPDATE posts
         SET status = ?, quality_verdict = ?, quality_checked_at = ?,
             review_note = COALESCE(?, review_note), error_message = ?, updated_at = ?
         WHERE id = ?`,
        [
          postStatus,
          review.verdict,
          completedAt,
          reviewNote,
          review.verdict === 'pass' ? null : reviewNote,
          completedAt,
          post.id,
        ]
      );
      db.logEvent(runId, review.verdict === 'pass' ? 'qa_passed' : `qa_${review.verdict}`, {
        stage: 'qa',
        nicheId: post.niche_id,
        message: `QA ${review.verdict} for post ${post.id}`,
        data: { postId: post.id, rank: post.rank, score: review.score, reasons: review.reasons },
      });
      db.save();
      stats[status === 'passed' ? 'passed' : status] += 1;
    } catch (error) {
      const failedAt = isoNow();
      const message = error?.message || String(error);
      upsertQualityCheck(db, {
        runId,
        post,
        model,
        status: 'failed',
        dryRun: false,
        imagePath: cleanText(post.image_path),
        captionHash: hashCaption(post.caption),
        prompt,
        localChecks: local,
        responseJson: null,
        verdict: 'failed',
        score: null,
        reasons: [message],
        imageFindings: {},
        captionFindings: {},
        safetyFindings: {},
        recommendedFix: null,
        errorMessage: message,
        startedAt,
        completedAt: failedAt,
      });
      db.run(
        `UPDATE posts
         SET status = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
        [originalStatus, message, failedAt, post.id]
      );
      db.logEvent(runId, 'qa_failed', {
        stage: 'qa',
        nicheId: post.niche_id,
        message,
        data: { postId: post.id, rank: post.rank },
      });
      db.save();
      stats.failed += 1;
    }

    await writePostsExport(db, runId);
    await delay(Number(pipelineConfig.qa.delayBetweenPostsMs || 1000));
  }
  return stats;
}

async function buildLocalChecks(post) {
  const reasons = [];
  const warnings = [];
  const imagePath = resolveImagePath(post);
  const imageInfo = await readImageInfo(imagePath.absolute).catch(error => ({
    ok: false,
    error: error?.message || String(error),
  }));
  if (!imageInfo.ok) {
    reasons.push(`image check failed: ${imageInfo.error}`);
  } else {
    if (imageInfo.bytes < Number(pipelineConfig.qa.minImageBytes || 50000)) {
      reasons.push(`image file too small (${imageInfo.bytes} bytes)`);
    }
    if (imageInfo.width && imageInfo.width < Number(pipelineConfig.qa.minImageWidth || 700)) {
      reasons.push(`image width too small (${imageInfo.width}px)`);
    }
    if (imageInfo.height && imageInfo.height < Number(pipelineConfig.qa.minImageHeight || 700)) {
      reasons.push(`image height too small (${imageInfo.height}px)`);
    }
    if (imageInfo.width && imageInfo.height) {
      const skew = Math.abs((imageInfo.width / imageInfo.height) - 1);
      if (skew > Number(pipelineConfig.qa.maxAspectSkew || 0.35)) {
        warnings.push(`image aspect is not close to square (${imageInfo.width}x${imageInfo.height})`);
      }
    }
  }

  const caption = cleanTextBlock(post.caption || '');
  const captionValidation = validateCaptionForScheduling(caption, { config: pipelineConfig });
  if (!captionValidation.ok) {
    reasons.push(...captionValidation.reasons.map(reason => `caption: ${reason}`));
  }
  const overlap = topicCaptionOverlap(post.topic, caption);
  if (overlap.matched_terms.length === 0) {
    warnings.push('caption has no obvious topic-term overlap');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    warnings,
    image: imageInfo,
    caption: captionValidation.metrics,
    topic_caption_overlap: overlap,
  };
}

async function readImageInfo(filePath) {
  const buffer = await fs.readFile(filePath);
  const stat = await fs.stat(filePath);
  const mimeType = detectMimeType(buffer, filePath);
  const dimensions = readImageDimensions(buffer, mimeType);
  return {
    ok: true,
    path: path.relative(pipelineDir, filePath),
    bytes: stat.size,
    mime_type: mimeType,
    width: dimensions.width || null,
    height: dimensions.height || null,
  };
}

async function readImageForClaude(imagePathValue) {
  const imagePath = resolveImagePath({ image_path: imagePathValue });
  let buffer = await fs.readFile(imagePath.absolute);
  let mediaType = detectMimeType(buffer, imagePath.absolute);
  if (mediaType === 'image/webp' || buffer.length > VISION_CONVERT_BYTES) {
    const converted = await convertImageToVisionJpeg(imagePath.absolute);
    if (converted) {
      buffer = converted;
      mediaType = 'image/jpeg';
    }
  }
  const base64 = buffer.toString('base64');
  if (base64.length > VISION_BASE64_MAX) {
    throw new Error(`Image too large for Claude Vision after prep (${(base64.length / 1024 / 1024).toFixed(1)}MB base64). Regenerate or compress image.`);
  }
  return {
    mediaType,
    base64,
  };
}

async function convertImageToVisionJpeg(imagePath) {
  const ffmpegPath = findFfmpeg();
  if (!ffmpegPath) return null;
  const tmpJpeg = path.join(
    path.dirname(imagePath),
    `_qa_vision_${Date.now()}_${Math.random().toString(16).slice(2)}.jpg`
  );
  try {
    execFileSync(ffmpegPath, [
      '-i',
      imagePath,
      '-vf',
      "scale='if(gt(iw,ih),1200,-2)':'if(gt(iw,ih),-2,1200)'",
      '-q:v',
      '2',
      '-y',
      tmpJpeg,
    ], { stdio: 'ignore', timeout: 20000 });
    return await fs.readFile(tmpJpeg);
  } catch (_) {
    return null;
  } finally {
    await fs.unlink(tmpJpeg).catch(() => {});
  }
}

function findFfmpeg() {
  const candidates = [
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 5000 });
      return candidate;
    } catch (_) {}
  }
  return null;
}

function detectMimeType(buffer, filePath) {
  if (buffer.length >= 8 && buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function readImageDimensions(buffer, mimeType) {
  if (mimeType === 'image/png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === 'image/jpeg') {
    return readJpegDimensions(buffer);
  }
  if (mimeType === 'image/webp') {
    return readWebpDimensions(buffer);
  }
  return { width: null, height: null };
}

function readJpegDimensions(buffer) {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1];
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buffer.length) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return { width: null, height: null };
}

function readWebpDimensions(buffer) {
  const type = buffer.toString('ascii', 12, 16);
  if (type === 'VP8X' && buffer.length >= 30) {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  return { width: null, height: null };
}

function buildQaPrompt(post, local) {
  return `PAGE
${post.facebook_page_name || post.niche_name}

NICHE
${post.niche_name} (${post.niche_id})

TOPIC
${post.topic}

HOOK
${post.hook}

IMAGE PROMPT
${post.image_prompt}

IMAGE PATH
${post.image_path}

GLOBAL IMAGE HARD FAILS
- The image must be a standalone square editorial/photo-style image, not a phone screenshot, social post mockup, app frame, or content displayed inside a device bezel.
- Fail any visible fake social-media chrome: avatar/profile placeholders, username bars, like/comment/share icons, notification/app UI, phone notch/bezel, or white social feed margins around the subject.
- A real physical device may appear only when the topic naturally requires it, but it must not frame the whole image as a mock social post or screenshot.

NICHE-SPECIFIC QA RULES
${nicheSpecificQaRules(post.niche_id)}

CAPTION
${cleanTextBlock(post.caption || '')}

LOCAL CHECKS
${JSON.stringify(local, null, 2)}

Review whether this exact image + caption should be allowed into the Facebook scheduler.`;
}

function nicheSpecificQaRules(nicheId) {
  const rules = {
    'get-fit': [
      'Flag review_needed or blocked for promised pounds lost, calorie burn claims without source, guaranteed timelines, medical treatment claims, or advice that ignores beginner safety.',
      'A pass should include gentle pacing, stop-if-unwell guidance, and appropriate professional caveats for medical conditions, pregnancy, injuries, or heart concerns.',
      'Do not require medical disclaimers to dominate the post, but unsafe certainty should not pass.',
    ],
    money: [
      'Flag review_needed or blocked for guaranteed savings, income claims, investment/debt/credit/legal/tax advice, or named products/organizations not supported by the source signals.',
      'General budgeting tips can pass when framed as educational and realistic.',
    ],
    'make-it': [
      'For DIY cleaners or household mixtures, block any instruction that mixes bleach with vinegar, ammonia, acids, or other cleaners.',
      'Flag review_needed if vinegar and castile soap are combined in the same cleaner; they should be kept as separate recipes.',
      'For household cleaner posts, a pass should include surface spot-testing, ventilation, labeling, and keep-away-from-children/pets guidance when relevant.',
      'Flag disinfectant kill claims, mold-remediation claims, pest-control claims, or medical/sanitizing guarantees unless they are narrowly sourced and safely framed.',
    ],
    'tech-it': [
      'Flag review_needed or blocked for unsupported named AI tools, current/recent launch claims, "free forever" claims, or absolute claims that AI replaces every paid app.',
      'Flag privacy-risk advice that encourages uploading sensitive personal, client, legal, medical, or financial files without caveats.',
      'A pass should frame AI tools as task helpers, include current pricing/terms/privacy checks, and avoid guaranteeing results or savings.',
    ],
    'look-good': [
      'For skincare, flag review_needed or blocked for cure/treatment promises, guaranteed clear skin, anti-aging result promises, unsafe exfoliation/acid stacking, or advice that ignores irritation/allergy risk.',
      'A pass should use generic product categories, include patch testing or one-new-product-at-a-time guidance, and advise stopping if irritation occurs.',
      'Persistent acne, rashes, severe irritation, allergies, or skin conditions should be framed as reasons to ask a qualified dermatologist or clinician.',
      'Do not require medical caveats to dominate a simple beginner routine, but medicalized certainty should not pass.',
    ],
  };
  return (rules[nicheId] || ['Apply general production-quality and safety checks for a practical public how-to post.'])
    .map(rule => `- ${rule}`)
    .join('\n');
}

function localFailureReview(local) {
  return {
    verdict: 'blocked',
    score: 0,
    reasons: local.reasons.length ? local.reasons : ['local QA checks failed'],
    image_findings: { notes: 'Local image checks failed.' },
    caption_findings: { notes: 'Local caption checks failed.' },
    safety_findings: { risk_level: 'medium', concerns: local.reasons, notes: 'Blocked before vision review.' },
    recommended_fix: 'Regenerate or repair the image/caption, then rerun QA.',
    response_json: {
      verdict: 'blocked',
      score: 0,
      reasons: local.reasons,
      source: 'local_checks',
    },
  };
}

function normalizeQaResponse(value, local) {
  const verdict = normalizeVerdict(value?.verdict);
  let score = Number(value?.score);
  if (!Number.isFinite(score)) score = verdict === 'pass' ? 80 : verdict === 'review_needed' ? 50 : 0;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const minPassScore = Number(pipelineConfig.qa.minPassScore || 75);
  const adjustedVerdict = verdict === 'pass' && score < minPassScore ? 'review_needed' : verdict;
  const reasons = asStringArray(value?.reasons);
  const finalReasons = [
    ...reasons,
    ...local.warnings.map(warning => `local warning: ${warning}`),
  ].filter(Boolean);
  if (!finalReasons.length) finalReasons.push(adjustedVerdict === 'pass' ? 'QA passed' : 'QA needs review');

  return {
    verdict: adjustedVerdict,
    score,
    reasons: finalReasons,
    image_findings: objectOrEmpty(value?.image_findings),
    caption_findings: objectOrEmpty(value?.caption_findings),
    safety_findings: objectOrEmpty(value?.safety_findings),
    recommended_fix: value?.recommended_fix ? String(value.recommended_fix) : null,
    response_json: {
      ...value,
      verdict: adjustedVerdict,
      score,
      reasons: finalReasons,
    },
  };
}

function normalizeVerdict(value) {
  const text = String(value || '').toLowerCase().replace(/[^a-z_]+/g, '_');
  if (text === 'pass' || text === 'passed') return 'pass';
  if (text === 'blocked' || text === 'block') return 'blocked';
  return 'review_needed';
}

function statusFromVerdict(verdict) {
  if (verdict === 'pass') return 'passed';
  if (verdict === 'blocked') return 'blocked';
  return 'review_needed';
}

function upsertQualityCheck(db, check) {
  const existing = db.queryOne(
    `SELECT id FROM post_quality_checks WHERE run_id = ? AND post_id = ?`,
    [check.runId, check.post.id]
  );
  const values = [
    check.post.niche_id,
    check.model || null,
    check.status,
    check.dryRun ? 1 : 0,
    check.imagePath || null,
    check.captionHash || null,
    check.prompt || null,
    JSON.stringify(check.localChecks || {}),
    check.responseJson ? JSON.stringify(check.responseJson) : null,
    check.verdict || null,
    Number.isFinite(check.score) ? check.score : null,
    JSON.stringify(check.reasons || []),
    JSON.stringify(check.imageFindings || {}),
    JSON.stringify(check.captionFindings || {}),
    JSON.stringify(check.safetyFindings || {}),
    check.recommendedFix || null,
    check.errorMessage || null,
    check.startedAt || null,
    check.completedAt || null,
    isoNow(),
  ];
  if (existing) {
    db.run(
      `UPDATE post_quality_checks
       SET niche_id = ?, model = ?, status = ?, dry_run = ?, image_path = ?, caption_hash = ?,
           prompt = ?, local_checks_json = ?, response_json = ?, verdict = ?, score = ?,
           reasons_json = ?, image_findings_json = ?, caption_findings_json = ?,
           safety_findings_json = ?, recommended_fix = ?, error_message = ?,
           started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [...values, existing.id]
    );
  } else {
    db.run(
      `INSERT INTO post_quality_checks
       (run_id, post_id, niche_id, model, status, dry_run, image_path, caption_hash,
        prompt, local_checks_json, response_json, verdict, score, reasons_json,
        image_findings_json, caption_findings_json, safety_findings_json,
        recommended_fix, error_message, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [check.runId, check.post.id, ...values]
    );
  }
}

function selectPosts(db, runId, argv) {
  const status = parseArgValue(argv, '--status') || 'content_done';
  const where = ['run_id = ?', 'status = ?'];
  const params = [runId, status];
  const ids = parseNumberList(parseArgList(argv, '--id'));
  const niche = parseArgValue(argv, '--niche');
  const ranks = parseRankList(parseArgList(argv, '--rank'));
  const limit = readInteger(parseArgValue(argv, '--limit'), 0);

  if (ids.length > 0) {
    where.push(`id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  }
  if (niche) {
    where.push('niche_id = ?');
    params.push(niche);
  }
  if (ranks.length > 0) {
    where.push(`rank IN (${ranks.map(() => '?').join(', ')})`);
    params.push(...ranks);
  }

  let sql = `
    SELECT * FROM posts
    WHERE ${where.join(' AND ')}
    ORDER BY niche_id, rank ASC, id ASC
  `;
  if (limit > 0) sql += ` LIMIT ${limit}`;
  return db.queryAll(sql, params);
}

function guardBulkSelection(posts, argv, label) {
  const hasSelector = parseArgValue(argv, '--id') || parseArgValue(argv, '--niche') || parseArgValue(argv, '--rank') || parseArgValue(argv, '--limit');
  if (!hasSelector && posts.length > 1) {
    throw new Error(`${label} requires --id, --niche/--rank, or --limit when more than one post matches.`);
  }
  if (posts.length > 10 && !hasFlag(argv, '--yes')) {
    throw new Error(`${label} selected ${posts.length} posts. Re-run with --yes to confirm bulk QA.`);
  }
}

function resolveImagePath(post) {
  const value = cleanText(post.image_path);
  if (!value) throw new Error(`Post #${post.id || '?'} has no image_path.`);
  return {
    relative: value,
    absolute: path.isAbsolute(value) ? value : path.resolve(value),
  };
}

async function writePostsExport(db, runId) {
  const posts = db.exportPosts(runId);
  await fs.writeFile(pipelineConfig.files.postsQueue, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
}

function topicCaptionOverlap(topic, caption) {
  const topicTerms = tokenize(topic).filter(term => !STOPWORDS.has(term));
  const captionTerms = new Set(tokenize(caption));
  const matchedTerms = topicTerms.filter(term => captionTerms.has(term));
  return {
    topic_terms: topicTerms,
    matched_terms: matchedTerms,
    score: topicTerms.length ? Number((matchedTerms.length / topicTerms.length).toFixed(3)) : 0,
  };
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map(term => term.trim())
    .filter(term => term.length >= 3);
}

function extractText(response) {
  return (response.content || [])
    .map(block => block?.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseQaResponse(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const value = JSON.parse(cleaned);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('QA response JSON is not an object');
    return value;
  } catch (directError) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw directError;
    const value = JSON.parse(match[0]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('QA response JSON is not an object');
    return value;
  }
}

function resolveRunId(db, value) {
  if (value && value !== 'latest') {
    const found = db.queryOne(`SELECT id FROM runs WHERE id = ?`, [value]);
    if (!found) throw new Error(`Run not found: ${value}`);
    return value;
  }
  const latestWithPosts = db.queryOne(
    `SELECT runs.id
     FROM runs
     JOIN posts ON posts.run_id = runs.id
     GROUP BY runs.id
     ORDER BY COALESCE(runs.completed_at, runs.updated_at, runs.started_at) DESC
     LIMIT 1`
  );
  return latestWithPosts?.id || null;
}

function hashCaption(value) {
  return crypto.createHash('sha256').update(cleanTextBlock(value || ''), 'utf8').digest('hex');
}

function parseArgValue(argv, flag) {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === flag && argv[index + 1]) return argv[index + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return null;
}

function parseArgList(argv, flag) {
  const out = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === flag && argv[index + 1]) {
      out.push(...splitList(argv[index + 1]));
      index++;
    } else if (arg.startsWith(`${flag}=`)) {
      out.push(...splitList(arg.slice(flag.length + 1)));
    }
  }
  return out;
}

function parseNumberList(values) {
  return values.map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0);
}

function parseRankList(values) {
  const ranks = new Set();
  for (const value of values) {
    const match = String(value).match(/^(\d+)-(\d+)$/);
    if (match) {
      const start = Number(match[1]);
      const end = Number(match[2]);
      for (let rank = Math.min(start, end); rank <= Math.max(start, end); rank++) ranks.add(rank);
      continue;
    }
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) ranks.add(parsed);
  }
  return Array.from(ranks).sort((a, b) => a - b);
}

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item || '').trim()).filter(Boolean);
  const text = String(value || '').trim();
  return text ? [text] : [];
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function isoNow() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`How-to post/image QA guard

Usage:
  npm.cmd run qa -- --dry-run --id 151 --status scheduled
  npm.cmd run qa -- --run --id 241
  npm.cmd run qa -- --run --niche money --rank 1

Options:
  --run-id latest
  --id 241
  --niche money
  --rank 1
  --limit 1
  --status content_done
  --allow-status-override
  --model claude-sonnet-4-6

Flow:
  content_done -> qa_generating -> qa_done

The QA run combines local checks with a Claude vision/text review. Facebook scheduling requires
a fresh passed QA row matching the current image path and caption hash.
`);
}
