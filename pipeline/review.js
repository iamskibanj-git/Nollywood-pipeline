import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipelineConfig } from './config.js';
import { openPipelineDb } from './db.js';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pipelineDir);

const POST_STATUSES = new Set([
  'queued',
  'review_needed',
  'approved',
  'rejected',
  'image_generating',
  'image_done',
  'content_generating',
  'content_done',
  'qa_generating',
  'qa_done',
  'scheduling',
  'scheduled',
  'deleted',
  'duplicate',
  'failed',
]);

const QA_PATTERNS = [
  {
    id: 'current_claim',
    label: 'current claim',
    regex: /\b(just released|newly released|latest|today|this week|this month|announced|launched|court ruling|lawsuit|ban|rolled out|free video generator)\b/i,
  },
  {
    id: 'safety_risk',
    label: 'safety risk',
    regex: /\b(live electrical|electrical wiring|breaker panel|garage door spring|gas leak|fuel line|asbestos|black mold|load-bearing|structural support|toxic chemical|roof repair)\b/i,
  },
  {
    id: 'high_stakes_advice',
    label: 'high-stakes advice',
    regex: /\b(diagnose|medical diagnosis|doctor|legal advice|tax advice|guaranteed return|credit repair|loan approval|investment returns)\b/i,
  },
];

const rawArgs = process.argv.slice(2);
const command = readCommand(rawArgs);
if (command === 'help' || hasFlag(rawArgs, '--help') || hasFlag(rawArgs, '-h')) {
  printHelp();
  process.exit(0);
}

const db = await openPipelineDb({
  config: pipelineConfig,
  logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
});

try {
  const runId = resolveRunId(db, parseArgValue(rawArgs, '--run-id') || parseArgValue(rawArgs, '--run') || 'latest');
  if (!runId) throw new Error('No run found in how-to content DB.');

  switch (command) {
    case 'status':
      printStatus(db, runId, { json: hasFlag(rawArgs, '--json') });
      break;
    case 'list':
      printList(db, runId, rawArgs);
      break;
    case 'show':
      printShow(db, runId, rawArgs);
      break;
    case 'approve':
      await updateSelectedPosts(db, runId, rawArgs, { status: 'approved', eventType: 'post_approved' });
      break;
    case 'reject':
      await updateSelectedPosts(db, runId, rawArgs, { status: 'rejected', eventType: 'post_rejected' });
      break;
    case 'needs-review':
    case 'review-needed':
      await updateSelectedPosts(db, runId, rawArgs, { status: 'review_needed', eventType: 'post_review_needed' });
      break;
    case 'reset':
      await updateSelectedPosts(db, runId, rawArgs, { status: 'queued', eventType: 'post_review_reset', clearNote: true });
      break;
    case 'set-status':
      await setStatusCommand(db, runId, rawArgs);
      break;
    case 'auto-flag':
    case 'flag-review':
      await autoFlagReview(db, runId, rawArgs);
      break;
    case 'export':
      await writePostsExport(db, runId);
      console.log(`Exported ${pipelineConfig.files.postsQueue}`);
      break;
    default:
      throw new Error(`Unknown review command: ${command}. Run "npm.cmd run review -- help".`);
  }
} finally {
  db.close();
}

function printStatus(db, runId, { json = false } = {}) {
  const run = db.queryOne(
    `SELECT id, status, stage, error_message, started_at, completed_at, updated_at
     FROM runs WHERE id = ?`,
    [runId]
  );
  const sourcePulls = db.queryAll(
    `SELECT status, COUNT(*) AS count
     FROM source_pulls WHERE run_id = ?
     GROUP BY status ORDER BY status`,
    [runId]
  );
  const postStatus = db.queryAll(
    `SELECT status, COUNT(*) AS count
     FROM posts WHERE run_id = ?
     GROUP BY status ORDER BY status`,
    [runId]
  );
  const postNiches = db.queryAll(
    `SELECT niche_id, status, COUNT(*) AS count
     FROM posts WHERE run_id = ?
     GROUP BY niche_id, status
     ORDER BY niche_id, status`,
    [runId]
  );
  const flagged = getPosts(db, runId, {}).map(withFlags).filter(post => post.flags.length > 0);
  const payload = {
    run,
    source_pulls: sourcePulls,
    posts_by_status: postStatus,
    posts_by_niche_status: postNiches,
    qa_flags: {
      count: flagged.length,
      samples: flagged.slice(0, 10).map(flaggedSample),
    },
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Run: ${run.id}`);
  console.log(`Status: ${run.status}${run.stage ? ` / ${run.stage}` : ''}`);
  if (run.error_message) console.log(`Error: ${run.error_message}`);
  console.log(`Started: ${run.started_at || 'n/a'}`);
  console.log(`Completed: ${run.completed_at || 'n/a'}`);
  console.log('');
  printRows('Source pulls', sourcePulls, row => `${row.status}: ${row.count}`);
  printRows('Posts by status', postStatus, row => `${row.status}: ${row.count}`);
  console.log('');
  console.log(`QA flags: ${flagged.length}`);
  for (const sample of payload.qa_flags.samples) {
    console.log(`- #${sample.id} ${sample.niche_id} r${sample.rank} [${sample.flags.join(', ')}] ${sample.topic}`);
  }
}

function printList(db, runId, argv) {
  let posts = getPosts(db, runId, {
    niche: parseArgValue(argv, '--niche'),
    status: parseArgList(argv, '--status'),
    ids: parseNumberList(parseArgList(argv, '--id')),
  }).map(withFlags);
  if (hasFlag(argv, '--flagged')) posts = posts.filter(post => post.flags.length > 0);
  const limit = readInteger(parseArgValue(argv, '--limit'), 30);
  posts = posts.slice(0, limit);

  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(posts.map(formatPostJson), null, 2));
    return;
  }

  for (const post of posts) {
    const flags = post.flags.length ? ` [${post.flags.join(', ')}]` : '';
    console.log(`#${post.id} ${post.niche_id} r${post.rank} ${post.status}${flags}`);
    console.log(`  ${post.topic}`);
    console.log(`  ${post.hook}`);
  }
}

function printShow(db, runId, argv) {
  const posts = findTargetPosts(db, runId, argv, { allowAll: false }).map(withFlags);
  if (posts.length === 0) throw new Error('No posts matched.');
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify(posts.map(formatPostJson), null, 2));
    return;
  }

  for (const post of posts) {
    console.log(`#${post.id} ${post.niche_id} r${post.rank} ${post.status}`);
    console.log(`Page: ${post.facebook_page_name}`);
    console.log(`Topic: ${post.topic}`);
    console.log(`Hook: ${post.hook}`);
    console.log(`Image prompt: ${post.image_prompt}`);
    console.log(`Sources: ${parseJson(post.sources_json, []).join(', ') || 'n/a'}`);
    if (post.flags.length) console.log(`QA flags: ${post.flags.join(', ')}`);
    if (post.review_note) console.log(`Review note: ${post.review_note}`);
    if (post.duplicate_reason) console.log(`Duplicate: ${post.duplicate_reason}`);
    if (post.error_message) console.log(`Error: ${post.error_message}`);
    console.log('');
  }
}

async function setStatusCommand(db, runId, argv) {
  const status = parseArgValue(argv, '--status');
  if (!POST_STATUSES.has(status)) {
    throw new Error(`--status must be one of: ${Array.from(POST_STATUSES).join(', ')}`);
  }
  await updateSelectedPosts(db, runId, argv, { status, eventType: 'post_status_set' });
}

async function autoFlagReview(db, runId, argv) {
  const onlyStatus = parseArgValue(argv, '--from-status') || 'queued';
  const posts = getPosts(db, runId, {
    niche: parseArgValue(argv, '--niche'),
    status: [onlyStatus],
  }).map(withFlags).filter(post => post.flags.length > 0);
  if (posts.length === 0) {
    console.log(`No ${onlyStatus} posts matched QA flags.`);
    return;
  }

  const limit = readInteger(parseArgValue(argv, '--limit'), posts.length);
  const targets = posts.slice(0, limit);
  if (targets.length > 10 && !hasFlag(argv, '--yes')) {
    throw new Error(`Refusing to update ${targets.length} posts without --yes.`);
  }
  db.backup(`pre-auto-flag-${runId}`);
  const now = isoNow();
  for (const post of targets) {
    const note = `Auto-flagged: ${post.flags.join(', ')}`;
    db.run(
      `UPDATE posts
       SET status = 'review_needed', review_note = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`,
      [note, now, now, post.id]
    );
    db.logEvent(runId, 'post_review_needed', {
      nicheId: post.niche_id,
      message: note,
      data: { postId: post.id, rank: post.rank, flags: post.flags },
    });
  }
  db.save();
  await writePostsExport(db, runId);
  console.log(`Moved ${targets.length} post(s) to review_needed.`);
}

async function updateSelectedPosts(db, runId, argv, { status, eventType, clearNote = false }) {
  const posts = findTargetPosts(db, runId, argv, { allowAll: true }).map(withFlags);
  if (posts.length === 0) throw new Error('No posts matched.');
  if (posts.length > 10 && !hasFlag(argv, '--yes')) {
    throw new Error(`Refusing to update ${posts.length} posts without --yes.`);
  }

  const note = cleanNote(parseArgValue(argv, '--note') || parseArgValue(argv, '--reason'));
  db.backup(`pre-review-${runId}`);
  const now = isoNow();
  for (const post of posts) {
    const nextNote = clearNote ? null : note || post.review_note || null;
    db.run(
      `UPDATE posts
       SET status = ?, review_note = ?, reviewed_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, nextNote, now, now, post.id]
    );
    db.logEvent(runId, eventType, {
      nicheId: post.niche_id,
      message: nextNote,
      data: { postId: post.id, rank: post.rank, status, flags: post.flags },
    });
  }
  db.save();
  await writePostsExport(db, runId);
  console.log(`Updated ${posts.length} post(s) to ${status}.`);
}

function findTargetPosts(db, runId, argv, { allowAll }) {
  const ids = parseNumberList(parseArgList(argv, '--id'));
  if (ids.length > 0) return getPosts(db, runId, { ids });

  const niche = parseArgValue(argv, '--niche');
  const ranks = parseRankList(parseArgList(argv, '--rank'));
  if (niche && ranks.length > 0) return getPosts(db, runId, { niche, ranks });

  if (allowAll && hasFlag(argv, '--all')) {
    let posts = getPosts(db, runId, {
      niche,
      status: parseArgList(argv, '--status'),
    }).map(withFlags);
    if (hasFlag(argv, '--flagged')) posts = posts.filter(post => post.flags.length > 0);
    const limit = readInteger(parseArgValue(argv, '--limit'), 0);
    return limit > 0 ? posts.slice(0, limit) : posts;
  }

  throw new Error('Select posts with --id, or --niche plus --rank. Bulk updates require --all.');
}

function getPosts(db, runId, { ids = [], niche = null, ranks = [], status = [] } = {}) {
  const where = ['run_id = ?'];
  const params = [runId];
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
  if (status.length > 0) {
    where.push(`status IN (${status.map(() => '?').join(', ')})`);
    params.push(...status);
  }
  return db.queryAll(
    `SELECT * FROM posts
     WHERE ${where.join(' AND ')}
     ORDER BY niche_id, rank ASC, id ASC`,
    params
  );
}

function withFlags(post) {
  const text = `${post.topic || ''} ${post.hook || ''} ${post.image_prompt || ''}`;
  return {
    ...post,
    flags: QA_PATTERNS.filter(pattern => pattern.regex.test(text)).map(pattern => pattern.id),
  };
}

function flaggedSample(post) {
  return {
    id: post.id,
    niche_id: post.niche_id,
    rank: post.rank,
    status: post.status,
    topic: post.topic,
    hook: post.hook,
    flags: post.flags,
  };
}

function formatPostJson(post) {
  return {
    id: post.id,
    run_id: post.run_id,
    niche_id: post.niche_id,
    facebook_page_name: post.facebook_page_name,
    rank: post.rank,
    status: post.status,
    topic: post.topic,
    hook: post.hook,
    image_prompt: post.image_prompt,
    sources: parseJson(post.sources_json, []),
    flags: post.flags,
    review_note: post.review_note || null,
    reviewed_at: post.reviewed_at || null,
    duplicate_of_post_id: post.duplicate_of_post_id || null,
    duplicate_reason: post.duplicate_reason || null,
  };
}

async function writePostsExport(db, runId) {
  const posts = db.exportPosts(runId);
  await fs.writeFile(pipelineConfig.files.postsQueue, `${JSON.stringify(posts, null, 2)}\n`, 'utf8');
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
  if (latestWithPosts?.id) return latestWithPosts.id;
  return db.queryOne(
    `SELECT id FROM runs
     ORDER BY COALESCE(completed_at, updated_at, started_at) DESC
     LIMIT 1`
  )?.id || null;
}

function readCommand(argv) {
  return argv.find(arg => !arg.startsWith('-')) || 'status';
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

function cleanNote(value) {
  return value ? String(value).replace(/\s+/g, ' ').trim() : null;
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function printRows(title, rows, formatter) {
  console.log(`${title}:`);
  if (!rows.length) {
    console.log('- none');
    return;
  }
  for (const row of rows) console.log(`- ${formatter(row)}`);
}

function isoNow() {
  return new Date().toISOString();
}

function printHelp() {
  console.log(`How-to queue review commands

Usage:
  npm.cmd run review -- status [--run-id latest] [--json]
  npm.cmd run review -- list [--status queued] [--niche fix-it] [--flagged] [--limit 20] [--json]
  npm.cmd run review -- show --id 123
  npm.cmd run review -- show --niche fix-it --rank 1
  npm.cmd run review -- approve --id 123 [--note "..."]
  npm.cmd run review -- reject --id 123 --reason "..."
  npm.cmd run review -- needs-review --niche tech-it --rank 17 --reason "source/date check"
  npm.cmd run review -- reset --id 123
  npm.cmd run review -- auto-flag [--from-status queued] [--yes]
  npm.cmd run review -- export

Bulk updates:
  npm.cmd run review -- approve --all --status queued --niche fix-it --limit 5
  npm.cmd run review -- reject --all --flagged --yes

Statuses:
  ${Array.from(POST_STATUSES).join(', ')}
`);
}
