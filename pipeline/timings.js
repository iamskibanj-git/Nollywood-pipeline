import path from 'node:path';
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

const limit = readInteger(parseArgValue(rawArgs, '--limit'), 10);
const batchRunId = readInteger(parseArgValue(rawArgs, '--id') || parseArgValue(rawArgs, '--batch-run-id'), 0);
const includeStages = hasFlag(rawArgs, '--stages') || batchRunId > 0;

const db = await openPipelineDb({
  config: pipelineConfig,
  logger: { info() {}, warn(message) { console.warn(message); }, error(message) { console.error(message); } },
});

try {
  const rows = batchRunId > 0
    ? db.queryAll(`SELECT * FROM batch_runs WHERE id = ?`, [batchRunId])
    : db.queryAll(`SELECT * FROM batch_runs ORDER BY id DESC LIMIT ?`, [limit]);

  if (rows.length === 0) {
    console.log('No batch timing rows found yet.');
    process.exit(0);
  }

  console.log('Recent batch runs');
  for (const row of rows) {
    printBatchRun(row);
    if (includeStages) printStageBreakdown(db, row);
  }
} finally {
  db.close();
}

function printBatchRun(row) {
  const filters = parseJson(row.filters_json, {});
  const selected = Number(row.selected_count || 0);
  const scheduled = Number(row.scheduled_count || 0);
  const prepared = Number(row.prepared_count || 0);
  const skipped = Number(row.skipped_count || 0);
  const failed = Number(row.failed_count || 0);
  const filterText = [
    filters.day ? `day=${filters.day}` : null,
    filters.niche ? `niche=${filters.niche}` : null,
    filters.post_id ? `post=${filters.post_id}` : null,
    filters.limit ? `limit=${filters.limit}` : null,
  ].filter(Boolean).join(' ');
  console.log(
    `#${row.id} ${row.mode} ${row.status} ${formatDuration(row.duration_ms)} ` +
    `selected=${selected} scheduled=${scheduled} prepared=${prepared} skipped=${skipped} failed=${failed} ` +
    `${filterText}`.trim()
  );
  console.log(`  started=${row.started_at || 'n/a'} completed=${row.completed_at || 'n/a'}`);
  if (row.error_message) console.log(`  error=${row.error_message}`);
}

function printStageBreakdown(db, batchRun) {
  const events = db.queryAll(
    `SELECT event_type, niche_id, message, data_json, created_at
     FROM events
     WHERE run_id = ? AND stage = 'batch'
     ORDER BY id ASC`,
    [batchRun.run_id]
  ).map(event => ({ ...event, data: parseJson(event.data_json, {}) }))
    .filter(event => Number(event.data?.batchRunId || 0) === Number(batchRun.id))
    .filter(event => ['batch_stage_complete', 'batch_stage_failed'].includes(event.event_type));

  if (events.length === 0) {
    console.log('  stages: none recorded');
    return;
  }

  const groups = new Map();
  for (const event of events) {
    const label = event.data.label || 'unknown';
    const existing = groups.get(label) || { count: 0, failed: 0, durationMs: 0 };
    existing.count += 1;
    existing.failed += event.event_type === 'batch_stage_failed' ? 1 : 0;
    existing.durationMs += Number(event.data.duration_ms || 0);
    groups.set(label, existing);
  }

  console.log('  stages:');
  for (const [label, group] of [...groups.entries()].sort((a, b) => b[1].durationMs - a[1].durationMs)) {
    const failText = group.failed ? `, failed=${group.failed}` : '';
    console.log(`    ${label}: ${formatDuration(group.durationMs)} over ${group.count} call(s)${failText}`);
  }
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function readInteger(value, fallback) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.round(parsed));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

function parseArgValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  return argv[index + 1] || null;
}

function printHelp() {
  console.log(`How-to batch timing report

Usage:
  npm.cmd run timings
  npm.cmd run timings -- --limit 20
  npm.cmd run timings -- --id 12 --stages

Options:
  --limit N          Number of recent batch runs to show, default 10.
  --id N            Show one batch run by batch_runs.id.
  --stages          Include per-stage duration totals for each shown batch.
`);
}
