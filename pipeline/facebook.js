import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { pipelineConfig } from './config.js';
import { openPipelineDb } from './db.js';
import { validateCaptionForScheduling } from './content-quality.js';
import { duplicateMessage, findDuplicatePost } from './dedup.js';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pipelineDir);
const require = createRequire(import.meta.url);
const { SocialFacebookUploader } = require('../src/main/social/social-facebook-uploader');

const rawArgs = process.argv.slice(2);
if (hasFlag(rawArgs, '--help') || hasFlag(rawArgs, '-h')) {
  printHelp();
  process.exit(0);
}

const mode = resolveMode(rawArgs);
if (!mode) {
  console.error('Choose --dry-run, --prepare, --schedule-dry-run, or --live. Use --help for examples.');
  process.exit(1);
}

const userDataDir = resolveUserDataDir(rawArgs);
const headless = hasFlag(rawArgs, '--headless');
const loginWaitMs = parseLoginWaitMs(rawArgs) ?? pipelineConfig.facebook.loginWaitMs ?? pipelineConfig.browser.loginWaitMs ?? 0;

const db = await openPipelineDb({
  config: pipelineConfig,
  logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
});

try {
  const runId = resolveRunId(db, parseArgValue(rawArgs, '--run-id') || parseArgValue(rawArgs, '--run') || 'latest');
  if (!runId) throw new Error('No run found in how-to content DB.');

  if (mode === 'context') {
    const result = await runContextDryRun({ db, runId, userDataDir, headless, loginWaitMs });
    if (result.hadFailure) process.exitCode = 1;
  } else if (mode === 'prepare') {
    const result = await prepareFacebookPosts({ db, runId, argv: rawArgs });
    console.log(`Prepared scheduling slot(s) for ${result.prepared} Facebook post(s).`);
    for (const post of result.posts) {
      console.log(`#${post.id} ${post.facebook_page_name} ${post.scheduled_date} ${post.scheduled_time}: ${post.caption.split('\n')[0]}`);
    }
  } else if (mode === 'schedule-dry-run') {
    const result = await runScheduleDryRun({ db, runId, argv: rawArgs });
    console.log(`Facebook schedule dry-run prepared for ${result.items.length} post(s).`);
    for (const item of result.items) {
      console.log(`#${item.post_id} ${item.target_page_name} ${item.scheduled_date} ${item.scheduled_time}: ${item.image_path}`);
    }
  } else if (mode === 'live') {
    const result = await runLiveSchedule({ db, runId, argv: rawArgs, userDataDir, headless, loginWaitMs });
    if (result.deferred) {
      console.log(`Facebook post deferred: ${result.error}`);
    } else if (result.success) {
      console.log(`Facebook post scheduled for post #${result.post_id}: ${result.scheduled_date} ${result.scheduled_time}`);
    } else {
      console.log(`Facebook post failed for post #${result.post_id}: ${result.error}`);
      process.exitCode = 1;
    }
  }
} finally {
  db.close();
}

async function runContextDryRun({ db, runId, userDataDir, headless, loginWaitMs }) {
  const targets = resolveTargets(rawArgs);
  if (targets.length === 0) {
    throw new Error('Select a page with --page "Fix It", --niche fix-it, or --all-pages.');
  }

  let context = null;
  let page = null;
  let hadFailure = false;
  const checkIds = [];
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: pipelineConfig.browser.viewport,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(10000);

    await ensureLoggedIn(page, { loginWaitMs });

    for (const target of targets) {
      const checkId = startContextCheck(db, runId, target);
      checkIds.push(checkId);
      try {
        console.log(`Checking Facebook page context: ${target.pageName}`);
        const result = await verifyPageContext(page, target, checkId);
        finishContextCheck(db, checkId, {
          status: 'verified',
          activeProfileName: result.active_profile_name,
          dashboardUrl: result.dashboard_url,
          contentLibraryUrl: result.content_library_url,
          screenshotPath: result.screenshot_path,
          diagnostics: result.diagnostics,
        });
        db.logEvent(runId, 'facebook_context_verified', {
          stage: 'facebook',
          nicheId: target.nicheId,
          message: `Verified Facebook page context for ${target.pageName}`,
          data: { checkId, pageName: target.pageName, screenshotPath: result.screenshot_path },
        });
        console.log(`Verified: ${target.pageName}`);
      } catch (error) {
        hadFailure = true;
        const diagnostics = await collectDiagnostics(page, target, { error });
        const screenshotPath = await captureContextScreenshot(page, checkId, target, 'failed').catch(() => null);
        finishContextCheck(db, checkId, {
          status: 'failed',
          activeProfileName: diagnostics.active_profile_name || null,
          dashboardUrl: diagnostics.dashboard_url || page.url(),
          contentLibraryUrl: diagnostics.content_library_url || null,
          screenshotPath,
          errorMessage: error?.message || String(error),
          diagnostics,
        });
        db.logEvent(runId, 'facebook_context_failed', {
          stage: 'facebook',
          nicheId: target.nicheId,
          message: error?.message || String(error),
          data: { checkId, pageName: target.pageName, screenshotPath },
        });
        console.warn(`Failed: ${target.pageName} - ${error?.message || error}`);
      }
    }

    await writeContextReport(db, checkIds);
    console.log(`Facebook context report written: ${pipelineConfig.files.facebookContextReport}`);
    return { hadFailure, checkIds };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function prepareFacebookPosts({ db, runId, argv }) {
  const posts = selectFacebookPosts(db, runId, argv, { defaultStatus: 'qa_done' });
  if (posts.length === 0) throw new Error('No qa_done posts selected for Facebook preparation. Run: npm.cmd run qa -- --run --id <post_id>');
  guardBulkSelection(posts, argv, 'prepare');
  const slot = resolveScheduleSlot(argv);
  const allowThinCaption = hasFlag(argv, '--allow-thin-caption');
  const allowDuplicate = hasFlag(argv, '--allow-duplicate');
  const allowQaOverride = hasFlag(argv, '--allow-qa-override');
  db.backup(`pre-facebook-prepare-${runId}`);
  const prepared = [];
  const now = isoNow();
  for (const post of posts) {
    const imagePath = resolveImagePath(post);
    await assertFileExists(imagePath.absolute, `Generated image for post #${post.id}`);
    const caption = cleanTextBlock(post.caption);
    assertCaptionQuality(post, caption, { allowThinCaption });
    assertQualityGatePassed(db, post, { allowQaOverride });
    assertNotAlreadyScheduledDuplicate(db, post, { allowDuplicate });
    db.run(
      `UPDATE posts
       SET status = 'qa_done', caption = ?, scheduled_date = ?, scheduled_time = ?,
           error_message = NULL, updated_at = ?
       WHERE id = ?`,
      [caption, slot.date, slot.time, now, post.id]
    );
    db.logEvent(runId, 'facebook_post_prepared', {
      stage: 'facebook',
      nicheId: post.niche_id,
      message: `Prepared Facebook post ${post.id}`,
      data: { postId: post.id, scheduledDate: slot.date, scheduledTime: slot.time, imagePath: imagePath.relative },
    });
    prepared.push({ ...post, caption, scheduled_date: slot.date, scheduled_time: slot.time, image_path: imagePath.relative });
  }
  db.save();
  await writePostsExport(db, runId);
  return { prepared: prepared.length, posts: prepared };
}

async function runScheduleDryRun({ db, runId, argv }) {
  const posts = selectFacebookPosts(db, runId, argv, { defaultStatus: 'qa_done' });
  if (posts.length === 0) throw new Error('No qa_done posts selected for Facebook schedule dry-run.');
  guardBulkSelection(posts, argv, 'schedule-dry-run');
  const allowThinCaption = hasFlag(argv, '--allow-thin-caption');
  const allowDuplicate = hasFlag(argv, '--allow-duplicate');
  const items = [];
  db.backup(`pre-facebook-schedule-dry-run-${runId}`);
  const now = isoNow();
  for (const post of posts) {
    const payload = await buildSchedulePayload(db, post, {
      requireVerifiedContext: true,
      allowThinCaption,
      allowDuplicate,
      allowQaOverride: hasFlag(argv, '--allow-qa-override'),
    });
    upsertScheduleJob(db, {
      runId,
      post,
      payload,
      status: 'dry_run',
      dryRun: true,
      contextCheckId: payload.context_check_id,
      now,
    });
    db.logEvent(runId, 'facebook_schedule_dry_run_prepared', {
      stage: 'facebook',
      nicheId: post.niche_id,
      message: `Prepared Facebook schedule dry-run for post ${post.id}`,
      data: { postId: post.id, scheduledDate: payload.scheduled_date, scheduledTime: payload.scheduled_time },
    });
    items.push({
      post_id: post.id,
      target_page_name: post.facebook_page_name,
      scheduled_date: payload.scheduled_date,
      scheduled_time: payload.scheduled_time,
      caption: payload.caption,
      image_path: payload.image_path,
      context_check_id: payload.context_check_id,
    });
  }
  db.save();
  return { items };
}

async function runLiveSchedule({ db, runId, argv, userDataDir, headless, loginWaitMs }) {
  const posts = selectFacebookPosts(db, runId, argv, { defaultStatus: 'qa_done' });
  if (posts.length !== 1) {
    throw new Error(`Live Facebook scheduling requires exactly one qa_done post. Selected ${posts.length}. Use --limit 1, --id, or --niche plus --rank.`);
  }
  if (!parseArgValue(argv, '--id') && !(parseArgValue(argv, '--niche') && parseArgValue(argv, '--rank')) && readInteger(parseArgValue(argv, '--limit'), 0) !== 1) {
    throw new Error('Live Facebook scheduling requires --limit 1 or an exact --id/--niche --rank selector.');
  }

  const post = posts[0];
  const target = nicheToTarget({
    id: post.niche_id,
    name: post.niche_name,
    facebook_page_name: post.facebook_page_name,
  });
  let context = null;
  let page = null;
  const startedAt = isoNow();
  let scheduleAttemptStarted = false;
  db.backup(`pre-facebook-live-${runId}`);

  try {
    const payload = await buildSchedulePayload(db, post, {
      requireVerifiedContext: true,
      allowThinCaption: hasFlag(argv, '--allow-thin-caption'),
      allowDuplicate: hasFlag(argv, '--allow-duplicate'),
      allowQaOverride: hasFlag(argv, '--allow-qa-override'),
    });
    upsertScheduleJob(db, {
      runId,
      post,
      payload,
      status: 'running',
      dryRun: false,
      contextCheckId: payload.context_check_id,
      now: startedAt,
    });
    db.run(
      `UPDATE posts
       SET status = 'scheduling', error_message = NULL, updated_at = ?
       WHERE id = ?`,
      [startedAt, post.id]
    );
    db.save();

    context = await chromium.launchPersistentContext(userDataDir, {
      headless,
      viewport: pipelineConfig.browser.viewport,
      args: ['--disable-blink-features=AutomationControlled'],
    });
    page = context.pages()[0] || await context.newPage();
    page.setDefaultTimeout(15000);
    await ensureLoggedIn(page, { loginWaitMs });

    const checkId = startContextCheck(db, runId, target);
    console.log(`Verifying Facebook page context before live schedule: ${target.pageName}`);
    const contextProof = await verifyPageContext(page, target, checkId);
    finishContextCheck(db, checkId, {
      status: 'verified',
      activeProfileName: contextProof.active_profile_name,
      dashboardUrl: contextProof.dashboard_url,
      contentLibraryUrl: contextProof.content_library_url,
      screenshotPath: contextProof.screenshot_path,
      diagnostics: contextProof.diagnostics,
    });
    db.run(
      `UPDATE facebook_schedule_jobs
       SET context_check_id = ?, updated_at = ?
       WHERE run_id = ? AND post_id = ?`,
      [checkId, isoNow(), runId, post.id]
    );
    db.save();

    const uploader = new SocialFacebookUploader({
      userDataDir,
      headless,
      log: message => console.log(message),
      onStepComplete: step => {
        if (step === 'schedule_for_later') scheduleAttemptStarted = true;
        db.logEvent(runId, 'facebook_schedule_step', {
          stage: 'facebook',
          nicheId: post.niche_id,
          message: `Facebook schedule step complete: ${step}`,
          data: { postId: post.id, step },
        });
      },
    });
    uploader.context = context;
    uploader.page = page;

    const result = await uploader.scheduleImagePost({
      mediaPath: payload.absolute_image_path,
      caption: payload.caption,
      scheduledDate: payload.scheduled_date,
      scheduledTime: payload.scheduled_time,
    });
    const completedAt = isoNow();
    if (result.success) {
      db.run(
        `UPDATE facebook_schedule_jobs
         SET status = 'done', facebook_post_id = ?, error_message = NULL, completed_at = ?, updated_at = ?
         WHERE run_id = ? AND post_id = ?`,
        [result.facebookPostId || null, completedAt, completedAt, runId, post.id]
      );
      db.run(
        `UPDATE posts
         SET status = 'scheduled', facebook_post_id = ?, scheduled_at = ?, error_message = NULL, updated_at = ?
         WHERE id = ?`,
        [result.facebookPostId || null, completedAt, completedAt, post.id]
      );
      db.logEvent(runId, 'facebook_scheduled', {
        stage: 'facebook',
        nicheId: post.niche_id,
        message: `Scheduled Facebook post ${post.id}`,
        data: { postId: post.id, scheduledDate: payload.scheduled_date, scheduledTime: payload.scheduled_time },
      });
      db.save();
      await writePostsExport(db, runId);
      return { success: true, post_id: post.id, scheduled_date: payload.scheduled_date, scheduled_time: payload.scheduled_time };
    }

    const nextStatus = result.deferred || !scheduleAttemptStarted ? 'qa_done' : 'failed';
    db.run(
      `UPDATE facebook_schedule_jobs
       SET status = ?, error_message = ?, completed_at = ?, updated_at = ?
       WHERE run_id = ? AND post_id = ?`,
      [result.deferred ? 'deferred' : 'failed', result.error || null, completedAt, completedAt, runId, post.id]
    );
    db.run(
      `UPDATE posts
       SET status = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      [nextStatus, result.error || 'Facebook schedule failed', completedAt, post.id]
    );
    db.save();
    await writePostsExport(db, runId);
    return { success: false, deferred: !!result.deferred, post_id: post.id, error: result.error || 'Facebook schedule failed' };
  } catch (error) {
    const failedAt = isoNow();
    const message = error?.message || String(error);
    const postStatus = scheduleAttemptStarted ? 'failed' : 'qa_done';
    db.run(
      `UPDATE facebook_schedule_jobs
       SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
       WHERE run_id = ? AND post_id = ?`,
      [message, failedAt, failedAt, runId, post.id]
    );
    db.run(
      `UPDATE posts
       SET status = ?, error_message = ?, updated_at = ?
       WHERE id = ?`,
      [postStatus, message, failedAt, post.id]
    );
    db.logEvent(runId, 'facebook_schedule_failed', {
      stage: 'facebook',
      nicheId: post.niche_id,
      message,
      data: { postId: post.id },
    });
    db.save();
    await writePostsExport(db, runId);
    throw error;
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

async function buildSchedulePayload(db, post, {
  requireVerifiedContext = true,
  allowThinCaption = false,
  allowDuplicate = false,
  allowQaOverride = false,
} = {}) {
  const imagePath = resolveImagePath(post);
  await assertFileExists(imagePath.absolute, `Generated image for post #${post.id}`);
  const caption = cleanTextBlock(post.caption);
  if (!caption) throw new Error(`Post #${post.id} has no caption. Run: npm.cmd run content -- --generate --id ${post.id}`);
  assertCaptionQuality(post, caption, { allowThinCaption });
  assertQualityGatePassed(db, post, { allowQaOverride });
  assertNotAlreadyScheduledDuplicate(db, post, { allowDuplicate });
  const scheduledDate = cleanText(post.scheduled_date);
  const scheduledTime = cleanText(post.scheduled_time);
  if (!isDateOnly(scheduledDate)) throw new Error(`Post #${post.id} has no valid scheduled_date. Run --prepare --date YYYY-MM-DD --time HH:MM.`);
  if (!isTimeOnly(scheduledTime)) throw new Error(`Post #${post.id} has no valid scheduled_time. Run --prepare --date YYYY-MM-DD --time HH:MM.`);

  const contextCheck = requireVerifiedContext ? findRecentVerifiedContextCheck(db, post) : null;
  if (requireVerifiedContext && !contextCheck) {
    throw new Error(`No recent verified Facebook context check for ${post.facebook_page_name}. Run: npm.cmd run facebook -- --dry-run --page "${post.facebook_page_name}" --user-data-dir .browser-profile`);
  }

  return {
    post_id: post.id,
    target_page_name: post.facebook_page_name,
    caption,
    scheduled_date: scheduledDate,
    scheduled_time: scheduledTime,
    image_path: imagePath.relative,
    absolute_image_path: imagePath.absolute,
    context_check_id: contextCheck?.id || null,
  };
}

function findRecentVerifiedContextCheck(db, post) {
  const maxHours = Number(pipelineConfig.facebook.contextFreshHours || 24);
  const row = db.queryOne(
    `SELECT *
     FROM facebook_page_context_checks
     WHERE status = 'verified'
       AND target_page_name = ?
       AND (? IS NULL OR niche_id IS NULL OR niche_id = ?)
     ORDER BY COALESCE(completed_at, updated_at, started_at) DESC, id DESC
     LIMIT 1`,
    [post.facebook_page_name, post.niche_id || null, post.niche_id || null]
  );
  if (!row) return null;
  if (!Number.isFinite(maxHours) || maxHours <= 0) return row;
  const stamp = Date.parse(row.completed_at || row.updated_at || row.started_at || '');
  if (!Number.isFinite(stamp)) return null;
  const ageMs = Date.now() - stamp;
  if (ageMs < 0) return row;
  return ageMs <= maxHours * 60 * 60 * 1000 ? row : null;
}

function upsertScheduleJob(db, { runId, post, payload, status, dryRun, contextCheckId, now }) {
  const existing = db.queryOne(
    `SELECT id FROM facebook_schedule_jobs WHERE run_id = ? AND post_id = ?`,
    [runId, post.id]
  );
  const values = [
    post.niche_id,
    post.facebook_page_name,
    status,
    dryRun ? 1 : 0,
    payload.image_path,
    payload.caption,
    payload.scheduled_date,
    payload.scheduled_time,
    contextCheckId || null,
    null,
    null,
    now,
    status === 'dry_run' ? now : null,
    now,
  ];
  if (existing) {
    db.run(
      `UPDATE facebook_schedule_jobs
       SET niche_id = ?, target_page_name = ?, status = ?, dry_run = ?, image_path = ?,
           caption = ?, scheduled_date = ?, scheduled_time = ?, context_check_id = ?,
           error_message = ?, screenshot_path = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [...values, existing.id]
    );
  } else {
    db.run(
      `INSERT INTO facebook_schedule_jobs
       (run_id, post_id, niche_id, target_page_name, status, dry_run, image_path,
        caption, scheduled_date, scheduled_time, context_check_id, error_message,
        screenshot_path, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [runId, post.id, ...values]
    );
  }
}

async function writePostsExport(db, runId) {
  const posts = db.exportPosts(runId);
  await fs.writeFile(pipelineConfig.files.postsQueue, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
}

function selectFacebookPosts(db, runId, argv, { defaultStatus }) {
  const status = parseArgValue(argv, '--status') || defaultStatus;
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
    throw new Error(`${label} selected ${posts.length} posts. Re-run with --yes to confirm bulk update.`);
  }
}

function resolveScheduleSlot(argv) {
  const date = parseArgValue(argv, '--date') || parseArgValue(argv, '--scheduled-date');
  const time = parseArgValue(argv, '--time') || parseArgValue(argv, '--scheduled-time') || pipelineConfig.facebook.defaultScheduleTime || '15:00';
  if (date && time) {
    if (!isDateOnly(date)) throw new Error('--date must use YYYY-MM-DD.');
    if (!isTimeOnly(time)) throw new Error('--time must use HH:MM in 24-hour time.');
    return { date, time };
  }
  if (hasFlag(argv, '--next-slot')) {
    const leadDays = Number(pipelineConfig.facebook.defaultScheduleLeadDays || 1);
    return { date: formatDateOnly(addDays(new Date(), leadDays)), time };
  }
  throw new Error('Provide --date YYYY-MM-DD --time HH:MM, or use --next-slot for the default next slot.');
}

function assertCaptionQuality(post, caption, { allowThinCaption = false } = {}) {
  if (allowThinCaption) return;
  const validation = validateCaptionForScheduling(caption, { config: pipelineConfig });
  if (!validation.ok) {
    throw new Error(`Post #${post.id} caption failed quality guard: ${validation.reasons.join('; ')}. Run: npm.cmd run content -- --generate --id ${post.id}`);
  }
}

function assertQualityGatePassed(db, post, { allowQaOverride = false } = {}) {
  if (allowQaOverride) return;
  const imagePath = cleanText(post.image_path);
  const captionHash = hashCaption(post.caption);
  const row = db.queryOne(
    `SELECT id, status, verdict, score, image_path, caption_hash, reasons_json, completed_at, updated_at
     FROM post_quality_checks
     WHERE run_id = ? AND post_id = ?
     ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
     LIMIT 1`,
    [post.run_id, post.id]
  );
  if (!row) {
    throw new Error(`Post #${post.id} has no post/image QA pass. Run: npm.cmd run qa -- --run --id ${post.id}`);
  }
  if (row.status !== 'passed' || row.verdict !== 'pass') {
    const reasons = parseJson(row.reasons_json, []).join('; ');
    throw new Error(`Post #${post.id} failed QA gate: latest QA is ${row.status}/${row.verdict || 'unknown'}${reasons ? ` (${reasons})` : ''}. Run: npm.cmd run qa -- --run --id ${post.id}`);
  }
  if (cleanText(row.image_path) !== imagePath) {
    throw new Error(`Post #${post.id} QA gate is stale: image path changed after QA. Run: npm.cmd run qa -- --run --id ${post.id}`);
  }
  if (cleanText(row.caption_hash) !== captionHash) {
    throw new Error(`Post #${post.id} QA gate is stale: caption changed after QA. Run: npm.cmd run qa -- --run --id ${post.id}`);
  }
}

function assertNotAlreadyScheduledDuplicate(db, post, { allowDuplicate = false } = {}) {
  if (allowDuplicate) return;
  const result = findDuplicatePost(db, post, {
    excludePostId: post.id,
    statuses: pipelineConfig.dedup?.hardStatuses || ['scheduled', 'published'],
    softThreshold: pipelineConfig.dedup?.hardSimilarityThreshold || 0.78,
  });
  if (result.duplicate) {
    throw new Error(`Post #${post.id} failed duplicate guard: ${duplicateMessage(result)}. Use --allow-duplicate only for a deliberate manual repeat.`);
  }
}

function hashCaption(value) {
  return crypto.createHash('sha256').update(cleanTextBlock(value || ''), 'utf8').digest('hex');
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

function resolveMode(argv) {
  const flags = [
    hasFlag(argv, '--dry-run') ? 'context' : null,
    hasFlag(argv, '--prepare') ? 'prepare' : null,
    hasFlag(argv, '--schedule-dry-run') ? 'schedule-dry-run' : null,
    hasFlag(argv, '--live') ? 'live' : null,
  ].filter(Boolean);
  if (flags.length > 1) throw new Error(`Choose one Facebook mode, not: ${flags.join(', ')}`);
  return flags[0] || null;
}

async function verifyPageContext(page, target, checkId) {
  await page.goto(pipelineConfig.facebook.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(pipelineConfig.facebook.settleMs);
  await dismissPopups(page);

  const beforeSwitch = await readContextProof(page, target);
  let switchProof = beforeSwitch;
  const switchSteps = [];
  if (!beforeSwitch.verified) {
    await openAccountMenu(page);
    switchSteps.push('account-menu-opened');
    const clickedDirect = await clickProfileTargetFromOpenMenu(page, target);
    if (clickedDirect) {
      switchSteps.push('target-clicked-from-account-menu');
    } else {
      await clickSeeAllProfiles(page);
      switchSteps.push('see-all-profiles-clicked');
      await clickProfileTargetFromProfilesPanel(page, target);
      switchSteps.push('target-clicked-from-profiles-panel');
    }
    switchProof = await waitForSwitchProof(page, target);
    switchSteps.push('switch-proof-found');
  } else {
    switchSteps.push('already-in-target-context');
  }

  await dismissPopups(page);
  const dashboardClicked = await clickProfessionalDashboardIfVisible(page);
  if (dashboardClicked) {
    await page.waitForTimeout(pipelineConfig.facebook.settleMs);
  }

  await page.goto(pipelineConfig.facebook.contentLibraryUrl, {
    waitUntil: 'domcontentloaded',
    timeout: pipelineConfig.facebook.dashboardTimeoutMs,
  });
  await waitForContentLibrary(page);
  await dismissPopups(page);

  const afterNavigation = await readContentLibraryProof(page, target);
  const menuProof = await inspectAccountMenu(page, target);
  const screenshotPath = await captureContextScreenshot(page, checkId, target, 'verified');
  const menuActive = isTargetAlias(menuProof.active_profile_name, target);
  const verified = switchProof.verified && afterNavigation.content_library_ready && menuActive;
  if (!verified) {
    throw new Error(`Context proof incomplete for ${target.pageName}: active account menu profile is "${menuProof.active_profile_name || 'unknown'}"`);
  }

  return {
    active_profile_name: menuProof.active_profile_name || switchProof.active_profile_name || target.pageName,
    dashboard_url: page.url(),
    content_library_url: page.url(),
    screenshot_path: screenshotPath,
    diagnostics: {
      dry_run: true,
      target,
      user_data_dir: path.relative(pipelineDir, userDataDir),
      switch_steps: switchSteps,
      dashboard_clicked: dashboardClicked,
      switch_proof: switchProof,
      content_library_proof: afterNavigation,
      account_menu_proof: menuProof,
      hard_gate: {
        switch_verified: switchProof.verified,
        content_library_ready: afterNavigation.content_library_ready,
        account_menu_active_target: menuActive,
      },
    },
  };
}

async function ensureLoggedIn(page, { loginWaitMs }) {
  await page.goto(pipelineConfig.facebook.homeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await dismissPopups(page);
  if (await isLoggedIn(page)) return;
  if (!loginWaitMs) throw new Error('Facebook login not detected. Re-run with --login-wait-sec 120 and log in manually.');

  console.log(`Waiting ${Math.round(loginWaitMs / 1000)}s for Facebook login...`);
  const deadline = Date.now() + loginWaitMs;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) return;
    await page.waitForTimeout(3000);
    await dismissPopups(page);
  }
  throw new Error('Timed out waiting for Facebook login.');
}

async function isLoggedIn(page) {
  return page.evaluate(() => {
    const url = location.href;
    if (/\/login|login_attempt/i.test(url)) return false;
    const selectors = [
      '[aria-label="Account"]',
      '[aria-label="Your profile"]',
      '[aria-label="Notifications"]',
      '[aria-label="Messenger"]',
      '[role="banner"] [role="navigation"]',
    ];
    if (selectors.some(selector => document.querySelector(selector))) return true;
    const text = document.body.innerText || '';
    return /What's on your mind|Professional dashboard|Create story|Meta Business Suite/i.test(text);
  }).catch(() => false);
}

async function openAccountMenu(page) {
  const selectors = [
    '[aria-label="Account"]',
    '[aria-label="Your profile"]',
    'div[role="button"][aria-label*="Account" i]',
    'div[role="button"][aria-label*="profile" i]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await locator.click({ timeout: 10000 });
        await page.waitForTimeout(1200);
        if (await hasAccountMenuText(page)) return;
      }
    }
  }

  const clicked = await page.evaluate(() => {
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 10 && rect.height > 10 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const candidates = [...document.querySelectorAll('[role="button"], [aria-label]')]
      .filter(visible)
      .map(element => ({ element, rect: element.getBoundingClientRect(), label: element.getAttribute('aria-label') || '' }))
      .filter(item => item.rect.top < 140 && item.rect.left > window.innerWidth * 0.75)
      .sort((a, b) => b.rect.left - a.rect.left);
    const explicit = candidates.find(item => /account|profile/i.test(item.label));
    const target = explicit || candidates[0];
    if (!target) return false;
    target.element.click();
    return true;
  });
  if (clicked) {
    await page.waitForTimeout(1200);
    if (await hasAccountMenuText(page)) return;
  }
  throw new Error('Could not open Facebook account menu.');
}

async function hasAccountMenuText(page) {
  const text = await bodyText(page);
  return /See all profiles|Your profiles|Meta Business Suite|Settings & privacy|Log out/i.test(text);
}

async function clickProfileTargetFromOpenMenu(page, target) {
  return clickVisibleText(page, target.aliases.map(alias => alias.source), {
    rightSideOnly: true,
    excludeTexts: [/See all profiles/i, /Settings & privacy/i, /Meta Business Suite/i],
  });
}

async function clickSeeAllProfiles(page) {
  const clicked = await clickVisibleText(page, [/^See all profiles$/i, /See all profiles/i], { rightSideOnly: false });
  if (!clicked) throw new Error('Could not click "See all profiles".');
  await page.waitForTimeout(1500);
  await page.waitForFunction(() => {
    const text = document.body.innerText || '';
    return /Your profiles\s*&\s*Pages|Search profiles and Pages|Search profiles/i.test(text);
  }, { timeout: 15000 }).catch(() => {});
}

async function clickProfileTargetFromProfilesPanel(page, target) {
  let clicked = await clickVisibleText(page, target.aliases.map(alias => alias.source), {
    centerPanelOnly: true,
    excludeTexts: [/notifications/i, /Search profiles/i],
  });
  if (clicked) return;

  const search = page.locator('input[placeholder*="Search profiles" i], input[placeholder*="Search profiles and Pages" i], input[aria-label*="Search profiles" i]').first();
  if (await search.count().catch(() => 0)) {
    const box = await search.boundingBox().catch(() => null);
    if (box) {
      await search.click({ timeout: 5000 });
      await page.keyboard.press('Control+A');
      await page.keyboard.type(target.pageName, { delay: 25 });
      await page.waitForTimeout(800);
    }
  }
  clicked = await clickVisibleText(page, target.aliases.map(alias => alias.source), {
    centerPanelOnly: true,
    excludeTexts: [/notifications/i, /Search profiles/i],
  });
  if (!clicked) {
    clicked = await scrollProfilesPanelAndClick(page, target);
  }
  if (!clicked) throw new Error(`Could not click target page "${target.pageName}" in profiles panel.`);
}

async function scrollProfilesPanelAndClick(page, target) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const clicked = await clickVisibleText(page, target.aliases.map(alias => alias.source), {
      centerPanelOnly: true,
      excludeTexts: [/notifications/i, /Search profiles/i],
    });
    if (clicked) return true;
    await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], div')]
        .map(element => ({ element, rect: element.getBoundingClientRect(), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))
        .filter(item => item.rect.width > 300 && item.rect.height > 300 && item.scrollHeight > item.clientHeight)
        .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
      const target = dialogs[0]?.element || document.scrollingElement || document.body;
      target.scrollBy(0, 420);
    }).catch(() => {});
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForSwitchProof(page, target) {
  const deadline = Date.now() + pipelineConfig.facebook.pageSwitchTimeoutMs;
  let lastProof = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1200);
    lastProof = await readContextProof(page, target);
    if (lastProof.verified) return lastProof;
  }
  throw new Error(`Timed out waiting for Facebook to switch to ${target.pageName}. Last proof: ${JSON.stringify(lastProof)}`);
}

async function readContextProof(page, target) {
  const aliases = target.aliases.map(alias => alias.source);
  return page.evaluate(aliasValues => {
    const text = document.body.innerText || '';
    const lowerText = text.toLowerCase();
    const matchedAliases = aliasValues.filter(alias => lowerText.includes(alias.toLowerCase()));
    const switchToast = aliasValues.find(alias => new RegExp(`switched to\\s+${escapeRegExp(alias)}`, 'i').test(text));
    const composer = aliasValues.find(alias => new RegExp(`what'?s on your mind,\\s*${escapeRegExp(alias)}\\??`, 'i').test(text));
    const leftNavIdentity = findLeftNavIdentity(aliasValues);
    const activeProfileName = switchToast || composer || leftNavIdentity || null;
    return {
      verified: Boolean(switchToast || composer || leftNavIdentity),
      active_profile_name: activeProfileName,
      signals: {
        switch_toast: switchToast || null,
        composer_placeholder: composer || null,
        left_nav_identity: leftNavIdentity || null,
        matched_aliases: matchedAliases,
      },
      url: location.href,
      title: document.title,
      body_sample: compactText(text).slice(0, 1200),
    };

    function escapeRegExp(value) {
      return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    function compactText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }
    function findLeftNavIdentity(aliases) {
      const visible = element => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 4 && rect.height > 4 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const aliasSet = new Set(aliases.map(norm));
      const nodes = [...document.querySelectorAll('a, [role="link"], [role="button"], span, div')]
        .filter(visible)
        .map(element => ({ element, rect: element.getBoundingClientRect(), text: String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim() }))
        .filter(item => item.rect.left < 240 && item.rect.top > 80 && item.rect.top < 260)
        .filter(item => aliasSet.has(norm(item.text)));
      nodes.sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
      return nodes[0]?.text || null;
    }
  }, aliases).catch(error => ({
    verified: false,
    active_profile_name: null,
    signals: { error: error.message },
    url: page.url(),
  }));
}

async function clickProfessionalDashboardIfVisible(page) {
  return clickVisibleText(page, [/^Professional dashboard$/i, /Professional dashboard/i], {
    leftSideOnly: true,
  });
}

async function waitForContentLibrary(page) {
  await page.waitForFunction(() => {
    const text = document.body.innerText || '';
    return /professional_dashboard\/content\/content_library/.test(location.href) &&
      /Content Library|Published\s+Scheduled\s+Drafts|Search for posts|Create/i.test(text);
  }, { timeout: pipelineConfig.facebook.dashboardTimeoutMs });
}

async function readContentLibraryProof(page, target) {
  const aliases = target.aliases.map(alias => alias.source);
  return page.evaluate(aliasValues => {
    const text = document.body.innerText || '';
    const lowerText = text.toLowerCase();
    return {
      content_library_ready: /professional_dashboard\/content\/content_library/.test(location.href) &&
        /Content Library|Published\s+Scheduled\s+Drafts|Search for posts|Create/i.test(text),
      target_text_present: aliasValues.some(alias => lowerText.includes(alias.toLowerCase())),
      url: location.href,
      title: document.title,
      body_sample: text.replace(/\s+/g, ' ').trim().slice(0, 1200),
    };
  }, aliases).catch(error => ({
    content_library_ready: false,
    target_text_present: false,
    url: page.url(),
    error: error.message,
  }));
}

async function inspectAccountMenu(page, target) {
  try {
    await openAccountMenu(page);
    await page.waitForTimeout(800);
    const proof = await page.evaluate(aliasValues => {
      const text = document.body.innerText || '';
      const norm = value => String(value || '').replace(/\s+/g, ' ').trim();
      const panelCandidates = [...document.querySelectorAll('[role="dialog"], div')]
        .map(element => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return { element, rect, text: norm(element.innerText || element.textContent || ''), style };
        })
        .filter(item => item.rect.width > 260 && item.rect.height > 180)
        .filter(item => item.rect.left > window.innerWidth * 0.45 && item.rect.top < 180)
        .filter(item => item.style.visibility !== 'hidden' && item.style.display !== 'none')
        .filter(item => /See all profiles|Meta Business Suite|Settings & privacy|Log out/i.test(item.text))
        .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
      const panelText = panelCandidates[0]?.text || text;
      const lines = panelText.split(/\n+/).map(line => norm(line)).filter(Boolean);
      const stopIndex = lines.findIndex(line => /^(See all profiles|Meta Business Suite|Settings & privacy|Help & support|Report a problem|Display & accessibility|Log out)\b/i.test(line));
      const topLines = (stopIndex >= 0 ? lines.slice(0, stopIndex) : lines.slice(0, 8))
        .filter(line => !/^\d+\s+notifications?$/i.test(line))
        .filter(line => !/^Switched to\b/i.test(line))
        .filter(line => !/^You're now acting as\b/i.test(line));
      const activeLine = topLines[0] || null;
      const activeMatchesTarget = aliasValues.some(alias => sameName(activeLine, alias));
      return {
        active_profile_name: activeLine,
        active_matches_target: activeMatchesTarget,
        target_in_menu: aliasValues.some(alias => text.toLowerCase().includes(alias.toLowerCase())),
        top_lines: topLines.slice(0, 5),
        menu_sample: panelText.replace(/\s+/g, ' ').trim().slice(0, 1000),
      };

      function sameName(a, b) {
        const clean = value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const left = clean(a);
        const right = clean(b);
        return !!left && !!right && (left === right || left.startsWith(`${right} `));
      }
    }, target.aliases.map(alias => alias.source));
    await page.keyboard.press('Escape').catch(() => {});
    return proof;
  } catch (error) {
    await page.keyboard.press('Escape').catch(() => {});
    return { active_profile_name: null, target_in_menu: false, error: error.message };
  }
}

async function dismissPopups(page) {
  const selectors = [
    'button[data-cookiebanner="accept_button"]',
    '[data-testid="cookie-policy-manage-dialog-accept-button"]',
    '[aria-label="Dismiss"]',
    '[aria-label="Close"]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      const box = await locator.boundingBox().catch(() => null);
      if (box) {
        await locator.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
  }
  const popupTextButtons = [/^Not now$/i, /^Turn off$/i, /^Maybe later$/i, /^Accept all$/i];
  for (const pattern of popupTextButtons) {
    await clickVisibleText(page, [pattern], { dialogOnly: true }).catch(() => false);
  }
}

async function clickVisibleText(page, patterns, options = {}) {
  const specs = patterns.map(pattern => ({
    source: pattern instanceof RegExp ? pattern.source : String(pattern),
    flags: pattern instanceof RegExp ? pattern.flags : 'i',
    exact: !(pattern instanceof RegExp),
  }));
  return page.evaluate(({ specs, options }) => {
    const compiled = specs.map(spec => ({
      ...spec,
      regex: spec.exact ? null : new RegExp(spec.source, spec.flags),
    }));
    const excluded = (options.excludeTexts || []).map(source => new RegExp(source.source || source, source.flags || 'i'));
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 4 && rect.height > 4 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const textMatches = text => {
      const compact = String(text || '').replace(/\s+/g, ' ').trim();
      if (!compact) return false;
      if (excluded.some(regex => regex.test(compact))) return false;
      return compiled.some(spec => spec.exact
        ? compact === spec.source || compact.split(/\n/).some(line => line.trim() === spec.source)
        : spec.regex.test(compact));
    };
    const nodes = [...document.querySelectorAll('a, [role="button"], [role="option"], [role="menuitem"], button, div, span')]
      .filter(visible)
      .map(element => ({ element, rect: element.getBoundingClientRect(), text: element.innerText || element.textContent || '' }))
      .filter(item => textMatches(item.text));
    const filtered = nodes.filter(item => {
      const { left, right, top } = item.rect;
      const midX = (left + right) / 2;
      if (options.rightSideOnly && midX < window.innerWidth * 0.55) return false;
      if (options.leftSideOnly && midX > window.innerWidth * 0.35) return false;
      if (options.centerPanelOnly && (midX < window.innerWidth * 0.2 || midX > window.innerWidth * 0.85 || top < 80)) return false;
      if (options.dialogOnly && !item.element.closest('[role="dialog"]')) return false;
      return true;
    });
    filtered.sort((a, b) => {
      const aClickable = a.element.matches('a, [role="button"], [role="option"], [role="menuitem"], button') ? 0 : 1;
      const bClickable = b.element.matches('a, [role="button"], [role="option"], [role="menuitem"], button') ? 0 : 1;
      if (aClickable !== bClickable) return aClickable - bClickable;
      return (a.text.length || 0) - (b.text.length || 0);
    });
    const chosen = filtered[0];
    if (!chosen) return false;
    const clickable = chosen.element.closest('a, [role="button"], [role="option"], [role="menuitem"], button') || chosen.element;
    clickable.click();
    return true;
  }, {
    specs,
    options: {
      ...options,
      excludeTexts: (options.excludeTexts || []).map(pattern => ({
        source: pattern instanceof RegExp ? pattern.source : String(pattern),
        flags: pattern instanceof RegExp ? pattern.flags : 'i',
      })),
    },
  }).catch(() => false);
}

async function collectDiagnostics(page, target, { error } = {}) {
  const contextProof = await readContextProof(page, target);
  const contentProof = await readContentLibraryProof(page, target);
  return {
    dry_run: true,
    target,
    error_message: error?.message || String(error || ''),
    current_url: page.url(),
    context_proof: contextProof,
    content_library_proof: contentProof,
  };
}

async function captureContextScreenshot(page, checkId, target, status) {
  const dir = path.resolve(pipelineConfig.files.facebookDiagnosticsDir);
  await fs.mkdir(dir, { recursive: true });
  const screenshotPath = path.join(dir, `${String(checkId).padStart(4, '0')}_${safeName(target.pageName)}_${status}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  return path.relative(pipelineDir, screenshotPath);
}

function startContextCheck(db, runId, target) {
  db.run(
    `INSERT INTO facebook_page_context_checks
     (run_id, niche_id, target_page_name, status, started_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
    [runId || null, target.nicheId || null, target.pageName, isoNow(), isoNow()]
  );
  const checkId = db.queryOne(`SELECT last_insert_rowid() AS id`)?.id;
  db.save();
  return checkId;
}

function finishContextCheck(db, checkId, fields) {
  db.run(
    `UPDATE facebook_page_context_checks
     SET status = ?, active_profile_name = ?, dashboard_url = ?, content_library_url = ?,
         screenshot_path = ?, error_message = ?, diagnostics_json = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      fields.status,
      fields.activeProfileName || null,
      fields.dashboardUrl || null,
      fields.contentLibraryUrl || null,
      fields.screenshotPath || null,
      fields.errorMessage || null,
      JSON.stringify(fields.diagnostics || {}),
      isoNow(),
      isoNow(),
      checkId,
    ]
  );
  db.save();
}

async function writeContextReport(db, checkIds) {
  if (!checkIds.length) return;
  const rows = db.queryAll(
    `SELECT * FROM facebook_page_context_checks
     WHERE id IN (${checkIds.map(() => '?').join(', ')})
     ORDER BY id ASC`,
    checkIds
  ).map(row => ({
    id: row.id,
    run_id: row.run_id,
    niche_id: row.niche_id,
    target_page_name: row.target_page_name,
    status: row.status,
    active_profile_name: row.active_profile_name,
    dashboard_url: row.dashboard_url,
    content_library_url: row.content_library_url,
    screenshot_path: row.screenshot_path,
    error_message: row.error_message,
    diagnostics: parseJson(row.diagnostics_json, {}),
    started_at: row.started_at,
    completed_at: row.completed_at,
  }));
  await fs.writeFile(pipelineConfig.files.facebookContextReport, `${JSON.stringify({
    generated_at: isoNow(),
    dry_run: true,
    checks: rows,
  }, null, 2)}\n`, 'utf8');
}

function resolveTargets(argv) {
  const allPages = hasFlag(argv, '--all-pages');
  const pageName = parseArgValue(argv, '--page');
  const nicheToken = parseArgValue(argv, '--niche');
  if (allPages) return pipelineConfig.niches.map(nicheToTarget);
  if (nicheToken) {
    const normalized = normalizeToken(nicheToken);
    const niche = pipelineConfig.niches.find(item => [
      item.id,
      item.name,
      item.facebook_page_name,
    ].map(normalizeToken).includes(normalized));
    if (!niche) throw new Error(`Unknown niche: ${nicheToken}`);
    return [nicheToTarget(niche)];
  }
  if (pageName) {
    return [{
      nicheId: null,
      nicheName: null,
      pageName,
      aliases: buildPageAliases({ facebook_page_name: pageName, name: pageName }),
    }];
  }
  return [];
}

function nicheToTarget(niche) {
  return {
    nicheId: niche.id,
    nicheName: niche.name,
    pageName: niche.facebook_page_name,
    aliases: buildPageAliases(niche),
  };
}

function buildPageAliases(niche) {
  const names = new Set([
    niche.facebook_page_name,
    niche.name,
    String(niche.name || '').replace(/^How to\s+/i, ''),
  ].filter(Boolean));
  if (/make money|money it/i.test(`${niche.facebook_page_name} ${niche.name}`)) {
    names.add('Money');
    names.add('Make Money');
    names.add('Money it');
  }
  return Array.from(names).map(source => ({ source }));
}

function resolveRunId(db, value = 'latest') {
  if (value && value !== 'latest') {
    const found = db.queryOne(`SELECT id FROM runs WHERE id = ?`, [value]);
    if (!found) throw new Error(`Run not found: ${value}`);
    return value;
  }
  return db.queryOne(
    `SELECT runs.id
     FROM runs
     JOIN posts ON posts.run_id = runs.id
     GROUP BY runs.id
     ORDER BY COALESCE(runs.completed_at, runs.updated_at, runs.started_at) DESC
     LIMIT 1`
  )?.id || null;
}

function resolveUserDataDir(argv) {
  const value = parseArgValue(argv, '--user-data-dir') || parseArgValue(argv, '--profile-dir') || pipelineConfig.browser.userDataDir || '.browser-profile';
  return path.isAbsolute(value) ? value : path.join(pipelineDir, value);
}

function parseLoginWaitMs(argv) {
  const msValue = parseArgValue(argv, '--login-wait-ms');
  if (msValue !== null) return readNonNegativeInteger(msValue, '--login-wait-ms');
  const secValue = parseArgValue(argv, '--login-wait-sec') || parseArgValue(argv, '--login-wait-seconds');
  if (secValue !== null) return readNonNegativeInteger(secValue, '--login-wait-sec') * 1000;
  return null;
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

function readNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.round(parsed);
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isTargetAlias(value, target) {
  const normalizeName = input => String(input || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const candidate = normalizeName(value);
  if (!candidate) return false;
  return target.aliases.some(alias => {
    const expected = normalizeName(alias.source);
    return expected && (candidate === expected || candidate.startsWith(`${expected} `));
  });
}

function isDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isTimeOnly(value) {
  if (!/^\d{1,2}:\d{2}$/.test(String(value || ''))) return false;
  const [hours, minutes] = String(value).split(':').map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function addDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDateOnly(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanTextBlock(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function bodyText(page) {
  return page.evaluate(() => document.body.innerText || document.body.textContent || '').catch(() => '');
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function safeName(value) {
  return String(value || 'page').replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'page';
}

function isoNow() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`How-to Facebook context and scheduling handoff

Usage:
  npm.cmd run facebook -- --dry-run --page "Fix It" --user-data-dir .browser-profile
  npm.cmd run facebook -- --dry-run --niche fix-it --user-data-dir .browser-profile
  npm.cmd run facebook -- --dry-run --all-pages --user-data-dir .browser-profile
  npm.cmd run content -- --generate --id 91
  npm.cmd run qa -- --run --id 91
  npm.cmd run facebook -- --prepare --id 91 --next-slot
  npm.cmd run facebook -- --prepare --id 91 --date 2026-06-30 --time 15:00
  npm.cmd run facebook -- --schedule-dry-run --id 91
  npm.cmd run facebook -- --live --id 91 --user-data-dir .browser-profile --login-wait-sec 180

Login:
  npm.cmd run facebook -- --dry-run --page "Fix It" --login-wait-sec 120

Notes:
  - --dry-run verifies account/page context only. It does not create, upload, post, or schedule.
  - --prepare writes local date/time only for qa_done posts with quality-passing captions.
  - --schedule-dry-run validates caption quality, passed post/image QA, image file, and recent page proof, then writes facebook_schedule_jobs.
  - --live is one-post gated and performs the real Facebook schedule action.
  - --allow-thin-caption bypasses the caption quality guard for deliberate automation tests only.
  - --allow-qa-override bypasses the post/image QA guard for deliberate manual tests only.
  - --allow-duplicate bypasses the duplicate-post guard for deliberate manual repeats only.
  - The context verifier records rows in facebook_page_context_checks, writes
    facebook_context_checks.json, and stores screenshots under facebook_context_diagnostics/.
`);
}
