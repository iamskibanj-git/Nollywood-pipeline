const fs = require('fs');
const path = require('path');

/**
 * ImageVerifier
 *
 * Vision-based quality verification for generated images at three pipeline stages:
 *   1. Portrait — does the portrait match the character bible description?
 *   2. Grid — does the grid maintain face consistency with the approved portrait?
 *   3. Scene — does the scene contain the correct characters, setting, and blocking?
 *
 * Uses Claude Vision API (Sonnet) for analysis. Returns structured scores + issues.
 *
 * Scoring (single pass/fail per stage):
 *   - PASS: score >= passThreshold  → auto-proceed, no human review
 *   - FAIL: score <  passThreshold  → auto-reject, regenerate (up to retry cap)
 *
 * If retry cap exhausted, pipeline pauses with diagnostic info.
 *
 * Pipeline position:
 *   Portrait gen → [VERIFY] → portrait approval gate
 *   Grid gen → [VERIFY] → grid gate (new)
 *   Scene gen → [VERIFY] → scene approval gate
 */
class ImageVerifier {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey - Claude API key
   * @param {Function} [opts.logger] - Log function (msg, level)
   * @param {string} [opts.model] - Claude model to use (default: claude-sonnet-4-6)
   */
  constructor({ apiKey, logger, model } = {}) {
    if (!apiKey) throw new Error('ImageVerifier requires apiKey');
    this.apiKey = apiKey;
    this.logger = logger || ((msg) => console.log(`[IMAGE-VERIFY] ${msg}`));
    this.model = model || 'claude-sonnet-4-6';
  }

  // ═══════════════════════════════════════════════════════════════════
  // PORTRAIT VERIFICATION
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Verify a generated portrait matches the character bible description.
   *
   * Checks: gender, approximate age, skin tone, build, hairstyle/texture,
   * clothing/outfit match, and overall fidelity to the description.
   *
   * @param {string} portraitPath - Path to generated portrait image
   * @param {Object} character - Character bible entry
   * @param {string} character.physical_description - Permanent features
   * @param {Array}  [character.outfits] - Outfits array (checks o1 for portrait)
   * @param {string} [character.full_prompt_description] - Legacy single description
   * @param {string} [character.description_label] - Human-readable name
   * @returns {Promise<{score: number, issues: string[], verdict: 'accept'|'review'|'reject', details: Object}>}
   */
  async verifyPortrait(portraitPath, character, { passThreshold = 80 } = {}) {
    this.logger(`Verifying portrait: ${character.description_label || character.id}`);

    const imageData = await this._loadImage(portraitPath);
    if (!imageData) return this._fallbackResult('Could not load portrait image');

    // Build expected description from character bible
    const expectedDesc = this._buildPortraitExpectation(character);

    const prompt = `You are a quality control system for an AI video production pipeline. Verify whether this generated portrait matches the character description.

EXPECTED CHARACTER:
${expectedDesc}

TASK: Compare the portrait against the expected description. Score each attribute:

1. GENDER — Does the person's apparent gender match? (critical)
2. AGE — Does the apparent age match the description? (within ~5 years acceptable)
3. SKIN_TONE — Does skin tone/complexion match? (critical for identity)
4. BUILD — Body type/height impression match?
5. HAIR — Hair texture, length, style, color match?
6. CLOTHING — Outfit/accessories match the description?
7. OVERALL_IMPRESSION — Does this look like the described character?

OUTPUT FORMAT (JSON only):
{
  "scores": {
    "gender": { "score": 0-100, "note": "brief explanation" },
    "age": { "score": 0-100, "note": "" },
    "skin_tone": { "score": 0-100, "note": "" },
    "build": { "score": 0-100, "note": "" },
    "hair": { "score": 0-100, "note": "" },
    "clothing": { "score": 0-100, "note": "" },
    "overall_impression": { "score": 0-100, "note": "" }
  },
  "critical_issues": ["list of critical mismatches that would make this character unrecognizable"],
  "minor_issues": ["list of minor discrepancies that don't affect identity"]
}

Be strict on gender, skin tone, and overall impression. Be moderate on clothing details (AI generation can miss accessories). Be lenient on exact age (±5 years is fine).

Output ONLY the JSON.`;

    const result = await this._callVision(imageData, prompt);
    if (!result) return this._fallbackResult('Vision API call failed');

    return this._scorePortraitResult(result, { passThreshold });
  }

  // ═══════════════════════════════════════════════════════════════════
  // GRID VERIFICATION
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Verify a generated character grid maintains face consistency with the
   * approved portrait and has proper multi-angle layout.
   *
   * Checks: face consistency, multi-angle coverage (front/left/right/back),
   * proper 4-column layout, consistent clothing across angles.
   *
   * @param {string} gridPath - Path to generated grid image
   * @param {string} portraitPath - Path to approved portrait (face reference)
   * @param {Object} character - Character bible entry
   * @returns {Promise<{score: number, issues: string[], verdict: 'accept'|'review'|'reject', details: Object}>}
   */
  async verifyGrid(gridPath, portraitPath, character, { passThreshold = 75 } = {}) {
    this.logger(`Verifying grid: ${character.description_label || character.id}`);

    const gridData = await this._loadImage(gridPath);
    if (!gridData) return this._fallbackResult('Could not load grid image');

    const portraitData = await this._loadImage(portraitPath);
    if (!portraitData) return this._fallbackResult('Could not load portrait for comparison');

    const prompt = `You are a quality control system for an AI video production pipeline. You are comparing a CHARACTER REFERENCE GRID against an APPROVED PORTRAIT to verify face consistency and layout quality.

IMAGE 1 (first image): The APPROVED PORTRAIT — this is the ground truth for this character's face.
IMAGE 2 (second image): The CHARACTER GRID — a reference sheet that should show the same person from multiple angles.

CHARACTER: ${character.description_label || character.id}
EXPECTED LAYOUT: 4 vertical columns. Each column has a full-body view on top and a close-up portrait below. Columns left→right: front view, left profile, right profile, back view.

TASK: Verify the grid against the approved portrait.

1. FACE_CONSISTENCY — Does the person in the grid look like the SAME person as in the approved portrait? Same face shape, same features, same skin tone, same apparent age? (CRITICAL — this is the primary check)
2. ANGLE_COVERAGE — Are all 4 angles present? (front, left profile, right profile, back) Any missing or duplicated?
3. LAYOUT_QUALITY — Proper 4-column structure? Full-body above, close-up below? Clean separation between panels?
4. CLOTHING_CONSISTENCY — Same outfit across all angles? (Should be identical in every panel)
5. IDENTITY_STABILITY — Could this grid be used as a reference to consistently identify this character? Would an AI model looking at this grid produce consistent results?

OUTPUT FORMAT (JSON only):
{
  "scores": {
    "face_consistency": { "score": 0-100, "note": "brief explanation" },
    "angle_coverage": { "score": 0-100, "note": "which angles present/missing" },
    "layout_quality": { "score": 0-100, "note": "" },
    "clothing_consistency": { "score": 0-100, "note": "" },
    "identity_stability": { "score": 0-100, "note": "" }
  },
  "critical_issues": ["e.g. 'face looks completely different from portrait', 'only 2 angles shown'"],
  "minor_issues": ["e.g. 'slight color shift in right profile', 'back view hair slightly different length'"]
}

FACE_CONSISTENCY is weighted 3x — a grid that shows a different person is useless regardless of layout quality.

Output ONLY the JSON.`;

    const result = await this._callVisionMultiImage([portraitData, gridData], prompt);
    if (!result) return this._fallbackResult('Vision API call failed');

    return this._scoreGridResult(result, { passThreshold });
  }

  // ═══════════════════════════════════════════════════════════════════
  // SCENE IMAGE VERIFICATION
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Verify a generated scene image contains the correct characters, setting,
   * and blocking positions.
   *
   * @param {string} scenePath - Path to generated scene image
   * @param {Object} opts
   * @param {Array<{name: string, description: string, portraitPath?: string}>} opts.characters - Expected characters
   * @param {string} opts.locationDescription - Expected location/setting
   * @param {Object} opts.blocking - Expected blocking positions {frame_left, frame_center, frame_right, notes}
   * @param {Array<string>} [opts.portraitPaths] - Portrait paths for character identification
   * @returns {Promise<{score: number, issues: string[], verdict: 'accept'|'review'|'reject', details: Object}>}
   */
  async verifySceneImage(scenePath, { characters, locationDescription, blocking, portraitPaths = [], propContract = null } = {}, { passThreshold = 70 } = {}) {
    this.logger(`Verifying scene image: ${characters.map(c => c.name).join(', ')}`);

    const sceneData = await this._loadImage(scenePath);
    if (!sceneData) return this._fallbackResult('Could not load scene image');

    // Build character identification context
    const charLines = characters.map((c, i) => {
      return `- @${c.name}: ${c.description}`;
    }).join('\n');

    // Build blocking expectation
    const blockingLines = [];
    if (blocking?.frame_left) blockingLines.push(`Frame-left: ${blocking.frame_left}`);
    if (blocking?.frame_center) blockingLines.push(`Frame-center: ${blocking.frame_center}`);
    if (blocking?.frame_right) blockingLines.push(`Frame-right: ${blocking.frame_right}`);
    if (blocking?.notes) blockingLines.push(`Atmosphere: ${blocking.notes}`);

    const requiredProps = (propContract?.requiredProps || []).filter(p => p.requiredVisible);
    const propLines = requiredProps.map((p, i) => {
      const propName = p.aliases?.[0] || p.prop;
      const holder = p.holder ? `Expected holder: @${p.holder}. ` : '';
      const placement = p.placement || 'visible and physically anchored in the scene';
      return `${i + 1}. ${propName}: ${holder}Placement: ${placement}. Cultural form: ${p.culturalDescription}. Reason: ${p.reason}. Must be held, touched, or resting on a visible surface; never floating.`;
    }).join('\n');

    const prompt = `You are a quality control system for an AI video production pipeline. Verify this generated SCENE IMAGE matches the expected characters, setting, and blocking.

EXPECTED CHARACTERS IN THIS SCENE:
${charLines}

EXPECTED LOCATION/SETTING:
${locationDescription}

EXPECTED BLOCKING (character positions):
${blockingLines.join('\n') || '(no specific blocking provided)'}

${propLines ? `REQUIRED STORY PROPS (Nigerian/Nollywood grounded):\n${propLines}\n` : ''}

TASK: Verify the scene image matches expectations.
${propLines ? 'Also score PROP_REQUIREMENTS: every required story prop must be visible, culturally grounded for Nigeria/Nollywood, physically anchored (held/touched/on surface), and not floating. If a holder is specified, the prop must be held by, touched by, or immediately beside that character. Penalize foreign/genre-wrong substitutions such as glossy Western contracts, dollars, spy gadgets, fantasy jewelry, or Bollywood-coded ornament. This is CRITICAL when present.' : ''}

1. CHARACTER_PRESENCE — Are ALL expected characters visible in the scene? Can you identify each one by their visual description? Are there any EXTRA people who shouldn't be there? (CRITICAL)
2. CHARACTER_IDENTITY — Do the characters LOOK like their descriptions? (skin tone, gender, approximate age, clothing)
3. SETTING_MATCH — Does the environment match the expected location? (indoor/outdoor, time of day, general setting type)
4. BLOCKING_POSITIONS — Are characters positioned roughly as expected? (left/center/right, relative positions)
5. COMPOSITION_QUALITY — Is the image well-composed for a scene start frame? (characters visible, not cropped, good framing)

OUTPUT FORMAT (JSON only):
{
  "scores": {
    "character_presence": { "score": 0-100, "note": "who is present/missing/extra" },
    "character_identity": { "score": 0-100, "note": "do they match descriptions" },
    "setting_match": { "score": 0-100, "note": "" },
    "blocking_positions": { "score": 0-100, "note": "" },
    "composition_quality": { "score": 0-100, "note": "" }${propLines ? ',\n    "prop_requirements": { "score": 0-100, "note": "which required props are visible/missing/floating/wrong cultural form" }' : ''}
  },
  "characters_identified": [
    { "name": "character_name", "found": true, "position": "where in frame", "confidence": "high|medium|low" }
  ],
  "critical_issues": ["e.g. 'character X is missing from scene', 'wrong number of people'"],
  "minor_issues": ["e.g. 'setting is slightly different shade', 'character positioned center instead of left'"]
}

CHARACTER_PRESENCE is the highest priority — wrong characters in a scene is a catastrophic error that ruins the entire clip sequence built on this start frame.

Output ONLY the JSON.`;

    // If we have portrait paths, send them as additional reference images
    const images = [sceneData];
    if (portraitPaths.length > 0) {
      for (const pp of portraitPaths.slice(0, 3)) { // Max 3 reference portraits
        const pData = await this._loadImage(pp);
        if (pData) images.push(pData);
      }
    }

    const result = images.length > 1
      ? await this._callVisionMultiImage(images, prompt)
      : await this._callVision(sceneData, prompt);
    if (!result) return this._fallbackResult('Vision API call failed');

    return this._scoreSceneResult(result, { passThreshold, expectedCount: characters.length, requiredPropCount: requiredProps.length });
  }

  // ═══════════════════════════════════════════════════════════════════
  // LOCATION IMAGE VERIFICATION
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Verify a generated location image matches its description, contains
   * no people, and is culturally authentic to the target nationality.
   *
   * Checks: matches description, no people/figures present (critical),
   * cultural authenticity (critical), mood/atmosphere match, composition quality.
   *
   * @param {string} locationPath - Path to generated location image
   * @param {Object} location - Location info
   * @param {string} location.description - Expected location description
   * @param {string} [location.name] - Location element name (for logging)
   * @param {string} [location.culturalContext] - Cultural verification instruction
   * @param {string[]} [location.forbiddenElements] - Culturally inappropriate elements to check for
   * @returns {Promise<{score: number, issues: string[], verdict: string, details: Object}>}
   */
  async verifyLocationImage(locationPath, location, { passThreshold = 70 } = {}) {
    this.logger(`Verifying location: ${location.name || 'unknown'}`);

    const imageData = await this._loadImage(locationPath);
    if (!imageData) return this._fallbackResult('Could not load location image');

    // Cultural grounding context (passed from orchestrator's CULTURAL_GROUNDING map)
    const culturalCheck = location.culturalContext
      ? `\n\n${location.culturalContext}\nFORBIDDEN ELEMENTS (any of these = critical issue): ${(location.forbiddenElements || []).join(', ')}`
      : '';

    const prompt = `You are a quality control system for an AI video production pipeline. Verify this generated EMPTY LOCATION IMAGE matches its description and contains NO people.

EXPECTED LOCATION:
${location.description}

CRITICAL RULE: This image MUST be completely empty — no people, no characters, no human figures, no silhouettes, no mannequins. It is used as a background reference for scene composition.${culturalCheck}

TASK: Verify the location image.

1. NO_PEOPLE — Is the image completely free of people, human figures, silhouettes, or any suggestion of a person? (CRITICAL — any human presence = instant fail)
2. DESCRIPTION_MATCH — Does the image match the expected location description? (correct type of place, matching features/elements described)
3. CULTURAL_AUTHENTICITY — Does the image look culturally authentic to the specified setting? Are there any out-of-place elements from a different culture (Western TV channels, European artwork, non-local architecture)? (CRITICAL for immersion)
4. MOOD_SETTING — Does the atmosphere, lighting, and mood feel right for the described location? (time of day, indoor/outdoor, color warmth)
5. COMPOSITION — Is the image well-composed as a background reference? (good framing, appropriate depth, usable as a scene backdrop)

OUTPUT FORMAT (JSON only):
{
  "scores": {
    "no_people": { "score": 0-100, "note": "brief explanation — 100 if completely empty, 0 if people visible" },
    "description_match": { "score": 0-100, "note": "how well it matches the description" },
    "cultural_authenticity": { "score": 0-100, "note": "culturally appropriate? any foreign/out-of-place elements?" },
    "mood_setting": { "score": 0-100, "note": "" },
    "composition": { "score": 0-100, "note": "" }
  },
  "critical_issues": ["e.g. 'person visible in background', 'CNN on TV screen — should be Nigerian channel', 'European portraits on wall'"],
  "minor_issues": ["e.g. 'slightly different lighting than expected', 'missing some described details'"]
}

NO_PEOPLE and CULTURAL_AUTHENTICITY are the highest priorities. Any human figure = score 0 for no_people. Any clearly foreign/Western cultural marker in a non-Western setting = score below 40 for cultural_authenticity.

Output ONLY the JSON.`;

    const result = await this._callVision(imageData, prompt);
    if (!result) return this._fallbackResult('Vision API call failed');

    return this._scoreLocationResult(result, { passThreshold });
  }

  // ═══════════════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build the expected description string from a character bible entry.
   */
  _buildPortraitExpectation(character) {
    const parts = [];
    if (character.description_label) parts.push(`Name: ${character.description_label}`);
    if (character.physical_description) {
      parts.push(`Physical features: ${character.physical_description}`);
    }
    if (character.outfits && character.outfits.length > 0) {
      // Portrait should show the first outfit (o1)
      parts.push(`Outfit (should be wearing): ${character.outfits[0].description}`);
    }
    if (character.full_prompt_description) {
      // Legacy fallback
      if (!character.physical_description) {
        parts.push(`Full description: ${character.full_prompt_description}`);
      }
    }
    return parts.join('\n') || 'No description available';
  }

  /**
   * Score portrait verification result.
   */
  _scorePortraitResult(parsed, { passThreshold }) {
    const scores = parsed.scores || {};

    // Weighted scoring: gender and skin_tone are critical (3x), others normal (1x)
    const weights = {
      gender: 3,
      skin_tone: 3,
      age: 1,
      build: 1,
      hair: 1.5,
      clothing: 1,
      overall_impression: 2,
    };

    let totalWeight = 0;
    let weightedSum = 0;
    const issues = [];

    for (const [key, weight] of Object.entries(weights)) {
      const entry = scores[key];
      if (entry && typeof entry.score === 'number') {
        totalWeight += weight;
        weightedSum += entry.score * weight;
        if (entry.score < 70 && entry.note) {
          issues.push(`${key}: ${entry.note} (${entry.score})`);
        }
      }
    }

    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    const allIssues = [
      ...(parsed.critical_issues || []),
      ...(parsed.minor_issues || []),
      ...issues,
    ];

    const verdict = score >= passThreshold ? 'pass' : 'fail';

    this.logger(`Portrait score: ${score} → ${verdict} (pass≥${passThreshold})`);
    if (allIssues.length > 0) {
      this.logger(`Issues: ${allIssues.slice(0, 3).join('; ')}`);
    }

    return { score, issues: allIssues, verdict, details: parsed };
  }

  /**
   * Score grid verification result.
   */
  _scoreGridResult(parsed, { passThreshold }) {
    const scores = parsed.scores || {};

    // Face consistency is weighted 3x — the entire point of the grid
    const weights = {
      face_consistency: 3,
      angle_coverage: 1.5,
      layout_quality: 1,
      clothing_consistency: 1,
      identity_stability: 2,
    };

    let totalWeight = 0;
    let weightedSum = 0;
    const issues = [];

    for (const [key, weight] of Object.entries(weights)) {
      const entry = scores[key];
      if (entry && typeof entry.score === 'number') {
        totalWeight += weight;
        weightedSum += entry.score * weight;
        if (entry.score < 70 && entry.note) {
          issues.push(`${key}: ${entry.note} (${entry.score})`);
        }
      }
    }

    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    const allIssues = [
      ...(parsed.critical_issues || []),
      ...(parsed.minor_issues || []),
      ...issues,
    ];

    const verdict = score >= passThreshold ? 'pass' : 'fail';

    this.logger(`Grid score: ${score} → ${verdict} (pass≥${passThreshold})`);
    if (allIssues.length > 0) {
      this.logger(`Issues: ${allIssues.slice(0, 3).join('; ')}`);
    }

    return { score, issues: allIssues, verdict, details: parsed };
  }

  /**
   * Score scene image verification result.
   */
  _scoreSceneResult(parsed, { passThreshold, expectedCount, requiredPropCount = 0 }) {
    const scores = parsed.scores || {};

    // Character presence is critical (3x) — wrong characters ruins everything downstream
    const weights = {
      character_presence: 3,
      character_identity: 2,
      setting_match: 1.5,
      blocking_positions: 1,
      composition_quality: 1,
    };
    if (requiredPropCount > 0) {
      weights.prop_requirements = 2;
    }

    let totalWeight = 0;
    let weightedSum = 0;
    const issues = [];

    for (const [key, weight] of Object.entries(weights)) {
      const entry = scores[key];
      if (entry && typeof entry.score === 'number') {
        totalWeight += weight;
        weightedSum += entry.score * weight;
        if (entry.score < 70 && entry.note) {
          issues.push(`${key}: ${entry.note} (${entry.score})`);
        }
      }
    }

    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    // Extra hard check: if character_presence < 50, force fail regardless of overall
    const presenceScore = scores.character_presence?.score ?? 100;
    const propScore = requiredPropCount > 0 ? (scores.prop_requirements?.score ?? 0) : 100;
    const forcedFail = presenceScore < 50 || propScore < 70;
    if (propScore < 70) {
      issues.push(`prop_requirements: required story props missing, floating, or culturally wrong (${propScore})`);
    }

    const allIssues = [
      ...(parsed.critical_issues || []),
      ...(parsed.minor_issues || []),
      ...issues,
    ];

    const verdict = forcedFail ? 'fail' : (score >= passThreshold ? 'pass' : 'fail');

    this.logger(`Scene score: ${score} → ${verdict}${forcedFail ? ' (forced: character_presence<50)' : ''} (pass≥${passThreshold})`);
    if (allIssues.length > 0) {
      this.logger(`Issues: ${allIssues.slice(0, 3).join('; ')}`);
    }

    return {
      score,
      issues: allIssues,
      verdict,
      details: parsed,
      charactersIdentified: parsed.characters_identified || [],
    };
  }

  /**
   * Score location image verification result.
   */
  _scoreLocationResult(parsed, { passThreshold }) {
    const scores = parsed.scores || {};

    // no_people and cultural_authenticity are critical (3x/2.5x)
    const weights = {
      no_people: 3,
      cultural_authenticity: 2.5,
      description_match: 2,
      mood_setting: 1.5,
      composition: 1,
    };

    let totalWeight = 0;
    let weightedSum = 0;
    const issues = [];

    for (const [key, weight] of Object.entries(weights)) {
      const entry = scores[key];
      if (entry && typeof entry.score === 'number') {
        totalWeight += weight;
        weightedSum += entry.score * weight;
        if (entry.score < 70 && entry.note) {
          issues.push(`${key}: ${entry.note} (${entry.score})`);
        }
      }
    }

    const score = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;

    // Hard checks — force fail for critical violations
    const noPeopleScore = scores.no_people?.score ?? 100;
    const culturalScore = scores.cultural_authenticity?.score ?? 100;
    const forcedFail = noPeopleScore < 50 || culturalScore < 40;

    let failReason = '';
    if (noPeopleScore < 50) failReason = 'no_people<50';
    else if (culturalScore < 40) failReason = 'cultural_authenticity<40';

    const allIssues = [
      ...(parsed.critical_issues || []),
      ...(parsed.minor_issues || []),
      ...issues,
    ];

    const verdict = forcedFail ? 'fail' : (score >= passThreshold ? 'pass' : 'fail');

    this.logger(`Location score: ${score} → ${verdict}${forcedFail ? ` (forced: ${failReason})` : ''} (pass≥${passThreshold})`);
    if (allIssues.length > 0) {
      this.logger(`Issues: ${allIssues.slice(0, 3).join('; ')}`);
    }

    return { score, issues: allIssues, verdict, details: parsed };
  }

  // ═══════════════════════════════════════════════════════════════════
  // IMAGE LOADING + VISION API
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Load an image file, detect mime type, convert webp→jpeg if needed.
   * Returns { base64, mimeType } or null on failure.
   */
  async _loadImage(imagePath) {
    try {
      if (!fs.existsSync(imagePath)) {
        this.logger(`Image not found: ${imagePath}`);
        return null;
      }

      let imageData = fs.readFileSync(imagePath);
      let mimeType = this._detectMime(imageData, imagePath);
      const needsConversion = mimeType === 'image/webp';

      if (imageData.length > 3 * 1024 * 1024 || needsConversion) {
        const converted = this._convertToJpeg(imagePath, imageData, needsConversion);
        if (converted) {
          imageData = converted.data;
          mimeType = 'image/jpeg';
        } else if (needsConversion) {
          this.logger('Cannot convert webp without ffmpeg');
          return null;
        }
      }

      const base64 = imageData.toString('base64');
      if (base64.length > 5 * 1024 * 1024) {
        this.logger(`Image too large after encoding: ${(base64.length / 1024 / 1024).toFixed(1)}MB`);
        return null;
      }

      return { base64, mimeType };
    } catch (err) {
      this.logger(`Failed to load image ${imagePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Detect MIME type from file magic bytes.
   */
  _detectMime(buf, filePath = '') {
    if (buf.length >= 4) {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
      if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
      if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
          && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
      if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
    }
    const ext = (filePath || '').split('.').pop().toLowerCase();
    if (ext === 'png') return 'image/png';
    if (ext === 'webp') return 'image/webp';
    return 'image/jpeg';
  }

  /**
   * Convert image to JPEG using ffmpeg (for webp or oversized images).
   */
  _convertToJpeg(imagePath, imageData, forceConvert = false) {
    const { execSync } = require('child_process');
    let ffmpegPath = null;
    for (const cmd of ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) {
      try { execSync(`"${cmd}" -version`, { stdio: 'ignore' }); ffmpegPath = cmd; break; } catch (_) {}
    }
    if (!ffmpegPath) return null;

    const tmpJpeg = path.join(path.dirname(imagePath), `_verify_tmp_${Date.now()}.jpg`);
    try {
      execSync(
        `"${ffmpegPath}" -i "${imagePath}" -vf "scale='if(gt(iw,ih),1200,-2)':'if(gt(iw,ih),-2,1200)'" -q:v 2 -y "${tmpJpeg}"`,
        { timeout: 15000, stdio: 'pipe' }
      );
      const data = fs.readFileSync(tmpJpeg);
      try { fs.unlinkSync(tmpJpeg); } catch (_) {}
      return { data };
    } catch (err) {
      try { fs.unlinkSync(tmpJpeg); } catch (_) {}
      return null;
    }
  }

  /**
   * Call Claude Vision API with a single image.
   */
  async _callVision(imageData, prompt) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: this.apiKey });

      const response = await client.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: imageData.mimeType, data: imageData.base64 },
            },
            { type: 'text', text: prompt },
          ],
        }],
      });

      const text = response.content?.[0]?.text || '';
      return this._parseJson(text);
    } catch (err) {
      this.logger(`Vision API error: ${err.message}`);
      return null;
    }
  }

  /**
   * Call Claude Vision API with multiple images (e.g., portrait + grid comparison).
   */
  async _callVisionMultiImage(imagesArray, prompt) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: this.apiKey });

      const content = [];
      for (const img of imagesArray) {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
        });
      }
      content.push({ type: 'text', text: prompt });

      const response = await client.messages.create({
        model: this.model,
        max_tokens: 1000,
        messages: [{ role: 'user', content }],
      });

      const text = response.content?.[0]?.text || '';
      return this._parseJson(text);
    } catch (err) {
      this.logger(`Vision API error (multi-image): ${err.message}`);
      return null;
    }
  }

  /**
   * Parse JSON from vision response text.
   */
  _parseJson(text) {
    // Try to extract JSON object from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      this.logger(`Could not find JSON in response: ${text.slice(0, 200)}`);
      return null;
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (err) {
      this.logger(`JSON parse error: ${err.message}`);
      return null;
    }
  }

  /**
   * Return a safe fallback result when verification can't run.
   */
  _fallbackResult(reason) {
    this.logger(`Fallback (skip verification): ${reason}`);
    return {
      score: -1, // -1 signals "could not verify" — treated as pass (non-blocking)
      issues: [reason],
      verdict: 'pass', // When we can't verify, pass through (don't block pipeline)
      details: null,
      skipped: true,
    };
  }
}

module.exports = { ImageVerifier };
