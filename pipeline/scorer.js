import fs from 'node:fs/promises';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { pipelineConfig } from './config.js';
import { resolveAnthropicApiKey } from './credentials.js';

export const SYSTEM_PROMPT = `You are a viral Facebook content strategist specialising in "how to" pages.

Score, deduplicate, and rewrite the raw topic list into a ranked content plan.

Scoring criteria (in order):
1. Cross-source presence - appeared on 2+ sources/signals = strong signal
2. Proven/trending engagement - high-upvote Reddit monthly-top posts, comment counts, and Google Trends Rising/Breakout values = boost
3. Evergreen value - still useful in 6 months?
4. Facebook visual potential - can this become a striking image post?
5. Curiosity gap - does it create a "wait, really?" hook?

Reject topics even if they have source signal when they are unsafe, off-niche, or not useful as a public how-to post:
- dangerous/illegal instructions, weapons, explosives, self-harm, evading safety systems, or high-risk medical/legal/financial advice
- broad publisher/domain/UI labels, ad-slot labels, image alt-text fragments, or topics without a clear practical reader benefit
- topics that belong to another niche unless the angle can be rewritten to fit the current Facebook page safely

For Fix It / repair content, prefer low-risk household fixes. Do not rank topics that teach readers to handle live electrical wiring, garage door springs, gas/fuel systems, structural supports, vehicle safety systems, toxic chemicals, or appliance internals. You may include safety-warning/when-to-call-a-pro posts only if they give no procedural dangerous steps.

Return ONLY a valid JSON array, no markdown, no explanation.
Each item:
{
  "rank": number,
  "topic": string,
  "hook": string,
  "image_prompt": string,
  "sources": [string],
  "score_reason": string
}

Hook rules:
- max 20 words
- curiosity gap
- sentence case
- no emoji
- never start with "Did you know" or "Here's how"

Hook examples (match this tone):
- "Most people replace this the wrong way and it costs them twice as much."
- "Three ingredients you already have will fix that in under ten minutes."
- "The reason your plants keep dying has nothing to do with watering."

Image prompt rules:
- max 30 words
- vivid real scene
- clean bright editorial style like high-quality Pinterest

Image prompt examples:
- "Overhead shot of hands fixing a leaky pipe under a sink, soft morning light, wrench and white cloth on tiled floor"
- "Close-up of a cast iron pan with golden garlic and cherry tomatoes, steam rising, rustic wood surface"

Return exactly 30 items ranked 1-30.`;

export async function scoreTopics({ config = pipelineConfig, logger = console, db = null, runId = null } = {}) {
  const log = makeLogger(logger);
  const apiKey = resolveAnthropicApiKey({ logger: log });
  if (!apiKey) {
    throw new Error('Claude/Anthropic API key required. Set ANTHROPIC_API_KEY or save a Claude key in the existing Electron app settings.');
  }

  const raw = db?.hasRawTopics?.(runId)
    ? db.exportRawTopics(runId)
    : JSON.parse(await fs.readFile(config.files.rawTopics, 'utf8'));
  if (db && runId && !db.hasRawTopics(runId)) {
    db.saveRawTopics(runId, raw);
  }
  const client = new Anthropic({ apiKey });
  const pages = [];

  for (const pageInfo of raw.pages || []) {
    const niche = config.niches.find(item => item.id === pageInfo.niche_id) || {};
    const rawItems = pageInfo.items || [];
    if (rawItems.length === 0) {
      log.warn(`[SCORER] ${pageInfo.niche_id}: no raw topics, skipping`);
      continue;
    }

    log.info(`[SCORER] ${pageInfo.niche_id}: scoring ${rawItems.length} raw item(s)`);
    let rawResponse = '';
    try {
      const response = await client.messages.create({
        model: config.scorer.model,
        max_tokens: config.scorer.maxTokens,
        temperature: config.scorer.temperature,
        system: SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: buildUserPrompt({
            nicheId: pageInfo.niche_id,
            nicheName: pageInfo.niche_name,
            facebookPageName: pageInfo.facebook_page_name || niche.facebook_page_name,
            rawItems,
            expectedItems: config.scorer.outputItemsPerNiche,
          }),
        }],
      });

      rawResponse = extractText(response);
      const topics = parseTopicArray(rawResponse);
      const normalizedTopics = normalizeTopics(topics, config.scorer.outputItemsPerNiche);
      if (normalizedTopics.length !== config.scorer.outputItemsPerNiche) {
        log.warn(`[SCORER] ${pageInfo.niche_id}: expected ${config.scorer.outputItemsPerNiche}, got ${normalizedTopics.length}`);
      }

      pages.push({
        niche_id: pageInfo.niche_id,
        niche_name: pageInfo.niche_name,
        facebook_page_name: pageInfo.facebook_page_name || niche.facebook_page_name || pageInfo.niche_name,
        topics: normalizedTopics,
      });
      log.info(`[SCORER] ${pageInfo.niche_id}: accepted ${normalizedTopics.length} scored topic(s)`);
    } catch (error) {
      await logRawScorerFailure(config.files.logsDir, pageInfo.niche_id, rawResponse, error);
      log.error(`[SCORER] ${pageInfo.niche_id}: scoring failed, skipping niche`, error.message);
    }

    await delay(config.scorer.delayBetweenNichesMs || 1500);
  }

  const outputJson = {
    generated_at: new Date().toISOString(),
    run_id: runId || raw.run_id || null,
    pages,
  };
  db?.saveScoredTopics?.(runId, outputJson);
  await fs.writeFile(config.files.scoredTopics, `${JSON.stringify(outputJson, null, 2)}\n`, 'utf8');
  log.info(`[SCORER] Wrote ${config.files.scoredTopics}`, { pages: pages.length });
  return outputJson;
}

function buildUserPrompt({ nicheId, nicheName, facebookPageName, rawItems, expectedItems }) {
  return `NICHE
id: ${nicheId}
name: ${nicheName}
facebook_page_name: ${facebookPageName || nicheName}

TASK
Score, deduplicate, and rewrite these raw topics into exactly ${expectedItems} ranked Facebook image-post topics for this page.
Use sources, source_count, signal_count, signals, and raw engagement details when present.
Reddit items include upvotes and comment counts; comment count is a secondary engagement signal.
Google Trends items include seed, section, tab, and value; Breakout is the strongest rising signal.
Pinterest items include autocomplete intent and pin-title validation signals, but no reliable public engagement count.
YouTube items include autocomplete seed and position; autocomplete position is search-demand signal, not numeric engagement.
Quora items are pre-validated curiosity-gap questions; weight their phrasing highly when writing hooks.

RAW TOPICS
${JSON.stringify(rawItems, null, 2)}`;
}

function extractText(response) {
  return (response.content || [])
    .map(block => block?.type === 'text' ? block.text : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseTopicArray(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    const value = JSON.parse(cleaned);
    if (!Array.isArray(value)) throw new Error('Claude response JSON is not an array');
    return value;
  } catch (directError) {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) throw directError;
    const value = JSON.parse(match[0]);
    if (!Array.isArray(value)) throw new Error('Claude response JSON is not an array');
    return value;
  }
}

function normalizeTopics(topics, expectedItems) {
  return (topics || [])
    .map((item, index) => ({
      rank: Number.isFinite(Number(item.rank)) ? Number(item.rank) : index + 1,
      topic: cleanText(item.topic),
      hook: cleanText(item.hook),
      image_prompt: cleanText(item.image_prompt),
      sources: Array.isArray(item.sources) ? item.sources.map(cleanText).filter(Boolean) : [],
      score_reason: cleanText(item.score_reason),
    }))
    .filter(item => item.topic && item.hook && item.image_prompt)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, expectedItems)
    .map((item, index) => ({ ...item, rank: index + 1 }));
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

async function logRawScorerFailure(logsDir, nicheId, rawResponse, error) {
  await fs.mkdir(logsDir, { recursive: true });
  const filePath = path.join(logsDir, `scorer_failed_${safeName(nicheId)}_${Date.now()}.txt`);
  const body = [
    `ERROR: ${error?.stack || error?.message || error}`,
    '',
    'RAW RESPONSE:',
    rawResponse || '(empty)',
  ].join('\n');
  await fs.writeFile(filePath, body, 'utf8').catch(() => {});
}

function safeName(value) {
  return String(value || 'niche').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeLogger(logger) {
  return {
    info: (message, details) => callLogger(logger, 'info', message, details),
    warn: (message, details) => callLogger(logger, 'warn', message, details),
    error: (message, details) => callLogger(logger, 'error', message, details),
  };
}

function callLogger(logger, level, message, details) {
  const fn = logger?.[level] || logger?.log || console.log;
  if (details) fn.call(logger, message, details);
  else fn.call(logger, message);
}
