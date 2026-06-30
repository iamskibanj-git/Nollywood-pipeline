import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipelineConfig } from './config.js';
import { openPipelineDb } from './db.js';
import {
  buildPostDedupFields,
  duplicateMessage,
  findDuplicatePost,
  similarity,
} from './dedup.js';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));

export async function buildWeeklyPlan({ db, runId, argv = [], config = pipelineConfig } = {}) {
  if (!db) throw new Error('buildWeeklyPlan requires db');
  if (!runId) throw new Error('buildWeeklyPlan requires runId');

  const settings = resolveSettings(argv, config);
  const niches = resolveNiches(argv, config);
  const slots = buildCalendarSlots(niches, settings, config);
  const existing = indexExistingCalendarPosts(db, runId, settings, niches);
  const occupiedSlots = indexOccupiedSlots(db, settings);
  const candidatePools = new Map();
  const candidateIndexes = new Map();
  const selected = [];
  const calendar = [];
  const skippedCandidates = [];
  const selectedPostIds = new Set();
  const perPageCounts = new Map(niches.map(niche => [niche.id, 0]));

  for (const slot of slots) {
    const existingPost = existing.byDayPage.get(dayPageKey(slot.niche_id, slot.scheduled_date));
    if (existingPost) {
      perPageCounts.set(slot.niche_id, (perPageCounts.get(slot.niche_id) || 0) + 1);
      calendar.push(formatExistingEntry(slot, existingPost));
      continue;
    }

    if ((perPageCounts.get(slot.niche_id) || 0) >= settings.postsPerPage) {
      calendar.push({
        ...slot,
        plan_status: 'not_requested',
        reason: `page target already reached (${settings.postsPerPage} post(s))`,
      });
      continue;
    }

    const conflict = occupiedSlots.get(slotKey(slot.scheduled_date, slot.scheduled_time));
    if (conflict) {
      calendar.push({
        ...slot,
        plan_status: 'blocked_slot_conflict',
        reason: `slot already occupied by post #${conflict.id} (${conflict.facebook_page_name || conflict.niche_id})`,
        conflict: formatExistingPost(conflict),
      });
      continue;
    }

    const candidate = selectNextCandidate({
      db,
      runId,
      slot,
      settings,
      config,
      candidatePools,
      candidateIndexes,
      selected,
      selectedPostIds,
      skippedCandidates,
    });

    if (!candidate) {
      calendar.push({
        ...slot,
        plan_status: 'blocked_no_candidate',
        reason: `no clean candidate with status: ${settings.eligibleStatuses.join(', ')}`,
      });
      continue;
    }

    perPageCounts.set(slot.niche_id, (perPageCounts.get(slot.niche_id) || 0) + 1);
    selectedPostIds.add(candidate.id);
    const entry = formatReadyEntry(slot, candidate);
    selected.push(entry);
    calendar.push(entry);
  }

  const alreadyScheduled = calendar.filter(entry => entry.plan_status === 'already_scheduled');
  const blockedSlots = calendar.filter(entry => String(entry.plan_status || '').startsWith('blocked_'));
  const pageSummaries = summarizePages(niches, calendar);

  return {
    generated_at: isoNow(),
    dry_run: true,
    run_id: runId,
    settings: {
      days: settings.days,
      posts_per_page: settings.postsPerPage,
      start_date: settings.startDate,
      end_date: settings.endDate,
      start_time: settings.startTime,
      interval_minutes: settings.intervalMinutes,
      eligible_statuses: settings.eligibleStatuses,
      active_calendar_statuses: settings.activeCalendarStatuses,
    },
    totals: {
      target_pages: niches.length,
      calendar_slots: calendar.length,
      target_posts: niches.length * settings.postsPerPage,
      already_scheduled_posts: alreadyScheduled.length,
      selected_posts: selected.length,
      blocked_slots: blockedSlots.length,
      blocked_candidates: skippedCandidates.length,
      ready_or_scheduled_posts: alreadyScheduled.length + selected.length,
    },
    pages: pageSummaries,
    calendar,
    selected,
    already_scheduled: alreadyScheduled,
    blocked_slots: blockedSlots,
    skipped_candidates: skippedCandidates,
  };
}

function resolveSettings(argv, config) {
  const weekly = config.weekly || {};
  const leadDays = readInteger(
    parseArgValue(argv, '--lead-days') || parseArgValue(argv, '--schedule-lead-days'),
    weekly.scheduleLeadDays ?? 1,
    { min: 0, label: '--lead-days' }
  );
  const days = readInteger(parseArgValue(argv, '--days'), weekly.days ?? 7, {
    min: 1,
    label: '--days',
  });
  const explicitPostsPerPage = parseArgValue(argv, '--posts-per-page');
  const postsPerPage = readInteger(explicitPostsPerPage, weekly.postsPerPage ?? days, {
    min: 1,
    label: '--posts-per-page',
  });
  const startDate = parseArgValue(argv, '--date') || formatDateOnly(addDays(new Date(), leadDays));
  const startTime = parseArgValue(argv, '--time') || parseArgValue(argv, '--start-time') || weekly.startTime || '15:00';
  if (!isDateOnly(startDate)) throw new Error(`--date must be YYYY-MM-DD. Got: ${startDate}`);
  if (!isTimeOnly(startTime)) throw new Error(`--time/--start-time must be HH:MM. Got: ${startTime}`);

  const eligibleStatuses = parseArgList(argv, '--status');
  const activeStatuses = parseArgList(argv, '--active-status');
  const endDate = formatDateOnly(addDays(parseDateOnly(startDate), days - 1));

  return {
    days,
    postsPerPage,
    startDate,
    endDate,
    startTime: normalizeTime(startTime),
    intervalMinutes: readInteger(
      parseArgValue(argv, '--interval-minutes') || parseArgValue(argv, '--slot-interval-minutes'),
      weekly.slotIntervalMinutes ?? 60,
      { min: 1, label: '--interval-minutes' }
    ),
    eligibleStatuses: eligibleStatuses.length ? eligibleStatuses : weekly.eligibleStatuses || ['queued'],
    activeCalendarStatuses: activeStatuses.length
      ? activeStatuses
      : weekly.activeCalendarStatuses || ['scheduled', 'scheduling', 'content_done'],
  };
}

function resolveNiches(argv, config) {
  const filters = parseArgList(argv, '--niche').map(normalizeToken);
  let niches = config.niches || [];
  if (filters.length) {
    niches = niches.filter(niche => {
      const aliases = [
        niche.id,
        niche.name,
        niche.facebook_page_name,
        String(niche.name || '').replace(/^How to\s+/i, ''),
      ].map(normalizeToken);
      return filters.some(filter => aliases.includes(filter));
    });
    if (!niches.length) throw new Error(`No configured niches matched --niche ${filters.join(', ')}`);
  }
  const limitPages = readInteger(parseArgValue(argv, '--limit-pages'), 0, {
    min: 0,
    label: '--limit-pages',
    allowZero: true,
  });
  return limitPages > 0 ? niches.slice(0, limitPages) : niches;
}

function buildCalendarSlots(niches, settings, config) {
  const slotTimes = buildPageSlotTimes(config, settings);
  const slots = [];
  for (let dayIndex = 0; dayIndex < settings.days; dayIndex++) {
    const date = formatDateOnly(addDays(parseDateOnly(settings.startDate), dayIndex));
    for (const niche of niches) {
      const scheduledTime = slotTimes.get(niche.id) || settings.startTime;
      slots.push({
        slot_id: `${date}_${scheduledTime}_${niche.id}`,
        day_index: dayIndex + 1,
        scheduled_date: date,
        scheduled_time: scheduledTime,
        niche_id: niche.id,
        niche_name: niche.name,
        facebook_page_name: niche.facebook_page_name,
      });
    }
  }
  return slots;
}

function buildPageSlotTimes(config, settings) {
  const times = new Map();
  const start = parseSlot(settings.startDate, settings.startTime);
  for (const [index, niche] of (config.niches || []).entries()) {
    times.set(niche.id, formatTimeOnly(addMinutes(start, index * settings.intervalMinutes)));
  }
  return times;
}

function indexExistingCalendarPosts(db, runId, settings, niches) {
  const nicheIds = niches.map(niche => niche.id);
  const statuses = settings.activeCalendarStatuses.filter(Boolean);
  const byDayPage = new Map();
  if (!nicheIds.length || !statuses.length) return { byDayPage };

  const rows = db.queryAll(
    `SELECT *
     FROM posts
     WHERE run_id = ?
       AND niche_id IN (${nicheIds.map(() => '?').join(', ')})
       AND status IN (${statuses.map(() => '?').join(', ')})
       AND scheduled_date IS NOT NULL
       AND scheduled_date >= ?
       AND scheduled_date <= ?
     ORDER BY scheduled_date ASC,
       CASE status
         WHEN 'scheduled' THEN 1
         WHEN 'scheduling' THEN 2
         WHEN 'content_done' THEN 3
         ELSE 9
       END,
       scheduled_time ASC,
       id ASC`,
    [runId, ...nicheIds, ...statuses, settings.startDate, settings.endDate]
  );

  for (const row of rows) {
    const key = dayPageKey(row.niche_id, row.scheduled_date);
    if (!byDayPage.has(key)) byDayPage.set(key, row);
  }
  return { byDayPage };
}

function indexOccupiedSlots(db, settings) {
  const rows = db.queryAll(
    `SELECT id, run_id, niche_id, facebook_page_name, status, topic, scheduled_date, scheduled_time
     FROM posts
     WHERE status IN ('scheduled', 'scheduling')
       AND scheduled_date IS NOT NULL
       AND scheduled_time IS NOT NULL
       AND scheduled_date >= ?
       AND scheduled_date <= ?
     ORDER BY scheduled_date ASC, scheduled_time ASC, id ASC`,
    [settings.startDate, settings.endDate]
  );
  const out = new Map();
  for (const row of rows) {
    out.set(slotKey(row.scheduled_date, row.scheduled_time), row);
  }
  return out;
}

function selectNextCandidate({
  db,
  runId,
  slot,
  settings,
  config,
  candidatePools,
  candidateIndexes,
  selected,
  selectedPostIds,
  skippedCandidates,
}) {
  if (!candidatePools.has(slot.niche_id)) {
    candidatePools.set(slot.niche_id, queryCandidates(db, runId, slot.niche_id, settings.eligibleStatuses));
    candidateIndexes.set(slot.niche_id, 0);
  }

  const pool = candidatePools.get(slot.niche_id) || [];
  let index = candidateIndexes.get(slot.niche_id) || 0;
  while (index < pool.length) {
    const candidate = pool[index];
    index += 1;
    candidateIndexes.set(slot.niche_id, index);
    if (selectedPostIds.has(candidate.id)) continue;

    const duplicate = findDuplicatePost(db, candidate, {
      excludePostId: candidate.id,
      config,
    });
    if (duplicate.duplicate) {
      skippedCandidates.push(formatSkippedCandidate(candidate, {
        plan_status: duplicate.level === 'hard' ? 'blocked_duplicate' : 'needs_review',
        reason: duplicateMessage(duplicate),
        duplicate_check: summarizeDuplicate(duplicate),
      }));
      continue;
    }

    const plannedDuplicate = findPlannedDuplicate(candidate, selected, config);
    if (plannedDuplicate?.duplicate) {
      skippedCandidates.push(formatSkippedCandidate(candidate, {
        plan_status: plannedDuplicate.level === 'hard' ? 'blocked_duplicate' : 'needs_review',
        reason: `planned ${plannedDuplicate.level} duplicate of post #${plannedDuplicate.matched_post_id}`,
        duplicate_check: plannedDuplicate,
      }));
      continue;
    }

    return candidate;
  }
  return null;
}

function queryCandidates(db, runId, nicheId, statuses) {
  const statusList = statuses.filter(Boolean);
  if (!statusList.length) return [];
  return db.queryAll(
    `SELECT *
     FROM posts
     WHERE run_id = ?
       AND niche_id = ?
       AND status IN (${statusList.map(() => '?').join(', ')})
     ORDER BY rank ASC, id ASC`,
    [runId, nicheId, ...statusList]
  );
}

function findPlannedDuplicate(post, plannedPosts, config) {
  const dedupConfig = config.dedup || {};
  const hard = Number(dedupConfig.hardSimilarityThreshold ?? 0.78);
  const soft = Number(dedupConfig.softSimilarityThreshold ?? 0.62);
  const minTokens = Number(dedupConfig.minTokenCount ?? 2);
  const source = buildPostDedupFields(post);
  if (source.fingerprint_tokens.length < minTokens) return null;

  let best = null;
  for (const planned of plannedPosts) {
    if (planned.niche_id !== post.niche_id) continue;
    const candidate = planned.fingerprint_tokens
      ? planned
      : buildPostDedupFields(planned);
    if ((candidate.fingerprint_tokens || []).length < minTokens) continue;
    const score = similarity(source.fingerprint_tokens, candidate.fingerprint_tokens);
    const exactTopic = source.topic_key && source.topic_key === candidate.topic_key;
    const exactFingerprint = source.content_fingerprint && source.content_fingerprint === candidate.content_fingerprint;
    const level = exactTopic || exactFingerprint || score >= hard ? 'hard' : score >= soft ? 'soft' : 'none';
    if (level === 'none') continue;
    if (!best || levelRank(level) > levelRank(best.level) || score > best.score) {
      best = {
        duplicate: true,
        level,
        score,
        matched_post_id: planned.post_id || planned.id,
        matched_topic: planned.topic,
        reason: exactTopic
          ? 'exact planned topic key match'
          : exactFingerprint
            ? 'exact planned fingerprint match'
            : `planned token similarity ${score.toFixed(3)}`,
        source: summarizeFingerprint(source),
        matched: summarizeFingerprint(candidate),
      };
    }
  }
  return best;
}

function formatExistingEntry(slot, post) {
  return {
    ...slot,
    plan_status: ['content_done', 'qa_done'].includes(post.status) ? 'prepared' : 'already_scheduled',
    post_id: post.id,
    post_status: post.status,
    rank: post.rank,
    topic: post.topic,
    hook: post.hook,
    actual_scheduled_time: normalizeTime(post.scheduled_time || slot.scheduled_time),
    time_matches_slot: normalizeTime(post.scheduled_time || slot.scheduled_time) === normalizeTime(slot.scheduled_time),
    image_path: post.image_path || null,
    caption_ready: !!post.caption,
  };
}

function formatReadyEntry(slot, post) {
  const fields = buildPostDedupFields(post);
  return {
    ...slot,
    plan_status: 'ready',
    post_id: post.id,
    run_id: post.run_id,
    rank: post.rank,
    post_status: post.status,
    topic: post.topic,
    hook: post.hook,
    sources: parseJson(post.sources_json, []),
    topic_key: fields.topic_key,
    content_fingerprint: fields.content_fingerprint,
    fingerprint_tokens: fields.fingerprint_tokens,
    duplicate_check: {
      duplicate: false,
      level: 'none',
      reason: 'no prior or planned duplicate',
    },
    required_actions: buildRequiredActions(post, {
      date: slot.scheduled_date,
      time: slot.scheduled_time,
    }),
  };
}

function buildRequiredActions(post, slot) {
  const actions = [];
  if (post.status === 'queued' || post.status === 'review_needed') {
    actions.push({
      step: 'approve',
      command: `npm.cmd run review -- approve --id ${post.id} --note "weekly plan"`,
    });
  }
  if (['queued', 'review_needed', 'approved'].includes(post.status)) {
    actions.push({
      step: 'generate_image',
      command: `npm.cmd run image -- --live --id ${post.id} --login-wait-sec 240`,
    });
  }
  if (['queued', 'review_needed', 'approved', 'image_done'].includes(post.status)) {
    actions.push({
      step: 'generate_content',
      command: `npm.cmd run content -- --generate --id ${post.id}`,
    });
  }
  if (['queued', 'review_needed', 'approved', 'image_done', 'content_done'].includes(post.status)) {
    actions.push({
      step: 'post_image_qa',
      command: `npm.cmd run qa -- --run --id ${post.id}`,
    });
  }
  actions.push({
    step: 'verify_facebook_page',
    command: `npm.cmd run facebook -- --dry-run --niche ${post.niche_id} --user-data-dir .browser-profile --login-wait-sec 120`,
  });
  actions.push({
    step: 'prepare_schedule_slot',
    command: `npm.cmd run facebook -- --prepare --id ${post.id} --date ${slot.date} --time ${slot.time}`,
  });
  actions.push({
    step: 'schedule_dry_run',
    command: `npm.cmd run facebook -- --schedule-dry-run --id ${post.id}`,
  });
  actions.push({
    step: 'live_schedule_one_post',
    command: `npm.cmd run facebook -- --live --id ${post.id} --user-data-dir .browser-profile --login-wait-sec 120`,
  });
  return actions;
}

function summarizePages(niches, calendar) {
  return niches.map(niche => {
    const rows = calendar.filter(entry => entry.niche_id === niche.id);
    return {
      niche_id: niche.id,
      niche_name: niche.name,
      facebook_page_name: niche.facebook_page_name,
      calendar_slots: rows.length,
      already_scheduled: rows.filter(entry => entry.plan_status === 'already_scheduled').length,
      prepared: rows.filter(entry => entry.plan_status === 'prepared').length,
      ready: rows.filter(entry => entry.plan_status === 'ready').length,
      blocked: rows.filter(entry => String(entry.plan_status || '').startsWith('blocked_')).length,
      not_requested: rows.filter(entry => entry.plan_status === 'not_requested').length,
    };
  });
}

function formatSkippedCandidate(post, extra = {}) {
  return {
    post_id: post.id,
    niche_id: post.niche_id,
    niche_name: post.niche_name,
    facebook_page_name: post.facebook_page_name,
    rank: post.rank,
    status: post.status,
    topic: post.topic,
    ...extra,
  };
}

function formatExistingPost(post) {
  return {
    post_id: post.id,
    run_id: post.run_id,
    niche_id: post.niche_id,
    facebook_page_name: post.facebook_page_name,
    status: post.status,
    topic: post.topic,
    scheduled_date: post.scheduled_date,
    scheduled_time: normalizeTime(post.scheduled_time),
  };
}

function summarizeDuplicate(result) {
  if (!result) return null;
  return {
    duplicate: !!result.duplicate,
    level: result.level || 'none',
    score: Number.isFinite(result.score) ? Number(result.score.toFixed(3)) : 0,
    reason: result.reason || null,
    matched_post_id: result.matched_post_id || null,
    matched_status: result.matched_status || null,
    matched_topic: result.matched_topic || null,
    matched_scheduled_date: result.matched_scheduled_date || null,
    matched_scheduled_time: result.matched_scheduled_time || null,
    source: result.source ? summarizeFingerprint(result.source) : null,
  };
}

function summarizeFingerprint(fields) {
  return {
    topic_key: fields.topic_key || null,
    content_fingerprint: fields.content_fingerprint || null,
    fingerprint_tokens: fields.fingerprint_tokens || [],
  };
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

function resolveOutputPath(argv, config) {
  const value = parseArgValue(argv, '--output') || parseArgValue(argv, '--manifest') || config.files.weeklyPlan || 'weekly_plan.json';
  return path.isAbsolute(value) ? value : path.join(pipelineDir, value);
}

function printPlan(plan, outputLabel) {
  console.log(`Weekly calendar dry-run for run ${plan.run_id}`);
  console.log(`Window: ${plan.settings.start_date} to ${plan.settings.end_date} (${plan.settings.days} day(s))`);
  console.log(
    `Ready ${plan.totals.selected_posts}, already scheduled ${plan.totals.already_scheduled_posts}, ` +
    `blocked slots ${plan.totals.blocked_slots}, blocked candidates ${plan.totals.blocked_candidates}.`
  );
  console.log('');
  console.log('Page summary:');
  for (const page of plan.pages) {
    console.log(
      `- ${page.facebook_page_name}: ${page.already_scheduled} scheduled, ` +
      `${page.ready} ready, ${page.blocked} blocked`
    );
  }
  if (plan.selected.length) {
    console.log('');
    console.log('Next ready posts:');
    for (const item of plan.selected.slice(0, 12)) {
      console.log(`- ${item.facebook_page_name} #${item.post_id} r${item.rank} -> ${item.scheduled_date} ${item.scheduled_time}: ${item.topic}`);
    }
    if (plan.selected.length > 12) console.log(`- ... ${plan.selected.length - 12} more in ${outputLabel}`);
  }
  if (plan.blocked_slots.length) {
    console.log('');
    console.log('Blocked slots:');
    for (const item of plan.blocked_slots.slice(0, 10)) {
      console.log(`- ${item.facebook_page_name} ${item.scheduled_date} ${item.scheduled_time}: ${item.reason}`);
    }
  }
  console.log('');
  console.log(`Wrote ${outputLabel}`);
}

async function runCli() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    printHelp();
    return;
  }
  if (!hasFlag(argv, '--dry-run')) {
    throw new Error('Weekly planning is dry-run only for now. Re-run with --dry-run.');
  }

  const db = await openPipelineDb({
    config: pipelineConfig,
    logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
  });
  try {
    const runId = resolveRunId(db, parseArgValue(argv, '--run-id') || parseArgValue(argv, '--run') || 'latest');
    if (!runId) throw new Error('No run found in how-to content DB.');
    const plan = await buildWeeklyPlan({ db, runId, argv, config: pipelineConfig });
    const outputPath = resolveOutputPath(argv, pipelineConfig);
    await fs.writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    printPlan(plan, path.relative(pipelineDir, outputPath) || outputPath);
  } finally {
    db.close();
  }
}

function parseSlot(dateValue, timeValue) {
  const [year, month, day] = String(dateValue).split('-').map(Number);
  const [hours, minutes] = normalizeTime(timeValue).split(':').map(Number);
  return new Date(year, month - 1, day, hours, minutes, 0, 0);
}

function parseDateOnly(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function formatDateOnly(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatTimeOnly(date) {
  return [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':');
}

function normalizeTime(value) {
  const [hours, minutes] = String(value || '').split(':');
  return `${String(Number(hours)).padStart(2, '0')}:${String(Number(minutes)).padStart(2, '0')}`;
}

function slotKey(dateValue, timeValue) {
  return `${dateValue} ${normalizeTime(timeValue)}`;
}

function dayPageKey(nicheId, dateValue) {
  return `${nicheId} ${dateValue}`;
}

function isDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function isTimeOnly(value) {
  if (!/^\d{1,2}:\d{2}$/.test(String(value || ''))) return false;
  const [hours, minutes] = String(value).split(':').map(Number);
  return Number.isInteger(hours) && Number.isInteger(minutes) && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
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

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function readInteger(value, fallback, { min = 0, label = 'value', allowZero = false } = {}) {
  if (value == null) return fallback;
  const parsed = Number(value);
  const tooSmall = allowZero ? parsed < 0 : parsed < min;
  if (!Number.isInteger(parsed) || tooSmall) {
    throw new Error(`${label} must be an integer >= ${allowZero ? 0 : min}`);
  }
  return parsed;
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function levelRank(level) {
  return { none: 0, soft: 1, hard: 2 }[level] || 0;
}

function isoNow() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`How-to weekly calendar planner

Usage:
  npm.cmd run weekly -- --dry-run
  npm.cmd run weekly -- --dry-run --days 7 --posts-per-page 7
  npm.cmd run weekly -- --dry-run --days 1
  npm.cmd run weekly -- --dry-run --niche grow-it --days 7

Notes:
  - This is read-only planning plus a JSON export.
  - Default calendar: 7 days, 7 posts per page, one daily slot per page.
  - Page slot times are stable from config order: start time plus interval.
  - Existing scheduled/scheduling posts in the window are marked already_scheduled.
  - Empty requested slots are filled from eligible queued posts after duplicate checks.
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(pipelineDir);
  runCli().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
