/**
 * clipMatcher
 *
 * Scoring + matching utilities for pairing scraped Higgsfield videos with
 * orphaned DB clips. Used by:
 *   - inline auto-recovery (single-asset scoreMatch)
 *   - CLI recover-from-history.js (batch matchAll with greedy assignment)
 *
 * Scoring philosophy:
 *   - Prompt similarity is the PRIMARY signal (Levenshtein-based, 0-100)
 *   - Timestamp delta is a SECONDARY signal (boosts confidence when prompts
 *     could be ambiguous, e.g., close-ups of the same character)
 *   - We use a single combined score 0-100 with confidence tiers so callers
 *     can apply different policies (auto-apply high, prompt user on medium)
 *
 * Why no semantic embeddings?
 *   - Prompts are 100+ chars typically — Levenshtein gives clean signal
 *   - Embeddings would need an extra API call per match
 *   - For our use case (matching a clip's exact prompt to its same prompt on
 *     Higgsfield), surface-level similarity is what we want
 */

/**
 * Score how well a scraped Higgsfield video matches an orphaned DB clip.
 *
 * @param {Object} scraped - { prompt, createdAtMs }
 * @param {Object} expected - { prompt, createdAtMs }
 * @param {Object} [options]
 * @param {number} [options.timestampWindowMs=600000] - ±10 min default
 * @returns {{ score: number, confidence: 'high'|'medium'|'low'|'none', breakdown: object }}
 */
function scoreMatch(scraped, expected, options = {}) {
  const { timestampWindowMs = 10 * 60 * 1000 } = options;

  // Defensive normalization
  const sPrompt = String(scraped.prompt || '').trim();
  const ePrompt = String(expected.prompt || '').trim();

  if (!sPrompt || !ePrompt) {
    return { score: 0, confidence: 'none', breakdown: { reason: 'empty prompt' } };
  }

  const promptSim = promptSimilarity(sPrompt, ePrompt);

  // Timestamp scoring: if both have timestamps, compute proximity. Otherwise
  // skip (don't penalize for missing data).
  let timestampScore = null;
  let timestampDeltaMs = null;
  if (scraped.createdAtMs && expected.createdAtMs) {
    timestampDeltaMs = Math.abs(scraped.createdAtMs - expected.createdAtMs);
    if (timestampDeltaMs <= timestampWindowMs) {
      // Within window: score 0-100 based on proximity (closer = higher)
      timestampScore = Math.max(0, 100 - (timestampDeltaMs / timestampWindowMs) * 100);
    } else {
      // Outside window: hard zero (this is probably from a different session)
      timestampScore = 0;
    }
  }

  // Combine: prompt is dominant (weight 0.85), timestamp adds confidence (0.15)
  // If no timestamp data, prompt similarity alone determines the score
  let combined;
  if (timestampScore != null) {
    combined = promptSim * 0.85 + timestampScore * 0.15;
  } else {
    combined = promptSim;
  }
  combined = Math.round(combined);

  const confidence = tierForScore(combined, timestampDeltaMs);

  return {
    score: combined,
    confidence,
    breakdown: {
      promptSimilarity: Math.round(promptSim),
      timestampDeltaMs,
      timestampScore: timestampScore != null ? Math.round(timestampScore) : null,
    },
  };
}

/**
 * Greedy batch matcher.
 * Each scraped video is claimed by at most one DB clip (no double-claiming).
 * Each DB clip is matched to at most one scraped video (its best).
 *
 * Algorithm:
 *   1. Score every (clip, video) pair
 *   2. Sort pairs by descending score
 *   3. Walk in order, claim if both clip and video unclaimed
 *
 * @param {Array} pendingClips - DB rows with { id, prompt_used, created_at }
 * @param {Array} scrapedVideos - { uuid, prompt, createdAtMs, cdnUrl? }
 * @param {Object} [options]
 * @returns {Array<{ asset, video, score, confidence }>}
 */
function matchAll(pendingClips, scrapedVideos, options = {}) {
  // Build all candidate pairs with scores
  const pairs = [];
  for (const clip of pendingClips) {
    for (const video of scrapedVideos) {
      const result = scoreMatch(
        { prompt: video.prompt, createdAtMs: video.createdAtMs },
        { prompt: clip.prompt_used || '', createdAtMs: clip.created_at ? new Date(clip.created_at).getTime() : null },
        options
      );
      if (result.confidence !== 'none') {
        pairs.push({ clip, video, ...result });
      }
    }
  }

  // Sort descending by score, then by confidence tier rank
  const tierRank = { high: 3, medium: 2, low: 1, none: 0 };
  pairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return tierRank[b.confidence] - tierRank[a.confidence];
  });

  // Greedy claim
  const claimedClips = new Set();
  const claimedVideos = new Set();
  const matches = [];

  for (const pair of pairs) {
    if (claimedClips.has(pair.clip.id)) continue;
    if (claimedVideos.has(pair.video.uuid)) continue;
    claimedClips.add(pair.clip.id);
    claimedVideos.add(pair.video.uuid);
    matches.push({
      asset: pair.clip,
      video: pair.video,
      score: pair.score,
      confidence: pair.confidence,
      breakdown: pair.breakdown,
    });
  }

  // Return matches sorted by clip order (predictable for UI display)
  matches.sort((a, b) => {
    if (a.asset.chapter !== b.asset.chapter) return a.asset.chapter - b.asset.chapter;
    return a.asset.line - b.asset.line;
  });

  return matches;
}

// ══════════════════════════════════════════════════════════
// INTERNAL — similarity + tier
// ══════════════════════════════════════════════════════════

/**
 * Compute prompt similarity 0-100. Normalizes whitespace + case + punctuation
 * before Levenshtein so cosmetic differences don't drop the score.
 */
function promptSimilarity(a, b) {
  const norm = (s) => s.toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return 100;
  if (!na || !nb) return 0;

  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 100;
  return Math.max(0, (1 - dist / maxLen) * 100);
}

/**
 * Two-row Levenshtein distance — same impl as ClipVerifier. Reused here to
 * keep recovery self-contained without depending on the verify module.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Bucket a combined score + timestamp delta into a confidence tier.
 *
 * High confidence requires BOTH:
 *   - Score ≥ 85
 *   - Timestamp within 10 min if available (or no timestamp data — neutral)
 *
 * Medium: 70-85% score, timestamp within 30 min
 * Low: ≥ 50% score
 * None: < 50% score
 */
function tierForScore(score, timestampDeltaMs) {
  if (score >= 85) {
    if (timestampDeltaMs == null || timestampDeltaMs <= 10 * 60 * 1000) return 'high';
    return 'medium'; // high score but timestamp suspicious — downgrade
  }
  if (score >= 70) {
    if (timestampDeltaMs == null || timestampDeltaMs <= 30 * 60 * 1000) return 'medium';
    return 'low';
  }
  if (score >= 50) return 'low';
  return 'none';
}

module.exports = { scoreMatch, matchAll, promptSimilarity, tierForScore };
