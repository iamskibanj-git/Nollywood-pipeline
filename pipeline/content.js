import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { pipelineConfig } from './config.js';
import { resolveAnthropicApiKey } from './credentials.js';
import { openPipelineDb } from './db.js';
import { cleanTextBlock, validateCaptionForScheduling } from './content-quality.js';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pipelineDir);

const CONTENT_SYSTEM_PROMPT = `You write practical Facebook how-to posts for topic pages.

The output must be useful enough that a reader can do the safe parts without leaving Facebook.
Use the provided tool to return the caption payload. Do not answer in free text.`;

const CONTENT_TOOL = {
  name: 'write_howto_caption',
  description: 'Return a practical Facebook how-to caption and quality notes.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      caption: { type: 'string' },
      hashtags: {
        type: 'array',
        items: { type: 'string' },
      },
      quality_notes: {
        type: 'object',
        additionalProperties: true,
        properties: {
          step_count: { type: 'number' },
          why_useful: { type: 'string' },
          safety_note: { type: 'string' },
        },
      },
    },
    required: ['caption', 'hashtags', 'quality_notes'],
  },
};

const rawArgs = process.argv.slice(2);
if (hasFlag(rawArgs, '--help') || hasFlag(rawArgs, '-h')) {
  printHelp();
  process.exit(0);
}

const dryRun = hasFlag(rawArgs, '--dry-run');
const generate = hasFlag(rawArgs, '--generate') || hasFlag(rawArgs, '--live');
if (dryRun && generate) {
  console.error('Use either --dry-run or --generate, not both.');
  process.exit(1);
}
if (!dryRun && !generate) {
  console.error('Choose --dry-run or --generate. Use --help for examples.');
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
  if (posts.length === 0) throw new Error('No image_done posts selected for content generation.');
  guardBulkSelection(posts, rawArgs, dryRun ? 'content dry-run' : 'content generation');

  if (dryRun) {
    const manifest = await buildDryRunManifest(db, runId, posts, rawArgs);
    console.log(`Content dry-run manifest written: ${manifest.manifest_path}`);
    console.log(`Prepared ${manifest.items.length} content job(s).`);
    for (const item of manifest.items.slice(0, 10)) {
      console.log(`#${item.post_id} ${item.niche_id} r${item.rank}: ${item.topic}`);
    }
    if (manifest.items.length > 10) console.log(`...${manifest.items.length - 10} more`);
  } else {
    const result = await runContentGeneration(db, runId, posts, rawArgs);
    console.log(`Content generation complete: ${result.done} done, ${result.failed} failed.`);
    if (result.failed > 0) process.exitCode = 1;
  }
} finally {
  db.close();
}

async function buildDryRunManifest(db, runId, posts, argv) {
  const model = parseArgValue(argv, '--model') || pipelineConfig.content.model;
  const manifestPath = path.resolve(parseArgValue(argv, '--manifest') || pipelineConfig.files.contentManifest);
  const now = isoNow();
  const items = [];

  db.backup(`pre-content-dry-run-${runId}`);
  for (const post of posts) {
    const imagePath = resolveImagePath(post);
    await assertFileExists(imagePath.absolute, `Generated image for post #${post.id}`);
    const prompt = buildContentPrompt(post);
    upsertContentJob(db, {
      runId,
      post,
      model,
      status: 'dry_run',
      dryRun: true,
      prompt,
      responseJson: null,
      caption: null,
      validationJson: null,
      errorMessage: null,
      now,
      completedAt: now,
    });
    db.logEvent(runId, 'content_dry_run_prepared', {
      stage: 'content',
      nicheId: post.niche_id,
      message: `Prepared content prompt for post ${post.id}`,
      data: { postId: post.id, rank: post.rank, model },
    });
    items.push({
      content_job_status: 'dry_run',
      post_id: post.id,
      run_id: runId,
      niche_id: post.niche_id,
      niche_name: post.niche_name,
      facebook_page_name: post.facebook_page_name,
      rank: post.rank,
      topic: post.topic,
      hook: post.hook,
      image_path: imagePath.relative,
      model,
      prompt,
    });
  }

  const manifest = {
    generated_at: now,
    run_id: runId,
    dry_run: true,
    model,
    items,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  db.save();
  return { ...manifest, manifest_path: path.relative(pipelineDir, manifestPath) };
}

async function runContentGeneration(db, runId, posts, argv) {
  const invalidStatuses = posts.filter(post => post.status !== 'image_done');
  if (invalidStatuses.length && !hasFlag(argv, '--allow-status-override')) {
    throw new Error(`Content generation only runs from image_done by default. Invalid selected posts: ${invalidStatuses.map(post => `#${post.id}:${post.status}`).join(', ')}. Use --allow-status-override only for a deliberate repair.`);
  }

  const apiKey = resolveAnthropicApiKey({ logger: { info() {}, warn() {}, error() {} } });
  if (!apiKey) {
    throw new Error('Claude/Anthropic API key required. Set ANTHROPIC_API_KEY or save a Claude key in the existing Electron app settings.');
  }
  const client = new Anthropic({ apiKey });
  const model = parseArgValue(argv, '--model') || pipelineConfig.content.model;
  const manifestPath = path.resolve(parseArgValue(argv, '--manifest') || pipelineConfig.files.contentManifest);
  const items = [];
  let done = 0;
  let failed = 0;

  db.backup(`pre-content-generate-${runId}`);
  for (const post of posts) {
    const startedAt = isoNow();
    const imagePath = resolveImagePath(post);
    await assertFileExists(imagePath.absolute, `Generated image for post #${post.id}`);
    const prompt = buildContentPrompt(post);
    upsertContentJob(db, {
      runId,
      post,
      model,
      status: 'generating',
      dryRun: false,
      prompt,
      responseJson: null,
      caption: null,
      validationJson: null,
      errorMessage: null,
      now: startedAt,
      completedAt: null,
    });
    db.run(
      `UPDATE posts
       SET status = 'content_generating', error_message = NULL, updated_at = ?
       WHERE id = ?`,
      [startedAt, post.id]
    );
    db.save();

    let responseJson = null;
    try {
      const response = await client.messages.create({
        model,
        max_tokens: Number(pipelineConfig.content.maxTokens || 1800),
        temperature: Number(pipelineConfig.content.temperature || 0.35),
        system: CONTENT_SYSTEM_PROMPT,
        tools: [CONTENT_TOOL],
        tool_choice: { type: 'tool', name: CONTENT_TOOL.name },
        messages: [{ role: 'user', content: prompt }],
      });
      responseJson = extractContentPayload(response);
      const normalized = normalizeContentResponse(responseJson, post);
      const validation = validateCaptionForScheduling(normalized.caption, { config: pipelineConfig });
      if (!validation.ok) {
        throw new Error(`Generated caption failed quality guard: ${validation.reasons.join('; ')}`);
      }

      const completedAt = isoNow();
      upsertContentJob(db, {
        runId,
        post,
        model,
        status: 'done',
        dryRun: false,
        prompt,
        responseJson: normalized.response_json,
        caption: validation.caption,
        validationJson: validation,
        errorMessage: null,
        now: startedAt,
        completedAt,
      });
      db.run(
        `UPDATE posts
         SET status = 'content_done', caption = ?, content_generated_at = ?, error_message = NULL, updated_at = ?
         WHERE id = ?`,
        [validation.caption, completedAt, completedAt, post.id]
      );
      db.logEvent(runId, 'content_done', {
        stage: 'content',
        nicheId: post.niche_id,
        message: `Generated useful caption for post ${post.id}`,
        data: { postId: post.id, rank: post.rank, validation: validation.metrics },
      });
      db.save();
      done++;
      items.push({
        content_job_status: 'done',
        post_id: post.id,
        run_id: runId,
        niche_id: post.niche_id,
        niche_name: post.niche_name,
        facebook_page_name: post.facebook_page_name,
        rank: post.rank,
        topic: post.topic,
        hook: post.hook,
        image_path: imagePath.relative,
        model,
        caption: validation.caption,
        validation,
      });
    } catch (error) {
      const failedAt = isoNow();
      const message = error?.message || String(error);
      const validation = responseJson?.caption
        ? validateCaptionForScheduling(responseJson.caption, { config: pipelineConfig })
        : null;
      upsertContentJob(db, {
        runId,
        post,
        model,
        status: 'failed',
        dryRun: false,
        prompt,
        responseJson,
        caption: responseJson?.caption || null,
        validationJson: validation,
        errorMessage: message,
        now: startedAt,
        completedAt: failedAt,
      });
      db.run(
        `UPDATE posts
         SET status = ?, error_message = ?, updated_at = ?
         WHERE id = ?`,
        [post.status === 'image_done' ? 'image_done' : post.status, message, failedAt, post.id]
      );
      db.logEvent(runId, 'content_failed', {
        stage: 'content',
        nicheId: post.niche_id,
        message,
        data: { postId: post.id, rank: post.rank, validation },
      });
      db.save();
      failed++;
      items.push({
        content_job_status: 'failed',
        post_id: post.id,
        run_id: runId,
        niche_id: post.niche_id,
        rank: post.rank,
        topic: post.topic,
        model,
        error_message: message,
        validation,
      });
    }

    await writePostsExport(db, runId);
    await delay(Number(pipelineConfig.content.delayBetweenPostsMs || 1200));
  }

  const manifest = {
    generated_at: isoNow(),
    run_id: runId,
    dry_run: false,
    model,
    items,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { done, failed, manifest_path: path.relative(pipelineDir, manifestPath) };
}

function buildContentPrompt(post) {
  const maxChars = Number(pipelineConfig.content.maxCaptionChars || 1800);
  const minChars = Number(pipelineConfig.content.minCaptionChars || 450);
  const targetMaxChars = Math.max(minChars, Math.min(maxChars - 150, 1600));
  const hashtags = hashtagsForNiche(post.niche_id);
  return `PAGE
${post.facebook_page_name || post.niche_name}

NICHE
${post.niche_name} (${post.niche_id})

TOPIC
${post.topic}

HOOK IDEA
${post.hook}

SOURCE SIGNALS
${parseJson(post.sources_json, []).join(', ') || 'n/a'}

IMAGE ALREADY GENERATED
${post.image_path || 'n/a'}

NICHE-SPECIFIC SAFETY RULES
${nicheSpecificContentRules(post.niche_id)}

TASK
Write one Facebook caption that actually helps the reader.

Caption requirements:
- ${minChars}-${targetMaxChars} characters. This is a hard target; stay comfortably below it.
- First line: strong hook, no emoji.
- The hook idea is inspiration, not mandatory wording. Rewrite it if it contains unsourced numbers, calorie claims, guarantees, medical claims, or anything that conflicts with the niche-specific safety rules.
- Include a "What you need:" section with 3-6 bullets or comma-separated items.
- Include a "Steps:" section with 3-5 numbered actionable steps.
- Include a "Safety note:" or "Quick check:" line.
- End with a short CTA and these hashtags if they fit: ${hashtags.join(' ')}.
- Keep the language simple, practical, and specific.
- Do not invent product claims, dates, prices, legal/medical/financial guarantees, or unsafe instructions.
- Do not name specific apps, companies, products, websites, tools, lenders, platforms, or organizations unless they appear in the source signals above. Use generic phrases instead.
- Do not use emoji or CTA wording that depends on emoji, such as "drop a [emoji] below".
- For risky tasks, give only safe checks and tell readers when to call a pro.

Return only JSON.`;
}

function nicheSpecificContentRules(nicheId) {
  const rules = {
    'get-fit': [
      'Do not promise specific weight-loss amounts, calorie burns, timelines, medical outcomes, or results for everyone.',
      'Frame exercise as a habit that can support health, not as treatment or guaranteed fat loss.',
      'Keep advice beginner-safe: start gently, use comfortable pace, rest when needed, and stop for chest pain, dizziness, shortness of breath, sharp pain, or unusual symptoms.',
      'Tell readers with injuries, pregnancy, chronic conditions, or heart concerns to ask a qualified professional before changing activity levels.',
      'Avoid body-shaming language.',
    ],
    money: [
      'Do not promise savings amounts, income, returns, debt relief, credit repair, or guaranteed financial outcomes.',
      'Avoid naming apps, lenders, platforms, websites, or organizations unless they appear in the source signals.',
      'Frame money advice as general educational tips, not financial/legal/tax advice.',
    ],
    'make-it': [
      'For DIY cleaners or household mixtures, never tell readers to mix bleach with vinegar, ammonia, acids, or other cleaners.',
      'Do not combine vinegar and castile soap in the same cleaner; keep vinegar sprays and soap-based cleaners as separate recipes.',
      'For household cleaning projects, include safe labeling, ventilation, surface spot-testing, and keep-out-of-reach guidance when relevant.',
      'Prefer simple low-risk recipes and avoid medical, pest-control, mold-remediation, or disinfectant kill-claim promises.',
    ],
    'tech-it': [
      'Do not claim tools are free forever, better than paid tools, or able to replace every paid app.',
      'Do not name specific AI tools, apps, companies, or platforms unless they appear in the source signals.',
      'Frame AI tools as options for specific tasks, not as guaranteed replacements for professional software or human expertise.',
      'Include a quick check to verify current pricing, privacy settings, data retention, and terms before uploading sensitive files.',
      'Avoid current-news, launch-date, or "just released" claims unless they are directly supported by the source signals.',
    ],
    'look-good': [
      'For skincare, do not promise clear skin, anti-aging results, acne cures, treatment outcomes, or results for every skin type.',
      'Keep advice beginner-safe: start with a simple routine, introduce one new product at a time, patch test, and stop if irritation occurs.',
      'Avoid naming brands or products unless they appear in the source signals; use generic categories such as gentle cleanser, moisturizer, and sunscreen.',
      'Tell readers with persistent acne, rashes, severe irritation, allergies, or skin conditions to ask a qualified dermatologist or clinician.',
      'Avoid body-shaming or appearance-shaming language.',
    ],
  };
  return (rules[nicheId] || ['Use practical, low-risk advice appropriate for a general audience.'])
    .map(rule => `- ${rule}`)
    .join('\n');
}

function normalizeContentResponse(value, post) {
  const hashtags = Array.isArray(value?.hashtags)
    ? value.hashtags.map(tag => normalizeHashtag(tag)).filter(Boolean)
    : [];
  const fallbackTags = hashtagsForNiche(post.niche_id);
  const uniqueTags = unique([...(hashtags.length ? hashtags : fallbackTags), ...fallbackTags.slice(0, 1)]).slice(0, 4);
  let caption = cleanTextBlock(normalizeReadableText(value?.caption || ''));
  const tagLine = uniqueTags.join(' ');
  if (tagLine && !caption.toLowerCase().includes(uniqueTags[0].toLowerCase())) {
    caption = cleanTextBlock(`${caption}\n\n${tagLine}`);
  }
  return {
    caption,
    response_json: {
      caption,
      hashtags: uniqueTags,
      quality_notes: value?.quality_notes || {},
    },
  };
}

function upsertContentJob(db, job) {
  const existing = db.queryOne(
    `SELECT id FROM content_jobs
     WHERE run_id = ? AND post_id = ? AND model = ?`,
    [job.runId, job.post.id, job.model]
  );
  const values = [
    job.post.niche_id,
    job.model,
    job.status,
    job.dryRun ? 1 : 0,
    job.prompt,
    job.responseJson ? JSON.stringify(job.responseJson) : null,
    job.caption || null,
    job.validationJson ? JSON.stringify(job.validationJson) : '{}',
    job.errorMessage || null,
    job.now,
    job.completedAt || null,
    isoNow(),
  ];
  if (existing) {
    db.run(
      `UPDATE content_jobs
       SET niche_id = ?, model = ?, status = ?, dry_run = ?, prompt = ?, response_json = ?,
           caption = ?, validation_json = ?, error_message = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [...values, existing.id]
    );
  } else {
    db.run(
      `INSERT INTO content_jobs
       (run_id, post_id, niche_id, model, status, dry_run, prompt, response_json,
        caption, validation_json, error_message, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [job.runId, job.post.id, ...values]
    );
  }
}

function selectPosts(db, runId, argv) {
  const status = parseArgValue(argv, '--status') || 'image_done';
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
    throw new Error(`${label} selected ${posts.length} posts. Re-run with --yes to confirm bulk generation.`);
  }
}

function resolveImagePath(post) {
  const value = cleanText(post.image_path);
  if (!value) throw new Error(`Post #${post.id} has no image_path.`);
  return {
    relative: value,
    absolute: path.isAbsolute(value) ? value : path.resolve(value),
  };
}

async function assertFileExists(filePath, label) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile() || stat.size <= 1024) {
    throw new Error(`${label} missing or too small: ${filePath}`);
  }
}

async function writePostsExport(db, runId) {
  const posts = db.exportPosts(runId);
  await fs.writeFile(pipelineConfig.files.postsQueue, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
}

function extractText(response) {
  return (response.content || [])
    .map(block => block?.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractContentPayload(response) {
  const toolUse = (response.content || []).find(block =>
    block?.type === 'tool_use' && block.name === CONTENT_TOOL.name
  );
  if (toolUse?.input && typeof toolUse.input === 'object') {
    return toolUse.input;
  }
  return parseContentResponse(extractText(response));
}

function parseContentResponse(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const value = JSON.parse(cleaned);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude response JSON is not an object');
    return value;
  } catch (directError) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw directError;
    const value = JSON.parse(match[0]);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Claude response JSON is not an object');
    return value;
  }
}

function hashtagsForNiche(nicheId) {
  const byNiche = {
    'fix-it': ['#FixIt', '#HomeRepair', '#DIY'],
    'cook-it': ['#CookIt', '#EasyMeals', '#KitchenTips'],
    'grow-it': ['#GrowIt', '#Gardening', '#PlantTips'],
    money: ['#MoneyTips', '#SaveMoney', '#SideHustle'],
    'get-fit': ['#GetFit', '#FitnessTips', '#HomeWorkout'],
    'make-it': ['#MakeIt', '#DIYProjects', '#CraftIdeas'],
    'tech-it': ['#TechIt', '#AITools', '#Productivity'],
    'look-good': ['#LookGood', '#StyleTips', '#Skincare'],
  };
  return byNiche[nicheId] || ['#HowTo', '#Tips'];
}

function normalizeHashtag(value) {
  const text = cleanText(value).replace(/^#+/, '');
  const compact = text.replace(/[^a-z0-9_]+/gi, '');
  return compact ? `#${compact}` : '';
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
  return normalizeReadableText(value).replace(/\s+/g, ' ').trim();
}

function normalizeReadableText(value) {
  return String(value || '')
    .replace(/\u00E2\u20AC\u2122/g, "'")
    .replace(/\u00E2\u20AC\u02DC/g, "'")
    .replace(/\u00E2\u20AC\u0153/g, '"')
    .replace(/\u00E2\u20AC\u009D/g, '"')
    .replace(/\u00E2\u20AC\u201D/g, '-')
    .replace(/\u00E2\u20AC\u201C/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[\u{1F000}-\u{1FAFF}]/gu, '');
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function unique(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = String(value || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms || 0)));
}

function isoNow() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`How-to useful content generation

Usage:
  npm.cmd run content -- --dry-run --id 91
  npm.cmd run content -- --generate --id 91
  npm.cmd run content -- --generate --niche fix-it --rank 1

Options:
  --run-id latest
  --id 91
  --niche fix-it
  --rank 1
  --limit 1
  --status image_done
  --allow-status-override
  --model claude-sonnet-4-6
  --manifest content_manifest.json

Flow:
  image_done -> content_generating -> content_done -> qa_generating -> qa_done

The generated caption must pass the scheduling quality guard: useful length, tools/materials,
3+ numbered actionable steps, and a safety/caution/pro note.
`);
}
