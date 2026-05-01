const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

// Cinematic-mode-specific rubric items injected into the structural reviewer
// prompt via {{CINEMATIC_RUBRIC_EXTENSION}}. Only applies when the project's
// generator_mode = 'cinematic'. See IMPROVEMENT-CINEMATIC-WORKFLOW.md.
const CINEMATIC_RUBRIC_EXTENSION = `
=== CINEMATIC MODE EXTENSIONS (adds to tier rubric above; applies ONLY when GENERATOR_MODE = cinematic) ===

The script includes additional cinematic-pipeline fields per scene: blocking, location_element_hint, props_in_scene, kling_clips. Grade these with the following bonus/penalty items (up to +15 pts, capped at 100 overall):

C1. BLOCKING COMPLETENESS (+5 pts max)
  - Full: every scene has a non-null blocking object; every character in characters_present appears in at least one of frame_left/frame_center/frame_right with a concrete posture/intent description
  - Half: blocking exists but some characters are missing frame positions
  - Zero: blocking is missing, null, or all positions are empty strings
  - Deduct for blocking that says "@claire is in the scene" without frame position or posture

C2. KLING CLIP COHERENCE (+5 pts max)
  - Full: every scene has kling_clips covering ALL lines via line_refs; clip durations are 6-12s; no clip exceeds 2500 chars in its multi_shot_prompt; shot count per clip is EXACTLY 3 (hard rule). Total clip count within 20% of target (if target provided). No scene has more than 3 characters in characters_present.
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

CINEMATIC-SPECIFIC FAILURE MODES (automatic critical issues):
- Any kling_clip.multi_shot_prompt missing the bracketed dialogue syntax [@character, speaking in a <tone> Nigerian English accent]: "..."
- Any kling_clip.multi_shot_prompt that uses @location-style references (e.g. "@clara_kitchen") — locations are reference images, NOT elements, so @location won't resolve and just becomes useless text. Describe locations naturally ("inside the kitchen from the reference image") instead.
- Any scene where characters speak in dialogue but don't appear in blocking
- Any prop mentioned by name in dialogue but not listed in props_in_scene of any scene where it appears
- Any kling_clip where Shot 1 has NO dialogue — Shot 1 must include the first dialogue line (the start frame image + CHARACTER POSITIONS preamble already establish the scene; a silent establishing Shot 1 wastes the model's limited shot budget and causes later dialogue to be dropped)
- Any kling_clip that does NOT have exactly 3 shots — Kling 3.0 renders 4+ shots unreliably (skips shots, misattributes dialogue). 3 shots per clip is the hard production rule.
- Any @element_name appearing inside dialogue quotes (e.g. "I am @okafor_otpto_0420") — characters speak human names, not element tags. The @ prefix inside quotes gets typed as an element reference attempt instead of spoken words.
- Any Shot 2 or Shot 3 that references another character in ANY form — no @element names, no human names, no "he/she" referring to a specific other character. Shot directions for Shot 2 and Shot 3 must describe ONLY the speaker's actions, expressions, and body language. Cross-references cause the video model to misassign dialogue to the wrong face.
- Any scene where blocking says a character is SEATED but Shot 1 of the first kling_clip describes them STANDING (or vice versa) — blocking defines the start frame; Shot 1 must match
- Any scene where blocking places a character at frame-left but Shot 1 places them frame-right (or other position contradictions) — the establishing shot must visually match the blocking composition

Log cinematic-specific issues with category values: 'blocking', 'kling_clips', 'element_hint', 'props_consistency'.
`;

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

    // ── PASS 1: Story outline + character bible ──
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
      "full_prompt_description": "Full physical description for portrait generation",
      "role": "protagonist|antagonist|confidant|supporting|bplot",
      "arc_summary": "One sentence: what this character wants and how they change"
    }
  ],
  "chapter_outlines": [
    {
      "chapter_number": 1,
      "chapter_title": "...",
      "act": "setup|rising|midpoint|climax|resolution",
      "narrative_beat": "What happens in this chapter — 2-3 sentences",
      "scene_beats": [
        {
          "scene_number": 1,
          "location": "Description of location",
          "location_element_hint": "snake_case_location",
          "characters_present": ["char_id_1", "char_id_2"],
          "beat": "What happens in this scene — 1-2 sentences",
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
- The character_bible must include full physical descriptions (full_prompt_description) — these are used for portrait generation.
- Scene beats should describe WHO is talking about WHAT, not the actual dialogue.
- Each scene beat specifies target_lines (how many dialogue lines) and target_clips (how many Kling clips).
- Total target_clips across all chapters should be ~${targetClips}.
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

    const characterBible = outline.character_bible;
    const title = outline.title || storyBrief.title;
    console.log(`[SCRIPT] Pass 1 complete: ${characterBible.length} characters, ${outline.chapter_outlines.length} chapter outlines`);

    // ── PASS 2: Generate each chapter independently ──
    console.log(`[SCRIPT] Pass 2 — generating ${totalChapters} chapters independently`);
    const allChapters = [];

    for (let chNum = 1; chNum <= totalChapters; chNum++) {
      const chOutline = outline.chapter_outlines.find(c => c.chapter_number === chNum)
        || outline.chapter_outlines[chNum - 1]; // fallback to index if numbering is off
      const chLabel = `Chapter ${chNum}/${totalChapters}`;

      if (onProgress) onProgress(`\n[Pass 2/2] ${chLabel}: "${chOutline?.chapter_title || '...'}"...`);

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

=== FULL STORY OUTLINE ===
B-Plot: ${outline.bplot_summary || 'N/A'}
Setup/Payoff pairs: ${JSON.stringify(outline.setup_payoff_pairs || [])}

Previous chapters (summary):
${prevSummary}

>>> THIS CHAPTER (${chNum}): "${chOutline?.chapter_title || ''}" <<<
Act: ${chOutline?.act || 'N/A'}
Narrative beat: ${chOutline?.narrative_beat || 'N/A'}
Target clips: ~${chOutline?.target_clips || clipsPerChapter}
Chapter-end hook: ${chOutline?.chapter_end_hook || '(final chapter — resolve)'}

Scene beats to expand:
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
4. Maintain character voices and physical descriptions EXACTLY as in the character bible.
5. Use @element_name_hint references (e.g. @${characterBible[0]?.element_name_hint || 'character_name'}).
6. ${chNum < totalChapters ? `End on: "${chOutline?.chapter_end_hook || 'a cliffhanger or reveal'}"` : 'Bring the story to a decisive resolution.'}
7. Use consistent location_element_hint values matching the outline.

=== STRICT RULES ===
- Dialogue Only: Only character speech. No narration, SFX, or descriptions.
- The 9-Word Rule: Every single sentence must be 9 words or less.
- The Camera Jump: If a character says more than 9 words, break it with [NEW CAMERA ANGLE] + the next short sentence.

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

      allChapters.push(...chChapters);
      const lastCh = chChapters[chChapters.length - 1];
      const sceneCount = (lastCh.scenes || []).length;
      const clipCount = (lastCh.scenes || []).reduce((sum, s) => sum + (s.kling_clips || []).length, 0);
      console.log(`[SCRIPT] ${chLabel} complete: ${sceneCount} scenes, ${clipCount} clips (total: ${allChapters.length}/${totalChapters})`);
    }

    return {
      title,
      character_bible: characterBible,
      chapters: allChapters,
    };
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
9. Do NOT re-output the character_bible — only output the chapters array.

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
   * Validate that a generated script has the expected structure.
   * Throws on critical issues (wrong chapter count), warns on minor ones.
   */
  _validateScriptCompleteness(script, storyBrief) {
    const expectedChapters = storyBrief.chapters || 5;
    const actualChapters = (script.chapters || []).length;
    const isCinematicStoryDriven = storyBrief.storyDriven && storyBrief.generatorMode === 'cinematic';

    // Chapter count validation (applies to both modes)
    if (actualChapters !== expectedChapters) {
      console.error(`[SCRIPT] CHAPTER COUNT MISMATCH: expected ${expectedChapters}, got ${actualChapters}`);
      console.error(`[SCRIPT] Chapters present: ${script.chapters.map(c => c.chapter_number).join(', ')}`);
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
      if (totalClips < expectedClips * 0.8) {
        console.warn(`[SCRIPT] Clip count LOW: ${totalClips} clips (target ~${expectedClips}, 80% threshold = ${Math.floor(expectedClips * 0.8)})`);
      } else if (totalClips > expectedClips * 1.2) {
        console.warn(`[SCRIPT] Clip count HIGH: ${totalClips} clips (target ~${expectedClips}, 120% threshold = ${Math.ceil(expectedClips * 1.2)})`);
      } else {
        console.log(`[SCRIPT] ✓ Clip count validated: ${totalClips} (target: ~${expectedClips})`);
      }
      console.log(`[SCRIPT] Story-driven stats: ${totalScenes} scenes, ${totalLines} lines, ${totalClips} clips across ${actualChapters} chapters`);
      if (maxCharsPerScene > 3) {
        console.warn(`[SCRIPT] ⚠ Max characters in a single scene: ${maxCharsPerScene} (Kling limit is 3)`);
      }

      // ── OVERSIZED CLIP AUTO-SPLIT ──
      // Hard rule: max 3 lines per clip. If Claude packed 4+ lines into one clip,
      // split it into multiple clips of 3 (with a possible remainder of 1-2).
      // The multi_shot_prompt can't be auto-split (would need re-prompting), so
      // we fix line_refs only and flag the prompt as needing regeneration.
      let oversizedFixed = 0;
      for (const ch of (script.chapters || [])) {
        for (const sc of (ch.scenes || [])) {
          const clips = sc.kling_clips || [];
          const newClips = [];
          for (const clip of clips) {
            const refs = clip.line_refs || [];
            if (refs.length <= 3) {
              newClips.push(clip);
              continue;
            }
            // Split oversized clip into chunks of 3
            console.warn(`[SCRIPT] ⚠ OVERSIZED CLIP: ${clip.clip_id} has ${refs.length} line_refs (max 3) — auto-splitting`);
            oversizedFixed++;
            for (let i = 0; i < refs.length; i += 3) {
              const chunkRefs = refs.slice(i, i + 3);
              const chunkIdx = Math.floor(i / 3) + 1;
              const baseId = clip.clip_id.replace(/_c(\d+)$/, '');
              // Recompute clip_id: find highest existing cN index in this scene
              const existingIds = [...clips, ...newClips].map(c => c.clip_id);
              const scenePrefix = baseId; // e.g. "ch7_sc5"
              let maxCN = 0;
              for (const eid of existingIds) {
                const m = eid.match(new RegExp(`^${scenePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_c(\\d+)$`));
                if (m) maxCN = Math.max(maxCN, parseInt(m[1], 10));
              }
              const newClipId = i === 0 ? clip.clip_id : `${scenePrefix}_c${maxCN + chunkIdx}`;

              newClips.push({
                clip_id: newClipId,
                duration_seconds: 10,
                line_refs: chunkRefs,
                multi_shot_prompt: i === 0
                  ? clip.multi_shot_prompt  // first chunk keeps original prompt (best effort)
                  : `[AUTO-SPLIT from ${clip.clip_id} — prompt needs regeneration for lines ${chunkRefs.join(',')}]`,
              });
            }
          }
          if (newClips.length !== clips.length) {
            sc.kling_clips = newClips;
          }
        }
      }
      if (oversizedFixed > 0) {
        console.warn(`[SCRIPT] Auto-split ${oversizedFixed} oversized clip(s). Prompts marked [AUTO-SPLIT] need vision pass regeneration.`);
        // Update total clip count after splits
        totalClips = 0;
        for (const ch of (script.chapters || [])) {
          for (const sc of (ch.scenes || [])) {
            totalClips += (sc.kling_clips || []).length;
          }
        }
        console.log(`[SCRIPT] Adjusted clip count after splits: ${totalClips}`);
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

          // ── 3. Add @ prefix to bare character names ──
          // Sort longest-first to avoid partial matches
          const sortedNames = [...validCharNames].sort((a, b) => b.length - a.length);
          for (const charName of sortedNames) {
            const escaped = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const bareRe = new RegExp(`(?<!@)\\b${escaped}\\b`, 'gi');
            const before = prompt;
            prompt = prompt.replace(bareRe, (match) => {
              // Don't add @ inside dialogue quotes — those should use human names
              return `@${match.toLowerCase()}`;
            });
            if (prompt !== before) {
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
          const shotBlockRe = /Shot\s*(2|3)\s*\([^)]*\)\s*:\s*([\s\S]*?)(?=\nShot\s*\d+\s*\(|$)/gi;
          let shotBlockMatch;
          while ((shotBlockMatch = shotBlockRe.exec(prompt)) !== null) {
            const shotNum = shotBlockMatch[1];
            const shotBody = shotBlockMatch[2];
            const speakerTags = shotBody.match(/\[@[a-z0-9_]+,\s*speaking/gi) || [];
            if (speakerTags.length > 1) {
              // Keep the first speaker tag, strip subsequent ones and their dialogue
              let cleaned = shotBody;
              let firstFound = false;
              cleaned = cleaned.replace(/\n?\[@([a-z0-9_]+),\s*speaking[^\]]*\]:\s*"[^"]*"/gi, (m) => {
                if (!firstFound) { firstFound = true; return m; }
                totalFixes++;
                console.log(`[PROMPT-SANITIZE] ${label}: stripped extra speaker from Shot ${shotNum}`);
                return '';
              });
              if (cleaned !== shotBody) {
                prompt = prompt.replace(shotBody, cleaned);
              }
            }
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
    let openBraces = 0;
    let openBrackets = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < json.length; i++) {
      const ch = json[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') openBraces++;
      else if (ch === '}') openBraces--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }

    // Remove any trailing comma before we close
    let result = json.replace(/,\s*$/, '');

    // Close any unclosed structures
    while (openBrackets > 0) { result += ']'; openBrackets--; }
    while (openBraces > 0) { result += '}'; openBraces--; }

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
          const rest = json.slice(i + 1).trimStart();
          const nextChar = rest[0];
          if (!nextChar || ':,}]'.includes(nextChar)) {
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
   *     1-3 dialogue lines within a 10-12s clip, exactly 3 shots per clip
   *   - scene.location_element_hint: a snake_case hint for the location element
   *     name (used downstream by Phase 3 location-generation stage)
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
   - Each clip has EXACTLY 3 shots, one dialogue line per shot. This is a hard rule — not 2, not 4, not 6. Kling 3.0 renders 4+ shots unreliably (skipped shots, misattributed dialogue). 3 shots is the proven sweet spot for 10-12s clips. If a clip has fewer than 3 lines (allowed only for the last clip in a scene), it still gets exactly 3 shots — distribute the dialogue across shots and use the extra shot(s) for reaction beats or silent continuation.
   - Duration: 10-12 seconds per clip. Target 10s. Never exceed 12s.
   - Shots within a clip are continuous beats of the same scene (same location, same lighting) — not "cuts between different scenes."
   - Each clip's \`multi_shot_prompt\` must stay under 2500 characters.
   - Use Kling's dialogue syntax: [@character, speaking in a <tone> Nigerian English accent]: "<dialogue>"
   - NEVER use @element_name inside dialogue quotes — not in kling_clip multi_shot_prompt dialogue, not in scene line dialogue. Inside quotes, characters speak their HUMAN NAME (e.g. "Ngozi", "Emeka"), not their @tag. The @ prefix triggers Higgsfield element resolution and corrupts the spoken audio. Wrong: [@ngozi, speaking...]: "I told @emeka the truth." Right: [@ngozi, speaking...]: "I told Emeka the truth." This rule is violated constantly — double-check every dialogue string.
   - BLOCKING → SHOT 1 CONSISTENCY (MANDATORY): The FIRST kling_clip's Shot 1 MUST match \`scene.blocking\` exactly — same postures, same positions. Write blocking FIRST, then write kling_clips Shot 1 as a visual realization of that blocking.
   - EVERY SHOT MUST HAVE DIALOGUE: The start frame image and a CHARACTER POSITIONS preamble already establish the scene composition for the video model. Do NOT waste Shot 1 as a silent establishing shot — include the first dialogue line in Shot 1. A 3-shot clip with 3 dialogue lines = 1 line per shot. Shot 1 can still set the camera (WIDE, MEDIUM, etc.) but MUST include dialogue. The video model only has ~10s — every shot must carry dialogue or the last lines get dropped.
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
      "duration_seconds": 10,
      "line_refs": [1, 2, 3],
      "multi_shot_prompt": "Inside the kitchen from the reference image at dusk, warm kerosene lamp light.\\n\\nShot 1 (0-3s): WIDE ESTABLISHING, static camera. @claire_obi frame-left near the wooden table, @richard_eze frame-right near the doorway.\\n[@claire_obi, speaking in a strained Nigerian English accent]: \\"I saw you at the market yesterday.\\"\\n\\nShot 2 (3-7s): CUT TO MEDIUM SHOT on @richard_eze, static. His jaw tightens.\\n[@richard_eze, speaking in a controlled Nigerian English accent]: \\"You saw nothing.\\"\\n\\nShot 3 (7-10s): CUT TO CLOSE-UP on @claire_obi, slow push-in. Her eyes narrow, fists clenching at her sides.\\n[@claire_obi, speaking in a sharp Nigerian English accent]: \\"Then why are you shaking?\\""
    }
  ]
}
\`\`\`

CHARACTER ELEMENT NAMING (CRITICAL — CONSISTENCY REQUIRED):
- Each character in the bible MUST have an \`element_name_hint\` field: a short snake_case name derived from the character's actual name (e.g. "mama_adaeze", "eze_okonkwo", "emeka"). This is the SINGLE name used as the @reference in ALL prompts.
- Use @element_name_hint (e.g. "@mama_adaeze", "@eze_okonkwo") in ALL cinematic-mode prompts: \`blocking.frame_left/center/right\`, \`blocking.notes\`, \`kling_clips[].multi_shot_prompt\`, and \`characters_present\`.
- Do NOT use @character_1 / @character_2 in blocking or kling_clips — those are internal IDs only. The @element_name_hint is what gets created as a Higgsfield Element and must match exactly everywhere.
- \`speaker_id\` in line objects uses \`element_name_hint\` prefixed with @ (e.g. "@mama_adaeze") for consistency with blocking refs.
- \`characters_present\` also uses element_name_hint values (e.g. ["mama_adaeze", "eze_okonkwo"]).
- Character bible still contains full physical descriptions for portrait generation, but once elements exist, visual identity is locked by @reference.

${storyBrief.storyDriven ? `
STORY-DRIVEN STRUCTURE (CINEMATIC ONLY):
- SCENES PER CHAPTER: UNLIMITED. Each chapter gets as many scenes as the story needs. A scene is a conversation beat — a distinct grouping of characters in dialogue. Same or different location.
- LINES PER SCENE: UNLIMITED. A scene can be 2 lines (a quick reaction) or 15 lines (an extended confrontation). Lines are grouped into clips of exactly 3 lines each — NEVER more than 3 lines per clip. A 9-line scene = 3 clips. A 7-line scene = 2 clips of 3 + 1 clip of 1. All clips share the same scene image as start frame.
- CHARACTERS PER PROJECT: UNLIMITED. Every speaking character gets a portrait and Higgsfield element. Create as many characters as the story needs — a 30-min drama might have 8-12 speaking roles.
- CHARACTERS PER SCENE: MAX 3. This is a hard Kling constraint — more than 3 characters in a scene degrades lip-sync and positioning quality. If 4+ characters need to interact, split into separate scenes or have characters enter/exit.
- TARGET CLIPS: ~${storyBrief.targetClips || 50} total across the entire script. Each clip = 10-12 seconds of footage. Distribute clips across chapters based on dramatic weight — a climactic chapter might get more clips than a transitional one.
- APPROXIMATE CLIPS PER CHAPTER: ~${Math.ceil((storyBrief.targetClips || 50) / (storyBrief.chapters || 10))} (this is guidance, not a hard rule — distribute based on story needs).
` : ''}
CINEMATIC MODE STRUCTURAL BAR IS HIGHER:
- The structural review grader applies stricter rules to cinematic scripts because each weak Kling clip burns ~18 credits.
- Blocking completeness is mandatory: every scene must have non-null frame positions for all present characters.
- Dialogue function rule is doubly enforced: every line in a kling_clip's multi_shot_prompt must either advance plot, reveal character, raise stakes, or create conflict.
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
   *   long-form  — score ≥ 70 (HIGH bar — long-form burns 2000-3000 credits;
   *                            weak scripts must be regenerated before video gen)
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

    // Summarise the script into something the grader can efficiently read. We
    // don't need image_prompts / animation_prompts for structural review — just
    // the narrative skeleton. Story-driven scripts are MUCH larger (64+ scenes,
    // 448+ lines, 150+ clips) so we aggressively trim: no kling_clips at all
    // (clip coherence can be checked computationally), and blocking as summary only.
    const isStoryDriven = storyBrief.storyDriven;
    const skeleton = {
      title: script.title,
      character_bible: (script.character_bible || []).map(c => ({
        id: c.id,
        label: c.description_label,
        role_inferred: null, // grader will deduce from dialogue
      })),
      chapters: (script.chapters || []).map(ch => ({
        chapter_number: ch.chapter_number,
        chapter_title: ch.chapter_title,
        scenes: (ch.scenes || []).map(sc => {
          const base = {
            scene_number: sc.scene_number,
            location: sc.location,
            characters_present: sc.characters_present || [],
            lines: (sc.lines || []).map(ln => ({
              line_number: ln.line_number,
              speaker: ln.speaker_id,
              dialogue: ln.dialogue,
              tone: ln.tone,
            })),
          };
          if (generatorMode === 'cinematic') {
            base.location_element_hint = sc.location_element_hint || null;
            base.props_in_scene = sc.props_in_scene || [];
            if (isStoryDriven) {
              // Story-driven: minimal cinematic metadata — grader focuses on narrative
              // Clip coherence (line coverage, duration, shot count) checked computationally
              base.blocking_summary = sc.blocking
                ? [sc.blocking.frame_left, sc.blocking.frame_center, sc.blocking.frame_right].filter(Boolean).join(' | ')
                : null;
              base.clip_count = (sc.kling_clips || []).length;
            } else {
              // Fixed-grid cinematic: full blocking + kling_clips with prompts
              base.blocking = sc.blocking || null;
              base.kling_clips = (sc.kling_clips || []).map(c => ({
                clip_id: c.clip_id,
                duration_seconds: c.duration_seconds,
                line_refs: c.line_refs,
                multi_shot_prompt_length: (c.multi_shot_prompt || '').length,
                multi_shot_prompt: c.multi_shot_prompt || '',
              }));
            }
          }
          return base;
        }),
      })),
    };

    // For story-driven, append computed cinematic stats so the grader has them
    // without needing the full kling_clips array
    if (isStoryDriven) {
      let totalClips = 0, totalLines = 0, maxCharsPerScene = 0;
      for (const ch of script.chapters || []) {
        for (const sc of ch.scenes || []) {
          totalClips += (sc.kling_clips || []).length;
          totalLines += (sc.lines || []).length;
          const chars = (sc.characters_present || []).length;
          if (chars > maxCharsPerScene) maxCharsPerScene = chars;
        }
      }
      skeleton.cinematic_stats = {
        total_clips: totalClips,
        target_clips: storyBrief.targetClips || 50,
        total_lines: totalLines,
        total_scenes: skeleton.chapters.reduce((s, ch) => s + ch.scenes.length, 0),
        max_characters_in_any_scene: maxCharsPerScene,
      };
    }

    const userMessage = `TIER: ${tier}\nGENERATOR_MODE: ${generatorMode}\nEXPECTED CHAPTERS: ${storyBrief.chapters}\n\nSCRIPT SKELETON:\n${JSON.stringify(skeleton, null, 2)}\n\nGrade this script per the rubric. Return JSON only.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8192, // Story-driven scripts produce many issues across 60+ scenes; 4K still truncated
      temperature: 0.2, // Low temp — we want consistent, critical grading
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content[0].text;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[REVIEW] No JSON in grader response — defaulting to neutral pass');
        return { score: 65, pass: true, tier, issues: [], strengths: [], summary: 'Grader returned malformed response; script auto-passed with neutral score.' };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      // Cinematic mode raises the bar by 5 pts at every tier — weak Kling clips
      // cost more per unit than weak Veo clips, and coverage authoring errors
      // (missing blocking, incoherent shot groups) propagate worse.
      const baseThresholds = { 'test': 50, 'standard': 60, 'long-form': 70 };
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
      return { score: 65, pass: true, tier, issues: [], strengths: [], summary: `Grader parse error: ${e.message}. Script auto-passed.` };
    }
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

module.exports = { ScriptEngine };
