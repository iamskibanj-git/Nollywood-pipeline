import { pipelineConfig } from './config.js';

const TOOL_SECTION_PATTERN = /\b(what you need|you(?:'|')ll need|you will need|tools?|materials?|ingredients?)\b/i;
const STEP_LINE_PATTERN = /^\s*(?:\d{1,2}[.)]|step\s+\d{1,2}\b)\s+/i;
const SAFETY_PATTERN = /\b(safety|caution|careful|warning|quick check|call a pro|call a professional|when to call|do not|don't|avoid|medical|doctor|trainer|licensed|unplug|turn off|shut off|test first|patch test|spot test|label|ventilate|discard|spoil|spoiled|food safety|refrigerate|raw|undercooked)\b/i;
const CTA_PATTERN = /\b(save this|try this|bookmark|follow|share|comment|tell us|send this|keep this)\b/i;
const UNSAFE_MIXING_PATTERNS = [
  /\b(?:mix|combine|add|blend)\b[^.\n]{0,80}\bbleach\b[^.\n]{0,80}\b(?:vinegar|ammonia)\b/i,
  /\b(?:mix|combine|add|blend)\b[^.\n]{0,80}\b(?:vinegar|ammonia)\b[^.\n]{0,80}\bbleach\b/i,
];
const NEGATED_SAFETY_WARNING_PATTERN = /\b(?:never|do not|don't|dont|avoid|should not|must not|without)\b/i;
const PLACEHOLDER_PATTERNS = [
  /\bsave this one for later\b/i,
  /\bhow to .+\.\s*save this\b/i,
  /\bmore details soon\b/i,
  /\bcoming soon\b/i,
  /\bcaption goes here\b/i,
  /\bdrop a\s+(?:below|in the comments)\b/i,
];
const ABSOLUTE_TECH_CLAIM_PATTERNS = [
  /\bfree forever\b/i,
  /\breplace (?:all|every) paid apps?\b/i,
  /\bnever pay for software again\b/i,
  /\bdoes (?:it|this|everything) better than paid\b/i,
];
const SKINCARE_OVERCLAIM_PATTERNS = [
  /\b(?:cure|treat|erase|get rid of)\b[^.\n]{0,80}\b(?:acne|eczema|rosacea|wrinkles|dark spots|hyperpigmentation)\b/i,
  /\b(?:clear skin|glass skin|younger skin|wrinkle-free)\b[^.\n]{0,80}\b(?:guaranteed|overnight|fast|in \d+\s*(?:days?|weeks?))\b/i,
];

export function validateCaptionForScheduling(caption, { config = pipelineConfig } = {}) {
  const contentConfig = config.content || {};
  const cleaned = cleanTextBlock(caption);
  const lines = cleaned.split('\n').map(line => line.trim()).filter(Boolean);
  const metrics = {
    chars: cleaned.length,
    lines: lines.length,
    step_count: countStepLines(lines),
    has_tools_section: TOOL_SECTION_PATTERN.test(cleaned),
    has_safety_note: SAFETY_PATTERN.test(cleaned),
    has_cta: CTA_PATTERN.test(cleaned),
    has_placeholder_phrase: PLACEHOLDER_PATTERNS.some(pattern => pattern.test(cleaned)),
    has_unsafe_cleaner_mix: hasUnsafeCleanerMix(cleaned),
    has_absolute_tech_claim: ABSOLUTE_TECH_CLAIM_PATTERNS.some(pattern => pattern.test(cleaned)),
    has_skincare_overclaim: SKINCARE_OVERCLAIM_PATTERNS.some(pattern => pattern.test(cleaned)),
    max_chars: Number(contentConfig.maxCaptionChars || 1800),
    min_chars: Number(contentConfig.minCaptionChars || 450),
    min_step_count: Number(contentConfig.minStepCount || 3),
  };
  const reasons = [];

  if (!cleaned) reasons.push('caption is empty');
  if (metrics.chars < metrics.min_chars) reasons.push(`caption is too short (${metrics.chars}/${metrics.min_chars} chars)`);
  if (metrics.max_chars > 0 && metrics.chars > metrics.max_chars) reasons.push(`caption is too long (${metrics.chars}/${metrics.max_chars} chars)`);
  if (metrics.step_count < metrics.min_step_count) reasons.push(`caption has fewer than ${metrics.min_step_count} numbered steps`);
  if (!metrics.has_tools_section) reasons.push('caption is missing a tools/materials/ingredients section');
  if (!metrics.has_safety_note) reasons.push('caption is missing a safety/caution/pro note');
  if (metrics.has_unsafe_cleaner_mix) reasons.push('caption suggests an unsafe cleaner mixture');
  if (metrics.has_absolute_tech_claim) reasons.push('caption contains an absolute/free-forever tech claim');
  if (metrics.has_skincare_overclaim) reasons.push('caption contains a skincare treatment/result overclaim');
  if (metrics.has_placeholder_phrase && metrics.step_count < metrics.min_step_count) {
    reasons.push('caption looks like placeholder teaser copy');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics,
    caption: cleaned,
  };
}

export function cleanTextBlock(value) {
  return normalizeReadableText(value)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function countStepLines(lines) {
  return lines.filter(line => STEP_LINE_PATTERN.test(line) && hasActionVerb(line)).length;
}

function hasUnsafeCleanerMix(cleaned) {
  const chunks = cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map(chunk => chunk.trim())
    .filter(Boolean);
  return chunks.some(chunk => (
    UNSAFE_MIXING_PATTERNS.some(pattern => pattern.test(chunk)) &&
    !NEGATED_SAFETY_WARNING_PATTERN.test(chunk)
  ));
}

function hasActionVerb(line) {
  return /\b(add|apply|attach|bake|blend|boil|cancel|check|choose|clean|clip|combine|compare|cover|cut|disconnect|drain|dry|ease|fill|find|fit|fold|heat|hold|increase|install|label|lift|limit|log|loosen|mark|measure|mix|note|open|patch|pause|pick|place|plan|plant|press|pull|push|reduce|remove|replace|review|rinse|roll|rub|sand|save|scrub|search|seal|set|shut|sign|slide|spray|start|stir|stop|stretch|test|tighten|track|trim|turn|unplug|upload|use|vary|verify|wait|walk|wash|water|wipe|wrap|write)\b/i.test(line);
}
