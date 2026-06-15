const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const db = require('../database/db');

// Cinematic-mode-specific rubric items injected into the structural reviewer
// prompt via {{CINEMATIC_RUBRIC_EXTENSION}}. Only applies when the project's
// generator_mode = 'cinematic'. See IMPROVEMENT-CINEMATIC-WORKFLOW.md.
const CINEMATIC_RUBRIC_EXTENSION = `
=== CINEMATIC MODE EXTENSIONS (adds to tier rubric above; applies ONLY when GENERATOR_MODE = cinematic) ===

The script includes additional cinematic-pipeline fields per scene: blocking, location_element_hint, background_roles, props_in_scene, kling_clips. Grade these with the following bonus/penalty items (up to +15 pts, capped at 100 overall):

C1. BLOCKING COMPLETENESS (+5 pts max)
  - Full: every scene has a non-null blocking object; every character in characters_present appears in at least one of frame_left/frame_center/frame_right with a concrete posture/intent description
  - Half: blocking exists but some characters are missing frame positions
  - Zero: blocking is missing, null, or all positions are empty strings
  - Deduct for blocking that says "@claire is in the scene" without frame position or posture

C2. KLING CLIP COHERENCE (+5 pts max)
  - Full: every scene has kling_clips covering ALL lines via line_refs; clip duration_seconds is 15; no clip exceeds 2500 chars in its multi_shot_prompt; shot count per clip is EXACTLY 3 (hard rule); every shot has at least 1 dialogue line. Total clip count within 20% of target (if target provided). No scene has more than 3 characters in characters_present.
  - Half: minor issues (one clip slightly over, one missing line_ref, clip count 20-30% off target)
  - Zero: scenes have no kling_clips, or clips don't cover their lines, or clip count >30% off target
  - Deduct for any clip whose duration > 12s (Kling degradation zone)
  - Deduct for any scene with >3 characters in characters_present (Kling lip-sync/positioning degrades)

C3. LOCATION HINT DEDUP DISCIPLINE (+3 pts max)
  - Full: location_element_hint is snake_case, consistent across scenes sharing a location (so the pipeline only generates one empty-location image per unique hint), different across different locations
  - Half: inconsistent naming (one scene uses "clara_kitchen", another uses "claras_kitchen") — would cause duplicate empty-location image generation
  - Zero: location_element_hint missing or free-form English
  - Note: locations are NOT Higgsfield Elements — they're reference images. The hint is purely a dedup key.

C4. PROPS-AS-ELEMENTS FOR SETUP/PAYOFF (+2 pts max)
  - Full: if the script has setup/payoff pairs (Chekhov's gun), both the setup scene and payoff scene list the same element in props_in_scene
  - Half: one side of the pair lists it, the other doesn't
  - Zero: no props_in_scene usage despite obvious setup/payoff pairs present

C5. REALISM + BACKGROUND POPULATION (deduction only)
  - Deduct when public/institutional locations feel empty without story justification.
  - Deduct when a court, hospital, police station, church, school, palace, market, wedding, or funeral lacks either appropriate speaking characters or non-speaking background_roles.
  - Deduct when legal, medical, business, land, school, or police stakes resolve through talk alone with no props_in_scene/proof/procedure.
  - Do NOT count background_roles toward the 3-character scene limit. They are non-speaking environment roles only.

CINEMATIC-SPECIFIC FAILURE MODES (automatic critical issues):
- Any kling_clip.multi_shot_prompt missing the bracketed dialogue syntax [@character, speaking in a <tone> Nigerian English accent]: "..."
- Any kling_clip.multi_shot_prompt that uses @location-style references (e.g. "@clara_kitchen") — locations are reference images, NOT elements, so @location won't resolve and just becomes useless text. Describe locations naturally ("inside the kitchen from the reference image") instead.
- Any scene where characters speak in dialogue but don't appear in blocking
- Any prop mentioned by name in dialogue but not listed in props_in_scene of any scene where it appears
- Any institutional scene that lacks required functional presence: court without judge/lawyer/clerk/bailiff, hospital without doctor/nurse/reception, police station without officer/investigator, church without pastor/elder/usher, school without teacher/principal, palace without chief/elder/attendant
- Any major legal/medical/business/land/police stake resolved only by dialogue with no visible proof/procedure in props_in_scene
- Any kling_clip where Shot 1 has NO dialogue — Shot 1 must include the first dialogue line (the start frame image + CHARACTER POSITIONS preamble already establish the scene; a silent establishing Shot 1 wastes the model's limited shot budget and causes later dialogue to be dropped)
- Any kling_clip that does NOT have exactly 3 shots — Kling 3.0 renders 4+ shots unreliably (skips shots, misattributes dialogue). 3 shots per clip is the hard production rule.
- Any @element_name appearing inside dialogue quotes (e.g. "I am @okafor_otpto_0420") — characters speak human names, not element tags. The @ prefix inside quotes gets typed as an element reference attempt instead of spoken words.
- Any Shot 2 or Shot 3 that references another character in ANY form — no @element names, no human names, no "he/she" referring to a specific other character. Shot directions for Shot 2 and Shot 3 must describe ONLY the speaker's actions, expressions, and body language. Cross-references cause the video model to misassign dialogue to the wrong face.
- Any scene where blocking says a character is SEATED but Shot 1 of the first kling_clip describes them STANDING (or vice versa) — blocking defines the start frame; Shot 1 must match
- Any scene where blocking places a character at frame-left but Shot 1 places them frame-right (or other position contradictions) — the establishing shot must visually match the blocking composition

Log cinematic-specific issues with category values: 'blocking', 'kling_clips', 'element_hint', 'props_consistency', 'realism', 'procedure'.
`;

class ScriptValidationError extends Error {
  constructor(message, draftScript, diagnostics) {
    super(message);
    this.name = 'ScriptValidationError';
    this.draftScript = draftScript;
    this.diagnostics = diagnostics;
  }
}

class ScriptEngine {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.model = 'claude-sonnet-4-6';

    // Load prompt templates
    const promptsDir = path.join(__dirname, '..', '..', '..', 'prompts');
    this.titlePrompt = fs.readFileSync(path.join(promptsDir, 'title-prompt.txt'), 'utf-8');
    this.researchBriefPrompt = fs.readFileSync(path.join(promptsDir, 'research-brief-prompt.txt'), 'utf-8');
    this.scriptPrompt = fs.readFileSync(path.join(promptsDir, 'script-prompt.txt'), 'utf-8');
  }

  /**
   * Generate title candidates.
   * If research data is available, uses the research-informed prompt.
   * Otherwise falls back to the standard title prompt.
   *
   * @param {Object} storyBrief - User's story brief
   * @param {Object|null} researchData - Research results from GeminiVideoAnalyzer
   */
  async generateTitles(storyBrief, researchData = null) {
    let systemPrompt;
    let userMessage;

    if (researchData && researchData.patterns) {
      // Research-informed title generation
      console.log('[SCRIPT] Using research data to inform title generation...');

      // Build a concise research summary for the prompt
      const researchSummary = this.buildResearchSummary(researchData);

      systemPrompt = this.researchBriefPrompt.replace('{{RESEARCH_DATA}}', researchSummary);

      // No "Setting:" line — the research summary in the system prompt already
      // contains the full effective_settings list from Gemini. Forcing a single
      // setting into the user message was overriding that context and producing
      // village-monoculture title sets. Claude picks settings contextually per-title.
      userMessage = `Story Concept: ${storyBrief.concept}\nNationality: ${storyBrief.nationality}\n\nUsing the market research patterns above, generate 5 viral Nollywood title candidates for this concept. Let the setting of each title emerge from the story — some may be village-set, others urban, palace, marketplace, etc. — guided by what the research patterns show works for Nollywood.`;
    } else {
      // Standard title generation (no research)
      systemPrompt = this.titlePrompt;
      userMessage = `Story Concept: ${storyBrief.concept}\nNationality: ${storyBrief.nationality}\n\nGenerate 5 viral Nollywood title candidates. Vary the implied settings — Nollywood stories can unfold in villages, cities, palaces, compounds, marketplaces, or move between them.`;
    }

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      temperature: 0.9,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0].text;
    let titles = [];
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        titles = parsed.titles || [];
      }
    } catch (e) {
      console.error('Title parse error:', e);
      return [{ rank: 1, title: storyBrief.concept.slice(0, 80), hook_reason: 'Fallback title from concept' }];
    }

    // Flag titles that are too similar to source video titles
    if (researchData?.sourceVideoTitles?.length) {
      titles = titles.map(t => {
        const similar = this.findSimilarSourceTitle(t.title, researchData.sourceVideoTitles);
        if (similar) {
          t.tooSimilar = true;
          t.similarTo = similar.sourceTitle;
          t.similarityScore = similar.score;
          t.hook_reason = `[WARNING: ${Math.round(similar.score * 100)}% similar to "${similar.sourceTitle}"] ${t.hook_reason || ''}`;
          console.warn(`[SCRIPT] Title "${t.title}" flagged: ${Math.round(similar.score * 100)}% similar to "${similar.sourceTitle}"`);
        }
        return t;
      });
    }

    return titles;
  }

  /**
   * Check if a generated title is too similar to any source video title.
   * Uses word-overlap scoring: if >40% of significant words match, flag it.
   * Returns { sourceTitle, score } or null.
   */
  findSimilarSourceTitle(generatedTitle, sourceTitles) {
    const stopWords = new Set(['the', 'a', 'an', 'my', 'his', 'her', 'our', 'their', 'in', 'of', 'and', 'or', 'to', 'for', 'is', 'was', 'with', 'on', 'at', 'by', 'from', 'that', 'this', 'it']);

    const tokenize = (title) => {
      return title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stopWords.has(w));
    };

    const genWords = tokenize(generatedTitle);
    if (genWords.length === 0) return null;

    let bestMatch = null;

    for (const sourceTitle of sourceTitles) {
      const srcWords = tokenize(sourceTitle);
      if (srcWords.length === 0) continue;

      // Count overlapping significant words
      const genSet = new Set(genWords);
      const srcSet = new Set(srcWords);
      const overlap = [...genSet].filter(w => srcSet.has(w)).length;

      // Score relative to the shorter title (stricter)
      const score = overlap / Math.min(genSet.size, srcSet.size);

      if (score > 0.4 && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { sourceTitle, score };
      }
    }

    return bestMatch;
  }

  /**
   * Generate the full script with character bible.
   * If research data is available, it's woven into the script prompt
   * to influence character archetypes, themes, and dialogue style.
   *
   * @param {Object} storyBrief - User's story brief (must include .title)
   * @param {Function} onProgress - Callback for streaming progress
   * @param {Object|null} researchData - Research results from GeminiVideoAnalyzer
   */
  async generateScript(storyBrief, onProgress, researchData = null) {
    // Build prompt with injected user data
    const aspect = (storyBrief.aspectRatio === '9:16') ? '9:16' : '16:9';
    const aspectFramingGuidance = aspect === '9:16'
      ? `=== ASPECT RATIO FRAMING: 9:16 VERTICAL (Shorts / TikTok / Reels) ===
This will be viewed on a phone in portrait orientation. Adjust your image_prompt AND animation_prompt accordingly:
- Favor SINGLE-CHARACTER framing and medium-close shots (chest up, head-and-shoulders)
- TWO-CHARACTER scenes: stage them close and intimate, NOT wide two-shot staging
- AVOID wide establishing shots, sweeping vistas, panoramic crowd scenes — they shrink to nothing in portrait frames
- Environmental detail should be minimal and close to the character (wall behind head, handheld prop, tight doorway) — not sprawling
- Camera moves: vertical pans and push-ins work; lateral pans and dolly tracks do not
- Pacing bias: vertical viewers scroll away faster than YouTube viewers — open lines should grip within the first 2-3 seconds
`
      : `=== ASPECT RATIO FRAMING: 16:9 HORIZONTAL (YouTube long-form) ===
Standard cinematic widescreen composition. Wide establishing shots, two-shots, and ensemble framing all work naturally. No special restrictions.
`;

    // NOTE: {{SETTING}} deliberately not substituted — it was removed from the
    // prompt template. Scene-level `location` is now chosen by Claude per-scene
    // based on narrative need + research patterns, not locked project-wide.

    const tier = storyBrief.durationTier || 'standard';
    const generatorMode = (storyBrief.generatorMode === 'cinematic') ? 'cinematic' : 'staged';
    const scaffolding = this._buildStructuralScaffolding(tier, storyBrief.chapters, storyBrief);
    const cinematicScaffolding = this._buildCinematicScaffolding(generatorMode, tier, storyBrief);
    const schemaAddendum = this._buildSchemaAddendum(generatorMode);

    const isCinematicStoryDriven = storyBrief.storyDriven && generatorMode === 'cinematic';

    let prompt = this.scriptPrompt
      .replace('{{TITLE}}', storyBrief.title)
      .replace(/\{\{CHAPTERS\}\}/g, String(storyBrief.chapters))
      .replace(/\{\{SCENES_PER_CHAPTER\}\}/g, isCinematicStoryDriven ? 'UNLIMITED (story-driven)' : String(storyBrief.scenesPerChapter || 3))
      .replace(/\{\{LINES_PER_SCENE\}\}/g, isCinematicStoryDriven ? 'UNLIMITED (group into clips of 3 lines)' : String(storyBrief.linesPerScene || 5))
      .replace(/\{\{TOTAL_LINES\}\}/g, isCinematicStoryDriven ? `~${storyBrief.targetClips * 3} (flexible, target ~${storyBrief.targetClips} clips)` : String(storyBrief.totalLines || 90))
      .replace(/\{\{ESTIMATED_DURATION\}\}/g, String(storyBrief.estimatedDuration || '10+'))
      .replace('{{NATIONALITY}}', storyBrief.nationality)
      .replace('{{ACCENT}}', storyBrief.accent)
      .replace('{{CONCEPT}}', storyBrief.concept)
      .replace('{{ASPECT_RATIO}}', aspect)
      .replace('{{ASPECT_FRAMING_GUIDANCE}}', aspectFramingGuidance)
      .replace('{{STRUCTURAL_SCAFFOLDING}}', scaffolding)
      .replace('{{CINEMATIC_SCAFFOLDING}}', cinematicScaffolding)
      .replace('{{CINEMATIC_SCHEMA_ADDENDUM}}', schemaAddendum);

    prompt += this._buildCharacterNameDiversityGuidance();

    // If we have research data, inject it as additional context
    let researchContext = '';
    if (researchData && researchData.patterns) {
      researchContext = this.buildScriptResearchContext(researchData);
      prompt += `\n\n=== MARKET RESEARCH CONTEXT (Use as inspiration, NOT to copy) ===\n${researchContext}\n\nUse these proven patterns to make the story more engaging, but ensure the script is 100% original.`;
    }

    const totalChapters = storyBrief.chapters || 5;
    const scenesPerChapter = storyBrief.scenesPerChapter || 3;
    const linesPerScene = storyBrief.linesPerScene || 5;
    const isCinematic = generatorMode === 'cinematic';

    // ── ITERATIVE GENERATION DECISION ──
    // Cinematic scripts are heavy: ~12K tokens per chapter (blocking, kling_clips,
    // image_prompt, animation_prompt per line). A 10-chapter cinematic script needs
    // ~120K tokens — far beyond max_tokens: 16384. Non-cinematic (staged) scripts
    // are lighter (~3-4K tokens/chapter) but can still overflow at 8+ chapters.
    //
    // Threshold: generate iteratively if estimated output exceeds ~14K tokens.
    // Cinematic story-driven: estimate from clip budget per chapter (~500 tokens/clip)
    // Each clip includes blocking, kling_clips with multi_shot_prompt, image_prompt,
    // animation_prompt — 150 tokens/clip was dramatically too low.
    // Cinematic fixed: scenesPerChapter * linesPerScene * 130
    // Staged: scenesPerChapter * linesPerScene * 45
    let estimatedTokensPerChapter;
    if (isCinematic && storyBrief.storyDriven) {
      // Story-driven: estimate from clip budget divided across chapters
      const clipsPerChapter = Math.ceil((storyBrief.targetClips || 50) / totalChapters);
      estimatedTokensPerChapter = clipsPerChapter * 500; // ~500 tokens/clip with full cinematic JSON
    } else if (isCinematic) {
      estimatedTokensPerChapter = scenesPerChapter * linesPerScene * 130;
    } else {
      estimatedTokensPerChapter = scenesPerChapter * linesPerScene * 45;
    }
    const estimatedTotalTokens = totalChapters * estimatedTokensPerChapter + 2000; // +2K for character bible
    // Story-driven cinematic chapters are heavy (unlimited scenes/lines, full blocking/kling_clips)
    // Claude Sonnet 4.6 supports up to 64K output tokens — use 32K for story-driven, 16K otherwise
    const storyDriven = isCinematic && storyBrief.storyDriven;
    const MAX_TOKENS_PER_CALL = storyDriven ? 32768 : 16384;
    // Story-driven cinematic ALWAYS needs iterative — the token estimate is unreliable
    // because scenes/lines are unlimited and the 150-tokens/clip estimate dramatically
    // underestimates the actual output (blocking, kling_clips, image_prompts, etc.)
    const needsIterative = storyDriven || estimatedTotalTokens > (MAX_TOKENS_PER_CALL * 0.85); // 85% safety margin

    if (!needsIterative) {
      // ── SINGLE-CALL PATH (short scripts — test/standard non-cinematic) ──
      console.log(`[SCRIPT] Single-call generation: ${totalChapters} chapters, ~${estimatedTotalTokens} estimated tokens`);
      return this._generateScriptSingleCall(prompt, onProgress);
    }

    // ── ITERATIVE PATH (long scripts — generates chapters in batches) ──
    const systemPrompt = 'You are a professional Nollywood screenplay writer and image prompt engineer. RESPOND WITH RAW JSON ONLY. Do NOT wrap in ```json``` code fences. Do NOT add any text before or after the JSON. Start your response with { and end with }.';

    // ── TWO-PASS vs CARRY-FORWARD ──
    // Story-driven cinematic uses TWO-PASS: outline first, then each chapter independently.
    // This keeps input constant (~8-10K) per chapter instead of growing linearly.
    // Non-story-driven uses the original CARRY-FORWARD: each batch carries compressed
    // previous chapters for narrative continuity.
    let finalScript;
    if (storyDriven) {
      finalScript = await this._generateStoryDriven({
        prompt, systemPrompt, storyBrief, totalChapters, tier, generatorMode,
        aspect, aspectFramingGuidance, scaffolding, cinematicScaffolding,
        researchContext, MAX_TOKENS_PER_CALL, onProgress,
      });
    } else {
      finalScript = await this._generateCarryForward({
        prompt, systemPrompt, storyBrief, totalChapters, tier, generatorMode,
        aspect, aspectFramingGuidance, scaffolding, cinematicScaffolding,
        researchContext, MAX_TOKENS_PER_CALL, isCinematic, scenesPerChapter,
        linesPerScene, onProgress,
      });
    }

    // ── POST-GENERATION VALIDATION ──
    let diagnostics = this._inspectScriptCompleteness(finalScript, storyBrief);
    if (diagnostics.oversizedClips.length > 0) {
      try {
        finalScript = await this._repairOversizedClipLineRefs(finalScript, storyBrief, diagnostics, onProgress);
        diagnostics = this._inspectScriptCompleteness(finalScript, storyBrief);
      } catch (repairErr) {
        diagnostics.ok = false;
        diagnostics.errors.unshift({
          type: 'oversized_line_refs_repair_failed',
          message: `Script repair failed: ${repairErr.message}`,
        });
        throw new ScriptValidationError(diagnostics.errors[0].message, finalScript, diagnostics);
      }
    }
    if (diagnostics.errors.length > 0) {
      throw new ScriptValidationError(diagnostics.errors[0].message, finalScript, diagnostics);
    }
    this._validateScriptCompleteness(finalScript, storyBrief);

    // Sanitize blocking
    this._sanitizeBlocking(finalScript);

    // Fix blocking → Shot 1 posture/position consistency
    this._fixBlockingShotConsistency(finalScript);

    // Sanitize kling_clip prompts — fix common LLM mistakes at the source
    this._sanitizeKlingClipPrompts(finalScript);

    return finalScript;
  }

  /**
   * Single-call script generation (original path for short scripts).
   * Used when the estimated token count fits within one API call.
   */
  async _generateScriptSingleCall(prompt, onProgress) {
    const fullText = await this._streamWithRetry({
      model: this.model,
      max_tokens: 16384,
      temperature: 0.7,
      system: 'You are a professional Nollywood screenplay writer and image prompt engineer. RESPOND WITH RAW JSON ONLY. Do NOT wrap in ```json``` code fences. Do NOT add any text before or after the JSON. Start your response with { and end with }.',
      messages: [{ role: 'user', content: prompt }],
      onProgress,
      label: 'Single-call script',
    });

    // Parse the JSON response with multi-strategy recovery
    const parsed = this._safeParseScriptJson(fullText);
    if (!parsed) throw new Error('No valid JSON found in Claude API response');

    // Sanitize blocking
    this._sanitizeBlocking(parsed);

    // Fix blocking → Shot 1 posture/position consistency
    this._fixBlockingShotConsistency(parsed);

    // Sanitize kling_clip prompts — fix common LLM mistakes at the source
    this._sanitizeKlingClipPrompts(parsed);

    return parsed;
  }

  /**
   * TWO-PASS story-driven generation for cinematic mode.
   *
   * Pass 1: Generate a lightweight story OUTLINE — character bible, chapter
   *         summaries, scene beats, key plot points, setup/payoff markers.
   *         This is ~4-8K tokens output.
   *
   * Pass 2: Generate each chapter INDEPENDENTLY using only the outline +
   *         character bible as context. Input stays constant (~8-10K) per
   *         chapter regardless of position in the story.
   *
   * This avoids the carry-forward problem where input grows linearly
   * (6K → 12K → 20K → 31K → 48K) as previous chapters accumulate.
   */
  async _generateStoryDriven({ prompt, systemPrompt, storyBrief, totalChapters,
    tier, generatorMode, aspect, aspectFramingGuidance, scaffolding,
    cinematicScaffolding, researchContext, MAX_TOKENS_PER_CALL, onProgress }) {

    const targetClips = storyBrief.targetClips || 50;
    const clipsPerChapter = Math.ceil(targetClips / totalChapters);

    // ── PRESTIGE TWO-PHASE PATH (R1 mitigation) ──
    // For prestige tier (15 chapters), the single-pass outline would exceed
    // max_tokens and get truncated. Split Pass A into:
    //   Phase A1: Arc skeleton (character bible + five-act beats, ~5K tokens)
    //   Phase A2: Detailed chapter outlines in batches of 5 (3 calls, ~5K each)
    // Non-prestige continues with the original single-outline Pass 1 below.
    let outline;
    if (tier === 'prestige') {
      outline = await this._generatePrestigeOutline({
        prompt, systemPrompt, storyBrief, totalChapters, targetClips,
        clipsPerChapter, onProgress,
      });
    } else {
      outline = await this._generateStandardOutline({
        prompt, systemPrompt, storyBrief, totalChapters, targetClips,
        clipsPerChapter, onProgress,
      });
    }

    const characterBible = outline.character_bible;
    const title = outline.title || storyBrief.title;

    // ── Extract voice anchors for chapter generation (all story-driven tiers) ──
    const voiceAnchors = this._extractVoiceAnchors(outline, storyBrief);

    // ── PASS 2 / PHASE B: Generate each chapter independently ──
    console.log(`[SCRIPT] Phase B — generating ${totalChapters} chapters independently`);
    const allChapters = [];

    for (let chNum = 1; chNum <= totalChapters; chNum++) {
      const chOutline = outline.chapter_outlines.find(c => c.chapter_number === chNum)
        || outline.chapter_outlines[chNum - 1]; // fallback to index if numbering is off
      const chLabel = `Chapter ${chNum}/${totalChapters}`;

      if (onProgress) onProgress(`\n[Phase B] ${chLabel}: "${chOutline?.chapter_title || '...'}"...`);

      // Narrative context: what happened BEFORE and AFTER this chapter (from outline only)
      const prevChapters = outline.chapter_outlines.filter(c => c.chapter_number < chNum);
      const nextChapters = outline.chapter_outlines.filter(c => c.chapter_number > chNum);
      const prevSummary = prevChapters.length
        ? prevChapters.map(c => `Ch ${c.chapter_number} "${c.chapter_title}": ${c.narrative_beat}`).join('\n')
        : '(This is the first chapter)';
      const nextSummary = nextChapters.length
        ? nextChapters.map(c => `Ch ${c.chapter_number} "${c.chapter_title}": ${c.narrative_beat}`).join('\n')
        : '(This is the final chapter)';

      // Beat guidance based on position
      let beatGuidance = '';
      if (chNum === totalChapters) {
        beatGuidance = 'This is the FINAL chapter — bring the story to a decisive climax and resolution. All plot threads must be resolved.';
      } else if (chNum > totalChapters * 0.5) {
        beatGuidance = 'This is in the second half — stakes should be at their highest. Every scene should escalate toward the climax.';
      }

      const chapterPrompt = `You are The Master Script & Image Engine for Nollywood AI drama production. You are generating ONE chapter of a ${totalChapters}-chapter cinematic script.

=== STORY CONTEXT ===
Title: "${title}"
Total chapters: ${totalChapters} (UNLIMITED scenes each, UNLIMITED lines per scene, target ~${targetClips} clips total, max 3 characters per scene)
Nationality: ${storyBrief.nationality}
Accent: ${storyBrief.accent}
Aspect Ratio: ${aspect}

${aspectFramingGuidance}

=== CHARACTER BIBLE (maintain these identities exactly) ===
${JSON.stringify(characterBible, null, 2)}

${voiceAnchors}

=== FULL STORY OUTLINE ===
B-Plot: ${outline.bplot_summary || 'N/A'}
${outline.bplot2_summary ? `B-Plot 2: ${outline.bplot2_summary}` : ''}
Setup/Payoff pairs: ${JSON.stringify(outline.setup_payoff_pairs || [])}
Relationship Arcs: ${JSON.stringify(outline.relationship_arcs || [], null, 2)}

Previous chapters (summary):
${prevSummary}

>>> THIS CHAPTER (${chNum}): "${chOutline?.chapter_title || ''}" <<<
Act: ${chOutline?.act || 'N/A'}
Narrative beat: ${chOutline?.narrative_beat || 'N/A'}
Power dynamic: ${chOutline?.power_holder_start || '?'} holds power at start → ${chOutline?.power_holder_end || '?'} holds power at end
Emotional temperature: ${chOutline?.emotional_temperature || 'building'}
Target clips: ~${chOutline?.target_clips || clipsPerChapter}
Chapter-end hook: ${chOutline?.chapter_end_hook || '(final chapter — resolve)'}

Scene beats to expand (each has scene_purpose and power_shift — honour them):
${JSON.stringify(chOutline?.scene_beats || [], null, 2)}

Upcoming chapters (summary):
${nextSummary}

=== NARRATIVE ARCHITECTURE RULES ===
${scaffolding}

${cinematicScaffolding}

${researchContext ? `=== MARKET RESEARCH CONTEXT ===\n${researchContext}` : ''}

=== YOUR TASK ===
Generate Chapter ${chNum} as a fully realized cinematic chapter with all scenes, dialogue, blocking, kling_clips, image_prompts, and animation_prompts.
${beatGuidance}

CRITICAL RULES:
1. Follow the scene beats from the outline but EXPAND them into full cinematic scenes with rich dialogue, blocking, and kling_clips.
2. Each scene has as many lines as the story needs — group into clips of exactly 3 lines each. Target ~${chOutline?.target_clips || clipsPerChapter} clips for this chapter.
3. Max 3 characters per scene.
4. Maintain character voices and physical descriptions EXACTLY as in the character bible. Respect each character's speech_style — a proverbial elder speaks in longer rhythmic cadences; a sharp young professional uses clipped sentences; a spiritual character invokes God/destiny. Voice is identity.
5. Use @element_name_hint references (e.g. @${characterBible[0]?.element_name_hint || 'character_name'}).
6. ${chNum < totalChapters ? `End on: "${chOutline?.chapter_end_hook || 'a cliffhanger or reveal'}"` : 'Bring the story to a decisive resolution.'}
7. Use consistent location_element_hint values matching the outline.
8. Each scene MUST include emotional_state: { "start": "...", "turn": "...", "end": "..." } — these are brief emotional descriptors (2-4 words) that track how the scene FEELS, not what happens. Examples: start: "uneasy calm", turn: "accusation lands", end: "cold fury". This helps continuity between scenes and prevents emotional whiplash.
9. Each kling_clip MUST include "visual_beat": a single concrete visual action tied to story meaning. NOT complex choreography — one AI-safe action that the camera can reveal. Examples: "clutches the envelope tighter", "slowly removes her ring", "steps back from the table", "hides phone behind her back", "turns the framed photo face-down". This gives Kling something visual to render beyond talking heads. The visual_beat goes into the shot direction of the most dramatically appropriate shot (usually Shot 2 or 3).
10. Honour the scene_purpose from the outline. A "reveal" scene must actually reveal something the audience didn't know. A "confrontation" must have characters in active opposition. A "setup" scene plants something for later. If the purpose doesn't match the content, the scene is mislabeled or broken.
11. Each scene MUST include "character_outfits": a mapping of character_id → outfit_id from the character_bible. This tells the visual pipeline which element (portrait/outfit) to use. Copy it directly from the outline's scene_beats. If a character changes outfit within a scene, SPLIT into two scenes — a single scene cannot have one character in two outfits.
12. Each scene SHOULD include "background_roles" when the location would feel fake without non-speaking people. Background roles are environmental only: no dialogue, no portrait, no character_bible entry, and they do not count toward the 3-character scene limit.
13. Institutional scenes MUST include appropriate functional presence as speaking characters or background_roles: court (judge/lawyer/clerk/bailiff), hospital (doctor/nurse/reception), police station (officer/investigator), church (pastor/elder/usher), school (teacher/principal), palace (chief/elder/attendant), market/event/funeral (crowd/traders/guests/mourners).
14. Procedure-heavy scenes MUST include "props_in_scene" for concrete proof: affidavits, stamped files, land receipts, medical reports, ID cards, charge sheets, ledgers, phone recordings, letters, keys, rings, medicine. Major legal/medical/business/land stakes should not resolve with talk alone.
15. Everyday realism MUST track logistics, money, communication, and aftermath. Travel between distant locations needs implied elapsed time; arrests, court dates, medical results, and family meetings need plausible sequence; phone calls/messages need believable access, battery, privacy, and timing; money demands should match the character's class and job; major revelations need aftermath before the next plot turn.
16. Social realism matters: gossip, family hierarchy, religious pressure, elder authority, class difference, gender expectations, community shame, workplace consequences, and public reputation should affect how characters behave. Do not let characters act as isolated plot machines.
17. Props persist across the story. If a phone, document, ring, key, test result, medicine, photograph, or recording triggers a beat, it must be accounted for later as setup/payoff or explicitly discarded.
18. Every kling_clip.line_refs array MUST contain 1-3 line numbers, never 4 or more. If a dramatic beat needs more than 3 dialogue lines, create another complete kling_clip with its own real multi_shot_prompt. Never rely on auto-splitting or placeholder prompts.

=== STRICT RULES ===
- Dialogue Only: Only character speech. No narration, SFX, or descriptions.
- The 9-Word Rule: Every single sentence must be 9 words or less. EXCEPTION: Characters with speech_style "proverbial" or "spiritual" may use up to 12 words per sentence to preserve cultural cadence (proverbs, blessings, accusations with rhetorical weight). This does NOT mean all their lines can be 12 words — it is a ceiling for lines that genuinely need the rhythmic space.
- The Camera Jump: If a character says more than 9 words (or 12 for proverbial/spiritual), break it with [NEW CAMERA ANGLE] + the next short sentence.

=== RESPONSE FORMAT ===
Respond in JSON:
{
  "chapters": [
    {
      "chapter_number": ${chNum},
      "chapter_title": "${chOutline?.chapter_title || '...'}",
      "scenes": [...]
    }
  ]
}

Generate Chapter ${chNum} now. JSON only.`;

      const chText = await this._streamWithRetry({
        model: this.model,
        max_tokens: MAX_TOKENS_PER_CALL,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: chapterPrompt }],
        onProgress,
        label: chLabel,
      });

      console.log(`[SCRIPT] ${chLabel} raw response length: ${chText.length} chars`);
      const chParsed = this._safeParseScriptJson(chText);
      if (!chParsed) {
        console.error(`[SCRIPT] ${chLabel} produced no valid JSON. Raw length: ${chText.length}`);
        throw new Error(`${chLabel} produced no valid JSON. Generated ${allChapters.length}/${totalChapters} chapters before failure.`);
      }

      const chChapters = chParsed.chapters || (Array.isArray(chParsed) ? chParsed : [chParsed]);
      if (!chChapters.length) {
        throw new Error(`${chLabel} returned 0 chapters. Generated ${allChapters.length}/${totalChapters} before failure.`);
      }

      // Validate: expect exactly one chapter with the correct chapter_number
      if (chChapters.length > 1) {
        console.warn(`[SCRIPT] ${chLabel} returned ${chChapters.length} chapters — expected 1. Taking first only.`);
      }
      const returnedCh = chChapters[0];
      if (returnedCh.chapter_number !== undefined && returnedCh.chapter_number !== chNum) {
        console.warn(`[SCRIPT] ${chLabel} returned chapter_number ${returnedCh.chapter_number} — expected ${chNum}. Correcting.`);
        returnedCh.chapter_number = chNum;
      } else if (returnedCh.chapter_number === undefined) {
        returnedCh.chapter_number = chNum;
      }

      allChapters.push(returnedCh);
      const sceneCount = (returnedCh.scenes || []).length;
      const clipCount = (returnedCh.scenes || []).reduce((sum, s) => sum + (s.kling_clips || []).length, 0);
      console.log(`[SCRIPT] ${chLabel} complete: ${sceneCount} scenes, ${clipCount} clips (total: ${allChapters.length}/${totalChapters})`);
    }

    // ── Validate final chapter coverage: exactly 1..totalChapters ──
    const finalChNums = allChapters.map(c => c.chapter_number);
    const finalSet = new Set(finalChNums);
    const finalMissing = [];
    for (let i = 1; i <= totalChapters; i++) {
      if (!finalSet.has(i)) finalMissing.push(i);
    }
    if (finalMissing.length || allChapters.length !== totalChapters) {
      throw new Error(
        `Phase B chapter validation failed — expected ${totalChapters} chapters (1-${totalChapters}), ` +
        `got ${allChapters.length} chapters [${finalChNums.join(',')}]` +
        (finalMissing.length ? `. Missing: ${finalMissing.join(', ')}` : '') +
        `. Re-run to retry.`
      );
    }

    return {
      title,
      character_bible: characterBible,
      chapters: allChapters,
    };
  }

  /**
   * Standard (non-prestige) outline generation — single Pass 1.
   * Returns the full outline object with character_bible, chapter_outlines, etc.
   */
  async _generateStandardOutline({ prompt, systemPrompt, storyBrief, totalChapters,
    targetClips, clipsPerChapter, onProgress }) {

    console.log(`[SCRIPT] Two-pass generation: Pass 1 — outline + character bible`);
    if (onProgress) onProgress(`[Pass 1/2] Generating story outline + character bible...`);

    const outlinePrompt = prompt + `\n\n` +
`=== GENERATION MODE: OUTLINE ONLY ===
You are generating a STORY OUTLINE, not the full script. This outline will be used to generate each chapter independently in a follow-up step.

Return JSON with this EXACT structure:
{
  "title": "${storyBrief.title}",
  "character_bible": [
    {
      "id": "character_id",
      "description_label": "Human-readable name",
      "element_name_hint": "snake_case_name",
      "physical_description": "PERMANENT physical features ONLY: face shape, skin tone, build, height, hair texture, distinguishing marks, age appearance. NO clothing here — clothing goes in outfits[]. This anchors face identity across all outfit changes.",
      "outfits": [
        {
          "outfit_id": "o1",
          "description": "Full clothing/styling description for this outfit: garments, accessories, hair styling, shoes, makeup level. E.g. 'Navy fitted power suit, gold stud earrings, straight shoulder-length wig, nude heels, minimal makeup'",
          "context": "When this outfit is worn: 'Office scenes, corporate meetings, public appearances'"
        },
        {
          "outfit_id": "o2",
          "description": "E.g. 'Coral ankara wrapper tied at waist, matching head tie, bare feet, no makeup, simple gold bangle'",
          "context": "When this outfit is worn: 'Home scenes, private moments, morning/evening'"
        }
      ],
      "role": "protagonist|antagonist|confidant|supporting|bplot",
      "arc_summary": "One sentence: what this character wants and how they change",
      "speech_style": "formal|proverbial|sharp|pleading|sarcastic|spiritual|street-smart|class-conscious|warm-maternal|cold-authoritative",
      "speech_notes": "1-2 sentences describing HOW this character talks: rhythm, cadence, vocabulary level, cultural markers. E.g. 'Uses proverbs to deflect, never answers directly, speaks in measured Igbo-inflected English.'"
    }
  ],
  "relationship_arcs": [
    {
      "characters": ["char_id_1", "char_id_2"],
      "type": "mother-daughter|husband-wife|rivals|employer-servant|elder-younger|lovers|siblings|mentor-protégé|friends-turned-enemies",
      "arc": "One sentence: how this relationship changes across the story",
      "tension_source": "What drives conflict between them"
    }
  ],
  "chapter_outlines": [
    {
      "chapter_number": 1,
      "chapter_title": "...",
      "act": "setup|rising|midpoint|climax|resolution",
      "narrative_beat": "What happens in this chapter — 2-3 sentences",
      "power_holder_start": "char_id who holds power at chapter start",
      "power_holder_end": "char_id who holds power at chapter end",
      "emotional_temperature": "low-simmer|building|boiling|aftermath",
      "scene_beats": [
        {
          "scene_number": 1,
          "location": "Description of location",
          "location_element_hint": "snake_case_location",
          "characters_present": ["char_id_1", "char_id_2"],
          "background_roles": ["non-speaking role or crowd context if needed"],
          "character_outfits": {"char_id_1": "o1", "char_id_2": "o2"},
          "props_in_scene": ["story-relevant prop or document visible in the setting"],
          "beat": "What happens in this scene — 1-2 sentences",
          "scene_purpose": "reveal|confrontation|reversal|temptation|public-shame|private-confession|decision|trap|payoff|setup|alliance",
          "power_shift": "char_id_1 → char_id_2 (or 'none' if power doesn't change)",
          "emotional_arc": "tension rises|power shifts|reveal|confrontation|resolution",
          "target_lines": 6,
          "target_clips": 2
        }
      ],
      "chapter_end_hook": "What cliffhanger/question ends this chapter",
      "target_clips": ${clipsPerChapter}
    }
  ],
  "setup_payoff_pairs": [
    { "setup_chapter": 2, "payoff_chapter": 8, "detail": "Description of the planted detail" }
  ],
  "bplot_summary": "One paragraph describing the B-plot arc and where it intersects the main plot"
}

RULES FOR OUTLINE:
- The character_bible MUST separate physical_description (permanent body/face features used for portrait generation) from outfits[] (clothing/styling that changes across the story). physical_description NEVER includes clothing — it anchors face identity across outfit changes.
- OUTFIT RULES: Every character must have at least 1 outfit. Protagonists and antagonists should have 2-4 outfits reflecting their life contexts (work, home, event, disguise, transformation). Supporting characters can have 1-2. Each outfit must have a clear context describing WHEN it is worn — this maps to specific scenes. Outfit descriptions must be vivid and specific enough for AI image generation (fabric type, color, accessories, styling details). outfit_id uses sequential numbering: o1, o2, o3...
- Each character MUST have speech_style and speech_notes — these enforce voice consistency when chapters are generated independently. Nigerian drama characters speak differently by class, age, region, and role. A market woman speaks differently than a banker's wife.
- relationship_arcs: Identify 3-5 key relationships that DRIVE the drama. Nollywood melodrama lives in the space between people — not just in plot events. The arc field describes how the bond transforms. The chapter generator uses these to ensure every scene services at least one relationship.
- Each scene_beat MUST include character_outfits — a mapping of each character_id in that scene to their outfit_id. This determines which visual identity (portrait + element) is used for generation. An outfit change mid-story (e.g. going from office to home) is a DIFFERENT element — the system needs this mapping to select the correct visual. If a character changes outfit within a chapter, they need separate scenes with the new outfit_id.
- Scene beats should describe WHO is talking about WHAT, not the actual dialogue.
- Each scene beat MUST have scene_purpose — this is the dramatic function of the scene. A scene without a clear purpose is filler. If you cannot name its purpose from the taxonomy, the scene should not exist.
- Each scene beat MUST have power_shift — who holds status/authority/leverage at the start vs end. Nollywood conflict thrives on reversals of social power: elder/younger, rich/poor, man/woman, saved/damned. Not every scene shifts power (use 'none'), but at least half should.
- Chapter-level power_holder_start/end tracks the macro power dynamic across the story — essential for the chapter generator to know who is winning at each point.
- emotional_temperature per chapter prevents the "constant escalation" trap. A story needs low-simmer chapters (aftermath, setup, quiet tension) as breathing room between boiling-point confrontations. Not every chapter can be at maximum intensity.
- Each scene beat specifies target_lines (how many dialogue lines) and target_clips (how many Kling clips).
- Total target_clips across all chapters should be ~${targetClips}.
- Each scene_beat SHOULD include background_roles when realism requires people who are present but not speaking. Background roles do NOT go in character_bible, do NOT get dialogue, and do NOT count toward the 3-character scene limit. Examples: courtroom gallery, judge at bench, court clerk, market crowd, church ushers, nurses at station.
- Institutional or procedure-heavy scenes MUST include either an appropriate speaking role in characters_present OR non-speaking background_roles. Examples: court needs judge/lawyer/clerk/bailiff; hospital needs doctor/nurse/reception; police station needs officer/investigator; church needs pastor/elder/usher; school needs teacher/principal; palace needs chief/elder/attendant.
- Scene beats involving legal, medical, business, land, school, or police stakes SHOULD include props_in_scene for concrete proof/procedure: affidavit, stamped file, land receipt, medical report, ID card, charge sheet, school-fee ledger, phone recording, signed letter. Do not resolve major stakes with talk alone.
- Scene beats SHOULD account for logistics when the plot moves across time/place: travel, court dates, hospital results, police processes, school meetings, funerals, weddings, family councils, and work obligations need plausible sequence and elapsed time.
- Scene beats SHOULD account for social pressure: gossip, family hierarchy, elder authority, religious expectation, public shame, class difference, gender expectations, workplace consequences, and reputation.
- Scene beats SHOULD preserve object continuity. If a phone, document, ring, key, medicine, photograph, money, test result, or recording matters, keep it visible in props_in_scene until it pays off or is explicitly removed.
- Money, jobs, housing, transport, and communication access SHOULD match the character's class/context. A broke student, market trader, banker, pastor, chief, police officer, and diaspora relative should not have identical resources or speech register.
- Max 3 characters per scene_beat (Kling constraint).
- Locations should use consistent location_element_hint values across chapters.
- The outline IS the story — each chapter must be rich enough that an independent writer could generate the full chapter from this outline alone.
- Include chapter_end_hook for every chapter except the last.

Generate the outline now. JSON only.`;

    const outlineText = await this._streamWithRetry({
      model: this.model,
      max_tokens: 16384,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: outlinePrompt }],
      onProgress,
      label: 'Pass 1 (outline)',
    });

    console.log(`[SCRIPT] Pass 1 raw response length: ${outlineText.length} chars`);
    const outline = this._safeParseScriptJson(outlineText);
    if (!outline) {
      console.error(`[SCRIPT] Pass 1 raw start: ${outlineText.substring(0, 500)}`);
      throw new Error('Pass 1 (outline) produced no valid JSON');
    }
    if (!outline.chapter_outlines?.length) {
      throw new Error('Pass 1 outline has no chapter_outlines');
    }
    if (!outline.character_bible?.length) {
      throw new Error('Pass 1 outline has no character_bible');
    }

    console.log(`[SCRIPT] Pass 1 complete: ${outline.character_bible.length} characters, ${outline.chapter_outlines.length} chapter outlines`);
    return outline;
  }

  /**
   * Prestige two-phase outline generation (R1 mitigation).
   * Phase A1: Arc skeleton — character bible, five-act beat structure, relationship
   *   arcs, setup/payoff pairs, B-plot summaries, thematic thesis. ~5K tokens.
   * Phase A2: Detailed chapter outlines in batches of 5 (3 calls for 15 chapters),
   *   each using A1 skeleton as fixed context. ~5K tokens per batch.
   * Returns the same outline shape as _generateStandardOutline.
   */
  async _generatePrestigeOutline({ prompt, systemPrompt, storyBrief, totalChapters,
    targetClips, clipsPerChapter, onProgress }) {

    const actBreaks = {
      act1End: Math.max(3, Math.floor(totalChapters / 5)),
      act2End: Math.max(6, Math.floor(totalChapters * 2 / 5)),
      act3End: Math.max(9, Math.floor(totalChapters * 3 / 5)),
      act4End: Math.max(12, Math.floor(totalChapters * 4 / 5)),
    };

    // ── PHASE A1: Arc skeleton (story bible) ──
    console.log(`[SCRIPT] Prestige two-phase outline: Phase A1 — arc skeleton`);
    if (onProgress) onProgress(`[Phase A1/A2] Generating arc skeleton (story bible)...`);

    const a1Prompt = prompt + `\n\n` +
`=== GENERATION MODE: ARC SKELETON ONLY (Phase A1 of 2) ===
You are generating a STORY BIBLE / ARC SKELETON for a ${totalChapters}-chapter prestige Nollywood drama. This is NOT the detailed chapter outline — that comes in Phase A2. This phase establishes the foundational elements that all chapters will reference.

Return JSON with this EXACT structure:
{
  "title": "${storyBrief.title}",
  "thematic_thesis": "One sentence: the central thematic argument this story makes (e.g. 'Power corrupts even those who seek it for righteous reasons')",
  "character_bible": [
    {
      "id": "character_id",
      "description_label": "Human-readable name",
      "element_name_hint": "snake_case_name",
      "physical_description": "PERMANENT physical features ONLY: face shape, skin tone, build, height, hair texture, distinguishing marks, age appearance. NO clothing.",
      "outfits": [
        {
          "outfit_id": "o1",
          "description": "Full clothing/styling description",
          "context": "When this outfit is worn"
        }
      ],
      "role": "protagonist|antagonist|confidant|supporting|bplot",
      "arc_summary": "One sentence: what this character wants and how they change",
      "speech_style": "formal|proverbial|sharp|pleading|sarcastic|spiritual|street-smart|class-conscious|warm-maternal|cold-authoritative",
      "speech_notes": "1-2 sentences describing HOW this character talks"
    }
  ],
  "relationship_arcs": [
    {
      "characters": ["char_id_1", "char_id_2"],
      "type": "mother-daughter|husband-wife|rivals|employer-servant|elder-younger|lovers|siblings|mentor-protégé|friends-turned-enemies",
      "arc": "How this relationship transforms across all five acts",
      "tension_source": "What drives conflict between them"
    }
  ],
  "five_act_beats": {
    "act1_setup": {
      "chapters": [1, ${actBreaks.act1End}],
      "beat": "2-3 sentences: what happens in Act I — world, ensemble, dual story engines launched",
      "inciting_incident": "The specific event that disrupts the protagonist's world",
      "bplot1_seed": "How B-plot 1 is introduced",
      "bplot2_seed": "How B-plot 2 is seeded (not fully launched)"
    },
    "act2_complications": {
      "chapters": [${actBreaks.act1End + 1}, ${actBreaks.act2End}],
      "beat": "2-3 sentences: A-plot escalation, both B-plots active",
      "new_complications": "What NEW complications arise (not just continuation)",
      "bplot1_intersection": "How B-plot 1 collides with A-plot by end of Act II"
    },
    "act3_midpoint_crisis": {
      "chapters": [${actBreaks.act2End + 1}, ${actBreaks.act3End}],
      "beat": "2-3 sentences: the major reversal that reframes everything",
      "midpoint_reversal": "The specific reframe — what the audience believed was true is wrong",
      "bplot2_collision": "How B-plot 2 collides with A-plot during/after midpoint"
    },
    "act4_unraveling": {
      "chapters": [${actBreaks.act3End + 1}, ${actBreaks.act4End}],
      "beat": "2-3 sentences: consequences cascade, alliances shift, highest tension",
      "bplot_crises": "How both B-plots reach their own mini-climaxes",
      "setup_payoffs_firing": "Which setup/payoff pairs fire in Act IV"
    },
    "act5_climax": {
      "chapters": [${actBreaks.act4End + 1}, ${totalChapters}],
      "beat": "2-3 sentences: all threads converge, decisive resolution",
      "resolution_order": "Order of resolution: B-plots first, then A-plot climax"
    }
  },
  "setup_payoff_pairs": [
    { "setup_act": "I", "payoff_act": "IV", "detail": "The specific planted detail and how it pays off" }
  ],
  "bplot_summary": "One paragraph: B-plot 1 arc — setup, complication, intersection with A-plot, resolution",
  "bplot2_summary": "One paragraph: B-plot 2 arc — setup, complication, intersection with A-plot, resolution"
}

RULES FOR ARC SKELETON:
- Character bible uses the same format as standard outlines (physical_description, outfits, speech_style, speech_notes).
- Prestige requires 6-10 characters with mandatory roles: protagonist, antagonist, 2 confidants, 2+ B-plot leads, 2+ supporting.
- 3+ setup/payoff pairs — these must be SPECIFIC objects/phrases/details, not abstract concepts.
- Dual B-plots required, each with own mini-arc that COLLIDES with A-plot.
- Five-act beats use the 20/40/60/80% chapter splits: Act I (ch 1-${actBreaks.act1End}), Act II (ch ${actBreaks.act1End + 1}-${actBreaks.act2End}), Act III (ch ${actBreaks.act2End + 1}-${actBreaks.act3End}), Act IV (ch ${actBreaks.act3End + 1}-${actBreaks.act4End}), Act V (ch ${actBreaks.act4End + 1}-${totalChapters}).
- This skeleton is the FOUNDATION. Phase A2 will generate detailed per-chapter outlines using this as fixed context.
- Do NOT include chapter_outlines here — those come in Phase A2.

Generate the arc skeleton now. JSON only.`;

    const a1Text = await this._streamWithRetry({
      model: this.model,
      max_tokens: 8192,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: a1Prompt }],
      onProgress,
      label: 'Phase A1 (arc skeleton)',
    });

    console.log(`[SCRIPT] Phase A1 raw response length: ${a1Text.length} chars`);
    const arcSkeleton = this._safeParseScriptJson(a1Text);
    if (!arcSkeleton) {
      console.error(`[SCRIPT] Phase A1 raw start: ${a1Text.substring(0, 500)}`);
      throw new Error('Phase A1 (arc skeleton) produced no valid JSON');
    }
    if (!arcSkeleton.character_bible?.length) {
      throw new Error('Phase A1 arc skeleton has no character_bible');
    }
    if (!arcSkeleton.five_act_beats) {
      throw new Error('Phase A1 arc skeleton has no five_act_beats');
    }
    console.log(`[SCRIPT] Phase A1 complete: ${arcSkeleton.character_bible.length} characters, five-act beats defined`);

    // ── PHASE A2: Detailed chapter outlines in batches of 5 ──
    const BATCH_SIZE = 5;
    const numBatches = Math.ceil(totalChapters / BATCH_SIZE);
    console.log(`[SCRIPT] Phase A2 — detailed chapter outlines in ${numBatches} batches of ${BATCH_SIZE}`);

    const allChapterOutlines = [];

    // Compact arc skeleton context for A2 calls (strip outfits to save tokens)
    const compactBible = arcSkeleton.character_bible.map(c => ({
      id: c.id,
      description_label: c.description_label,
      element_name_hint: c.element_name_hint,
      role: c.role,
      arc_summary: c.arc_summary,
      speech_style: c.speech_style,
      speech_notes: c.speech_notes,
      outfits: (c.outfits || []).map(o => ({
        outfit_id: o.outfit_id || o.id,
        context: o.context || o.description || o.label || '',
      })),
    }));

    for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
      const batchStart = batchIdx * BATCH_SIZE + 1;
      const batchEnd = Math.min((batchIdx + 1) * BATCH_SIZE, totalChapters);
      const batchLabel = `Phase A2 batch ${batchIdx + 1}/${numBatches} (Ch ${batchStart}-${batchEnd})`;

      if (onProgress) onProgress(`\n[Phase A2] Generating chapter outlines ${batchStart}-${batchEnd}...`);

      // Determine which act(s) this batch covers
      const batchActContext = [];
      for (let ch = batchStart; ch <= batchEnd; ch++) {
        let actName;
        if (ch <= actBreaks.act1End) actName = 'act1_setup';
        else if (ch <= actBreaks.act2End) actName = 'act2_complications';
        else if (ch <= actBreaks.act3End) actName = 'act3_midpoint_crisis';
        else if (ch <= actBreaks.act4End) actName = 'act4_unraveling';
        else actName = 'act5_climax';
        if (!batchActContext.includes(actName)) batchActContext.push(actName);
      }
      const actBeats = batchActContext.map(a => `${a}: ${JSON.stringify(arcSkeleton.five_act_beats[a])}`).join('\n');

      // Include previous batch outlines as summary context
      const prevOutlineSummary = allChapterOutlines.length
        ? allChapterOutlines.map(c => `Ch ${c.chapter_number} "${c.chapter_title}": ${c.narrative_beat}`).join('\n')
        : '(No previous chapters — this is the first batch)';

      const a2Prompt = `You are generating DETAILED CHAPTER OUTLINES for chapters ${batchStart}-${batchEnd} of a ${totalChapters}-chapter prestige Nollywood drama.

=== ARC SKELETON (fixed — do not modify) ===
Title: "${arcSkeleton.title}"
Thematic thesis: ${arcSkeleton.thematic_thesis || 'N/A'}

Characters (compact):
${JSON.stringify(compactBible, null, 2)}

Relationship Arcs:
${JSON.stringify(arcSkeleton.relationship_arcs || [], null, 2)}

Five-Act Beats (relevant to this batch):
${actBeats}

Setup/Payoff Pairs:
${JSON.stringify(arcSkeleton.setup_payoff_pairs || [])}

B-Plot 1: ${arcSkeleton.bplot_summary || 'N/A'}
B-Plot 2: ${arcSkeleton.bplot2_summary || 'N/A'}

Previous chapter outlines (summary):
${prevOutlineSummary}

=== YOUR TASK ===
Generate detailed chapter outlines for chapters ${batchStart} through ${batchEnd}.

Return JSON:
{
  "chapter_outlines": [
    {
      "chapter_number": N,
      "chapter_title": "...",
      "act": "setup|rising|midpoint|climax|resolution",
      "narrative_beat": "What happens — 2-3 sentences",
      "power_holder_start": "char_id",
      "power_holder_end": "char_id",
      "emotional_temperature": "low-simmer|building|boiling|aftermath",
      "scene_beats": [
        {
          "scene_number": 1,
          "location": "Description of location",
          "location_element_hint": "snake_case_location",
          "characters_present": ["char_id_1", "char_id_2"],
          "background_roles": ["non-speaking role or crowd context if needed"],
          "character_outfits": {"char_id_1": "o1", "char_id_2": "o2"},
          "props_in_scene": ["story-relevant prop or document visible in the setting"],
          "beat": "What happens — 1-2 sentences",
          "scene_purpose": "reveal|confrontation|reversal|temptation|public-shame|private-confession|decision|trap|payoff|setup|alliance",
          "power_shift": "char_id_1 → char_id_2 (or 'none')",
          "emotional_arc": "tension rises|power shifts|reveal|confrontation|resolution",
          "target_lines": 6,
          "target_clips": 2
        }
      ],
      "chapter_end_hook": "What cliffhanger/question ends this chapter",
      "target_clips": ${clipsPerChapter}
    }
  ]
}

RULES:
- Follow the five-act beat structure from the arc skeleton — each chapter must serve its act's dramatic function.
- Maintain continuity with previous chapter outlines (if any).
- Each scene_beat MUST include character_outfits, scene_purpose, and power_shift.
- Each scene_beat SHOULD include background_roles for realistic non-speaking institutional/community presence and props_in_scene for concrete proof/procedure when documents, money, medicine, police, court, school, church, palace, market, land, or business stakes are involved.
- Max 3 characters per scene_beat (Kling constraint).
- Total target_clips across ALL ${totalChapters} chapters should be ~${targetClips}. Distribute ~${clipsPerChapter} per chapter, weighted by dramatic importance.
- Use consistent location_element_hint values.
- Include chapter_end_hook for every chapter except the last (chapter ${totalChapters}).
- These outlines must be rich enough that an independent writer could generate the full chapter from them alone.

Generate chapter outlines ${batchStart}-${batchEnd} now. JSON only.`;

      const a2Text = await this._streamWithRetry({
        model: this.model,
        max_tokens: 8192,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: a2Prompt }],
        onProgress,
        label: batchLabel,
      });

      console.log(`[SCRIPT] ${batchLabel} raw response length: ${a2Text.length} chars`);
      const a2Parsed = this._safeParseScriptJson(a2Text);
      if (!a2Parsed) {
        console.error(`[SCRIPT] ${batchLabel} raw start: ${a2Text.substring(0, 500)}`);
        throw new Error(`${batchLabel} produced no valid JSON`);
      }

      const batchOutlines = a2Parsed.chapter_outlines || [];
      if (!batchOutlines.length) {
        throw new Error(`${batchLabel} returned 0 chapter outlines`);
      }

      allChapterOutlines.push(...batchOutlines);
      console.log(`[SCRIPT] ${batchLabel} complete: ${batchOutlines.length} chapter outlines (total: ${allChapterOutlines.length}/${totalChapters})`);
    }

    // ── Validate outline coverage: every chapter 1..totalChapters exactly once ──
    const seen = new Set();
    const duplicates = [];
    const outOfRange = [];
    for (const ol of allChapterOutlines) {
      const cn = ol.chapter_number;
      if (cn < 1 || cn > totalChapters) outOfRange.push(cn);
      if (seen.has(cn)) duplicates.push(cn);
      seen.add(cn);
    }
    const missing = [];
    for (let i = 1; i <= totalChapters; i++) {
      if (!seen.has(i)) missing.push(i);
    }
    if (duplicates.length || missing.length || outOfRange.length || allChapterOutlines.length !== totalChapters) {
      const parts = [];
      if (allChapterOutlines.length !== totalChapters) parts.push(`expected ${totalChapters} outlines but got ${allChapterOutlines.length}`);
      if (outOfRange.length) parts.push(`out-of-range chapters: ${outOfRange.join(', ')}`);
      if (missing.length) parts.push(`missing chapters: ${missing.join(', ')}`);
      if (duplicates.length) parts.push(`duplicate chapters: ${duplicates.join(', ')}`);
      throw new Error(
        `Prestige outline validation failed — expected exactly chapters 1-${totalChapters} (${parts.join('; ')}). ` +
        `Re-run to retry.`
      );
    }
    // Sort by chapter number in case batches returned out of order
    allChapterOutlines.sort((a, b) => a.chapter_number - b.chapter_number);

    // ── Merge A1 + A2 into the standard outline shape ──
    const mergedOutline = {
      title: arcSkeleton.title,
      character_bible: arcSkeleton.character_bible,
      relationship_arcs: arcSkeleton.relationship_arcs,
      chapter_outlines: allChapterOutlines,
      setup_payoff_pairs: arcSkeleton.setup_payoff_pairs,
      bplot_summary: arcSkeleton.bplot_summary,
      bplot2_summary: arcSkeleton.bplot2_summary,
      thematic_thesis: arcSkeleton.thematic_thesis,
      five_act_beats: arcSkeleton.five_act_beats,
    };

    console.log(`[SCRIPT] Prestige outline complete: ${mergedOutline.character_bible.length} characters, ${mergedOutline.chapter_outlines.length} chapter outlines`);
    return mergedOutline;
  }

  /**
   * Extract voice anchors from outline for injection into chapter prompts.
   * Prevents voice drift across independent chapter generation calls by giving
   * each call a compact reference of each character's speech patterns.
   *
   * Applies to ALL story-driven scripts (not just prestige) — voice consistency
   * matters at any chapter count, but especially at 12-15 chapters.
   *
   * Returns a formatted string block (~200-400 tokens) for injection into
   * chapter prompts between CHARACTER BIBLE and FULL STORY OUTLINE sections.
   */
  _extractVoiceAnchors(outline, storyBrief) {
    const characterBible = outline.character_bible || [];
    if (!characterBible.length) return '';

    // Extract 2-3 signature phrases per major character from speech_notes + speech_style
    const characterAnchors = characterBible
      .filter(c => c.speech_style || c.speech_notes)
      .map(c => {
        const phrases = [];

        // Derive signature phrase patterns from speech_notes
        if (c.speech_notes) {
          // Extract quoted phrases if present in speech_notes
          const quotedPhrases = c.speech_notes.match(/'[^']+'/g) || c.speech_notes.match(/"[^"]+"/g) || [];
          phrases.push(...quotedPhrases.slice(0, 2));
        }

        // Add speech style descriptor as a phrase anchor
        if (c.speech_style) {
          const styleDescriptors = {
            'proverbial': 'speaks in proverbs and indirect wisdom — longer rhythmic cadences',
            'spiritual': 'invokes God, destiny, ancestors — blessings and curses as punctuation',
            'sharp': 'clipped, direct sentences — wastes no words, cuts with precision',
            'formal': 'measured, proper English — distances with vocabulary',
            'pleading': 'repetitive, emotional appeals — rises in pitch and urgency',
            'sarcastic': 'dry wit, loaded pauses — says the opposite of what they mean',
            'street-smart': 'pidgin-inflected, quick retorts — streetwise rhythm',
            'class-conscious': 'code-switches between registers — polished in public, raw in private',
            'warm-maternal': 'gentle authority — endearments mixed with firm directives',
            'cold-authoritative': 'commands, not requests — minimal emotion, maximum control',
          };
          const descriptor = styleDescriptors[c.speech_style] || c.speech_style;
          phrases.push(descriptor);
        }

        return {
          id: c.element_name_hint || c.id,
          label: c.description_label || c.id,
          role: c.role || 'supporting',
          style: c.speech_style || 'neutral',
          anchors: phrases.slice(0, 3),
          speech_notes: c.speech_notes || '',
        };
      });

    if (!characterAnchors.length) return '';

    // Derive TONE_BASELINE from emotional temperatures + concept
    const emotionalTemps = (outline.chapter_outlines || [])
      .map(c => c.emotional_temperature)
      .filter(Boolean);
    const tempDistribution = {};
    emotionalTemps.forEach(t => { tempDistribution[t] = (tempDistribution[t] || 0) + 1; });
    const dominantTemp = Object.entries(tempDistribution)
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0])
      .slice(0, 2)
      .join(' → ');

    const concept = storyBrief.concept || '';
    const toneBaseline = `This is a Nigerian drama with emotional register moving ${dominantTemp || 'building → boiling'}. ${
      concept.length > 100 ? concept.substring(0, 100) + '...' : concept
    } — maintain cultural authenticity in speech patterns throughout.`;

    // Format as injectable block
    const anchorLines = characterAnchors.map(a => {
      const anchorStr = a.anchors.length
        ? `\n    Anchors: ${a.anchors.join(' | ')}`
        : '';
      return `  @${a.id} (${a.label}, ${a.role}): ${a.style}${anchorStr}${
        a.speech_notes ? `\n    Notes: ${a.speech_notes}` : ''
      }`;
    }).join('\n');

    return `=== VOICE_ANCHORS (maintain these speech patterns in EVERY chapter) ===
TONE_BASELINE: ${toneBaseline}

CHARACTER VOICE SIGNATURES:
${anchorLines}

VOICE DRIFT PREVENTION: Each character's speech pattern above is their identity. A proverbial character NEVER speaks in clipped sentences. A sharp character NEVER uses proverbs. If you find a character's dialogue sounding generic or interchangeable with another character, rewrite it to match their voice signature above. Voice consistency across chapters is as important as plot consistency.
===`;
  }

  /**
   * Original carry-forward iterative generation for non-story-driven scripts.
   * Each batch includes compressed previous chapters for narrative continuity.
   * Works well for shorter scripts where context growth is manageable.
   */
  async _generateCarryForward({ prompt, systemPrompt, storyBrief, totalChapters,
    tier, generatorMode, aspect, aspectFramingGuidance, scaffolding,
    cinematicScaffolding, researchContext, MAX_TOKENS_PER_CALL, isCinematic,
    scenesPerChapter, linesPerScene, onProgress }) {

    const storyDriven = false; // carry-forward is never story-driven
    const batchPlan = this._calculateBatchPlan(totalChapters, isCinematic, storyDriven);
    console.log(`[SCRIPT] Carry-forward generation: ${totalChapters} chapters in ${batchPlan.length} batches`);
    console.log(`[SCRIPT] Batch plan: ${batchPlan.map(b => `[Ch ${b.startChapter}-${b.endChapter}]`).join(' → ')}`);

    // ── BATCH 1: Character bible + first batch of chapters ──
    const batch1 = batchPlan[0];
    const batch1Prompt = prompt + `\n\nIMPORTANT: This script will be generated in multiple parts due to its length. For THIS response, generate the character_bible and ONLY Chapters ${batch1.startChapter} through ${batch1.endChapter}. You will be asked to continue with the remaining chapters in follow-up messages. Make sure the story arc is planned for ALL ${totalChapters} chapters even though you're only writing ${batch1.endChapter - batch1.startChapter + 1} now.`;

    if (onProgress) onProgress(`[Batch 1/${batchPlan.length}] Generating character bible + Chapters ${batch1.startChapter}-${batch1.endChapter}...`);

    const batch1Text = await this._streamWithRetry({
      model: this.model,
      max_tokens: MAX_TOKENS_PER_CALL,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: 'user', content: batch1Prompt }],
      onProgress,
      label: `Batch 1/${batchPlan.length}`,
    });

    console.log(`[SCRIPT] Batch 1 raw response length: ${batch1Text.length} chars`);
    const batch1Parsed = this._safeParseScriptJson(batch1Text);
    if (!batch1Parsed) {
      console.error(`[SCRIPT] Batch 1 raw start: ${batch1Text.substring(0, 500)}`);
      console.error(`[SCRIPT] Batch 1 raw end: ${batch1Text.substring(batch1Text.length - 500)}`);
      throw new Error('Batch 1 (character bible + first chapters) produced no valid JSON');
    }
    if (!batch1Parsed.chapters?.length) {
      console.error(`[SCRIPT] Batch 1 parsed keys: ${Object.keys(batch1Parsed).join(', ')}`);
      throw new Error('Batch 1 produced no chapters — response may have been truncated at max_tokens');
    }

    const characterBible = batch1Parsed.character_bible || [];
    const title = batch1Parsed.title || storyBrief.title;
    const allChapters = [...batch1Parsed.chapters];

    console.log(`[SCRIPT] Batch 1 complete: ${allChapters.length} chapters, ${characterBible.length} characters`);

    // ── BATCHES 2+: Continue generating remaining chapters ──
    for (let bIdx = 1; bIdx < batchPlan.length; bIdx++) {
      const batch = batchPlan[bIdx];
      const batchLabel = `Batch ${bIdx + 1}/${batchPlan.length}`;

      if (onProgress) onProgress(`\n[${batchLabel}] Generating Chapters ${batch.startChapter}-${batch.endChapter}...`);

      const continuationPrompt = this._buildContinuationPrompt({
        storyBrief,
        title,
        characterBible,
        chaptersSoFar: allChapters,
        startChapter: batch.startChapter,
        endChapter: batch.endChapter,
        totalChapters,
        scenesPerChapter,
        linesPerScene,
        tier,
        generatorMode,
        aspect,
        aspectFramingGuidance,
        scaffolding,
        cinematicScaffolding,
        researchContext,
        isLastBatch: bIdx === batchPlan.length - 1,
      });

      const batchText = await this._streamWithRetry({
        model: this.model,
        max_tokens: MAX_TOKENS_PER_CALL,
        temperature: 0.7,
        system: systemPrompt,
        messages: [{ role: 'user', content: continuationPrompt }],
        onProgress,
        label: batchLabel,
      });

      const batchParsed = this._safeParseScriptJson(batchText);
      if (!batchParsed) {
        console.error(`[SCRIPT] ${batchLabel} produced no valid JSON. Raw length: ${batchText.length}`);
        throw new Error(`${batchLabel} (Chapters ${batch.startChapter}-${batch.endChapter}) produced no valid JSON. Generated ${allChapters.length}/${totalChapters} chapters before failure.`);
      }

      const batchChapters = batchParsed.chapters || (Array.isArray(batchParsed) ? batchParsed : []);
      if (!batchChapters.length) {
        console.error(`[SCRIPT] ${batchLabel} returned no chapters`);
        throw new Error(`${batchLabel} returned 0 chapters. Generated ${allChapters.length}/${totalChapters} chapters before failure.`);
      }

      allChapters.push(...batchChapters);
      console.log(`[SCRIPT] ${batchLabel} complete: +${batchChapters.length} chapters (total: ${allChapters.length}/${totalChapters})`);
    }

    return {
      title,
      character_bible: characterBible,
      chapters: allChapters,
    };
  }

  /**
   * Calculate batch plan for iterative chapter generation.
   * Returns array of { startChapter, endChapter } objects.
   *
   * Story-driven cinematic: 1 chapter per batch (unlimited scenes/lines = heavy output)
   * Fixed-grid cinematic: 2 chapters per batch (heavy metadata)
   * Staged scripts: 3 chapters per batch (lighter)
   * Batch 1 always includes character bible overhead, so gets fewer chapters.
   */
  _calculateBatchPlan(totalChapters, isCinematic, storyDriven = false) {
    const chaptersPerBatch = storyDriven ? 1 : isCinematic ? 2 : 3;
    // Batch 1 gets 1 fewer chapter to account for character_bible overhead
    const batch1Size = Math.max(1, chaptersPerBatch - 1);

    const batches = [];
    let nextChapter = 1;

    // Batch 1: character bible + first chapters
    const batch1End = Math.min(nextChapter + batch1Size - 1, totalChapters);
    batches.push({ startChapter: nextChapter, endChapter: batch1End });
    nextChapter = batch1End + 1;

    // Remaining batches
    while (nextChapter <= totalChapters) {
      const batchEnd = Math.min(nextChapter + chaptersPerBatch - 1, totalChapters);
      batches.push({ startChapter: nextChapter, endChapter: batchEnd });
      nextChapter = batchEnd + 1;
    }

    return batches;
  }

  /**
   * Build the continuation prompt for batches 2+ in iterative generation.
   * Includes the character bible and a compressed summary of chapters so far
   * to maintain narrative coherence without blowing up the context window.
   */
  _buildContinuationPrompt({ storyBrief, title, characterBible, chaptersSoFar,
    startChapter, endChapter, totalChapters, scenesPerChapter, linesPerScene,
    tier, generatorMode, aspect, aspectFramingGuidance, scaffolding,
    cinematicScaffolding, researchContext, isLastBatch }) {

    // Build a compressed summary of previous chapters (dialogue only, no image_prompts)
    // to fit in context without wasting tokens on repeated image descriptions
    const compressedChapters = chaptersSoFar.map(ch => ({
      chapter_number: ch.chapter_number,
      chapter_title: ch.chapter_title,
      scenes: (ch.scenes || []).map(sc => ({
        scene_number: sc.scene_number,
        location: sc.location,
        location_element_hint: sc.location_element_hint,
        characters_present: sc.characters_present,
        background_roles: sc.background_roles || [],
        props_in_scene: sc.props_in_scene || [],
        blocking: sc.blocking,
        lines: (sc.lines || []).map(l => ({
          line_number: l.line_number,
          speaker_id: l.speaker_id,
          dialogue: l.dialogue,
          tone: l.tone,
        })),
        // Include kling_clips line_refs for continuity but strip the heavy multi_shot_prompt
        kling_clips: (sc.kling_clips || []).map(c => ({
          clip_id: c.clip_id,
          line_refs: c.line_refs,
          duration_seconds: c.duration_seconds,
        })),
      })),
    }));

    // Narrative beat guidance based on position in the story
    let beatGuidance = '';
    if (isLastBatch) {
      beatGuidance = `\nThis is the FINAL batch — these chapters must bring the story to a decisive climax and resolution. All plot threads must be resolved. The last chapter must feel complete, not rushed.`;
    } else if (startChapter > totalChapters * 0.5) {
      beatGuidance = `\nThese chapters are in the second half of the story — stakes should be at their highest. Every scene should escalate toward the climax.`;
    }

    const isCinematic = generatorMode === 'cinematic';

    return `You are The Master Script & Image Engine for Nollywood AI drama production. You are CONTINUING a script that is being generated in multiple parts.

=== STORY CONTEXT ===
Title: "${title}"
Total planned chapters: ${totalChapters}${storyBrief.storyDriven ? ` (UNLIMITED scenes each, UNLIMITED lines per scene, target ~${storyBrief.targetClips} clips total, max 3 characters per scene)` : ` (${scenesPerChapter} scenes each, ${linesPerScene} lines per scene)`}
Nationality: ${storyBrief.nationality}
Accent: ${storyBrief.accent}
Aspect Ratio: ${aspect}

${aspectFramingGuidance}

=== CHARACTER BIBLE (maintain these identities exactly) ===
${JSON.stringify(characterBible, null, 2)}

=== CHAPTERS GENERATED SO FAR (${chaptersSoFar.length} of ${totalChapters}) ===
${JSON.stringify(compressedChapters, null, 2)}

=== NARRATIVE ARCHITECTURE RULES ===
${scaffolding}

${isCinematic ? cinematicScaffolding : ''}

${researchContext ? `=== MARKET RESEARCH CONTEXT (Use as inspiration, NOT to copy) ===\n${researchContext}` : ''}

=== YOUR TASK ===
Generate Chapters ${startChapter} through ${endChapter} (${endChapter - startChapter + 1} chapter${endChapter > startChapter ? 's' : ''}).
${beatGuidance}

CRITICAL RULES FOR CONTINUATION:
1. ${storyBrief.storyDriven ? `Each chapter has as many scenes as the story needs (UNLIMITED). Each scene has as many lines as the story needs (UNLIMITED — group into clips of exactly 3 lines each). Max 3 characters per scene. Target ~${Math.ceil((storyBrief.targetClips || 50) / totalChapters)} clips per chapter.` : `Each chapter must have EXACTLY ${scenesPerChapter} scenes with EXACTLY ${linesPerScene} lines each.`}
2. Maintain character voices and physical descriptions EXACTLY as in the character bible.
3. Use the SAME @element_name_hint references for characters (e.g. @${characterBible[0]?.element_name_hint || 'character_name'}).
4. Continue chapter_number sequencing (start at ${startChapter}).
5. Continue the narrative arc logically from Chapter ${startChapter - 1}.
6. Stakes must be HIGHER than the previous chapter.
7. ${startChapter < totalChapters ? `End each chapter (except the last) on a cliffhanger or reveal.` : 'Bring the story to a decisive resolution.'}
8. Use consistent location_element_hint values for returning locations.
9. Include background_roles and props_in_scene where institutional/community realism or procedure requires them.
10. Do NOT re-output the character_bible — only output the chapters array.

=== STRICT RULES ===
- Dialogue Only: Only character speech. No narration, SFX, or descriptions.
- The 9-Word Rule: Every single sentence must be 9 words or less.
- The Camera Jump: If a character says more than 9 words, break it with [NEW CAMERA ANGLE] + the next short sentence.

=== RESPONSE FORMAT ===
Respond in JSON with ONLY the chapters array:
{
  "chapters": [
    {
      "chapter_number": ${startChapter},
      "chapter_title": "...",
      "scenes": [...]
    }
  ]
}

Generate Chapters ${startChapter}-${endChapter} now. Respond with valid JSON only, no markdown.`;
  }

  /**
   * Repair generated cinematic scenes where Claude packed 4+ dialogue lines
   * into one Kling clip. The repair call is scene-scoped and may only replace
   * scene.kling_clips; all story/dialogue metadata must remain unchanged.
   */
  async _repairOversizedClipLineRefs(script, storyBrief, diagnostics, onProgress) {
    if (!diagnostics?.oversizedClips?.length) return script;
    const repairedScript = script;
    const sceneKeys = new Map();

    for (const item of diagnostics.oversizedClips) {
      const key = `${item.chapter}::${item.scene}`;
      if (!sceneKeys.has(key)) sceneKeys.set(key, []);
      sceneKeys.get(key).push(item);
    }

    console.log(`[SCRIPT-REPAIR] Repairing ${diagnostics.oversizedClips.length} oversized clip(s) across ${sceneKeys.size} scene(s)`);
    if (onProgress) onProgress(`\n[Repair] Fixing ${diagnostics.oversizedClips.length} oversized Kling clip(s)...`);

    for (const [key, oversizedItems] of sceneKeys.entries()) {
      const [chapterNumRaw, sceneNumRaw] = key.split('::');
      const chapterNum = Number(chapterNumRaw);
      const sceneNum = sceneNumRaw === '?' ? '?' : Number(sceneNumRaw);
      const chapter = (repairedScript.chapters || []).find(ch => ch.chapter_number === chapterNum);
      if (!chapter) throw new Error(`[SCRIPT-REPAIR] Could not find chapter ${chapterNum} for oversized clip repair`);
      const scene = (chapter.scenes || []).find(sc => String(sc.scene_number || '?') === String(sceneNum));
      if (!scene) throw new Error(`[SCRIPT-REPAIR] Could not find Ch${chapterNum} Scene ${sceneNum} for oversized clip repair`);

      const relevantCharacterIds = new Set([
        ...(scene.characters_present || []),
        ...(scene.lines || []).map(l => String(l.speaker_id || '').replace(/^@/, '')).filter(Boolean),
      ]);
      const relevantCharacters = (repairedScript.character_bible || []).filter(c => {
        const keys = [c.id, c.element_name_hint, c.name, c.description_label]
          .filter(Boolean)
          .map(v => String(v).replace(/^@/, '').toLowerCase());
        return keys.some(v => relevantCharacterIds.has(v) || relevantCharacterIds.has(`@${v}`));
      });

      const repairPrompt = `You are repairing ONLY the kling_clips array for one cinematic Nollywood scene.

The previous script is good, but these clip ids illegally contain 4+ line_refs:
${oversizedItems.map(i => `- ${i.clipId}: [${i.lineRefs.join(', ')}]`).join('\n')}

Hard requirements:
- Return JSON only: { "kling_clips": [...] }
- Preserve the scene dialogue lines exactly. Do not add, remove, renumber, or rewrite scene.lines.
- Rewrite ONLY kling_clips.
- Every scene line_number must be covered exactly once across kling_clips.
- Each kling_clip.line_refs array must contain 1-3 existing line numbers, never 4+.
- Use sequential clip groups in story order.
- Every kling_clip must have duration_seconds: 15.
- Every kling_clip must include a real multi_shot_prompt with exactly 3 shots and Nigerian English dialogue syntax.
- Every kling_clip must include visual_beat.
- Do not use [AUTO-SPLIT] placeholders.

Character bible subset:
${JSON.stringify(relevantCharacters, null, 2)}

Scene JSON:
${JSON.stringify(scene, null, 2)}

Return the repaired kling_clips JSON now.`;

      const repairText = await this._streamWithRetry({
        model: this.model,
        max_tokens: 8192,
        temperature: 0.2,
        system: 'You are a precise JSON repair engine. Return raw JSON only. No markdown. No prose.',
        messages: [{ role: 'user', content: repairPrompt }],
        onProgress,
        label: `Repair Ch${chapterNum} Sc${sceneNum} kling_clips`,
      }, 2);

      const parsed = this._safeParseScriptJson(repairText);
      const repairedClips = parsed?.kling_clips || parsed?.scene?.kling_clips || (Array.isArray(parsed) ? parsed : null);
      if (!Array.isArray(repairedClips) || repairedClips.length === 0) {
        throw new Error(`[SCRIPT-REPAIR] Ch${chapterNum} Sc${sceneNum}: repair returned no kling_clips`);
      }

      const coverage = this._validateSceneKlingClipCoverage(scene, repairedClips);
      if (!coverage.ok) {
        throw new Error(`[SCRIPT-REPAIR] Ch${chapterNum} Sc${sceneNum}: invalid repaired clips — ${coverage.errors.join('; ')}`);
      }

      scene.kling_clips = repairedClips;
      console.log(`[SCRIPT-REPAIR] Ch${chapterNum} Sc${sceneNum}: repaired ${repairedClips.length} kling clip(s)`);
    }

    return repairedScript;
  }

  _validateSceneKlingClipCoverage(scene, clips) {
    const errors = [];
    const lineNumbers = (scene.lines || [])
      .map(l => l.line_number ?? l.id)
      .filter(n => n !== undefined && n !== null)
      .map(Number);
    const expected = new Set(lineNumbers);
    const seen = new Map();
    const clipIds = new Set();

    let previousLastRef = null;
    for (const clip of clips || []) {
      if (!clip.clip_id) errors.push('clip missing clip_id');
      if (clip.clip_id) {
        if (clipIds.has(clip.clip_id)) errors.push(`duplicate clip_id ${clip.clip_id}`);
        clipIds.add(clip.clip_id);
      }
      if (clip.duration_seconds !== 15) {
        errors.push(`${clip.clip_id || 'clip'} duration_seconds must be 15`);
      }
      if (!clip.visual_beat || String(clip.visual_beat).trim().length === 0) {
        errors.push(`${clip.clip_id || 'clip'} missing visual_beat`);
      }
      const refs = (clip.line_refs || []).map(Number);
      if (refs.length < 1 || refs.length > 3) {
        errors.push(`${clip.clip_id || 'clip'} has ${refs.length} line_refs`);
      }
      for (let i = 1; i < refs.length; i++) {
        if (refs[i] !== refs[i - 1] + 1) {
          errors.push(`${clip.clip_id || 'clip'} line_refs must be contiguous and ascending`);
          break;
        }
      }
      if (previousLastRef !== null && refs.length && refs[0] <= previousLastRef) {
        errors.push(`${clip.clip_id || 'clip'} is out of line order`);
      }
      if (refs.length) previousLastRef = refs[refs.length - 1];
      if (clip.multi_shot_prompt && clip.multi_shot_prompt.startsWith('[AUTO-SPLIT')) {
        errors.push(`${clip.clip_id || 'clip'} has AUTO-SPLIT placeholder prompt`);
      }
      if (!clip.multi_shot_prompt || String(clip.multi_shot_prompt).trim().length < 30) {
        errors.push(`${clip.clip_id || 'clip'} missing real multi_shot_prompt`);
      }
      const shotMatches = String(clip.multi_shot_prompt || '').match(/\bShot\s*\d+\b/gi) || [];
      if (shotMatches.length !== 3) {
        errors.push(`${clip.clip_id || 'clip'} must have exactly 3 shots`);
      }
      for (const ref of refs) {
        if (!expected.has(ref)) errors.push(`${clip.clip_id || 'clip'} references unknown line ${ref}`);
        if (!seen.has(ref)) seen.set(ref, []);
        seen.get(ref).push(clip.clip_id || 'clip');
      }
    }

    for (const n of lineNumbers) {
      const holders = seen.get(n) || [];
      if (holders.length === 0) errors.push(`line ${n} is not covered`);
      if (holders.length > 1) errors.push(`line ${n} is covered multiple times (${holders.join(', ')})`);
    }

    return { ok: errors.length === 0, errors };
  }

  /**
   * Inspect script completeness without throwing. This is intentionally
   * side-effect free so repair code can decide whether to fix or fail while
   * _validateScriptCompleteness() keeps the historical throwing contract.
   */
  _inspectScriptCompleteness(script, storyBrief) {
    const expectedChapters = storyBrief.chapters || 5;
    const chapters = script?.chapters || [];
    const actualChapters = chapters.length;
    const isCinematicStoryDriven = storyBrief.storyDriven && storyBrief.generatorMode === 'cinematic';
    const expectedClips = storyBrief.targetClips || 50;
    const diagnostics = {
      ok: true,
      errors: [],
      warnings: [],
      stats: {
        expectedChapters,
        actualChapters,
        expectedClips,
        totalClips: 0,
        totalScenes: 0,
        totalLines: 0,
        maxCharsPerScene: 0,
      },
      chapterMismatch: null,
      underTarget: null,
      overloadedScenes: [],
      oversizedClips: [],
      autoSplitClips: [],
      unknownRefs: [],
    };

    const fail = (type, message, extra = {}) => {
      diagnostics.ok = false;
      diagnostics.errors.push({ type, message, ...extra });
    };

    if (actualChapters !== expectedChapters) {
      diagnostics.chapterMismatch = {
        expected: expectedChapters,
        actual: actualChapters,
        chaptersPresent: chapters.map(c => c.chapter_number),
      };
      if (actualChapters === 0 || actualChapters < expectedChapters * 0.5) {
        fail(
          'chapter_count',
          `Script generation failed: got ${actualChapters} chapters but expected ${expectedChapters}. Script is too incomplete to proceed.`,
          diagnostics.chapterMismatch
        );
      } else {
        diagnostics.warnings.push({
          type: 'chapter_count',
          message: `Chapter count mismatch: expected ${expectedChapters}, got ${actualChapters}`,
          ...diagnostics.chapterMismatch,
        });
      }
    }

    if (isCinematicStoryDriven) {
      for (const ch of chapters) {
        for (const sc of (ch.scenes || [])) {
          diagnostics.stats.totalScenes++;
          diagnostics.stats.totalLines += (sc.lines || []).length;
          diagnostics.stats.totalClips += (sc.kling_clips || []).length;
          const charsInScene = (sc.characters_present || []).length;
          diagnostics.stats.maxCharsPerScene = Math.max(diagnostics.stats.maxCharsPerScene, charsInScene);
          if (charsInScene > 3) {
            diagnostics.overloadedScenes.push({
              chapter: ch.chapter_number,
              scene: sc.scene_number || '?',
              count: charsInScene,
              label: `Ch${ch.chapter_number} S${sc.scene_number || '?'} (${charsInScene} chars)`,
            });
          }

          for (const clip of (sc.kling_clips || [])) {
            const refs = clip.line_refs || [];
            if (refs.length > 3) {
              const fallbackId = `Ch${ch.chapter_number} S${sc.scene_number || '?'}`;
              diagnostics.oversizedClips.push({
                chapter: ch.chapter_number,
                scene: sc.scene_number || '?',
                clipId: clip.clip_id || fallbackId,
                lineRefs: refs,
                count: refs.length,
                label: `${clip.clip_id || fallbackId} (${refs.length} line_refs)`,
              });
            }
            if (clip.multi_shot_prompt && clip.multi_shot_prompt.startsWith('[AUTO-SPLIT')) {
              diagnostics.autoSplitClips.push({
                chapter: ch.chapter_number,
                scene: sc.scene_number || '?',
                clipId: clip.clip_id || `Ch${ch.chapter_number} S${sc.scene_number || '?'}`,
              });
            }
          }
        }
      }

      if (diagnostics.stats.totalClips < expectedClips * 0.5) {
        diagnostics.underTarget = {
          totalClips: diagnostics.stats.totalClips,
          expectedClips,
          threshold: Math.floor(expectedClips * 0.5),
          ratio: diagnostics.stats.totalClips / expectedClips,
        };
        fail(
          'clip_count_too_low',
          `Script generation failed: only ${diagnostics.stats.totalClips} clips produced (target ~${expectedClips}, minimum 50% = ${Math.floor(expectedClips * 0.5)}). Script is too incomplete to proceed.`,
          diagnostics.underTarget
        );
      } else if (expectedClips >= 100 && diagnostics.stats.totalClips < expectedClips * 0.8) {
        diagnostics.underTarget = {
          totalClips: diagnostics.stats.totalClips,
          expectedClips,
          threshold: Math.floor(expectedClips * 0.8),
          ratio: diagnostics.stats.totalClips / expectedClips,
        };
        fail(
          'clip_count_under_80',
          `Script generation failed: only ${diagnostics.stats.totalClips} clips produced (target ~${expectedClips}, minimum 80% = ${Math.floor(expectedClips * 0.8)}). Regenerate the script before asset creation.`,
          diagnostics.underTarget
        );
      } else if (diagnostics.stats.totalClips < expectedClips * 0.8) {
        diagnostics.underTarget = {
          totalClips: diagnostics.stats.totalClips,
          expectedClips,
          threshold: Math.floor(expectedClips * 0.8),
          ratio: diagnostics.stats.totalClips / expectedClips,
        };
        diagnostics.warnings.push({
          type: 'clip_count_low',
          message: `Clip count LOW: ${diagnostics.stats.totalClips} clips (target ~${expectedClips}, 80% threshold = ${Math.floor(expectedClips * 0.8)})`,
          ...diagnostics.underTarget,
        });
      }

      if (diagnostics.overloadedScenes.length > 0) {
        fail(
          'too_many_characters',
          `Kling hard limit: max 3 characters per scene. ${diagnostics.overloadedScenes.length} scene(s) exceed this: ` +
            `${diagnostics.overloadedScenes.slice(0, 5).map(s => s.label).join(', ')}${diagnostics.overloadedScenes.length > 5 ? '...' : ''}. ` +
            `Regenerate the script — scene splitting must happen at outline level.`,
          { overloadedScenes: diagnostics.overloadedScenes }
        );
      }

      if (diagnostics.oversizedClips.length > 0) {
        fail(
          'oversized_line_refs',
          `${diagnostics.oversizedClips.length} cinematic clip(s) exceed the 3-line limit: ` +
            `${diagnostics.oversizedClips.slice(0, 5).map(c => c.label).join(', ')}${diagnostics.oversizedClips.length > 5 ? '...' : ''}. ` +
            `Regenerate the script so each kling_clip has its own real multi_shot_prompt.`,
          { oversizedClips: diagnostics.oversizedClips }
        );
      }

      if (diagnostics.autoSplitClips.length > 0) {
        fail(
          'auto_split_placeholder',
          `${diagnostics.autoSplitClips.length} clip(s) have [AUTO-SPLIT] placeholder prompts that would waste video credits: ` +
            `${diagnostics.autoSplitClips.slice(0, 5).map(c => c.clipId).join(', ')}${diagnostics.autoSplitClips.length > 5 ? '...' : ''}. ` +
            `Regenerate the script to fix oversized clips at the source.`,
          { autoSplitClips: diagnostics.autoSplitClips }
        );
      }
    }

    const characterIds = new Set((script?.character_bible || []).map(c => c.element_name_hint || c.id));
    const unknownRefs = new Set();
    for (const ch of chapters) {
      for (const sc of (ch.scenes || [])) {
        for (const charId of (sc.characters_present || [])) {
          if (!characterIds.has(charId)) unknownRefs.add(charId);
        }
      }
    }
    diagnostics.unknownRefs = [...unknownRefs];
    if (diagnostics.unknownRefs.length > 0) {
      diagnostics.warnings.push({
        type: 'unknown_character_refs',
        message: `Unknown character references: ${diagnostics.unknownRefs.join(', ')}`,
        refs: diagnostics.unknownRefs,
      });
    }

    return diagnostics;
  }

  /**
   * Validate that a generated script has the expected structure.
   * Throws on critical issues (wrong chapter count), warns on minor ones.
   */
  _validateScriptCompleteness(script, storyBrief) {
    const diagnostics = this._inspectScriptCompleteness(script, storyBrief);
    if (diagnostics.errors.length > 0) {
      throw new Error(diagnostics.errors[0].message);
    }

    const expectedChapters = storyBrief.chapters || 5;
    const actualChapters = (script.chapters || []).length;
    const isCinematicStoryDriven = storyBrief.storyDriven && storyBrief.generatorMode === 'cinematic';

    // Chapter count validation (applies to both modes)
    if (actualChapters !== expectedChapters) {
      console.error(`[SCRIPT] CHAPTER COUNT MISMATCH: expected ${expectedChapters}, got ${actualChapters}`);
      console.error(`[SCRIPT] Chapters present: ${script.chapters.map(c => c.chapter_number).join(', ')}`);
      // Hard fail if chapters are missing entirely or severely off (< 50% of expected)
      if (actualChapters === 0 || actualChapters < expectedChapters * 0.5) {
        throw new Error(`Script generation failed: got ${actualChapters} chapters but expected ${expectedChapters}. Script is too incomplete to proceed.`);
      }
    } else {
      console.log(`[SCRIPT] ✓ Chapter count validated: ${actualChapters}/${expectedChapters}`);
    }

    if (isCinematicStoryDriven) {
      // ── CINEMATIC STORY-DRIVEN: validate CLIP count, not scene/line count ──
      let totalClips = 0;
      let totalScenes = 0;
      let totalLines = 0;
      let maxCharsPerScene = 0;
      for (const ch of (script.chapters || [])) {
        for (const sc of (ch.scenes || [])) {
          totalScenes++;
          totalLines += (sc.lines || []).length;
          totalClips += (sc.kling_clips || []).length;
          const charsInScene = (sc.characters_present || []).length;
          if (charsInScene > maxCharsPerScene) maxCharsPerScene = charsInScene;
        }
      }
      const expectedClips = storyBrief.targetClips || 50;
      if (totalClips < expectedClips * 0.5) {
        // Hard fail: less than 50% of target clips is a malformed script
        throw new Error(`Script generation failed: only ${totalClips} clips produced (target ~${expectedClips}, minimum 50% = ${Math.floor(expectedClips * 0.5)}). Script is too incomplete to proceed.`);
      } else if (expectedClips >= 100 && totalClips < expectedClips * 0.8) {
        throw new Error(`Script generation failed: only ${totalClips} clips produced (target ~${expectedClips}, minimum 80% = ${Math.floor(expectedClips * 0.8)}). Regenerate the script before asset creation.`);
      } else if (totalClips < expectedClips * 0.8) {
        console.warn(`[SCRIPT] Clip count LOW: ${totalClips} clips (target ~${expectedClips}, 80% threshold = ${Math.floor(expectedClips * 0.8)})`);
      } else if (totalClips > expectedClips * 1.2) {
        console.warn(`[SCRIPT] Clip count HIGH: ${totalClips} clips (target ~${expectedClips}, 120% threshold = ${Math.ceil(expectedClips * 1.2)})`);
      } else {
        console.log(`[SCRIPT] ✓ Clip count validated: ${totalClips} (target: ~${expectedClips})`);
      }
      console.log(`[SCRIPT] Story-driven stats: ${totalScenes} scenes, ${totalLines} lines, ${totalClips} clips across ${actualChapters} chapters`);
      if (maxCharsPerScene > 3) {
        // Collect offending scenes for the error message
        const overloadedScenes = [];
        for (const ch of (script.chapters || [])) {
          for (const sc of (ch.scenes || [])) {
            const n = (sc.characters_present || []).length;
            if (n > 3) overloadedScenes.push(`Ch${ch.chapter_number} S${sc.scene_number || '?'} (${n} chars)`);
          }
        }
        throw new Error(
          `Kling hard limit: max 3 characters per scene. ${overloadedScenes.length} scene(s) exceed this: ` +
          `${overloadedScenes.slice(0, 5).join(', ')}${overloadedScenes.length > 5 ? '...' : ''}. ` +
          `Regenerate the script — scene splitting must happen at outline level.`
        );
      }

      // ── CINEMATIC CLIP STRUCTURE HARD FAILS ──
      // Story-driven clips are too expensive to patch with placeholder prompts.
      // If Claude packs 4+ lines into one clip, regenerate instead of auto-splitting.
      const oversizedClipIds = [];
      const autoSplitClipIds = [];
      for (const ch of (script.chapters || [])) {
        for (const sc of (ch.scenes || [])) {
          const clips = sc.kling_clips || [];
          for (const clip of clips) {
            const refs = clip.line_refs || [];
            if (refs.length > 3) {
              oversizedClipIds.push(`${clip.clip_id || `Ch${ch.chapter_number} S${sc.scene_number || '?'}`} (${refs.length} line_refs)`);
            }
            if (clip.multi_shot_prompt && clip.multi_shot_prompt.startsWith('[AUTO-SPLIT')) {
              autoSplitClipIds.push(clip.clip_id || `Ch${ch.chapter_number} S${sc.scene_number || '?'}`);
            }
          }
        }
      }
      if (oversizedClipIds.length > 0) {
        throw new Error(
          `${oversizedClipIds.length} cinematic clip(s) exceed the 3-line limit: ` +
          `${oversizedClipIds.slice(0, 5).join(', ')}${oversizedClipIds.length > 5 ? '...' : ''}. ` +
          `Regenerate the script so each kling_clip has its own real multi_shot_prompt.`
        );
      }
      if (autoSplitClipIds.length > 0) {
        throw new Error(
          `${autoSplitClipIds.length} clip(s) have [AUTO-SPLIT] placeholder prompts that would waste video credits: ` +
          `${autoSplitClipIds.slice(0, 5).join(', ')}${autoSplitClipIds.length > 5 ? '...' : ''}. ` +
          `Regenerate the script to fix oversized clips at the source.`
        );
      }

      const totalCharacters = (script.character_bible || []).length;
      console.log(`[SCRIPT] Characters: ${totalCharacters} (unlimited — all get portraits)`);
    } else {
      // ── STAGED: validate scene/line counts (existing logic) ──
      const scenesPerChapter = storyBrief.scenesPerChapter || 3;
      const linesPerScene = storyBrief.linesPerScene || 5;

      // Scene count validation
      let sceneMismatches = 0;
      for (const ch of (script.chapters || [])) {
        const actualScenes = (ch.scenes || []).length;
        if (actualScenes !== scenesPerChapter) {
          console.warn(`[SCRIPT] Chapter ${ch.chapter_number}: expected ${scenesPerChapter} scenes, got ${actualScenes}`);
          sceneMismatches++;
        }
      }
      if (sceneMismatches === 0) {
        console.log(`[SCRIPT] ✓ Scene counts validated across all chapters`);
      }

      // Line count validation
      let totalLines = 0;
      for (const ch of (script.chapters || [])) {
        for (const sc of (ch.scenes || [])) {
          totalLines += (sc.lines || []).length;
        }
      }
      const expectedLines = storyBrief.totalLines || (expectedChapters * scenesPerChapter * linesPerScene);
      if (totalLines < expectedLines * 0.9) {
        console.warn(`[SCRIPT] Line count low: ${totalLines} lines (expected ~${expectedLines})`);
      } else {
        console.log(`[SCRIPT] ✓ Line count validated: ${totalLines} (target: ${expectedLines})`);
      }
    }

    // ── STORYTELLING FIELD COMPLIANCE (soft warnings — monitor LLM adherence) ──
    if (isCinematicStoryDriven) {
      let scenesWithoutEmotional = 0;
      let scenesWithoutPurpose = 0;
      let clipsWithoutVisualBeat = 0;
      let totalScenesChecked = 0;
      let totalClipsChecked = 0;

      for (const ch of (script.chapters || [])) {
        for (const sc of (ch.scenes || [])) {
          totalScenesChecked++;
          if (!sc.emotional_state || !sc.emotional_state.start) scenesWithoutEmotional++;
          if (!sc.scene_purpose) scenesWithoutPurpose++;
          for (const clip of (sc.kling_clips || [])) {
            totalClipsChecked++;
            if (!clip.visual_beat) clipsWithoutVisualBeat++;
          }
        }
      }

      if (scenesWithoutEmotional > 0) {
        console.warn(`[SCRIPT] ⚠ ${scenesWithoutEmotional}/${totalScenesChecked} scenes missing emotional_state (start/turn/end)`);
      } else if (totalScenesChecked > 0) {
        console.log(`[SCRIPT] ✓ All ${totalScenesChecked} scenes have emotional_state`);
      }
      if (scenesWithoutPurpose > 0) {
        console.warn(`[SCRIPT] ⚠ ${scenesWithoutPurpose}/${totalScenesChecked} scenes missing scene_purpose`);
      } else if (totalScenesChecked > 0) {
        console.log(`[SCRIPT] ✓ All ${totalScenesChecked} scenes have scene_purpose`);
      }
      if (clipsWithoutVisualBeat > 0) {
        console.warn(`[SCRIPT] ⚠ ${clipsWithoutVisualBeat}/${totalClipsChecked} clips missing visual_beat`);
      } else if (totalClipsChecked > 0) {
        console.log(`[SCRIPT] ✓ All ${totalClipsChecked} clips have visual_beat`);
      }

      // Speech style coverage
      const charsWithoutSpeechStyle = (script.character_bible || []).filter(c => !c.speech_style).length;
      if (charsWithoutSpeechStyle > 0) {
        console.warn(`[SCRIPT] ⚠ ${charsWithoutSpeechStyle} character(s) missing speech_style`);
      }
    }

    // Character reference validation
    const characterIds = new Set((script.character_bible || []).map(c => c.element_name_hint || c.id));
    const unknownRefs = new Set();
    for (const ch of (script.chapters || [])) {
      for (const sc of (ch.scenes || [])) {
        for (const charId of (sc.characters_present || [])) {
          if (!characterIds.has(charId)) unknownRefs.add(charId);
        }
      }
    }
    if (unknownRefs.size > 0) {
      console.warn(`[SCRIPT] Unknown character references: ${[...unknownRefs].join(', ')}`);
    }
  }

  /**
   * Sanitize blocking: convert null positions to empty strings.
   * Claude sometimes outputs null despite the rubric saying "" — this
   * prevents downstream warnings from the structural grader and avoids
   * null-check bugs in the pipeline.
   */
  _sanitizeBlocking(script) {
    if (script.chapters) {
      for (const ch of script.chapters) {
        for (const sc of (ch.scenes || [])) {
          if (sc.blocking) {
            for (const pos of ['frame_left', 'frame_center', 'frame_right']) {
              if (sc.blocking[pos] === null || sc.blocking[pos] === undefined) {
                sc.blocking[pos] = '';
              }
            }
          }
        }
      }
    }
  }

  /**
   * Deterministic post-generation fix: ensure kling_clips Shot 1 posture verbs
   * and frame positions match scene.blocking exactly.
   *
   * Parses each scene's blocking to extract character posture (seated/standing/leaning)
   * and frame position (left/center/right), then scans Shot 1 of each kling_clip
   * and corrects any mismatches.
   *
   * This runs at script generation time so the stored script.json is already correct,
   * eliminating the need for runtime fixes in the orchestrator for NEW scripts.
   */
  _fixBlockingShotConsistency(script) {
    if (!script?.chapters) return;
    let totalFixes = 0;

    for (const ch of script.chapters) {
      for (const sc of (ch.scenes || [])) {
        const blocking = sc.blocking || {};
        const clips = sc.kling_clips || [];
        if (clips.length === 0) continue;

        // Parse blocking postures and frame positions
        const charPostures = {}; // charName → { posture: 'sits'|'stands'|'leans', framePos: 'left'|'center'|'right' }
        const framePosMap = { frame_left: 'left', frame_center: 'center', frame_right: 'right' };
        for (const [pos, text] of Object.entries(framePosMap)) {
          const blockText = (blocking[pos] || '').trim();
          if (!blockText) continue;
          const charMatch = blockText.match(/@?([a-z0-9_]+)/i);
          if (!charMatch) continue;
          const charName = charMatch[1].toLowerCase();
          const lower = blockText.toLowerCase();
          let verb = 'stands'; // default
          if (/\bseat(?:ed|s)\b|\bsitting\b|\bsits?\b/.test(lower)) verb = 'sits';
          else if (/\bstand(?:s|ing)\b/.test(lower)) verb = 'stands';
          else if (/\blean(?:s|ing)\b/.test(lower)) verb = 'leans';
          charPostures[charName] = { verb, framePos: text };
        }

        if (Object.keys(charPostures).length === 0) continue;

        // Fix Shot 1 in each clip
        for (const clip of clips) {
          if (!clip.multi_shot_prompt) continue;
          const s1Match = clip.multi_shot_prompt.match(/(Shot\s*1\s*\([^)]*\)\s*:\s*)([\s\S]*?)(?=\nShot\s*2\s*\(|\n\[|$)/);
          if (!s1Match) continue;

          let shot1 = s1Match[2];
          for (const [charName, info] of Object.entries(charPostures)) {
            const nameEsc = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Match @charName (with optional suffix) + optional "is" + posture verb
            const re = new RegExp(
              `(@${nameEsc}(?:_[a-z0-9_]*)?)(\\s+(?:is\\s+)?)(stands?|stand|standing|sits?|sitting|seated|leans?|leaning)\\b`,
              'gi'
            );
            shot1 = shot1.replace(re, (match, nameRef, space, verb) => {
              const isCorrect =
                (info.verb === 'sits' && /^(sits?|sitting|seated)$/i.test(verb)) ||
                (info.verb === 'stands' && /^(stands?|standing)$/i.test(verb)) ||
                (info.verb === 'leans' && /^(leans?|leaning)$/i.test(verb));
              if (isCorrect) return match;
              totalFixes++;
              console.log(`[SCRIPT-FIX] Ch${ch.chapter_number} Sc${sc.scene_number} ${clip.clip_id}: ${nameRef} "${verb}" → "${info.verb}"`);
              return `${nameRef} ${info.verb}`;
            });
          }
          clip.multi_shot_prompt = clip.multi_shot_prompt.replace(s1Match[2], shot1);
        }
      }
    }

    if (totalFixes > 0) {
      console.log(`[SCRIPT-FIX] Fixed ${totalFixes} blocking/Shot 1 posture mismatch(es)`);
    }
  }

  /**
   * Deterministic post-generation sanitizer for kling_clip multi_shot_prompts.
   * Fixes common LLM mistakes at the source so runtime patches are redundant
   * for newly generated scripts.
   *
   * Fixes applied:
   * 1. @location refs → strip @ from non-character references
   * 2. character_N → replace with actual @element_name_hint
   * 3. Bare character names → add @ prefix
   * 4. @element in dialogue → convert to human name
   * 5. Shot count validation → warn if != 3 shots
   * 6. Dual-speaker strip → remove extra [@speaker] tags from Shot 2/3
   * 7. Shot direction length → warn when direction body > 20 words
   * 8. Difficult-word replacement → swap known TTS problem words
   */
  _sanitizeKlingClipPrompts(script) {
    if (!script?.chapters || !script?.character_bible) return;

    // Build character name sets from the bible
    const validCharNames = new Set(); // element_name_hints (lowercase)
    const charIndexMap = {};          // "character_1" → element_name_hint
    const charBible = script.character_bible || [];
    charBible.forEach((char, i) => {
      const hint = (char.element_name_hint || '').toLowerCase();
      if (hint) {
        validCharNames.add(hint);
        charIndexMap[`character_${i + 1}`] = hint;
      }
    });

    if (validCharNames.size === 0) return;

    let totalFixes = 0;

    for (const ch of script.chapters) {
      for (const sc of (ch.scenes || [])) {
        // ── 0. Normalize character_outfits keys ──
        // The LLM may key character_outfits by character_N, @name, or bare name.
        // The orchestrator's outfit resolution looks up by bare lowercase
        // element_name_hint (extracted from blocking @refs). Normalize here so
        // the keys always match what the orchestrator expects.
        if (sc.character_outfits && typeof sc.character_outfits === 'object') {
          const normalized = {};
          let outfitKeyFixes = 0;
          for (const [key, outfitId] of Object.entries(sc.character_outfits)) {
            let resolvedKey = key.toLowerCase().replace(/^@/, '');
            // Resolve character_N → element_name_hint
            if (charIndexMap[resolvedKey]) {
              const before = resolvedKey;
              resolvedKey = charIndexMap[resolvedKey];
              outfitKeyFixes++;
              console.log(`[PROMPT-SANITIZE] Ch${ch.chapter_number} Sc${sc.scene_number}: character_outfits key "${before}" → "${resolvedKey}"`);
            }
            // If it's already a valid character name, use it; otherwise keep as-is
            // (the orchestrator will just miss it, which is the existing fallback behavior)
            normalized[resolvedKey] = outfitId;
          }
          sc.character_outfits = normalized;
          if (outfitKeyFixes > 0) totalFixes += outfitKeyFixes;
        }

        for (const clip of (sc.kling_clips || [])) {
          if (!clip.multi_shot_prompt) continue;
          let prompt = clip.multi_shot_prompt;
          const label = `Ch${ch.chapter_number} Sc${sc.scene_number} ${clip.clip_id}`;

          // ── 1. Strip @ from non-character references ──
          // If @some_name is not in the character bible, remove the @
          prompt = prompt.replace(/@([a-z0-9_]+)/gi, (match, name) => {
            const lower = name.toLowerCase();
            if (validCharNames.has(lower)) return match; // valid character
            // Check if it's a suffixed version of a valid char (e.g. adaora_hhbhe_0420)
            for (const cn of validCharNames) {
              if (lower.startsWith(cn + '_')) return match; // suffixed valid char
            }
            totalFixes++;
            console.log(`[PROMPT-SANITIZE] ${label}: stripped @${name} → ${name} (not a character)`);
            return name;
          });

          // ── 2. Replace character_N with @element_name_hint ──
          prompt = prompt.replace(/\bcharacter_(\d+)\b/gi, (match) => {
            const key = match.toLowerCase();
            const resolved = charIndexMap[key];
            if (resolved) {
              totalFixes++;
              console.log(`[PROMPT-SANITIZE] ${label}: ${match} → @${resolved}`);
              return `@${resolved}`;
            }
            return match;
          });

          // ── 3. Add @ prefix to bare character names (OUTSIDE dialogue quotes only) ──
          // Sort longest-first to avoid partial matches.
          // First, identify character positions inside dialogue quotes so we can skip them.
          // Dialogue quotes follow the pattern ]: "..."
          const dialogueRanges = [];
          const dqRe = /\]:\s*"([^"]*)"/gi;
          let dqMatch;
          while ((dqMatch = dqRe.exec(prompt)) !== null) {
            // Range covers the content inside the quotes (group 1)
            const contentStart = dqMatch.index + dqMatch[0].indexOf('"') + 1;
            const contentEnd = contentStart + dqMatch[1].length;
            dialogueRanges.push({ start: contentStart, end: contentEnd });
          }
          const isInsideDialogue = (pos) => dialogueRanges.some(r => pos >= r.start && pos < r.end);

          const sortedNames = [...validCharNames].sort((a, b) => b.length - a.length);
          for (const charName of sortedNames) {
            const escaped = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const bareRe = new RegExp(`(?<!@)\\b${escaped}\\b`, 'gi');
            const before = prompt;
            // Build replacement by checking each match position
            let offset = 0;
            let result = '';
            let lastEnd = 0;
            let m;
            const tempRe = new RegExp(`(?<!@)\\b${escaped}\\b`, 'gi');
            while ((m = tempRe.exec(prompt)) !== null) {
              if (isInsideDialogue(m.index)) continue; // skip — human names in dialogue
              result += prompt.slice(lastEnd, m.index) + `@${m[0].toLowerCase()}`;
              lastEnd = m.index + m[0].length;
            }
            if (lastEnd > 0) {
              result += prompt.slice(lastEnd);
              prompt = result;
              totalFixes++;
            }
          }

          // ── 4. Strip @element from dialogue quotes → human names ──
          prompt = prompt.replace(
            /\]:\s*"([^"]*?)@([a-z0-9_]+)([^"]*?)"/gi,
            (match, pre, name, post) => {
              const baseName = name.replace(/_[a-z]{2,6}_\d{4}$/i, '');
              const humanName = baseName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              totalFixes++;
              console.log(`[PROMPT-SANITIZE] ${label}: dialogue @${name} → ${humanName}`);
              return `]: "${pre}${humanName}${post}"`;
            }
          );

          // ── 5. Shot count warning ──
          const shotMatches = prompt.match(/Shot \d+/gi) || [];
          if (shotMatches.length > 3) {
            console.log(`[PROMPT-SANITIZE] ⚠ ${label}: ${shotMatches.length} shots (expected 3) — Kling renders 4+ unreliably`);
          }

          // ── 6. Dual-speaker strip (Shots 2 & 3) ──
          // Shot 2 and Shot 3 must have only ONE [@speaker] tag. If Claude wrote
          // two speaker tags in the same shot, strip the second one.
          // Collect replacements first, then apply — modifying prompt mid-iteration
          // with a stateful regex (g flag + exec loop) corrupts lastIndex.
          const shotBlockRe = /Shot\s*(2|3)\s*\([^)]*\)\s*:\s*([\s\S]*?)(?=\nShot\s*\d+\s*\(|$)/gi;
          const dualSpeakerFixes = []; // { original, cleaned, shotNum }
          let shotBlockMatch;
          while ((shotBlockMatch = shotBlockRe.exec(prompt)) !== null) {
            const shotNum = shotBlockMatch[1];
            const shotBody = shotBlockMatch[2];
            const speakerTags = shotBody.match(/\[@[a-z0-9_]+,\s*speaking/gi) || [];
            if (speakerTags.length > 1) {
              let cleaned = shotBody;
              let firstFound = false;
              cleaned = cleaned.replace(/\n?\[@([a-z0-9_]+),\s*speaking[^\]]*\]:\s*"[^"]*"/gi, (m) => {
                if (!firstFound) { firstFound = true; return m; }
                return '';
              });
              if (cleaned !== shotBody) {
                dualSpeakerFixes.push({ original: shotBody, cleaned, shotNum });
              }
            }
          }
          for (const fix of dualSpeakerFixes) {
            prompt = prompt.replace(fix.original, fix.cleaned);
            totalFixes++;
            console.log(`[PROMPT-SANITIZE] ${label}: stripped extra speaker from Shot ${fix.shotNum}`);
          }

          // ── 7. Shot direction length warning ──
          // Warn when shot direction body (excluding dialogue tag) exceeds 15 words
          const directionRe = /Shot\s*(\d+)\s*\([^)]*\)\s*:\s*([\s\S]*?)(?=\n\[@|\n\nShot\s*\d+\s*\(|$)/gi;
          let dirMatch;
          while ((dirMatch = directionRe.exec(prompt)) !== null) {
            const dirShotNum = dirMatch[1];
            const dirBody = dirMatch[2].trim();
            const wordCount = dirBody.split(/\s+/).length;
            if (wordCount > 20) {
              console.log(`[PROMPT-SANITIZE] ⚠ ${label} Shot ${dirShotNum}: direction is ${wordCount} words (recommended max 15) — may cause Kling to drop dialogue`);
            }
          }

          // ── 8. Difficult-word replacement ──
          prompt = ScriptEngine._replaceDifficultWords(prompt, label);

          clip.multi_shot_prompt = prompt;
        }
      }
    }

    if (totalFixes > 0) {
      console.log(`[PROMPT-SANITIZE] Fixed ${totalFixes} issue(s) across all kling_clip prompts`);
    }
  }

  /**
   * Multi-strategy JSON recovery for Claude script responses.
   * Claude sometimes returns truncated or slightly malformed JSON,
   * especially for large scripts (90+ lines). This method tries
   * progressively more aggressive recovery strategies.
   *
   * Strategies (in order):
   *  1. Direct JSON.parse
   *  2. Extract JSON object via regex (strips markdown fences, preamble)
   *  3. Fix trailing commas
   *  4. Close unclosed brackets/braces
   *  5. Fix unescaped quotes inside string values
   *  6. Truncate to last complete array element (for truncated responses)
   *
   * @param {string} text - Raw text from Claude API response
   * @returns {Object|null} Parsed script object, or null if all strategies fail
   */
  _safeParseScriptJson(text) {
    if (!text || typeof text !== 'string') return null;

    // Strategy 1: Direct parse
    try {
      return JSON.parse(text);
    } catch (e) {
      console.log('[SCRIPT] Direct JSON.parse failed, trying recovery strategies...');
    }

    // Strategy 2: Extract JSON object via regex (strip markdown fences, preamble text)
    let jsonStr = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
      try {
        return JSON.parse(jsonStr);
      } catch (e) {
        console.log('[SCRIPT] Regex-extracted JSON failed, trying fixes...');
      }
    } else {
      console.log('[SCRIPT] No JSON object found in response');
      return null;
    }

    // Strategy 3: Fix trailing commas (common Gemini/Claude quirk)
    let fixed = jsonStr.replace(/,\s*([}\]])/g, '$1');
    try {
      return JSON.parse(fixed);
    } catch (e) {
      console.log('[SCRIPT] Trailing comma fix failed, trying bracket closing...');
    }

    // Strategy 4: Close unclosed brackets/braces
    fixed = this._closeUnclosedBrackets(fixed);
    try {
      return JSON.parse(fixed);
    } catch (e) {
      console.log('[SCRIPT] Bracket closing failed, trying quote fix...');
    }

    // Strategy 5: Fix unescaped quotes inside string values
    // Pattern: find strings with unescaped quotes and escape them
    fixed = this._fixUnescapedQuotes(jsonStr);
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');
    fixed = this._closeUnclosedBrackets(fixed);
    try {
      return JSON.parse(fixed);
    } catch (e) {
      console.log('[SCRIPT] Quote fix failed, trying truncation recovery...');
    }

    // Strategy 6: Truncate to last complete top-level element
    // For truncated responses where the JSON was cut mid-object
    const truncated = this._truncateToLastComplete(jsonStr);
    if (truncated && truncated !== jsonStr) {
      try {
        return JSON.parse(truncated);
      } catch (e) {
        console.log('[SCRIPT] Truncation recovery failed');
      }
    }

    console.error('[SCRIPT] All JSON recovery strategies exhausted');
    return null;
  }

  /**
   * Stream a Claude API call with retry on transient errors (Premature close,
   * ECONNRESET, overloaded_error, rate_limit_error, etc.).
   * Returns the accumulated text. Throws after all retries exhausted.
   */
  async _streamWithRetry({ model, max_tokens, temperature, system, messages, onProgress, label = 'API call' }, maxRetries = 3) {
    const RETRYABLE = /premature close|econnreset|socket hang up|overloaded|rate_limit|529|timeout|network|fetch failed/i;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        let text = '';
        const stream = this.client.messages.stream({ model, max_tokens, temperature, system, messages });
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.text) {
            text += event.delta.text;
            if (onProgress) onProgress(text);
          }
        }
        return text;
      } catch (err) {
        const msg = err.message || String(err);
        if (attempt < maxRetries && RETRYABLE.test(msg)) {
          const delay = attempt * 5000; // 5s, 10s, 15s
          console.warn(`[SCRIPT] ${label} attempt ${attempt}/${maxRetries} failed: ${msg} — retrying in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err; // non-retryable or final attempt
      }
    }
  }

  /**
   * Close unclosed brackets and braces by counting open/close pairs.
   */
  _closeUnclosedBrackets(json) {
    // Track the ORDERED nesting stack so we close in the correct reverse order.
    // The old approach counted braces/brackets separately and always appended
    // ] before } — wrong when the nesting is [ { (should close } then ]).
    const stack = []; // each entry: '{' or '['
    let inString = false;
    let escaped = false;

    for (let i = 0; i < json.length; i++) {
      const ch = json[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') stack.push('{');
      else if (ch === '}') { if (stack.length && stack[stack.length - 1] === '{') stack.pop(); }
      else if (ch === '[') stack.push('[');
      else if (ch === ']') { if (stack.length && stack[stack.length - 1] === '[') stack.pop(); }
    }

    // Remove any trailing comma before we close
    let result = json.replace(/,\s*$/, '');

    // Close unclosed structures in reverse nesting order
    while (stack.length > 0) {
      const opener = stack.pop();
      result += (opener === '{') ? '}' : ']';
    }

    return result;
  }

  /**
   * Fix unescaped quotes inside JSON string values.
   * Looks for patterns like: "key": "value with "unescaped" quotes"
   * and escapes the inner quotes.
   */
  _fixUnescapedQuotes(json) {
    // This is a best-effort heuristic — we walk through the string
    // tracking whether we're inside a JSON string value, and if we
    // encounter a quote that doesn't look like a string boundary
    // (not preceded by a colon/comma/bracket or followed by colon/comma/bracket),
    // we escape it.
    let result = '';
    let inString = false;
    let escaped = false;
    let i = 0;

    while (i < json.length) {
      const ch = json[i];

      if (escaped) {
        result += ch;
        escaped = false;
        i++;
        continue;
      }

      if (ch === '\\' && inString) {
        result += ch;
        escaped = true;
        i++;
        continue;
      }

      if (ch === '"') {
        if (!inString) {
          inString = true;
          result += ch;
        } else {
          // Check if this quote ends the string or is an unescaped inner quote
          // Look ahead: if next non-whitespace char is : , } ] or end-of-string, it's a boundary
          // Also treat \n as boundary — JSON string values end before newlines in key:value pairs
          const rest = json.slice(i + 1).trimStart();
          const nextChar = rest[0];
          if (!nextChar || ':,}]\n\r'.includes(nextChar)) {
            // This is a legitimate string boundary
            inString = false;
            result += ch;
          } else {
            // Likely an unescaped inner quote — escape it
            result += '\\"';
          }
        }
      } else {
        result += ch;
      }

      i++;
    }

    return result;
  }

  /**
   * Truncate a malformed JSON string to the last complete top-level element.
   * Useful when Claude's response was cut off mid-generation.
   *
   * For script JSON like { "characters": [...], "chapters": [...] },
   * this finds the last complete array element in the chapters array
   * and closes everything after it.
   */
  _truncateToLastComplete(json) {
    // Find the last complete object in an array — look for },{ or },\n{ patterns
    // and truncate after the last complete one

    // Strategy: find all positions where a } is followed (after optional whitespace)
    // by , or ] — these are likely complete object boundaries
    const completionPoints = [];
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < json.length; i++) {
      const ch = json[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') {
        depth--;
        // At depth 1 or 2, a closing brace/bracket marks a significant boundary
        if (depth <= 2 && depth >= 0) {
          completionPoints.push(i);
        }
      }
    }

    if (completionPoints.length === 0) return null;

    // Take the last completion point and close everything from there
    const lastGoodPos = completionPoints[completionPoints.length - 1];
    let truncated = json.slice(0, lastGoodPos + 1);

    // Remove any trailing comma
    truncated = truncated.replace(/,\s*$/, '');

    // Close remaining open structures
    truncated = this._closeUnclosedBrackets(truncated);

    return truncated;
  }

  /**
   * Build tier-aware structural scaffolding injected into the script prompt as
   * {{STRUCTURAL_SCAFFOLDING}}. Tells Claude the narrative architecture for the
   * specific duration preset. Different tiers get different craft requirements:
   *
   *   test       — 1-5 min: hook + escalation + punch; 2-3 characters
   *   standard   — 10 min: 3-act with midpoint reversal; 3-4 characters
   *   long-form  — 20-30 min: 3-act + midpoint + B-plot + ensemble; 4-6 characters
   *
   * The grader (`reviewScriptStructure`) checks compliance with these rules.
   * Hard-block kicks in if compliance falls below tier-specific thresholds.
   */
  /**
   * Build mode-specific scaffolding for cinematic vs staged generation.
   *
   * In cinematic mode, Claude must additionally author:
   *   - scene.blocking: explicit frame positions (left/center/right) per character
   *   - scene.kling_clips: ordered array of Kling multi-shot prompts, each covering
   *     1-3 dialogue lines within a 15s clip, exactly 3 shots per clip (each with dialogue)
   *   - scene.location_element_hint: a snake_case hint for the location element
   *     name (used downstream by Phase 3 location-generation stage)
   *   - scene.background_roles: non-speaking realism roles/crowds that do not
   *     create portraits, elements, or promo posts
   *   - scene.props_in_scene: array of prop element hints (Chekhov's gun scaffolding)
   *
   * In staged mode, the addendum is empty — Claude writes the standard schema only.
   *
   * See IMPROVEMENT-CINEMATIC-WORKFLOW.md for the full architecture.
   */
  _buildCinematicScaffolding(mode, tier, storyBrief = {}) {
    if (mode !== 'cinematic') return '';

    // Cinematic mode's clip packing math — 1 Kling clip covers roughly 2-3 dialogue
    // lines at ~3-4 seconds per line inside a 10s clip. Claude decides the exact
    // grouping per scene based on narrative beats.
    return `
=== CINEMATIC MODE — ADDITIONAL AUTHORING REQUIREMENTS ===

This project runs the CINEMATIC pipeline (Cinema Studio 2.0 scene images + Kling 3.0 multi-shot video with native audio). Beyond the dialogue + per-line \`image_prompt\`/\`animation_prompt\` fields required by the staged pipeline, you MUST additionally author for each scene:

1. BLOCKING — explicit character staging in the frame.
   - \`scene.blocking.frame_left\`: character + posture/intent at frame-left ("" if unused — never null)
   - \`scene.blocking.frame_center\`: character + posture/intent at frame-center ("" if unused — never null)
   - \`scene.blocking.frame_right\`: character + posture/intent at frame-right ("" if unused — never null)
   - \`scene.blocking.notes\`: lighting/atmosphere notes that anchor the scene image
   - Use @charactername references (e.g. "@claire near the wooden table, arms tense").
   - Every character in \`characters_present\` must appear in at least one frame position.
   - CRITICAL — BLOCKING DEFINES THE START FRAME: The blocking describes exactly how characters are positioned at the START of the scene. Shot 1 of the FIRST kling_clip for this scene MUST match the blocking positions exactly. If blocking says a character is "seated" and "frame-left", Shot 1 must show them seated frame-left — not standing, not frame-right. The blocking is the source of truth for the opening composition; kling_clips must follow it, not contradict it.

2. LOCATION HINT — a snake_case identifier used to deduplicate locations across scenes.
   - \`scene.location_element_hint\`: e.g. "clara_kitchen", "village_path", "lagos_highrise"
   - Scenes sharing the same location MUST reuse the same hint (scene.location text may vary slightly, but the hint is the stable dedup key).
   - The pipeline generates ONE empty-location image per unique hint (Nano Banana Pro, no characters in frame). That image is then attached as a REFERENCE IMAGE in Cinema Studio 2.0 when generating each scene image. Locations are NOT created as Higgsfield Elements — they're reference images that Cinema Studio composites characters into.
   - Do NOT use @location-style references in any prompt (blocking notes, kling_clips). Only @character references resolve to Higgsfield elements; locations are described in plain language because they're carried by the reference image.

3. PROPS IN SCENE — any recurring plot objects that deserve prop-element treatment (Chekhov's gun).
   - \`scene.props_in_scene\`: array of snake_case prop element hints, e.g. ["the_flashlight", "hidden_letter"]
   - Empty array if no prop elements needed. Only include objects that RECUR across scenes OR serve as structural setup/payoff — not every item in the environment.

4. KLING_CLIPS — ordered array of multi-shot video generations that cover this scene's dialogue.
   - Each clip covers EXACTLY 3 dialogue lines. Not 1, not 2, not 4, not 5 — exactly 3. The ONLY exception is the LAST clip in a scene when the remaining lines don't divide evenly by 3 (e.g. 7 lines = clip of 3 + clip of 3 + clip of 1). Even then, the final clip must have at minimum 1 line and at maximum 3. NEVER pack 4+ lines into a single clip — this is a hard structural failure that causes dialogue to be dropped.
   - Each clip has EXACTLY 3 shots, each shot MUST have at least 1 line of dialogue. This is a hard rule — not 2, not 4, not 6. Kling 3.0 renders 4+ shots unreliably (skipped shots, misattributed dialogue). 3 shots is the proven sweet spot. If a clip has fewer than 3 lines (allowed only for the last clip in a scene), it still gets exactly 3 shots — distribute the dialogue across shots and use the extra shot(s) for reaction beats with brief dialogue continuation.
   - Duration: Fixed at 15 seconds per clip. Let the video model decide timing allocation across shots — do NOT include timing brackets in shot headers (no "0-3s", "3-7s" etc.). The model paces shots naturally based on dialogue length and action.
   - Shots within a clip are continuous beats of the same scene (same location, same lighting) — not "cuts between different scenes."
   - Each clip's \`multi_shot_prompt\` must stay under 2500 characters.
   - Use Kling's dialogue syntax: [@character, speaking in a <tone> Nigerian English accent]: "<dialogue>"
   - Use \`scene.background_roles\` for non-speaking court clerks, judges at bench, market crowds, church ushers, nurses, palace attendants, mourners, and similar realism roles. They do not get dialogue, portraits, Higgsfield Elements, promo posts, or character_bible entries, and they do not count toward the max-3 \`characters_present\` limit.
   - NEVER use @element_name inside dialogue quotes — not in kling_clip multi_shot_prompt dialogue, not in scene line dialogue. Inside quotes, characters speak their HUMAN NAME (e.g. "Ngozi", "Emeka"), not their @tag. The @ prefix triggers Higgsfield element resolution and corrupts the spoken audio. Wrong: [@ngozi, speaking...]: "I told @emeka the truth." Right: [@ngozi, speaking...]: "I told Emeka the truth." This rule is violated constantly — double-check every dialogue string.
   - BLOCKING → SHOT 1 CONSISTENCY (MANDATORY): The FIRST kling_clip's Shot 1 MUST match \`scene.blocking\` exactly — same postures, same positions. Write blocking FIRST, then write kling_clips Shot 1 as a visual realization of that blocking.
   - EVERY SHOT MUST HAVE DIALOGUE: The start frame image and a CHARACTER POSITIONS preamble already establish the scene composition for the video model. Do NOT waste Shot 1 as a silent establishing shot — include the first dialogue line in Shot 1. A 3-shot clip with 3 dialogue lines = 1 line per shot. Shot 1 can still set the camera (WIDE, MEDIUM, etc.) but MUST include dialogue. Every shot must carry dialogue — no silent shots allowed.
   - ONE CHARACTER PER SHOT (MANDATORY — Shots 2 and 3): Shot 1 is a WIDE establishing shot where all characters are visible — multiple @references are allowed in Shot 1 only. For Shot 2 and Shot 3, each shot direction must ONLY describe the character delivering the dialogue. Absolutely NO references to other characters — no @element names, no human names, no pronouns referring to others. The CHARACTER POSITIONS preamble already tells the model where everyone is. Any mention of another character in a shot direction confuses the video model and causes dialogue to be assigned to the wrong face. Wrong: "Shot 2: CLOSE-UP on @ada. She points at @emeka." Wrong: "Shot 2: CLOSE-UP on @ada. She points at Emeka." Right: "Shot 2: CLOSE-UP on @ada. She points sharply ahead, eyes blazing." The ONLY @reference in Shot 2 or Shot 3 is the speaker. Describe reactions, gestures, and emotions of the speaker alone.
   - Shot vocabulary: WIDE ESTABLISHING, WIDE, MEDIUM, CLOSE-UP, EXTREME CLOSE-UP, OVER-SHOULDER, REACTION, INSERT
   - Camera movement vocabulary: STATIC, SLOW PUSH-IN, SLOW PUSH-OUT, PAN LEFT, PAN RIGHT, TILT UP, TILT DOWN, HANDHELD, TRACKING
   - NO SUBTITLES: Do NOT include subtitle text, caption overlays, or on-screen text of any kind in any shot direction or prompt.

KLING RENDERING BUDGET — CRITICAL CONSTRAINTS (from 150-clip production data):
Kling 3.0 has a finite rendering budget per clip. Lip-sync, camera movement, body animation, emotional state animations, and prop interactions ALL compete for the same budget. When the budget is overloaded, lip-sync is the first thing sacrificed — dialogue gets dropped, delivered off-screen, or assigned to the wrong character.

Budget rules for shot directions:
- PUSH-IN + DIALOGUE: Keep dialogue to 6 words or fewer on push-in shots. No concurrent emotional state animations (tears, trembling, jaw tightening). If the dialogue line exceeds 6 words, use STATIC camera instead.
- PROPS-IN-HAND + DIALOGUE: Characters should NOT interact with held props during dialogue shots unless the dialogue is 4 words or fewer. "Clutches the letter" or "sips from the cup" while delivering 8 words of dialogue = lip-sync failure.
- LAUGHTER + DIALOGUE: Never describe a character laughing, chuckling, or bursting into laughter while simultaneously delivering dialogue. Use "warm smile", "grinning", or "smiling warmly" instead. Laughter animation and lip-sync are mutually exclusive.
- WORD COUNT PER SHOT: Aim for 8-10 words on static shots, 6-8 words on push-in shots. Kling drops trailing words beyond ~12 words in a single shot. If a line is 12+ words, it MUST go on a static shot with no competing animations.
- SHOT DIRECTION LENGTH: Keep each shot direction body (excluding the dialogue tag) to 15 words maximum. Shot directions are concise instructions: camera + subject + primary action. Not prose descriptions. Format: "MEDIUM SHOT on @emeka, static. He spreads his hands wide." (11 words) — NOT "As the camera holds on Emeka in a medium shot, he slowly spreads his hands wide while looking toward the window." (21 words).
- SPEAKER FACING CAMERA: If a character's blocking places them facing away from camera (back to camera, looking out window, etc.), their FIRST dialogue shot MUST include a turn directive — "turns to face camera" or "turns over shoulder." Kling cannot animate lip-sync on the back of a head.
- EMOTIONAL STATE ANIMATIONS vs DESCRIPTIONS: Animations COMPETE with lip-sync: "face drains of color", "jaw tightens", "tears streaming", "chin trembles", "eyes fill with tears." Descriptions are SAFE (no budget cost): "eyes are steady", "jaw is set", "face is calm", "expression is unreadable." When dialogue is present, prefer descriptions over animations.

CROSS-CLIP CONTINUITY (SAME SCENE — CRITICAL):
All clips in the same scene share ONE start frame image. Kling renders each clip independently with NO memory of what happened in the previous clip.
- Shot 1 of EVERY clip must re-establish the current physical state of all visible characters. Do NOT assume Kling remembers what happened in the previous clip.
- If dialogue implies a position transition ("Sit down.", "Come inside.", "Stand up.", "Leave."), the NEXT clip's Shot 1 must acknowledge the new state — but the start frame will still show the original positions. Keep transitions subtle: prefer dialogue that matches the static start frame. Avoid "Come inside" when the character is already inside in the scene image.
- Movement WITHIN a clip is fine (character stands up in Shot 2). Movement ACROSS clips creates visual contradictions because the start frame resets.
- For scenes with physical progression, write dialogue that works with the static composition rather than against it. If a character must move, place the movement dialogue in the LAST clip of the scene where the visual contradiction has the least screen time before the scene changes.

EXAMPLE scene excerpt with cinematic fields:

\`\`\`json
{
  "scene_number": 3,
  "location": "Nigerian village kitchen at dusk",
  "location_details": "earthen red clay walls, kerosene lamp, window with sunset light",
  "location_element_hint": "clara_kitchen",
  "characters_present": ["claire_obi", "richard_eze"],
  "background_roles": [],
  "props_in_scene": [],
  "blocking": {
    "frame_left": "@claire_obi near the wooden table, body angled toward the window, arms tense",
    "frame_center": "",
    "frame_right": "@richard_eze in the doorway, hands clenched, eyes fixed on @claire_obi",
    "notes": "dusk light from window behind @richard_eze casts back-rim on his silhouette; warm kerosene lamp glow foreground"
  },
  "lines": [
    {
      "line_number": 1,
      "speaker_id": "@claire_obi",
      "dialogue": "I saw you at the market yesterday.",
      "tone": "Strained"
    }
  ],
  "kling_clips": [
    {
      "clip_id": "ch3_sc3_c1",
      "duration_seconds": 15,
      "line_refs": [1, 2, 3],
      "multi_shot_prompt": "Inside the kitchen from the reference image at dusk, warm kerosene lamp light.\\n\\nShot 1 (WIDE ESTABLISHING, static): @claire_obi frame-left near the wooden table, @richard_eze frame-right near the doorway.\\n[@claire_obi, speaking in a strained Nigerian English accent]: \\"I saw you at the market yesterday.\\"\\n\\nShot 2 (MEDIUM, static): CUT TO @richard_eze. His jaw tightens.\\n[@richard_eze, speaking in a controlled Nigerian English accent]: \\"You saw nothing.\\"\\n\\nShot 3 (CU, slow push-in): CUT TO @claire_obi. Her eyes narrow, fists clenching at her sides.\\n[@claire_obi, speaking in a sharp Nigerian English accent]: \\"Then why are you shaking?\\""
    }
  ]
}
\`\`\`

REALISM AND WORLD POPULATION (CRITICAL FOR LONG-FORM BELIEVABILITY):
- Use \`background_roles\` for people who make a location believable but should NOT become full speaking characters. They do not get portraits, grids, elements, promo posts, or dialogue. They do not count toward the max-3 \`characters_present\` limit. Examples: court clerk, judge at bench, lawyers in gallery, market crowd, church ushers, nurses at station, palace attendants, mourners.
- Institutional scenes require functional presence. Court scenes need judge/lawyer/clerk/bailiff; hospital scenes need doctor/nurse/reception; police scenes need officer/investigator; church scenes need pastor/elder/usher; school scenes need teacher/principal; palace scenes need chief/elder/attendant. If the role drives plot or speaks, add it to character_bible; otherwise put it in \`background_roles\`.
- Populate public settings. Markets, churches, courts, hospitals, schools, weddings, funerals, police stations, and palace compounds should not feel empty unless the story explicitly says they are empty. Use \`background_roles\` and location details such as sparse/moderate/packed crowd density.
- Legal, medical, business, land, school, and police beats need concrete procedure. Use \`props_in_scene\` and dialogue references for affidavits, stamped files, land receipts, medical reports, ID cards, charge sheets, ledgers, phone recordings, signed letters, keys, rings, medicine, or other proof. Do not resolve major stakes with talk alone.
- Respect authority boundaries. Judges do not investigate like police. Pastors do not issue legal judgments. Doctors do not disclose private medical details publicly. Police do not settle inheritance or land ownership with one argument. Use the correct institution for the action.
- Track time and logistics. If scenes move between village, Lagos, court, hospital, police station, palace, or church, imply believable elapsed time. Court dates, medical results, arrests, travel, and family meetings should not happen instantly unless the script explains the urgency.
- Money and work have consequences. Demands, bribes, dowry/bridal negotiations, rent, school fees, hospital bills, transport, business losses, and salary threats should match the character's class, job, and access to cash.
- Communication must be plausible. Phone calls, WhatsApp messages, recordings, screenshots, and viral posts need access, privacy, timing, and a reason the information reaches the right person.
- Domestic life should feel specific. Homes, meals, clothes, transport, work schedules, church/mosque days, market hours, school pickup, and neighborhood routines should ground the drama where relevant.
- Emotional aftermath matters. Big reveals, arrests, public disgrace, death news, betrayal, or legal defeat need a reaction beat: silence, avoidance, prayer, family meeting, apology attempt, shame, or community gossip before the next major plot turn.
- Props persist. If a phone, letter, land document, ring, test result, key, medicine, or photograph triggers a scene, account for it later or use it as setup/payoff. Do not let crucial objects vanish.
- Language register should match role and class: lawyer formal, pastor spiritual, elder proverbial, trader blunt, police procedural, young professional clipped. Avoid one generic voice for everyone.

CHARACTER ELEMENT NAMING (CRITICAL — CONSISTENCY REQUIRED):
- Each character in the bible MUST have an \`element_name_hint\` field: a short snake_case name derived from the character's actual name (e.g. "mama_adaeze", "eze_okonkwo", "emeka"). This is the SINGLE name used as the @reference in ALL prompts.
- Use @element_name_hint (e.g. "@mama_adaeze", "@eze_okonkwo") in ALL cinematic-mode prompts: \`blocking.frame_left/center/right\`, \`blocking.notes\`, \`kling_clips[].multi_shot_prompt\`, and \`characters_present\`.
- Do NOT use @character_1 / @character_2 in blocking or kling_clips — those are internal IDs only. The @element_name_hint is what gets created as a Higgsfield Element and must match exactly everywhere.
- \`speaker_id\` in line objects uses \`element_name_hint\` prefixed with @ (e.g. "@mama_adaeze") for consistency with blocking refs.
- \`characters_present\` also uses element_name_hint values (e.g. ["mama_adaeze", "eze_okonkwo"]).
- Character bible still contains full physical descriptions for portrait generation, but once elements exist, visual identity is locked by @reference.

MULTI-OUTFIT CHARACTER SYSTEM:
Characters in Nollywood drama wear different outfits across the story. Each outfit becomes a SEPARATE Higgsfield Element — a distinct visual identity that the pipeline selects per scene.
- The character_bible separates \`physical_description\` (permanent features: face, body, skin tone, hair texture) from \`outfits[]\` (clothing/styling per context).
- Each outfit has an \`outfit_id\` (o1, o2, o3...) and a \`context\` explaining when it's worn.
- Each scene_beat MUST include \`character_outfits\`: a mapping of character_id → outfit_id. This is how the pipeline knows which element to render for each character in each scene.
- Downstream pipeline creates: one master portrait per character (from physical_description), then one outfit portrait per outfit (using master portrait as face reference + outfit description), then one grid per outfit, then one Higgsfield Element per outfit. Element names follow the pattern: @{baseName}_o{N}_{suffix}.
- The @element_name_hint in scene-level references resolves to the outfit-specific element at generation time. Write \`@claire_obi\` in blocking and kling_clips — the orchestrator appends the outfit suffix automatically based on \`character_outfits\`.
- An outfit change within a scene is NOT supported — split into two scenes if a character changes clothes.
- Outfit assignment should follow story logic: corporate scenes → formal outfit, home scenes → casual outfit, event scenes → glamour outfit, etc. A character's first-seen outfit should be o1.

${storyBrief.storyDriven ? `
STORY-DRIVEN STRUCTURE (CINEMATIC ONLY):
- SCENES PER CHAPTER: UNLIMITED. Each chapter gets as many scenes as the story needs. A scene is a conversation beat — a distinct grouping of characters in dialogue. Same or different location.
- LINES PER SCENE: UNLIMITED. A scene can be 2 lines (a quick reaction) or 15 lines (an extended confrontation). Lines are grouped into clips of exactly 3 lines each — NEVER more than 3 lines per clip. A 9-line scene = 3 clips. A 7-line scene = 2 clips of 3 + 1 clip of 1. All clips share the same scene image as start frame.
- CHARACTERS PER PROJECT: UNLIMITED. Every speaking character gets a portrait and Higgsfield element. Create as many characters as the story needs — a 30-min drama might have 8-12 speaking roles.
- CHARACTERS PER SCENE: MAX 3. This is a hard Kling constraint — more than 3 characters in a scene degrades lip-sync and positioning quality. If 4+ characters need to interact, split into separate scenes or have characters enter/exit.
- TARGET CLIPS: ~${storyBrief.targetClips || 50} total across the entire script. Each clip = 10-12 seconds of footage. Distribute clips across chapters based on dramatic weight — a climactic chapter might get more clips than a transitional one.
- APPROXIMATE CLIPS PER CHAPTER: ~${Math.ceil((storyBrief.targetClips || 50) / (storyBrief.chapters || 10))} (this is guidance, not a hard rule — distribute based on story needs).
- HARD LINE-REF RULE: every kling_clip.line_refs array must contain 1-3 line numbers, never 4+. If a beat needs more dialogue, create a second complete kling_clip with its own real multi_shot_prompt.
` : ''}
AI-SAFE VISUAL STORYTELLING (visual_beat per clip):
Cinema is not only dialogue. Each kling_clip MUST include a "visual_beat" field — ONE concrete, simple physical action that carries story meaning and that Kling can reliably render. This prevents "talking heads" syndrome and gives the camera something to reveal.

GOOD visual beats (AI-safe — single character, single action, no complex choreography):
- "clutches the envelope tighter" (fear of discovery)
- "slowly removes her wedding ring" (decision made)
- "steps backward from the table" (power yielded)
- "hides the phone behind her back" (guilt)
- "turns the framed photo face-down" (rejection)
- "sets down the glass with deliberate control" (suppressed rage)
- "grips the edge of the chair" (restraint under pressure)
- "closes her eyes, chin lifted" (spiritual surrender)

BAD visual beats (too complex for Kling, multi-character, or silent-only):
- "grabs his collar and slams him against the wall" (two-character physics)
- "the room erupts in chaos as everyone stands" (ensemble action)
- "flashback to the childhood scene" (Kling has no flashback concept)
- "montage of her walking through the city" (multi-location)

The visual_beat should be written INTO the shot direction of Shot 2 or 3 (whichever carries the most emotional weight). It is NOT a separate silent shot — it accompanies dialogue. Example: "CLOSE-UP on @ada, static. She grips the chair edge, knuckles whitening. [@ada, speaking...]: "I will not beg.""

EMOTIONAL RHYTHM AND BREATHING ROOM:
Not every scene can be at maximum tension. Real drama needs:
- PRESSURE scenes (confrontation, reveal, reversal) — high energy, rapid dialogue
- BREATHING scenes (aftermath, private confession, quiet setup) — slower pace, fewer clips, emotional processing
- The outline's emotional_temperature field guides this: "low-simmer" chapters should feel reflective, intimate, or quietly ominous — not explosive. "boiling" chapters earn their intensity BECAUSE the previous chapter was quieter.
- If 3+ consecutive scenes are all confrontations, the viewer experiences fatigue. Alternate scene_purpose types: confrontation → private-confession → setup → reveal.
- Nollywood melodrama needs moments of RECOGNITION: shame, pride, longing, family duty, spiritual fear, public humiliation. These emotions need SPACE to land — they cannot be rushed through in 3 lines. A shame scene might have a character repeat themselves, trail off, or speak to God rather than the person in front of them.

CULTURAL DIALOGUE CADENCE:
Nigerian dramatic speech has distinctive patterns that should be preserved:
- PROVERBIAL characters (elders, traditional authority): May use up to 12 words per sentence. Proverbs are complete units that lose meaning when broken: "The tortoise that tries to fly will break its shell." Do NOT break these with [NEW CAMERA ANGLE] mid-proverb.
- SPIRITUAL characters (pastors, prayer warriors, market women invoking God): May use up to 12 words. Blessings, curses, and spiritual declarations are rhythmic units: "May the God of our fathers judge between us today."
- ACCUSATORY cadence: Nigerian confrontation often uses repetition for dramatic weight: "You did this. You. Not them. You." This is intentional rhythm, not wasted words.
- CLASS MARKERS: A wealthy character uses English differently than a market trader. Vocabulary, sentence structure, and directness all signal social position. Maintain these consistently.
- The 9-word rule remains the DEFAULT for all other speech_styles. The 12-word ceiling is ONLY for proverbial and spiritual characters on lines that genuinely need the rhythmic space.

CINEMATIC MODE STRUCTURAL BAR IS HIGHER:
- The structural review grader applies stricter rules to cinematic scripts because each weak Kling clip burns ~18 credits.
- Blocking completeness is mandatory: every scene must have non-null frame positions for all present characters.
- Dialogue function rule is doubly enforced: every line in a kling_clip's multi_shot_prompt must either advance plot, reveal character, raise stakes, or create conflict.

${tier === 'prestige' ? `
PRESTIGE CINEMATIC — ADDITIONAL CONSTRAINTS (45 min, ~245 clips):
- CLIP BUDGET DISCIPLINE: At ~245 clips, every clip must earn its runtime. If a scene's dialogue can be covered in 2 clips instead of 3, use 2. Do not pad scenes to fill a target — let the story's natural pace dictate clip count per chapter.
- THREE-LINE MAXIMUM PER CLIP IS ABSOLUTE: With 245 clips, auto-split from oversized clips cascades across the entire project. Strictly enforce exactly 3 lines per clip (except the final clip in a scene which may have 1-2).
- FIVE-ACT PACING IN CINEMATIC: Distribute clips across acts roughly: Act I ~15%, Act II ~20%, Act III ~25% (midpoint crisis gets the most visual density), Act IV ~25%, Act V ~15%. The midpoint crisis and unraveling should be the most visually rich — more close-ups, more rapid cuts, more emotional visual_beats.
- VOICE CONSISTENCY ACROSS 12-15 CHAPTERS: Each character has a defined speech pattern. Characters with proverbial speech_style maintain it in every chapter. Characters with clipped speech stay clipped. Do not let characters drift into generic dialogue register in later chapters.
` : ''}
`;
  }

  /**
   * (kept as placeholder — we don't split schema between modes at the prompt
   * level; Claude writes the standard schema in both modes and optionally adds
   * the cinematic fields when scaffolding above is present. This keeps the
   * script-prompt.txt template simpler and avoids drift between two schemas.)
   */
  _buildSchemaAddendum(mode) {
    return '';
  }

  _buildStructuralScaffolding(tier, chapters, storyBrief = {}) {
    const half = Math.ceil(chapters / 2);
    const firstThird = Math.max(1, Math.floor(chapters / 3));
    const lastChapter = chapters;
    const isCinematicStoryDriven = storyBrief.storyDriven && storyBrief.generatorMode === 'cinematic';

    if (tier === 'test') {
      return `
=== TIER: TEST (short-form, ${chapters} chapters, cheap iteration) ===

CHARACTER COUNT: ${isCinematicStoryDriven ? 'UNLIMITED — every speaking character gets a portrait. Max 3 characters per scene.' : '2-3 characters total.'} Every character must appear in at least 2 lines.

ARC (compressed 3-act):
- Chapter 1: Open mid-conflict. Inciting incident by end of Chapter 1.
- Middle chapters (if any): Escalate stakes. Each chapter ends with a hook.
- Final chapter (Chapter ${lastChapter}): Climax + emotional resolution. No loose threads.

This is a cheap test preset — structural bar is low but the 4 universal rules above still apply.

HOOK-RESOLUTION CYCLE (even test scripts must hook):
- OPENING HOOK: The first 2 lines of Chapter 1 Scene 1 MUST plant an unanswered question, unresolved tension, or mid-action moment. The viewer decides in 10 seconds whether to stay.
- INTRA-SCENE LADDER: When a question or tension is resolved within a scene, immediately open a new one in the SAME beat or the next line. Never leave the viewer with "okay, that's settled" — always give them a reason to keep watching.
- SCENE-TO-SCENE HANDOFF: The last line of a scene should hand off tension to the next scene. Resolve one rung, open the next.
`;
    }

    if (tier === 'standard') {
      return `
=== TIER: STANDARD (10-min form, ${chapters} chapters, classic 3-act) ===

CHARACTER COUNT: ${isCinematicStoryDriven ? 'UNLIMITED — every speaking character gets a portrait. Max 3 characters per scene.' : '3-4 characters total.'} Each has a distinct voice and a clear want.
Roles should include: PROTAGONIST (the wanter), ANTAGONIST (the obstacle), plus 1-2 supporting characters (confidant, rival, family figure). Every character appears in ≥3 lines.

3-ACT STRUCTURE:
- ACT 1 (Chapter 1): Setup + inciting incident. The protagonist's ordinary world is disrupted BY THE END OF CHAPTER 1. Open mid-action.
- ACT 2 (Chapters 2 through ${lastChapter - 1}): Rising action. Each chapter raises the stakes. Around the midpoint (Chapter ${half}), a REVERSAL — something the audience thought was true flips, or a secret is revealed, or an ally becomes a threat. This is non-negotiable.
- ACT 3 (Chapter ${lastChapter}): Climax + resolution. The protagonist's want is either granted or denied decisively. No loose threads.

EVERY CHAPTER EXCEPT CHAPTER ${lastChapter} ENDS ON A CLIFFHANGER, QUESTION, OR REVEAL.

STAKES ESCALATION: Chapter N+1 must have higher stakes than Chapter N. If the worst outcome is the same in Chapter 2 as in Chapter 5, the story is flat.

HOOK-RESOLUTION CYCLE (the retention engine):
- OPENING HOOK: The first 2 lines of Chapter 1 Scene 1 MUST plant an unanswered question, unresolved tension, or mid-action moment. No greetings, no introductions, no scene-setting. The viewer decides in 10-15 seconds whether to stay — earn those seconds.
- THE LADDER: Structure each chapter as a series of "rungs." Each rung is a question/tension planted → partially or fully resolved → which immediately opens the NEXT question. Never resolve something without planting the next hook in the same beat. The viewer should always be holding at least one unanswered question.
- INTRA-SCENE TENSION: Within a single scene, every 2-3 lines of dialogue should either (a) raise a new micro-question, (b) shift power between characters, or (c) reveal new information that reframes what we just heard. Flat exchanges where characters agree or exchange pleasantries are dead air.
- SCENE-TO-SCENE HANDOFF: The last line of scene N should create tension that ONLY scene N+1 can resolve. This is the glue that prevents drop-off between scenes.
- ESCALATING HOOKS: Chapter 2's hook should be more compelling than Chapter 1's. Chapter ${lastChapter - 1}'s hook should be the strongest in the story (right before the climax). The hooks themselves must escalate, not just the stakes.
`;
    }

    // prestige tier (45 min) — MUST be checked before long-form (R5 mitigation)
    if (tier === 'prestige') {
      const actBreaks = {
        act1End: Math.max(3, Math.floor(chapters / 5)),          // ~20% of chapters
        act2End: Math.max(6, Math.floor(chapters * 2 / 5)),      // ~40%
        act3End: Math.max(9, Math.floor(chapters * 3 / 5)),      // ~60%
        act4End: Math.max(12, Math.floor(chapters * 4 / 5)),     // ~80%
      };
      return `
=== TIER: PRESTIGE (${chapters} chapters, five-act ensemble drama) ===

This is a 45-minute YouTube Nollywood prestige drama. The structural bar is the HIGHEST in the system. At 45 minutes, every single chapter must earn its runtime or viewers leave. A bad script at this tier wastes ~3000 credits.

CHARACTER COUNT: ${isCinematicStoryDriven ? 'UNLIMITED — every speaking character gets a portrait and element. Max 3 characters per scene (Kling constraint). Create as many characters as the story needs — prestige dramas thrive on ensemble casts.' : '6-10 characters total.'} Mandatory roles:
- PROTAGONIST (the wanter — drives the A-plot)
- ANTAGONIST (the obstacle — active, intelligent opposition with their own logic)
- 2 CONFIDANTS (one per side of the conflict — reveal inner thoughts through dialogue)
- 2+ B-PLOT LEADS (each drives a secondary storyline — more on dual B-plots below)
- 2+ SUPPORTING (family figures, authority figures, community voices, rivals)

Every character appears in ≥6 lines and has at least 2 scenes where they drive the action (not just reacting). No passive characters — everyone pushes or pulls the plot.

FIVE-ACT STRUCTURE:

ACT I — SETUP (Chapters 1-${actBreaks.act1End}):
- Establish the world, the ensemble, and TWO story engines (A-plot + first B-plot).
- Chapter 1 opens mid-conflict. The inciting incident lands BY END OF CHAPTER 1.
- The second B-plot is seeded (not fully launched) by end of Act I.
- Plant at least 2 of your 3+ setup/payoff details in Act I.

ACT II — COMPLICATIONS (Chapters ${actBreaks.act1End + 1}-${actBreaks.act2End}):
- A-plot escalates. Both B-plots are now active and running in parallel.
- Each chapter introduces a NEW complication, not just a continuation of existing tension.
- Characters' alliances begin to show cracks.
- The first B-plot intersects with the A-plot by end of Act II (collision, not just adjacency).

ACT III — MIDPOINT CRISIS (Chapters ${actBreaks.act2End + 1}-${actBreaks.act3End}):
- MAJOR REVERSAL at the midpoint that reframes EVERYTHING. This is not a plot twist — it's a reframe: what the audience believed was true was wrong (hidden identity, secret relationship, past betrayal, pregnancy, death, double life). The reversal must change the meaning of scenes the audience has already watched.
- The second B-plot collides with the A-plot during or immediately after the midpoint.
- Highest emotional volatility — alliances shatter, secrets surface, consequences begin.

ACT IV — UNRAVELING (Chapters ${actBreaks.act3End + 1}-${actBreaks.act4End}):
- Consequences cascade from the midpoint crisis.
- Alliances shift or reform under pressure.
- Tension is at its HIGHEST — the protagonist faces the worst possible version of their situation.
- Both B-plots reach their own crisis points (mini-climaxes before the main climax).
- At least 1 setup/payoff pair fires in Act IV.

ACT V — CLIMAX + RESOLUTION (Chapters ${actBreaks.act4End + 1}-${chapters}):
- ALL threads converge. Both B-plots resolve BEFORE or DURING the main climax (not after).
- The A-plot climax is decisive — the protagonist's want is granted or denied permanently.
- Remaining setup/payoff pairs fire.
- Final chapter ties off ALL loose threads. No sequel bait, no ambiguity — the story is complete.

DUAL B-PLOT REQUIREMENT: You MUST have TWO secondary storylines running parallel to the A-plot.
- B-Plot 1: shares a character with the A-plot, intersects with A-plot by end of Act II, has its own mini-arc (setup → complication → resolution)
- B-Plot 2: may share a character with A-plot or B-plot 1, intersects with A-plot during Act III-IV, has its own mini-arc
- Both B-plots must COLLIDE with the A-plot — their resolutions directly affect the main climax.

EVERY CHAPTER EXCEPT CHAPTER ${chapters} ENDS ON A CLIFFHANGER, QUESTION, OR REVEAL. For ${chapters} chapters that means ${chapters - 1} distinct hooks. Vary hook types — alternate between reveals, questions, emotional beats, and act-break reversals. Never repeat the same hook type twice consecutively.

STAKES ESCALATION: Stakes must rise monotonically. Map out the "worst outcome" at each act break — it must grow: reputation → relationships → livelihood → identity → life.

SETUP & PAYOFF: Plant at least 3 specific details in Acts I-II that pay off in Acts IV-V. These must be SPECIFIC (a necklace, a phrase, a letter, a scar) not abstract (trust, loyalty).

NO EXPOSITION DUMPS: Backstory revealed through conflict only. If a character needs to know X, they discover it or are forced to confront it — never told it.

THEMATIC COHERENCE: A 45-minute drama needs a unifying theme (power vs love, tradition vs ambition, truth vs loyalty). The theme should be tested from multiple angles through the A-plot and both B-plots. By the end, the story has made an argument about this theme — even if the argument is ambiguous.

HOOK-RESOLUTION CYCLE (the retention engine — CRITICAL at 45 minutes):
- OPENING HOOK: The first 2 lines of Chapter 1 Scene 1 MUST plant an unanswered question, unresolved tension, or mid-action moment. At 45 minutes, viewers are maximally skeptical — earn their commitment in the first 10 seconds.
- THE LADDER: Structure each chapter as 3-4 "rungs." Each rung: tension planted → resolved → IMMEDIATELY opens next. Never leave the viewer in a resolved state. For ${chapters} chapters, aim for 3-4 rungs per chapter (45-60 total tension cycles across the full story).
- INTRA-SCENE TENSION: Every 2-3 lines of dialogue shift power, raise a question, or reveal something that reframes the scene. Zero flat exchanges. At this length, even one dead scene costs viewers.
- SCENE-TO-SCENE HANDOFF: Every scene transition hands off tension. With ${chapters} chapters and multiple scenes each, there could be 40-60 scene transitions — every one must push forward.
- ESCALATING HOOKS: Hooks escalate across the five acts. Act I hooks create curiosity. Act II hooks create concern. Act III hooks create dread. Act IV hooks create desperation. The Chapter ${chapters - 1} hook (right before the climax) should be the strongest in the entire story.
- CONTINUOUS VALUE: Each chapter adds NEW dramatic value. If a chapter only bridges between two important chapters, it doesn't earn its runtime at 45 minutes — merge it or give it its own dramatic function.
`;
    }

    // long-form tier (20-30 min)
    return `
=== TIER: LONG-FORM (${chapters} chapters, prestige drama architecture) ===

This is a 20-30 minute YouTube Nollywood drama. The structural bar is HIGH. Viewers drop off fast at 20+ min unless every chapter earns its runtime.

CHARACTER COUNT: ${isCinematicStoryDriven ? 'UNLIMITED — every speaking character gets a portrait and element. Max 3 characters per scene (Kling constraint). Create as many characters as the story needs.' : '4-6 characters total.'} Mandatory roles:
- PROTAGONIST (the wanter — drives the main plot)
- ANTAGONIST (the obstacle — active opposition)
- CONFIDANT or AIDE (reveals protagonist's inner thoughts through dialogue)
- B-PLOT CHARACTER (drives the secondary storyline — more on B-plot below)
- Additional supporting roles as needed (family figure, authority, rival suitor, etc.)

Every character appears in ≥4 lines and has at least one scene where they drive the action (not just reacting).

3-ACT STRUCTURE WITH LONG-FORM ARCHITECTURE:
- ACT 1 (Chapters 1-${firstThird}): Setup + inciting incident. The main-plot protagonist's world is disrupted by end of Chapter 1. The B-plot (secondary storyline) is INTRODUCED by Chapter ${firstThird}.
- ACT 2 (Chapters ${firstThird + 1} through ${lastChapter - firstThird}): Rising action on BOTH plots. They run in parallel and eventually intersect. Around Chapter ${half}, a MAJOR REVERSAL — a reveal that reframes everything (hidden identity, secret relationship, past betrayal, pregnancy, death). The reversal must change what the audience thought was true, not just add new information.
- ACT 3 (Chapters ${lastChapter - firstThird + 1} through ${lastChapter}): Climax + resolution. Both plots converge. The climax is decisive — protagonist gets what they want (or doesn't) permanently. Loose threads tied off in the final chapter.

B-PLOT REQUIREMENT: You MUST have a secondary storyline running parallel to the main plot. Examples: the protagonist's mother has her own crisis; the antagonist's wife discovers something; a sibling pursues their own goal. The B-plot must:
(a) share at least one character with the main plot,
(b) intersect with the main plot before the climax (their collision IS the climax, or causes it),
(c) have its own mini-arc (setup → complication → resolution).

EVERY CHAPTER EXCEPT CHAPTER ${lastChapter} ENDS ON A CLIFFHANGER, QUESTION, OR REVEAL. For a ${chapters}-chapter story that means ${chapters - 1} distinct hooks. Do NOT repeat the same type of hook twice in a row — alternate between reveals, questions, and emotional beats.

STAKES ESCALATION: Stakes must rise monotonically from Chapter 1 to Chapter ${lastChapter}. Map out what the "worst outcome" is at each chapter break — it must grow. Someone's reputation at stake in Chapter 2 → their marriage in Chapter 5 → their life in Chapter ${lastChapter - 1}.

SETUP & PAYOFF: Plant at least 2 specific details in the first third (an object, a phrase, a relationship) that PAY OFF in the final third. Example: a specific necklace mentioned in Chapter 2 is what identifies the long-lost daughter in Chapter 9.

NO EXPOSITION DUMPS: Backstory is revealed through conflict, not through one character explaining things to another. If a character needs to know X, they should DISCOVER it or BE FORCED TO CONFRONT it, not be told it.

HOOK-RESOLUTION CYCLE (the retention engine — non-negotiable at this length):
- OPENING HOOK: The first 2 lines of Chapter 1 Scene 1 MUST plant an unanswered question, unresolved tension, or mid-action moment. No greetings, no introductions, no scene-setting. At 20-30 minutes, viewers are skeptical from the first second — you must earn their commitment immediately.
- THE LADDER: Structure each chapter as a series of "rungs." Each rung: question/tension planted → partially or fully resolved → which IMMEDIATELY opens the next question. Never leave the viewer in a resolved state — they should always be holding at least one unanswered question. For ${chapters} chapters, aim for 2-3 rungs per chapter minimum.
- INTRA-SCENE TENSION: Within a single scene, every 2-3 lines of dialogue should either (a) raise a new micro-question, (b) shift power between characters, or (c) reveal new information that reframes what we just heard. Flat exchanges where characters agree or exchange pleasantries are dead air — at this length, dead air kills retention.
- SCENE-TO-SCENE HANDOFF: The last line of scene N should create tension that ONLY scene N+1 can resolve. This is the glue that prevents drop-off between scenes. For a ${chapters}-chapter story with multiple scenes each, there could be 15-25 scene transitions — every single one must hand off tension.
- ESCALATING HOOKS: Chapter 2's hook should be more compelling than Chapter 1's. Chapter ${lastChapter - 1}'s hook should be the strongest in the story (right before the climax). The hooks themselves must escalate, not just the stakes. Map out the hook escalation: curiosity → worry → dread → "I NEED to know what happens."
- CONTINUOUS VALUE: Each consecutive chapter must add NEW tension or value, not just maintain existing tension. If a chapter exists only to bridge between two important chapters, it doesn't earn its runtime — merge it or give it its own dramatic function.
`;
  }

  /**
   * Grade a generated script against the structural rubric for its tier.
   * Runs a SINGLE Claude call (~$0.05-0.10) that reads the full script JSON
   * and returns { score, pass, issues, strengths, summary }.
   *
   * Pass thresholds:
   *   test       — score ≥ 50 (low bar, test runs don't need prestige arc)
   *   standard   — score ≥ 60
   *   long-form  — score ≥ 70
   *   prestige   — score ≥ 80 (HIGHEST bar — prestige burns ~3000 credits)
   *   +5 cinematic bump across all tiers
   *
   * Caller (orchestrator) uses `pass` to hard-block the approval gate on fail.
   */
  async reviewScriptStructure(script, tier, storyBrief) {
    const fs = require('fs');
    const path = require('path');
    const reviewerPromptPath = path.join(__dirname, '..', '..', '..', 'prompts', 'structure-review-prompt.txt');
    const generatorMode = (storyBrief.generatorMode === 'cinematic') ? 'cinematic' : 'staged';
    const systemPrompt = fs.readFileSync(reviewerPromptPath, 'utf-8')
      .replace('{{TIER}}', tier)
      .replace('{{CHAPTERS}}', String(storyBrief.chapters || script.chapters?.length || 6))
      .replace('{{GENERATOR_MODE}}', generatorMode)
      .replace('{{CINEMATIC_RUBRIC_EXTENSION}}', generatorMode === 'cinematic' ? CINEMATIC_RUBRIC_EXTENSION : '');

    const skeleton = this._buildStructuralReviewSkeleton(script, tier, storyBrief, generatorMode);

    const userMessage = `TIER: ${tier}\nGENERATOR_MODE: ${generatorMode}\nEXPECTED CHAPTERS: ${storyBrief.chapters}\n\nSCRIPT SKELETON:\n${JSON.stringify(skeleton, null, 2)}\n\nGrade this script per the rubric. Return JSON only.`;

    // Prestige tier: 15 chapters × 5 scenes each produces many more issues to report;
    // 8K was already tight for long-form, 16K gives headroom for the five-act rubric
    const graderMaxTokens = (tier === 'prestige') ? 16384 : 8192;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: graderMaxTokens,
      temperature: 0.2, // Low temp — we want consistent, critical grading
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0].text;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[REVIEW] No JSON in grader response — defaulting to cautious fail (re-review needed)');
        return { score: 0, pass: false, tier, threshold: 0, issues: [{ severity: 'critical', category: 'grader_error', description: 'Structural grader returned no valid JSON. Cannot verify script quality — please regenerate or override manually.' }], strengths: [], summary: 'Grader returned malformed response; script blocked until re-review or manual override.' };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      // Cinematic mode raises the bar by 5 pts at every tier — weak Kling clips
      // cost more per unit than weak Veo clips, and coverage authoring errors
      // (missing blocking, incoherent shot groups) propagate worse.
      const baseThresholds = { 'test': 50, 'standard': 60, 'long-form': 70, 'prestige': 80 };
      const bump = (generatorMode === 'cinematic') ? 5 : 0;
      const threshold = (baseThresholds[tier] || 60) + bump;
      const pass = typeof parsed.score === 'number' && parsed.score >= threshold;
      return {
        score: parsed.score || 0,
        pass,
        tier,
        threshold,
        issues: parsed.issues || [],
        strengths: parsed.strengths || [],
        summary: parsed.summary || '',
        raw: parsed,
      };
    } catch (e) {
      console.error('[REVIEW] Parse error:', e);
      return { score: 0, pass: false, tier, threshold: 0, issues: [{ severity: 'critical', category: 'grader_error', description: `Structural grader response failed to parse: ${e.message}. Cannot verify script quality.` }], strengths: [], summary: `Grader parse error: ${e.message}. Script blocked until re-review or manual override.` };
    }
  }

  /**
   * Build the compact script skeleton sent to the structural reviewer.
   * Story-driven cinematic scripts still include compact kling_clips evidence so
   * the grader can verify clip existence, line coverage, shot count, and Shot 1
   * dialogue without the full 2K+ prompt text for every clip.
   */
  _buildStructuralReviewSkeleton(script, tier, storyBrief, generatorMode) {
    const isStoryDriven = storyBrief.storyDriven;
    const skeleton = {
      title: script.title,
      character_bible: (script.character_bible || []).map(c => ({
        id: c.id,
        label: c.description_label,
        role_inferred: c.role_inferred || c.role || null,
      })),
      chapters: (script.chapters || []).map(ch => ({
        chapter_number: ch.chapter_number,
        chapter_title: ch.chapter_title,
        scenes: (ch.scenes || []).map(sc => {
          const base = {
            scene_number: sc.scene_number,
            location: sc.location,
            ...(tier !== 'prestige' && sc.location_details ? { location_details: sc.location_details } : {}),
            characters_present: sc.characters_present || [],
            background_roles: sc.background_roles || [],
            lines: (sc.lines || []).map(ln => {
              const line = {
                line_number: ln.line_number,
                speaker: ln.speaker_id,
                dialogue: tier === 'prestige'
                  ? (ln.dialogue || '').split(/\s+/).slice(0, 6).join(' ')
                  : ln.dialogue,
              };
              if (tier !== 'prestige') line.tone = ln.tone;
              return line;
            }),
          };

          if (generatorMode === 'cinematic') {
            base.location_element_hint = sc.location_element_hint || null;
            base.props_in_scene = sc.props_in_scene || [];
            base.blocking = this._compactReviewBlocking(sc.blocking);
            base.clip_count = (sc.kling_clips || []).length;
            base.kling_clips = (sc.kling_clips || []).map(c => this._compactReviewClip(c, isStoryDriven));
          }

          return base;
        }),
      })),
    };

    if (isStoryDriven && generatorMode === 'cinematic') {
      let totalClips = 0, totalLines = 0, maxCharsPerScene = 0;
      for (const ch of script.chapters || []) {
        for (const sc of ch.scenes || []) {
          totalClips += (sc.kling_clips || []).length;
          totalLines += (sc.lines || []).length;
          maxCharsPerScene = Math.max(maxCharsPerScene, (sc.characters_present || []).length);
        }
      }
      skeleton.cinematic_stats = {
        total_clips: totalClips,
        target_clips: storyBrief.targetClips || 50,
        total_lines: totalLines,
        total_scenes: skeleton.chapters.reduce((sum, ch) => sum + ch.scenes.length, 0),
        max_characters_in_any_scene: maxCharsPerScene,
      };
    }

    return skeleton;
  }

  _compactReviewBlocking(blocking) {
    if (!blocking) return null;
    return {
      frame_left: blocking.frame_left || null,
      frame_center: blocking.frame_center || null,
      frame_right: blocking.frame_right || null,
      notes: blocking.notes || blocking.blocking_summary || null,
    };
  }

  _compactReviewClip(clip, isStoryDriven) {
    const prompt = clip.multi_shot_prompt || '';
    const shotMatches = prompt.match(/\bShot\s*\d+\b/gi) || [];
    const shot1Text = this._extractShotText(prompt, 1);
    const compact = {
      clip_id: clip.clip_id,
      duration_seconds: clip.duration_seconds,
      line_refs: clip.line_refs || [],
      multi_shot_prompt_length: prompt.length,
      shot_count: shotMatches.length,
      shot1_has_dialogue: /\[[^\]]+\]\s*:\s*"/.test(shot1Text),
      prompt_preview: prompt.slice(0, isStoryDriven ? 500 : 1200),
    };
    if (!isStoryDriven) compact.multi_shot_prompt = prompt;
    return compact;
  }

  _extractShotText(prompt, shotNumber) {
    if (!prompt) return '';
    const startRe = new RegExp(`\\bShot\\s*${shotNumber}\\b`, 'i');
    const start = prompt.search(startRe);
    if (start < 0) return '';
    const nextRe = new RegExp(`\\bShot\\s*${shotNumber + 1}\\b`, 'i');
    const rest = prompt.slice(start + 1);
    const next = rest.search(nextRe);
    return next >= 0 ? prompt.slice(start, start + 1 + next) : prompt.slice(start);
  }

  /**
   * Build a concise research summary for the title prompt.
   * Keeps only the most actionable data to stay within token limits.
   */
  buildResearchSummary(researchData) {
    const parts = [];

    if (researchData.patterns) {
      const p = researchData.patterns;

      if (p.recurring_themes?.length) {
        const sanitized = p.recurring_themes.slice(0, 8).map(t => this.sanitizePatternEntry(t));
        parts.push(`PROVEN THEMES (from 100k+ view videos): ${sanitized.join(', ')}`);
      }
      if (p.winning_character_archetypes?.length) {
        const sanitized = p.winning_character_archetypes.slice(0, 6).map(a => this.sanitizePatternEntry(a));
        parts.push(`WINNING CHARACTER ARCHETYPES: ${sanitized.join(', ')}`);
      }
      if (p.title_patterns) {
        if (p.title_patterns.emotional_words?.length) {
          parts.push(`EFFECTIVE TITLE WORDS: ${p.title_patterns.emotional_words.slice(0, 10).join(', ')}`);
        }
        if (p.title_patterns.structures?.length) {
          // Title structures are formulas (e.g., "My [Noun]'s [Adjective] [Noun]") — safe to pass
          parts.push(`TITLE FORMULAS THAT WORK: ${p.title_patterns.structures.slice(0, 5).join(' | ')}`);
        }
      }
      if (p.audience_triggers?.length) {
        const sanitized = p.audience_triggers.slice(0, 6).map(t => this.sanitizePatternEntry(t));
        parts.push(`AUDIENCE TRIGGERS: ${sanitized.join(', ')}`);
      }
      if (p.content_formula) {
        // Content formula is typically a short abstract pattern — sanitize if long
        const sanitized = this.sanitizePatternEntry(p.content_formula);
        parts.push(`CONTENT FORMULA: ${sanitized}`);
      }
      if (p.recommendations?.length) {
        const sanitized = p.recommendations.slice(0, 5).map(r => this.sanitizePatternEntry(r));
        parts.push(`KEY RECOMMENDATIONS:\n${sanitized.map(r => `- ${r}`).join('\n')}`);
      }
    }

    // Show source titles for genre awareness, but explicitly warn not to copy
    if (researchData.sourceVideoTitles?.length) {
      const titleList = researchData.sourceVideoTitles.slice(0, 5).map(t => `"${t}"`).join(', ');
      parts.push(`EXISTING TITLES IN THIS SPACE (DO NOT COPY OR PARAPHRASE — these are shown only so you know what ALREADY EXISTS and can avoid overlap):\n${titleList}`);
    }

    return parts.join('\n\n');
  }

  /**
   * Build research context for script generation.
   * More focused on story structure, character types, and dialogue style.
   */
  buildScriptResearchContext(researchData) {
    const parts = [];

    if (researchData.patterns) {
      const p = researchData.patterns;

      // Only pass abstract genre-level patterns — strip anything that reads
      // like a specific plot summary, character name, or recognisable story beat.

      if (p.recurring_themes?.length) {
        const sanitized = p.recurring_themes.slice(0, 5).map(t => this.sanitizePatternEntry(t));
        parts.push(`Themes that resonate with audiences: ${sanitized.join(', ')}`);
      }
      if (p.winning_character_archetypes?.length) {
        const sanitized = p.winning_character_archetypes.slice(0, 5).map(a => this.sanitizePatternEntry(a));
        parts.push(`Character archetypes viewers respond to: ${sanitized.join(', ')}`);
      }
      if (p.proven_conflict_types?.length) {
        const sanitized = p.proven_conflict_types.slice(0, 5).map(c => this.sanitizePatternEntry(c));
        parts.push(`Conflict types that drive engagement: ${sanitized.join(', ')}`);
      }
      if (p.effective_settings?.length) {
        const sanitized = p.effective_settings.slice(0, 5).map(s => this.sanitizePatternEntry(s));
        parts.push(`Settings that work well: ${sanitized.join(', ')}`);
      }

      // ── NEW: Relationship, emotional arc, power, and visual patterns ──
      if (p.relationship_patterns?.length) {
        const relSummary = p.relationship_patterns.slice(0, 4).map(r => {
          const type = r.type || r;
          const why = r.why_it_works || r.tension_formula || '';
          return why ? `${type} (${this.sanitizePatternEntry(why)})` : type;
        });
        parts.push(`Relationship dynamics that drive engagement: ${relSummary.join('; ')}`);
      }
      if (p.emotional_arc_patterns) {
        const eap = p.emotional_arc_patterns;
        const emotionalParts = [];
        if (eap.dominant_pacing) emotionalParts.push(`pacing: ${eap.dominant_pacing}`);
        if (eap.breathing_room) emotionalParts.push(`breathing room: ${this.sanitizePatternEntry(eap.breathing_room)}`);
        if (eap.emotional_beats_that_hook?.length) {
          emotionalParts.push(`emotional hooks: ${eap.emotional_beats_that_hook.slice(0, 5).join(', ')}`);
        }
        if (emotionalParts.length) parts.push(`Emotional arc patterns: ${emotionalParts.join(' | ')}`);
      }
      if (p.power_shift_patterns) {
        const psp = p.power_shift_patterns;
        const powerParts = [];
        if (psp.common_inversions?.length) {
          powerParts.push(`inversions audiences love: ${psp.common_inversions.slice(0, 4).join(', ')}`);
        }
        if (psp.social_axes?.length) {
          powerParts.push(`axes of power: ${psp.social_axes.slice(0, 4).join(', ')}`);
        }
        if (powerParts.length) parts.push(`Power dynamics: ${powerParts.join(' | ')}`);
      }
      if (p.effective_visual_beats?.length) {
        const beats = p.effective_visual_beats.slice(0, 5).map(b => this.sanitizePatternEntry(b));
        parts.push(`Visual storytelling moments that work: ${beats.join('; ')}`);
      }
      if (p.dialogue_voice_patterns?.length) {
        const voices = p.dialogue_voice_patterns.slice(0, 4).map(v => this.sanitizePatternEntry(v));
        parts.push(`Dialogue voice patterns: ${voices.join('; ')}`);
      }
    }

    // REMOVED: Individual video story structures.
    // Previously this passed through specific plot summaries (setup/conflict/climax)
    // from source videos, which risked leaking recognisable storylines into the
    // generated script. Abstract patterns above are sufficient for genre guidance.

    parts.push('IMPORTANT: Use these patterns as abstract genre inspiration ONLY. Do NOT recreate any specific storyline, character, or scenario.');

    return parts.join('\n');
  }

  /**
   * Sanitize a single pattern entry from Gemini analysis.
   * Strips specific plot details, character names, and story summaries
   * down to abstract category-level descriptions.
   *
   * Examples:
   *   "A young wife discovers her husband's secret family" → "marital betrayal and hidden secrets"
   *   "The village chief's son rebels against tradition" → "generational conflict with tradition"
   *
   * Heuristic: if the entry is longer than 60 chars or contains narrative
   * indicators (articles + verbs suggesting a plot description), truncate to
   * just the first meaningful noun-phrase / category label.
   */
  sanitizePatternEntry(entry) {
    if (!entry || typeof entry !== 'string') return entry;

    // Already short and abstract (e.g., "family loyalty", "scorned wife") — pass through
    if (entry.length <= 60 && !this.looksLikePlotSummary(entry)) {
      return entry;
    }

    // Looks like a plot description — extract just the abstract theme
    // Take everything before the first verb-indicator or truncate at the
    // first clause boundary
    const clauseBreak = entry.match(/^([^,;.—–\-]+)/);
    const shortened = clauseBreak ? clauseBreak[1].trim() : entry.slice(0, 60);

    // If still too long or still narrative, fall back to a generic label
    if (shortened.length > 80 || this.looksLikePlotSummary(shortened)) {
      // Last resort: strip to first 4 significant words
      const words = shortened.split(/\s+/).filter(w => w.length > 2).slice(0, 4);
      return words.join(' ');
    }

    return shortened;
  }

  /**
   * Heuristic check: does this string look like a specific plot summary
   * rather than an abstract category?
   * Looks for narrative indicators: articles + action verbs suggesting a story.
   */
  looksLikePlotSummary(text) {
    // Narrative patterns: "A [person] [verb]s...", "The [person] [verb]s...",
    // "When [person]...", "[Name] discovers/finds/learns..."
    const narrativePatterns = [
      /\b(discovers?|finds?|learns?|realizes?|escapes?|fights?|kills?|marries|divorces|betrays?|steals?|kidnaps?|returns?|reveals?|confesses?|plots?|schemes?)\b/i,
      /^(a|the|an|one|when|after|before)\s+(young|old|rich|poor|beautiful|lonely)?\s*(man|woman|wife|husband|girl|boy|mother|father|son|daughter|chief|king|queen|prince|princess)\b/i,
    ];

    return narrativePatterns.some(p => p.test(text));
  }

  /**
   * Build prompt guidance that pushes Claude away from the small default
   * Nollywood name pool it tends to overuse across projects.
   *
   * The DB helper reads prior scripts and returns names/element hints already
   * used in recent projects. We include those as a soft ban list, then provide
   * broader regional name palettes so the model has somewhere better to go.
   */
  _buildCharacterNameDiversityGuidance() {
    let recentNames = [];
    try {
      if (typeof db.getRecentCharacterNames === 'function') {
        recentNames = db.getRecentCharacterNames(100);
      }
    } catch (e) {
      console.warn(`[SCRIPT] Character-name history unavailable: ${e.message}`);
    }

    const staleDefaults = [
      'ada', 'adaeze', 'adanna', 'adaora',
      'emeka', 'chidi', 'chukwuemeka',
      'ngozi', 'okafor', 'eze',
      'tunde', 'mama ada', 'mama adaeze',
    ];

    const bannedNames = [...new Set([...recentNames, ...staleDefaults])]
      .map(n => String(n || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 120);

    const bannedText = bannedNames.length
      ? `\nRECENT / OVERUSED NAMES TO AVOID IN THIS SCRIPT:\n${bannedNames.map(n => `- ${n}`).join('\n')}`
      : '';

    return `

=== CHARACTER NAME DIVERSITY (ANTI-RECYCLING RULE) ===
Do not fall back to the same small name pool. Avoid recycling Ada, Adaeze, Emeka, Ngozi, Chidi, Okafor, or near variants unless the story absolutely requires them.

${bannedText}

NAME GENERATION REQUIREMENTS:
- Every major character needs a fresh, culturally plausible Nigerian name that has not appeared in the avoid list above.
- Vary ethnic and regional origins when the story supports it: Igbo, Yoruba, Hausa/Fulani, Edo, Delta, Ibibio, Efik, Tiv, Nupe, Ijaw, Idoma, etc.
- Use full human names where useful: first name + surname, title + name, or culturally natural honorifics such as Mama, Papa, Chief, Pastor, Barrister, Alhaji, Alhaja, Madam.
- Do not give unrelated characters the same first name, surname, or element_name_hint stem inside one script.
- Derive element_name_hint from the chosen human name in snake_case. If the human name is "Morenike Balogun", use "morenike_balogun", not a generic tag like "mother" or "character_1".
- If two characters are relatives, shared surname is allowed, but their first names must still be distinct.

UNDERUSED NAME PALETTES TO DRAW FROM (examples, not a fixed list):
- Yoruba: Morenike, Folashade, Yetunde, Ronke, Bimpe, Tinuade, Sewa, Damilola, Bamidele, Segun, Wale, Jide, Akinwale, Rotimi.
- Igbo: Nnenna, Oluchi, Uchechi, Ifunanya, Kamsiyochukwu, Amarachi, Ikenna, Nonso, Obinna, Somto, Tochukwu, Nduka, Arinze.
- Hausa/Fulani: Hauwa, Hadiza, Nafisa, Bilkisu, Zainab, Jamila, Aminu, Kabiru, Yakubu, Bello, Sani, Lawal, Garba.
- Edo/Delta/Ijaw/South-South: Osas, Itohan, Eseosa, Kevwe, Oghenekaro, Tare, Tari, Tamuno, Preye, Fiyin, Ebi, Oritse, Efe.

Freshness matters: character names are part of channel variety, and repeated names make separate films feel like the same recycled script.
`;
  }

  /**
   * Replace words that Kling's TTS consistently mispronounces or mangles.
   * Only operates INSIDE dialogue quotes ([@speaker, ...]: "...") to avoid
   * corrupting shot directions or technical terms.
   *
   * Dictionary is built incrementally from production observations.
   * Each entry: regex pattern → replacement string.
   *
   * @param {string} prompt - The multi_shot_prompt text
   * @param {string} label - Clip label for logging
   * @returns {string} Prompt with difficult words replaced
   */
  static _replaceDifficultWords(prompt, label) {
    // Pattern → replacement. Only applied inside dialogue quotes.
    // Add new entries as TTS failures are observed in production.
    const dictionary = [
      // Known mispronunciations from 150-clip run
      [/\burgently\b/gi, 'with urgency'],
      [/\bEFCC\b/g, 'E.F.C.C.'],        // spell out acronyms for TTS
      [/\bNDLEA\b/g, 'N.D.L.E.A.'],
      [/\bLASIEPA\b/g, 'L.A.S.I.E.P.A.'],
      [/\bNASS\b/g, 'N.A.S.S.'],
      [/\bICPC\b/g, 'I.C.P.C.'],
      [/\bATM\b/g, 'A.T.M.'],
      [/\bSUV\b/g, 'S.U.V.'],
      [/\bPHD\b/gi, 'P.H.D.'],
      [/\bLGA\b/g, 'L.G.A.'],
    ];

    let fixed = prompt;
    // Match dialogue blocks: ]: "..."
    fixed = fixed.replace(/(\]:\s*")([^"]*?)(")/gi, (fullMatch, pre, dialogue, post) => {
      let replaced = dialogue;
      for (const [pattern, replacement] of dictionary) {
        const before = replaced;
        replaced = replaced.replace(pattern, replacement);
        if (replaced !== before) {
          console.log(`[DIFFICULT-WORD] ${label}: "${before.match(pattern)?.[0]}" → "${replacement}" in dialogue`);
        }
      }
      return pre + replaced + post;
    });

    return fixed;
  }
}

module.exports = { ScriptEngine, ScriptValidationError };
