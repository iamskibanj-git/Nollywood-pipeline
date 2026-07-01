import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HiggsFieldAutomation } = require('../../src/main/automation/higgsfield.js');

export async function generateHiggsfieldImage({
  prompt,
  outputPath,
  aspectRatio = '1:1',
  projectDir,
  loginWaitMs = 0,
  onGenClicked = null,
  logger = console,
} = {}) {
  if (!prompt || !prompt.trim()) throw new Error('Image prompt is empty');
  if (!outputPath) throw new Error('outputPath is required');
  if (!projectDir) throw new Error('projectDir is required');

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const automation = new HiggsFieldAutomation(null, projectDir);
  try {
    await ensureSessionReady(automation, { loginWaitMs, logger });
    const started = Date.now();
    const genMeta = await automation.generateImage({
      prompt,
      outputPath,
      references: [],
      useUnlimited: true,
      aspectRatio,
      onGenClicked,
      requireAssetPromptMatchBeforeDownload: true,
      promptMatchMinSimilarity: 80,
      promptMatchMaxTilesToCheck: 10,
      promptMatchTimeoutMs: 120000,
    });

    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
      throw new Error(`Higgsfield reported success but output file is missing or tiny: ${outputPath}`);
    }

    await automation.saveSession().catch(() => {});
    return {
      ...genMeta,
      outputPath,
      generationDurationMs: genMeta?.generationDurationMs || (Date.now() - started),
    };
  } finally {
    await automation.close?.().catch(() => {});
  }
}

async function ensureSessionReady(automation, { loginWaitMs, logger }) {
  await automation.ensureBrowser();
  await automation.page.goto('https://higgsfield.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await automation.page.waitForTimeout(2500).catch(() => {});

  let preflight = await automation.preflightCheck();
  if (preflight?.ok) {
    await automation.saveSession().catch(() => {});
    logger.info?.('[HIGGSFIELD] Session verified');
    return;
  }

  if (!loginWaitMs) {
    throw new Error(`SESSION_EXPIRED: ${preflight?.reason || 'Higgsfield session is not ready'}. Re-run with --login-wait-sec 180.`);
  }

  logger.warn?.(`[HIGGSFIELD] Session not ready: ${preflight?.reason || 'unknown'}`);
  logger.warn?.(`[HIGGSFIELD] Waiting ${Math.round(loginWaitMs / 1000)}s for login/verification in the browser window...`);
  await automation.page.goto('https://higgsfield.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const deadline = Date.now() + loginWaitMs;
  let lastReason = preflight?.reason || 'not ready';
  while (Date.now() < deadline) {
    await automation.page.waitForTimeout(3000).catch(() => {});
    preflight = await automation.preflightCheck();
    if (preflight?.ok) {
      await automation.saveSession().catch(() => {});
      logger.info?.('[HIGGSFIELD] Session verified after login wait');
      return;
    }
    lastReason = preflight?.reason || lastReason;
  }

  throw new Error(`SESSION_EXPIRED: Higgsfield session still not ready after login wait: ${lastReason}`);
}
