import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipelineConfig } from './config.js';
import { openPipelineDb } from './db.js';
import { generateHiggsfieldImage } from './adapters/higgsfield-image-generator.js';
import { prepareVisualPromptForGeneration, summarizeVisualPlan } from './visual-dedup.js';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pipelineDir);

const rawArgs = process.argv.slice(2);
if (hasFlag(rawArgs, '--help') || hasFlag(rawArgs, '-h')) {
  printHelp();
  process.exit(0);
}

const dryRun = hasFlag(rawArgs, '--dry-run');
const live = hasFlag(rawArgs, '--live');
if (dryRun && live) {
  console.error('Use either --dry-run or --live, not both.');
  process.exit(1);
}
if (!dryRun && !live) {
  console.error('Choose --dry-run or --live. Live mode is guarded and requires --limit 1.');
  process.exit(1);
}

const db = await openPipelineDb({
  config: pipelineConfig,
  logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
});

try {
  const runId = resolveRunId(db, parseArgValue(rawArgs, '--run-id') || parseArgValue(rawArgs, '--run') || 'latest');
  if (!runId) throw new Error('No run found in how-to content DB.');

  const posts = selectPosts(db, runId, rawArgs);
  if (dryRun) {
    const manifest = await buildDryRunManifest(db, runId, posts, rawArgs);
    console.log(`Image dry-run manifest written: ${manifest.manifest_path}`);
    console.log(`Prepared ${manifest.items.length} image job(s) from ${posts.length} approved post(s).`);
    for (const item of manifest.items.slice(0, 10)) {
      console.log(`#${item.post_id} ${item.niche_id} r${item.rank}: ${item.output_path}`);
    }
    if (manifest.items.length > 10) console.log(`...${manifest.items.length - 10} more`);
  } else {
    const result = await runLiveImageGeneration(db, runId, posts, rawArgs);
    console.log(`Live image generation complete for post #${result.post_id}`);
    console.log(`Saved image: ${result.image_path}`);
  }
} finally {
  db.close();
}

async function runLiveImageGeneration(db, runId, posts, argv) {
  if (posts.length !== 1) {
    throw new Error(`Live image mode requires exactly one approved post. Selected ${posts.length}. Use --limit 1, --id, or --niche plus --rank.`);
  }

  const limit = readInteger(parseArgValue(argv, '--limit'), 0);
  if (limit !== 1 && !parseArgValue(argv, '--id') && !(parseArgValue(argv, '--niche') && parseArgValue(argv, '--rank'))) {
    throw new Error('Live image mode requires --limit 1 or an exact --id/--niche --rank selector.');
  }

  const post = posts[0];
  const provider = parseArgValue(argv, '--provider') || pipelineConfig.image.provider;
  const model = parseArgValue(argv, '--model') || pipelineConfig.image.model;
  if (provider !== 'higgsfield') throw new Error(`Unsupported live image provider: ${provider}`);
  const manifestPath = path.resolve(parseArgValue(argv, '--manifest') || pipelineConfig.files.imageManifest);
  const outputPath = buildOutputPath(runId, post);
  await fs.mkdir(path.dirname(outputPath.absolute), { recursive: true });
  db.backup(`pre-image-live-${runId}`);
  const promptPayload = buildPromptPayload(db, post, { provider, model, runId, persist: true });
  const projectDir = path.resolve(pipelineConfig.image.higgsfieldProjectDir || '_higgsfield/project');
  const loginWaitMs = parseLoginWaitMs(argv) ?? pipelineConfig.image.higgsfieldLoginWaitMs ?? 0;
  const now = isoNow();
  let genClicked = false;

  logVisualDedupeEvent(db, runId, post, promptPayload);
  upsertImageJob(db, {
    runId,
    post,
    provider,
    model,
    prompt: promptPayload.prompt,
    promptPayload,
    manifestPath: path.relative(pipelineDir, manifestPath),
    outputPath: outputPath.relative,
    status: 'generating',
    dryRun: false,
    now,
  });
  db.run(
    `UPDATE posts
     SET status = 'image_generating', error_message = NULL, updated_at = ?
     WHERE id = ?`,
    [now, post.id]
  );
  db.save();

  try {
    const genMeta = await generateHiggsfieldImage({
      prompt: promptPayload.prompt,
      outputPath: outputPath.absolute,
      aspectRatio: promptPayload.aspect_ratio,
      projectDir,
      loginWaitMs,
      logger: console,
      onGenClicked: (creditCost) => {
        genClicked = true;
        const clickedAt = isoNow();
        db.run(
          `UPDATE image_jobs
           SET gen_clicked_at = ?, credit_cost = ?, updated_at = ?
           WHERE run_id = ? AND post_id = ? AND provider = ? AND mode = 'single-image'`,
          [clickedAt, creditCost ?? null, clickedAt, runId, post.id, provider]
        );
        db.logEvent(runId, 'image_generate_clicked', {
          stage: 'image',
          nicheId: post.niche_id,
          message: `Higgsfield Generate clicked for post ${post.id}`,
          data: { postId: post.id, rank: post.rank, creditCost: creditCost ?? null },
        });
        db.save();
      },
    });

    const completedAt = isoNow();
    db.run(
      `UPDATE image_jobs
       SET status = 'done', dry_run = 0, output_path = ?, source_gen_id = ?, cdn_url = ?,
           generation_duration_ms = ?, error_message = NULL, completed_at = ?, updated_at = ?
       WHERE run_id = ? AND post_id = ? AND provider = ? AND mode = 'single-image'`,
      [
        outputPath.relative,
        genMeta?.sourceGenId || null,
        genMeta?.cdnUrl || null,
        genMeta?.generationDurationMs || null,
        completedAt,
        completedAt,
        runId,
        post.id,
        provider,
      ]
    );
    db.run(
      `UPDATE posts
       SET status = 'image_done', image_path = ?, error_message = NULL, generated_at = ?, updated_at = ?
       WHERE id = ?`,
      [outputPath.relative, completedAt, completedAt, post.id]
    );
    db.logEvent(runId, 'image_done', {
      stage: 'image',
      nicheId: post.niche_id,
      message: `Generated Higgsfield image for post ${post.id}`,
      data: { postId: post.id, rank: post.rank, outputPath: outputPath.relative, genMeta },
    });
    db.save();
    await writePostsExport(db, runId);
    await writeLiveManifest({
      runId,
      post,
      provider,
      model,
      outputPath: outputPath.relative,
      promptPayload,
      genMeta,
      manifestPath,
    });
    return { post_id: post.id, image_path: outputPath.relative };
  } catch (error) {
    const failedAt = isoNow();
    const message = error?.message || String(error);
    const postStatus = genClicked ? 'failed' : 'approved';
    db.run(
      `UPDATE image_jobs
       SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
       WHERE run_id = ? AND post_id = ? AND provider = ? AND mode = 'single-image'`,
      [message, failedAt, failedAt, runId, post.id, provider]
    );
    db.run(
      `UPDATE posts
       SET status = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      [postStatus, message, failedAt, post.id]
    );
    db.logEvent(runId, 'image_failed', {
      stage: 'image',
      nicheId: post.niche_id,
      message,
      data: { postId: post.id, rank: post.rank, genClicked },
    });
    db.save();
    await writePostsExport(db, runId);
    throw error;
  }
}

async function buildDryRunManifest(db, runId, posts, argv) {
  const provider = parseArgValue(argv, '--provider') || pipelineConfig.image.provider;
  const model = parseArgValue(argv, '--model') || pipelineConfig.image.model;
  const manifestPath = path.resolve(parseArgValue(argv, '--manifest') || pipelineConfig.files.imageManifest);
  const items = [];

  db.backup(`pre-image-dry-run-${runId}`);
  const now = isoNow();
  for (const post of posts) {
    const outputPath = buildOutputPath(runId, post);
    await fs.mkdir(path.dirname(outputPath.absolute), { recursive: true });
    const promptPayload = buildPromptPayload(db, post, { provider, model, runId, persist: false });
    logVisualDedupeEvent(db, runId, post, promptPayload);
    upsertImageJob(db, {
      runId,
      post,
      provider,
      model,
      prompt: promptPayload.prompt,
      promptPayload,
      manifestPath: path.relative(pipelineDir, manifestPath),
      outputPath: outputPath.relative,
      status: 'dry_run',
      dryRun: true,
      now,
    });
    db.logEvent(runId, 'image_dry_run_prepared', {
      stage: 'image',
      nicheId: post.niche_id,
      message: `Prepared dry-run image payload for post ${post.id}`,
      data: { postId: post.id, rank: post.rank, outputPath: outputPath.relative, provider, model },
    });
    items.push({
      image_job_status: 'dry_run',
      post_id: post.id,
      run_id: runId,
      niche_id: post.niche_id,
      niche_name: post.niche_name,
      facebook_page_name: post.facebook_page_name,
      rank: post.rank,
      topic: post.topic,
      hook: post.hook,
      sources: parseJson(post.sources_json, []),
      provider,
      model,
      output_path: outputPath.relative,
      prompt_payload: promptPayload,
    });
  }

  const manifest = {
    generated_at: now,
    run_id: runId,
    dry_run: true,
    provider,
    model,
    items,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  db.save();
  return { ...manifest, manifest_path: path.relative(pipelineDir, manifestPath) };
}

function upsertImageJob(db, job) {
  const existing = db.queryOne(
    `SELECT id FROM image_jobs
     WHERE run_id = ? AND post_id = ? AND provider = ? AND mode = 'single-image'`,
    [job.runId, job.post.id, job.provider]
  );
  const values = [
    job.runId,
    job.post.id,
    job.post.niche_id,
    job.provider,
    job.model,
    'single-image',
    job.status,
    job.dryRun ? 1 : 0,
    job.prompt,
    JSON.stringify(job.promptPayload),
    JSON.stringify(job.promptPayload.visual_fingerprint || null),
    JSON.stringify(job.promptPayload.visual_dedupe || null),
    job.manifestPath,
    job.outputPath,
    null,
    job.now,
    job.now,
    job.now,
  ];
  if (existing) {
    db.run(
      `UPDATE image_jobs
       SET niche_id = ?, model = ?, status = ?, dry_run = ?, prompt = ?, prompt_payload_json = ?,
           visual_fingerprint = ?, visual_dedupe_json = ?, manifest_path = ?, output_path = ?,
           error_message = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        job.post.niche_id,
        job.model,
        job.status,
        job.dryRun ? 1 : 0,
        job.prompt,
        JSON.stringify(job.promptPayload),
        JSON.stringify(job.promptPayload.visual_fingerprint || null),
        JSON.stringify(job.promptPayload.visual_dedupe || null),
        job.manifestPath,
        job.outputPath,
        null,
        job.now,
        job.now,
        job.now,
        existing.id,
      ]
    );
  } else {
    db.run(
      `INSERT INTO image_jobs
       (run_id, post_id, niche_id, provider, model, mode, status, dry_run, prompt, prompt_payload_json,
        visual_fingerprint, visual_dedupe_json, manifest_path, output_path, error_message, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values
    );
  }
}

function logVisualDedupeEvent(db, runId, post, promptPayload) {
  if (!promptPayload?.visual_dedupe?.changed) return;
  db.logEvent(runId, 'visual_dedup_prompt_varied', {
    stage: 'image',
    nicheId: post.niche_id,
    message: promptPayload.visual_dedupe.reason,
    data: {
      postId: post.id,
      rank: post.rank,
      visual_dedupe: promptPayload.visual_dedupe,
    },
  });
}

async function writeLiveManifest({ runId, post, provider, model, outputPath, promptPayload, genMeta, manifestPath }) {
  const manifest = {
    generated_at: isoNow(),
    run_id: runId,
    dry_run: false,
    provider,
    model,
    items: [{
      image_job_status: 'done',
      post_id: post.id,
      run_id: runId,
      niche_id: post.niche_id,
      niche_name: post.niche_name,
      facebook_page_name: post.facebook_page_name,
      rank: post.rank,
      topic: post.topic,
      hook: post.hook,
      sources: parseJson(post.sources_json, []),
      provider,
      model,
      output_path: outputPath,
      prompt_payload: promptPayload,
      gen_meta: genMeta,
    }],
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

async function writePostsExport(db, runId) {
  const posts = db.exportPosts(runId);
  await fs.writeFile(pipelineConfig.files.postsQueue, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
}

function selectPosts(db, runId, argv) {
  const status = parseArgValue(argv, '--status') || 'approved';
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

function buildPromptPayload(db, post, { provider, model, runId = post?.run_id || null, persist = false }) {
  const visualPlan = prepareVisualPromptForGeneration(db, post, {
    runId,
    persist,
    logger: console,
  });
  const visualPrompt = cleanText(visualPlan.prompt);
  const style = cleanText(pipelineConfig.image.promptStyle);
  const visualGuard = 'No readable words, labels, logos, app icons, brand marks, watermarks, UI text, captions, posters, or printed text anywhere in the image; no fake social media post frames, profile icons, like/comment/share UI, smartphone-screen mockups, tablet frames, or device bezels framing the subject; use generic blank props and abstract interface shapes only; avoid color palettes or geometry that resemble real brand logos';
  const prompt = `${visualPrompt}. ${style}. ${visualGuard}.`;
  return {
    provider,
    model,
    mode: 'single-image',
    aspect_ratio: pipelineConfig.image.aspectRatio,
    prompt,
    original_image_prompt: visualPlan.original_prompt,
    visual_fingerprint: visualPlan.fingerprint,
    visual_dedupe: summarizeVisualPlan(visualPlan),
    negative_prompt: [
      'text overlay',
      'readable words',
      'readable labels',
      'watermark',
      'brand logos',
      'app logos',
      'real company logos',
      'brand-like color blocks',
      'UI text',
      'fake social media post',
      'phone screen mockup',
      'smartphone frame',
      'device bezel',
      'profile icon',
      'like button',
      'comment icon',
      'printed text',
      'distorted hands',
      'extra fingers',
      'unsafe repair steps',
      'graphic injury',
    ],
    post_context: {
      facebook_page_name: post.facebook_page_name,
      niche_id: post.niche_id,
      niche_name: post.niche_name,
      rank: post.rank,
      topic: post.topic,
      hook: post.hook,
    },
  };
}

function buildOutputPath(runId, post) {
  const fileName = `${String(post.rank).padStart(2, '0')}_${slug(post.topic)}.png`;
  const relative = path.join(pipelineConfig.files.imagesDir, runId, post.niche_id, fileName);
  return {
    relative,
    absolute: path.resolve(relative),
  };
}

function resolveRunId(db, value) {
  if (value && value !== 'latest') {
    const found = db.queryOne(`SELECT id FROM runs WHERE id = ?`, [value]);
    if (!found) throw new Error(`Run not found: ${value}`);
    return value;
  }
  const latestWithApprovedPosts = db.queryOne(
    `SELECT runs.id
     FROM runs
     JOIN posts ON posts.run_id = runs.id
     GROUP BY runs.id
     ORDER BY COALESCE(runs.completed_at, runs.updated_at, runs.started_at) DESC
     LIMIT 1`
  );
  return latestWithApprovedPosts?.id || null;
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

function parseLoginWaitMs(argv) {
  const msValue = parseArgValue(argv, '--login-wait-ms');
  if (msValue !== null) return readNonNegativeInteger(msValue, '--login-wait-ms');

  const secValue = parseArgValue(argv, '--login-wait-sec') ?? parseArgValue(argv, '--login-wait-seconds');
  if (secValue !== null) return readNonNegativeInteger(secValue, '--login-wait-sec') * 1000;

  return null;
}

function readNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.round(parsed);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slug(value) {
  return String(value || 'post')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'post';
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function isoNow() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`How-to image stage

Usage:
  npm.cmd run image -- --dry-run --limit 1
  npm.cmd run image -- --dry-run --niche fix-it --rank 1
  npm.cmd run image -- --dry-run --id 123
  npm.cmd run image -- --live --limit 1 --login-wait-sec 180

Notes:
  - Only posts with status=approved are selected by default.
  - Dry-run writes image_manifest.json, creates generated_images/<run>/<niche>/ folders,
    and records image_jobs rows with status=dry_run.
  - Live mode requires exactly one approved post and checks the Higgsfield session before Generate.
`);
}
