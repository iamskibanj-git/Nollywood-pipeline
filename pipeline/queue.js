import fs from 'node:fs/promises';
import { pipelineConfig } from './config.js';
import { buildPostDedupFields, duplicateMessage, findDuplicatePost } from './dedup.js';

export async function buildQueue({ config = pipelineConfig, logger = console, db = null, runId = null } = {}) {
  const log = makeLogger(logger);
  const scored = db?.hasScoredTopics?.(runId)
    ? db.exportScoredTopics(runId)
    : JSON.parse(await fs.readFile(config.files.scoredTopics, 'utf8'));
  if (db && runId && !db.hasScoredTopics(runId)) {
    db.saveScoredTopics(runId, scored);
  }
  const queue = [];

  for (const pageInfo of scored.pages || []) {
    for (const topic of pageInfo.topics || []) {
      const row = {
        run_id: runId || scored.run_id || null,
        niche_id: pageInfo.niche_id,
        niche_name: pageInfo.niche_name,
        facebook_page_name: pageInfo.facebook_page_name || pageInfo.niche_name,
        rank: topic.rank,
        topic: cleanText(topic.topic),
        hook: cleanText(topic.hook),
        image_prompt: cleanText(topic.image_prompt),
        sources: Array.isArray(topic.sources) ? topic.sources.map(cleanText).filter(Boolean) : [],
        status: 'queued',
      };
      applyDedupeDecision(db, row, log);
      queue.push(row);
      log.info(`[QUEUE] ${row.niche_id} #${row.rank}: ${row.hook}`);
      log.info(`[QUEUE] image_prompt: ${row.image_prompt}`);
      if (row.duplicate_reason) log.info(`[QUEUE] dedup: ${row.duplicate_reason}`);
    }
  }

  db?.savePosts?.(runId, queue);
  await fs.writeFile(config.files.postsQueue, `${JSON.stringify(queue, null, 2)}\n`, 'utf8');
  log.info(`[QUEUE] Wrote ${config.files.postsQueue}`, { posts: queue.length });
  return queue;
}

function applyDedupeDecision(db, row, log) {
  const fields = buildPostDedupFields(row);
  row.topic_key = fields.topic_key;
  row.content_fingerprint = fields.content_fingerprint;
  row.dedupe_checked_at = new Date().toISOString();
  row.duplicate_of_post_id = null;
  row.duplicate_reason = null;
  row.error_message = null;
  if (!db) return;

  const result = findDuplicatePost(db, row);
  if (!result.duplicate) return;

  row.duplicate_of_post_id = result.matched_post_id;
  row.duplicate_reason = duplicateMessage(result);
  row.error_message = row.duplicate_reason;
  row.status = result.level === 'hard' ? 'duplicate' : 'review_needed';
  log.info(`[QUEUE] ${row.status}: ${row.duplicate_reason}`);
}

function makeLogger(logger) {
  return {
    info: (message, details) => callLogger(logger, 'info', message, details),
  };
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

function callLogger(logger, level, message, details) {
  const fn = logger?.[level] || logger?.log || console.log;
  if (details) fn.call(logger, message, details);
  else fn.call(logger, message);
}
