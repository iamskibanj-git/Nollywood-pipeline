import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pipelineConfig } from './config.js';
import { openPipelineDb } from './db.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'best', 'can', 'for', 'from', 'get', 'getting',
  'guide', 'hack', 'hacks', 'home', 'how', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'own', 'simple', 'the', 'this', 'tip', 'tips', 'to', 'use', 'using', 'way', 'ways', 'with',
  'without', 'you', 'your', 'yourself',
  // Generic how-to verbs. The object/condition should carry the fingerprint.
  'build', 'cook', 'create', 'diy', 'do', 'fix', 'grow', 'make', 'repair', 'replace', 'save',
]);

const SYNONYMS = new Map([
  ['leaking', 'leak'],
  ['leaky', 'leak'],
  ['running', 'run'],
  ['broken', 'break'],
  ['cracked', 'crack'],
  ['clogged', 'clog'],
  ['blocked', 'clog'],
  ['stuck', 'stick'],
  ['worn', 'wear'],
  ['cheap', 'budget'],
  ['beginner', 'begin'],
  ['beginners', 'begin'],
]);

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));

export function buildPostDedupFields(post) {
  const topic = cleanText(post?.topic);
  const hook = cleanText(post?.hook);
  const topicKey = makeTopicKey(topic);
  let fingerprintInfo = buildContentFingerprint(topic);
  if (fingerprintInfo.tokens.length < Number(pipelineConfig.dedup?.minTokenCount || 2)) {
    fingerprintInfo = buildContentFingerprint(`${topic} ${hook}`);
  }
  return {
    topic_key: topicKey,
    content_fingerprint: fingerprintInfo.fingerprint,
    fingerprint_tokens: fingerprintInfo.tokens,
  };
}

export function buildContentFingerprint(value) {
  const tokens = tokenize(value);
  return {
    fingerprint: tokens.join(' '),
    tokens,
  };
}

export function findDuplicatePost(db, post, {
  config = pipelineConfig,
  excludePostId = post?.id || null,
  statuses = null,
  hardThreshold = null,
  softThreshold = null,
  minTokenCount = null,
} = {}) {
  const dedupConfig = config.dedup || {};
  const hard = Number(hardThreshold ?? dedupConfig.hardSimilarityThreshold ?? 0.78);
  const soft = Number(softThreshold ?? dedupConfig.softSimilarityThreshold ?? 0.62);
  const minTokens = Number(minTokenCount ?? dedupConfig.minTokenCount ?? 2);
  const statusList = statuses || dedupConfig.softStatuses || ['scheduled', 'published', 'content_done', 'scheduling'];
  const sourceFields = buildPostDedupFields(post);
  const sourceTokens = sourceFields.fingerprint_tokens;
  if (!post?.niche_id || sourceTokens.length < minTokens) {
    return {
      duplicate: false,
      level: 'none',
      score: 0,
      reason: 'insufficient fingerprint',
      source: sourceFields,
    };
  }

  const rows = queryCandidatePosts(db, {
    nicheId: post.niche_id,
    statuses: statusList,
    excludePostId,
  });
  let best = null;
  for (const row of rows) {
    const candidateFields = row.content_fingerprint
      ? { content_fingerprint: row.content_fingerprint, fingerprint_tokens: splitFingerprint(row.content_fingerprint), topic_key: row.topic_key || makeTopicKey(row.topic) }
      : buildPostDedupFields(row);
    if (candidateFields.fingerprint_tokens.length < minTokens) continue;
    const score = similarity(sourceTokens, candidateFields.fingerprint_tokens);
    const exactTopic = sourceFields.topic_key && sourceFields.topic_key === candidateFields.topic_key;
    const exactFingerprint = sourceFields.content_fingerprint && sourceFields.content_fingerprint === candidateFields.content_fingerprint;
    const level = exactTopic || exactFingerprint || score >= hard ? 'hard' : score >= soft ? 'soft' : 'none';
    if (level === 'none') continue;
    if (!best || levelRank(level) > levelRank(best.level) || score > best.score) {
      best = {
        duplicate: true,
        level,
        score,
        matched_post_id: row.id,
        matched_status: row.status,
        matched_run_id: row.run_id,
        matched_topic: row.topic,
        matched_scheduled_date: row.scheduled_date || null,
        matched_scheduled_time: row.scheduled_time || null,
        reason: exactTopic
          ? 'exact topic key match'
          : exactFingerprint
            ? 'exact content fingerprint match'
            : `token similarity ${score.toFixed(3)}`,
        source: sourceFields,
        matched: candidateFields,
      };
    }
  }

  return best || {
    duplicate: false,
    level: 'none',
    score: 0,
    reason: 'no prior match',
    source: sourceFields,
  };
}

export function duplicateMessage(result) {
  if (!result?.duplicate) return '';
  const score = Number.isFinite(result.score) ? result.score.toFixed(3) : 'n/a';
  return `${result.level} duplicate of post #${result.matched_post_id} (${result.matched_status}, score ${score}): ${result.matched_topic}`;
}

export function makeTopicKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value) {
  const normalized = makeTopicKey(value)
    .replace(/\bhow to\b/g, ' ')
    .replace(/\bdo it yourself\b/g, ' ')
    .replace(/\bdiy\b/g, ' ');
  const raw = normalized.split(/\s+/).filter(Boolean);
  const tokens = raw
    .map(token => SYNONYMS.get(token) || stemToken(token))
    .map(token => SYNONYMS.get(token) || token)
    .filter(token => token.length >= 3)
    .filter(token => !STOPWORDS.has(token));
  return Array.from(new Set(tokens)).sort();
}

export function similarity(leftTokens, rightTokens) {
  const left = new Set(leftTokens || []);
  const right = new Set(rightTokens || []);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  const cosine = intersection / Math.sqrt(left.size * right.size);
  const union = left.size + right.size - intersection;
  const jaccard = union ? intersection / union : 0;
  return Math.max(cosine, jaccard);
}

export function splitFingerprint(value) {
  return String(value || '').split(/\s+/).map(token => token.trim()).filter(Boolean);
}

function queryCandidatePosts(db, { nicheId, statuses, excludePostId }) {
  const statusList = (statuses || []).filter(Boolean);
  if (!statusList.length) return [];
  const params = [nicheId, ...statusList];
  let where = `niche_id = ? AND status IN (${statusList.map(() => '?').join(', ')})`;
  if (excludePostId) {
    where += ' AND id != ?';
    params.push(excludePostId);
  }
  return db.queryAll(
    `SELECT id, run_id, niche_id, status, topic, hook, topic_key, content_fingerprint,
            scheduled_date, scheduled_time, scheduled_at, updated_at
     FROM posts
     WHERE ${where}
     ORDER BY COALESCE(scheduled_at, updated_at, created_at) DESC, id DESC
     LIMIT 500`,
    params
  );
}

function stemToken(value) {
  let token = String(value || '').toLowerCase();
  if (token.endsWith('ies') && token.length > 5) token = `${token.slice(0, -3)}y`;
  else if (token.endsWith('ing') && token.length > 5) token = token.slice(0, -3).replace(/([a-z])\1$/, '$1');
  else if (token.endsWith('ed') && token.length > 4) token = token.slice(0, -2).replace(/([a-z])\1$/, '$1');
  else if (token.endsWith('es') && token.length > 4) token = token.slice(0, -2);
  else if (token.endsWith('s') && token.length > 4) token = token.slice(0, -1);
  return token;
}

function levelRank(level) {
  return { none: 0, soft: 1, hard: 2 }[level] || 0;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

async function runCli() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    printHelp();
    return;
  }

  const db = await openPipelineDb({
    config: pipelineConfig,
    logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
  });
  try {
    if (hasFlag(argv, '--backfill')) {
      await backfillPostFingerprints(db);
      return;
    }

    const postId = readInteger(parseArgValue(argv, '--id'), 0);
    const topic = parseArgValue(argv, '--topic');
    const niche = parseArgValue(argv, '--niche');
    let post = null;
    if (postId) {
      post = db.queryOne('SELECT * FROM posts WHERE id = ?', [postId]);
      if (!post) throw new Error(`Post not found: ${postId}`);
    } else if (topic && niche) {
      post = { id: null, niche_id: niche, topic, hook: parseArgValue(argv, '--hook') || '' };
    } else {
      throw new Error('Use --id <post_id>, --topic "..." --niche <niche_id>, or --backfill.');
    }
    const result = findDuplicatePost(db, post, {
      excludePostId: post.id || null,
      statuses: parseArgList(argv, '--statuses').length ? parseArgList(argv, '--statuses') : null,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

async function backfillPostFingerprints(db) {
  const rows = db.queryAll('SELECT id, topic, hook FROM posts ORDER BY id ASC');
  db.backup('pre-dedup-backfill');
  const now = new Date().toISOString();
  for (const row of rows) {
    const fields = buildPostDedupFields(row);
    db.run(
      `UPDATE posts
       SET topic_key = ?, content_fingerprint = ?, dedupe_checked_at = ?, updated_at = ?
       WHERE id = ?`,
      [fields.topic_key, fields.content_fingerprint, now, now, row.id]
    );
  }
  db.save();
  const runIds = db.queryAll('SELECT DISTINCT run_id FROM posts WHERE run_id IS NOT NULL').map(row => row.run_id);
  for (const runId of runIds) {
    await fs.writeFile(pipelineConfig.files.postsQueue, `${JSON.stringify(db.exportPosts(runId), null, 2)}\n`, 'utf8');
  }
  console.log(JSON.stringify({ backfilled_posts: rows.length }, null, 2));
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

function readInteger(value, fallback) {
  if (value == null) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function printHelp() {
  console.log(`How-to duplicate checker

Usage:
  npm.cmd run dedup -- --backfill
  npm.cmd run dedup -- --id 301
  npm.cmd run dedup -- --topic "How to stop a toilet from running" --niche fix-it

Notes:
  - Hard duplicates should be blocked from queue/scheduling.
  - Soft duplicates should move to review_needed.
  - Deleted/test posts are ignored by default because they are not in the dedup status set.
`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(pipelineDir);
  runCli().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
