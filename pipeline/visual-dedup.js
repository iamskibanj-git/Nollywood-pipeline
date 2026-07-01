import crypto from 'node:crypto';
import { pipelineConfig } from './config.js';

const DEFAULT_STATUSES = [
  'scheduled',
  'scheduling',
  'qa_done',
  'content_done',
  'image_done',
  'image_generating',
];

const STOPWORDS = new Set([
  'about',
  'above',
  'across',
  'after',
  'again',
  'against',
  'along',
  'also',
  'with',
  'without',
  'within',
  'while',
  'where',
  'which',
  'that',
  'this',
  'these',
  'those',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'using',
  'uses',
  'use',
  'show',
  'shows',
  'showing',
  'image',
  'photo',
  'photograph',
  'realistic',
  'natural',
  'lighting',
  'bright',
  'clean',
  'simple',
  'generic',
  'blank',
  'unlabeled',
  'text',
  'overlay',
  'watermark',
  'brand',
  'logo',
  'logos',
  'words',
  'readable',
  'social',
  'post',
  'frame',
  'frames',
  'mockup',
]);

const SYNONYMS = new Map([
  ['flatlay', 'flat-lay'],
  ['flatlays', 'flat-lay'],
  ['topdown', 'overhead'],
  ['top', 'overhead'],
  ['birds', 'overhead'],
  ['birdseye', 'overhead'],
  ['countertop', 'counter'],
  ['worktop', 'counter'],
  ['workbench', 'bench'],
  ['desktop', 'desk'],
  ['tabletop', 'table'],
  ['cellphone', 'phone'],
  ['mobile', 'phone'],
  ['smartphone', 'phone'],
  ['hands', 'hand'],
  ['fingers', 'finger'],
  ['screws', 'screw'],
  ['screwdrivers', 'screwdriver'],
  ['plants', 'plant'],
  ['vegetables', 'vegetable'],
  ['veggies', 'vegetable'],
  ['dumbbells', 'dumbbell'],
  ['weights', 'weight'],
  ['laptops', 'laptop'],
  ['bowls', 'bowl'],
  ['pots', 'pot'],
  ['pans', 'pan'],
  ['jars', 'jar'],
  ['bottles', 'bottle'],
  ['needles', 'needle'],
  ['brushes', 'brush'],
  ['cloths', 'cloth'],
  ['towels', 'towel'],
]);

const COMPOSITION_PATTERNS = [
  ['overhead', /\b(overhead|top[- ]?down|flat[- ]?lay|bird'?s[- ]?eye)\b/i],
  ['macro-detail', /\b(macro|extreme close[- ]?up|tight detail|detail shot)\b/i],
  ['close-up', /\b(close[- ]?up|tight shot|close view)\b/i],
  ['side-angle', /\b(side[- ]?angle|side view|three[- ]?quarter|3\/4|angled view)\b/i],
  ['wide-context', /\b(wide shot|room scene|environmental|full workspace|context shot)\b/i],
  ['before-after', /\b(before[- ]?and[- ]?after|split arrangement|left and right)\b/i],
  ['tabletop', /\b(table|counter|bench|desk|surface)\b/i],
];

const SETTING_PATTERNS = [
  ['kitchen', /\b(kitchen|stove|oven|pantry|cutting board|counter)\b/i],
  ['workshop', /\b(workshop|workbench|garage|toolbox|bench)\b/i],
  ['bathroom', /\b(bathroom|sink|toilet|shower|tap|faucet)\b/i],
  ['garden', /\b(garden|soil|potting|plant bed|greenhouse|yard|compost)\b/i],
  ['gym-home', /\b(gym|mat|workout|exercise|home floor|dumbbell)\b/i],
  ['craft-room', /\b(craft|sewing|fabric|woodworking|paint|glue|scissors)\b/i],
  ['desk-office', /\b(desk|office|workspace|laptop|notebook|keyboard)\b/i],
  ['vanity-style', /\b(vanity|mirror|skincare|fashion|closet|wardrobe|bath shelf)\b/i],
];

const PROP_PATTERNS = [
  ['hand-action', /\b(hand|finger|pressing|holding|gripping|placing|pouring|mixing|cutting|stirring)\b/i],
  ['tools', /\b(tool|screw|screwdriver|wrench|pliers|drill|hammer|tape|rubber band)\b/i],
  ['food', /\b(food|meal|bowl|plate|pot|pan|ingredient|vegetable|rice|pasta|sauce|knife)\b/i],
  ['plants', /\b(plant|seed|soil|pot|leaf|watering|compost|garden)\b/i],
  ['money', /\b(money|cash|coin|budget|receipt|calculator|wallet|spreadsheet)\b/i],
  ['fitness', /\b(workout|mat|dumbbell|weight|shoe|resistance band|timer)\b/i],
  ['craft', /\b(craft|fabric|thread|needle|wood|paint|brush|glue|jar|paper)\b/i],
  ['tech', /\b(laptop|phone|tablet|screen|keyboard|cable|device|app|interface)\b/i],
  ['beauty', /\b(skincare|cream|bottle|jar|brush|comb|fabric|outfit|hanger|mirror)\b/i],
];

const VARIATION_STRATEGIES = [
  'Use an eye-level three-quarter angle instead of an overhead flat lay; show the key action mid-process with only two or three essential props.',
  'Use a tight macro detail of the exact contact point or technique, shallow depth of field, with the background kept plain and secondary props pushed out of focus.',
  'Use a wider environmental shot that places the action in a real room or workspace, with the subject centered and the background uncluttered.',
  'Use a side-angle documentary photo with natural shadows and visible depth, avoiding perfectly arranged tabletop symmetry.',
  'Use a before-and-after physical arrangement without text: the problem object on one side and the improved result on the other, separated by empty space.',
  'Use a person performing the action from a natural shoulder or torso perspective when appropriate, rather than only isolated hands over a surface.',
];

export function prepareVisualPromptForGeneration(db, post, {
  config = pipelineConfig,
  runId = post?.run_id || null,
  persist = false,
  logger = console,
  candidatePrompt = post?.image_prompt || '',
} = {}) {
  const basePrompt = cleanText(candidatePrompt);
  const plan = buildVisualDedupePlan(db, post, { config, runId, candidatePrompt: basePrompt });
  if (persist && plan.changed) {
    const now = isoNow();
    db.run(
      `UPDATE posts
       SET image_prompt = ?, visual_fingerprint = ?, visual_dedupe_reason = ?, visual_dedupe_checked_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        plan.prompt,
        JSON.stringify(plan.fingerprint),
        plan.reason || null,
        now,
        now,
        post.id,
      ]
    );
  } else if (persist) {
    const now = isoNow();
    db.run(
      `UPDATE posts
       SET visual_fingerprint = ?, visual_dedupe_reason = ?, visual_dedupe_checked_at = ?, updated_at = ?
       WHERE id = ?`,
      [JSON.stringify(plan.fingerprint), plan.reason || null, now, now, post.id]
    );
  }
  if (plan.changed) {
    logger?.warn?.(`[VISUAL DEDUP] Post #${post.id} prompt varied: ${plan.reason}`);
  }
  return plan;
}

export function buildVisualDedupePlan(db, post, {
  config = pipelineConfig,
  runId = post?.run_id || null,
  candidatePrompt = post?.image_prompt || '',
} = {}) {
  const visualConfig = config.visualDedup || {};
  const enabled = visualConfig.enabled !== false;
  const basePrompt = cleanText(candidatePrompt);
  const fingerprint = buildVisualFingerprint(basePrompt);
  if (/\bVisual variation:/i.test(basePrompt)) {
    return {
      changed: false,
      already_varied: true,
      prompt: basePrompt,
      original_prompt: basePrompt,
      fingerprint,
      match: null,
      reason: 'existing visual variation retained',
    };
  }
  if (!enabled || !db || !post?.id || !basePrompt) {
    return {
      changed: false,
      prompt: basePrompt,
      original_prompt: basePrompt,
      fingerprint,
      match: null,
      reason: null,
    };
  }

  const match = findSimilarVisualPrompt(db, post, fingerprint, { config, runId });
  if (!match) {
    return {
      changed: false,
      prompt: basePrompt,
      original_prompt: basePrompt,
      fingerprint,
      match: null,
      reason: null,
    };
  }

  const strategy = chooseVariationStrategy(post, fingerprint, match);
  const reason = `similar to post #${match.post_id} (${match.niche_id}, ${Math.round(match.score * 100)}%, ${match.reason})`;
  const prompt = cleanPrompt([
    basePrompt,
    `Visual variation: ${strategy}`,
    `Avoid repeating the recent ${match.fingerprint.composition || 'similar'} composition${match.fingerprint.setting ? ` in a ${match.fingerprint.setting} setting` : ''}; make the angle, subject distance, prop layout, lighting, and background visibly distinct.`,
  ].join(' '));

  return {
    changed: true,
    prompt,
    original_prompt: basePrompt,
    fingerprint: buildVisualFingerprint(prompt),
    base_fingerprint: fingerprint,
    match,
    reason,
    strategy,
  };
}

export function findSimilarVisualPrompt(db, post, fingerprint, {
  config = pipelineConfig,
  runId = post?.run_id || null,
} = {}) {
  const visualConfig = config.visualDedup || {};
  const statuses = Array.isArray(visualConfig.statuses) && visualConfig.statuses.length
    ? visualConfig.statuses
    : DEFAULT_STATUSES;
  const recentLimit = Number(visualConfig.recentLimit || 80);
  const sameNicheThreshold = Number(visualConfig.sameNicheThreshold || 0.64);
  const globalThreshold = Number(visualConfig.globalThreshold || 0.74);
  const params = [];
  const where = [
    'id <> ?',
    'image_prompt IS NOT NULL',
    `status IN (${statuses.map(() => '?').join(', ')})`,
  ];
  params.push(Number(post.id), ...statuses);
  if (runId) {
    where.push('run_id = ?');
    params.push(runId);
  }
  const rows = db.queryAll(
    `SELECT id, run_id, niche_id, status, topic, image_prompt, visual_fingerprint,
            scheduled_at, quality_checked_at, generated_at, updated_at, created_at
     FROM posts
     WHERE ${where.join(' AND ')}
     ORDER BY COALESCE(scheduled_at, quality_checked_at, generated_at, updated_at, created_at) DESC
     LIMIT ?`,
    [...params, recentLimit]
  );

  let best = null;
  for (const row of rows) {
    const candidateFingerprint = parseFingerprint(row.visual_fingerprint) || buildVisualFingerprint(row.image_prompt);
    const scoreInfo = visualSimilarity(fingerprint, candidateFingerprint);
    const sameNiche = row.niche_id === post.niche_id;
    const threshold = sameNiche ? sameNicheThreshold : globalThreshold;
    if (scoreInfo.score < threshold) continue;
    const candidate = {
      post_id: row.id,
      run_id: row.run_id,
      niche_id: row.niche_id,
      status: row.status,
      topic: row.topic,
      score: scoreInfo.score,
      reason: scoreInfo.reason,
      same_niche: sameNiche,
      fingerprint: candidateFingerprint,
      threshold,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

export function buildVisualFingerprint(value) {
  const text = cleanText(value).toLowerCase();
  const tokens = visualTokens(text);
  const composition = firstPattern(text, COMPOSITION_PATTERNS) || 'unspecified';
  const setting = firstPattern(text, SETTING_PATTERNS) || 'unspecified';
  const props = allPatterns(text, PROP_PATTERNS);
  const actor = /\b(person|woman|man|adult|model|someone|torso|shoulder)\b/i.test(text)
    ? 'person'
    : /\b(hand|hands|finger|fingers)\b/i.test(text)
      ? 'hands'
      : 'object-only';
  const family = [composition, setting, actor, ...props].filter(Boolean).join('|');
  return {
    hash: hashText([family, ...tokens].join(' ')),
    composition,
    setting,
    actor,
    props,
    tokens,
    family,
  };
}

export function visualSimilarity(left, right) {
  const tokenScore = jaccard(left.tokens, right.tokens);
  const propScore = jaccard(left.props, right.props);
  const compositionScore = left.composition && left.composition === right.composition && left.composition !== 'unspecified' ? 1 : 0;
  const settingScore = left.setting && left.setting === right.setting && left.setting !== 'unspecified' ? 1 : 0;
  const actorScore = left.actor && left.actor === right.actor ? 1 : 0;
  const score = (tokenScore * 0.52) + (propScore * 0.16) + (compositionScore * 0.14) + (settingScore * 0.12) + (actorScore * 0.06);
  const reasons = [];
  if (compositionScore) reasons.push(`same ${left.composition} angle`);
  if (settingScore) reasons.push(`same ${left.setting} setting`);
  if (propScore >= 0.5) reasons.push('overlapping prop family');
  if (tokenScore >= 0.45) reasons.push('overlapping prompt tokens');
  if (actorScore && left.actor !== 'object-only') reasons.push(`same ${left.actor} actor framing`);
  return {
    score,
    tokenScore,
    propScore,
    compositionScore,
    settingScore,
    actorScore,
    reason: reasons.length ? reasons.join(', ') : 'prompt similarity',
  };
}

export function summarizeVisualPlan(plan) {
  return {
    changed: Boolean(plan?.changed),
    reason: plan?.reason || null,
    strategy: plan?.strategy || null,
    match: plan?.match
      ? {
          post_id: plan.match.post_id,
          niche_id: plan.match.niche_id,
          status: plan.match.status,
          score: Number(plan.match.score.toFixed(4)),
          topic: plan.match.topic,
          reason: plan.match.reason,
        }
      : null,
    fingerprint: plan?.fingerprint || null,
  };
}

function visualTokens(text) {
  const rough = String(text || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 -]+/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean)
    .map(token => SYNONYMS.get(token) || singularize(token));
  return Array.from(new Set(rough))
    .filter(token => token.length > 2)
    .filter(token => !STOPWORDS.has(token))
    .sort();
}

function singularize(token) {
  if (SYNONYMS.has(token)) return SYNONYMS.get(token);
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('es') && token.length > 4) return token.slice(0, -2);
  if (token.endsWith('s') && token.length > 4) return token.slice(0, -1);
  return token;
}

function firstPattern(text, patterns) {
  return patterns.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function allPatterns(text, patterns) {
  return patterns
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label)
    .sort();
}

function chooseVariationStrategy(post, fingerprint, match) {
  const blockedComposition = match?.fingerprint?.composition || fingerprint.composition;
  let pool = VARIATION_STRATEGIES;
  if (blockedComposition === 'overhead' || blockedComposition === 'tabletop') {
    pool = VARIATION_STRATEGIES.filter(strategy => !/overhead|tabletop/i.test(strategy));
  }
  if (blockedComposition === 'macro-detail' || blockedComposition === 'close-up') {
    pool = VARIATION_STRATEGIES.filter(strategy => !/macro|tight/i.test(strategy));
  }
  if (!pool.length) pool = VARIATION_STRATEGIES;
  const key = `${post?.id || ''}:${match?.post_id || ''}:${fingerprint.hash}`;
  const index = Number.parseInt(hashText(key).slice(0, 8), 16) % pool.length;
  return pool[index];
}

function parseFingerprint(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || !Array.isArray(parsed.tokens)) return null;
    return {
      hash: parsed.hash || hashText(String(parsed.family || parsed.tokens.join(' '))),
      composition: parsed.composition || 'unspecified',
      setting: parsed.setting || 'unspecified',
      actor: parsed.actor || 'object-only',
      props: Array.isArray(parsed.props) ? parsed.props : [],
      tokens: parsed.tokens,
      family: parsed.family || '',
    };
  } catch (_) {
    return null;
  }
}

function jaccard(leftValues, rightValues) {
  const left = new Set(leftValues || []);
  const right = new Set(rightValues || []);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function cleanPrompt(value) {
  return cleanText(value)
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/([.!?]){2,}/g, '$1')
    .slice(0, 1800);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isoNow() {
  return new Date().toISOString();
}
