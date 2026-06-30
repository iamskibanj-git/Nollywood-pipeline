import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pipelineDir = path.dirname(fileURLToPath(import.meta.url));
process.chdir(pipelineDir);
loadDotEnv(path.join(pipelineDir, '.env'));

const [
  { pipelineConfig },
  { createRunLogger },
  { openPipelineDb },
  { scrapeTopics },
  { scoreTopics },
  { buildQueue },
] = await Promise.all([
  import('./config.js'),
  import('./logger.js'),
  import('./db.js'),
  import('./scraper.js'),
  import('./scorer.js'),
  import('./queue.js'),
]);

const rawArgs = process.argv.slice(2);
const args = new Set(rawArgs);
if (args.has('--no-login-pause')) pipelineConfig.browser.pauseForManualLogin = false;
if (args.has('--headless')) pipelineConfig.browser.headless = true;
const loginWaitMs = parseLoginWaitMs(rawArgs);
if (loginWaitMs !== null) {
  pipelineConfig.browser.loginWaitMs = loginWaitMs;
}
const userDataDir = parseArgValue(rawArgs, '--user-data-dir') ?? parseArgValue(rawArgs, '--profile-dir');
if (userDataDir) {
  pipelineConfig.browser.userDataDir = path.isAbsolute(userDataDir)
    ? userDataDir
    : path.join(pipelineDir, userDataDir);
}

const logger = createRunLogger({ logsDir: pipelineConfig.files.logsDir });
const filterResult = applyCliFilters(pipelineConfig, rawArgs);
for (const warning of filterResult.warnings) logger.warn(warning);
if (filterResult.errors.length > 0) {
  for (const error of filterResult.errors) logger.error(error);
  process.exit(1);
}

let hadError = false;
const enabledStages = {
  scraper: !args.has('--skip-scrape'),
  scorer: !args.has('--skip-score'),
  queue: !args.has('--skip-queue'),
};
const hasEnabledStage = Object.values(enabledStages).some(Boolean);
const pipelineDb = hasEnabledStage ? await openPipelineDb({ config: pipelineConfig, logger }) : null;
const runId = pipelineDb?.createRun?.({
  options: {
    args: rawArgs,
    noLoginPause: args.has('--no-login-pause'),
    headless: args.has('--headless'),
    loginWaitMs: pipelineConfig.browser.loginWaitMs || 0,
    userDataDir: pipelineConfig.browser.userDataDir || null,
    niches: pipelineConfig.niches.map(niche => niche.id),
    sources: pipelineConfig.scraper.sources || null,
  },
});

logger.info('[RUN] How-to Facebook content research pipeline starting');
logger.info('[RUN] Log file', logger.logPath);
if (filterResult.applied.niches) logger.info('[RUN] Niche filter', filterResult.applied.niches);
if (filterResult.applied.sources) logger.info('[RUN] Source filter', filterResult.applied.sources);
if (runId) logger.info('[RUN] DB run id', runId);

try {
  await runStage('scraper', enabledStages.scraper, () => scrapeTopics({ config: pipelineConfig, logger, db: pipelineDb, runId }));
  await runStage('scorer', enabledStages.scorer, () => scoreTopics({ config: pipelineConfig, logger, db: pipelineDb, runId }));
  await runStage('queue', enabledStages.queue, () => buildQueue({ config: pipelineConfig, logger, db: pipelineDb, runId }));

  pipelineDb?.finishRun?.(runId, { ok: !hadError });
  logger.info('[RUN] Pipeline finished', { ok: !hadError, runId: runId || null });
  if (hadError) process.exitCode = 1;
} finally {
  pipelineDb?.close?.();
}

async function runStage(name, enabled, fn) {
  if (!enabled) {
    logger.info(`[RUN] Stage skipped: ${name}`);
    return;
  }

  const started = Date.now();
  logger.stageStart(name);
  pipelineDb?.stageStart?.(runId, name);
  try {
    const result = await fn();
    const details = {
      duration_sec: Math.round((Date.now() - started) / 1000),
      summary: summarizeResult(result),
    };
    logger.stageEnd(name, details);
    pipelineDb?.stageEnd?.(runId, name, details);
  } catch (error) {
    hadError = true;
    logger.error(`[RUN] Stage failed: ${name}`, error);
    pipelineDb?.stageFailed?.(runId, name, error);
  }
}

function summarizeResult(result) {
  if (Array.isArray(result)) return { rows: result.length };
  if (result?.totals) return result.totals;
  if (Array.isArray(result?.pages)) return { pages: result.pages.length };
  return {};
}

function applyCliFilters(config, argv) {
  const result = { errors: [], warnings: [], applied: {} };
  const nicheValues = parseArgList(argv, '--niche');
  const sourceValues = parseArgList(argv, '--sources');

  if (nicheValues.length > 0 && !nicheValues.some(value => value.toLowerCase() === 'all')) {
    const requested = new Set(nicheValues.map(normalizeToken));
    const selected = config.niches.filter(niche => {
      const keys = [
        niche.id,
        niche.name,
        niche.facebook_page_name,
      ].map(normalizeToken);
      return keys.some(key => requested.has(key));
    });
    if (selected.length === 0) {
      result.errors.push(`[RUN] No niches matched --niche ${nicheValues.join(', ')}`);
    } else {
      config.niches = selected;
      result.applied.niches = selected.map(niche => niche.id);
    }
  }

  if (sourceValues.length > 0 && !sourceValues.some(value => value.toLowerCase() === 'all')) {
    const validSources = new Set(['reddit', 'google_trends', 'pinterest', 'youtube', 'quora']);
    const aliases = {
      google: 'google_trends',
      trends: 'google_trends',
      googletrends: 'google_trends',
      google_trends: 'google_trends',
      yt: 'youtube',
      youtube: 'youtube',
      reddit: 'reddit',
      pinterest: 'pinterest',
      quora: 'quora',
    };
    const normalizedSources = [];
    for (const value of sourceValues) {
      const key = normalizeToken(value).replace(/-/g, '_');
      const source = aliases[key] || key;
      if (!validSources.has(source)) {
        result.errors.push(`[RUN] Unknown source in --sources: ${value}`);
        continue;
      }
      if (!normalizedSources.includes(source)) normalizedSources.push(source);
    }
    if (normalizedSources.length > 0) {
      config.scraper.sources = normalizedSources;
      result.applied.sources = normalizedSources;
    }
  }

  if (config.niches.length === 0) {
    result.errors.push('[RUN] No niches selected.');
  }

  return result;
}

function parseArgList(argv, flag) {
  const out = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === flag && argv[index + 1]) {
      out.push(...splitArgList(argv[index + 1]));
      index++;
    } else if (arg.startsWith(`${flag}=`)) {
      out.push(...splitArgList(arg.slice(flag.length + 1)));
    }
  }
  return out.map(value => value.trim()).filter(Boolean);
}

function parseLoginWaitMs(argv) {
  const msValue = parseArgValue(argv, '--login-wait-ms');
  if (msValue !== null) return readNonNegativeInteger(msValue, '--login-wait-ms');

  const secValue = parseArgValue(argv, '--login-wait-sec') ?? parseArgValue(argv, '--login-wait-seconds');
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

function readNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return Math.round(parsed);
}

function splitArgList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    value = value.replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}
