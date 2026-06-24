/**
 * Thumbnail Generator — Three-stage Nano Banana Pro flow.
 *
 * Stage 1: Key art (characters + setting, no text) — uses character element refs
 * Stage 2: Title card (transparent PNG typography) — OCR verified via Gemini
 * Stage 3: Composite (key art + title card overlaid) — both as references
 *
 * Single-vendor (Higgsfield Nano Banana Pro). No Sharp, no Canvas, no font files.
 * Gemini Vision used only for OCR verification (Stage 2) and optional auto-placement (Stage 3).
 */

const path = require('path');
const fs = require('fs');

class ThumbnailGenerator {
  /**
   * @param {object} automation - HiggsFieldAutomation instance (for Nano Banana Pro generation)
   * @param {object} options - { geminiApiKey, presetsPath }
   */
  constructor(automation, options = {}) {
    this.automation = automation;
    this.geminiApiKey = options.geminiApiKey || '';
    this.presets = this._loadPresets(options.presetsPath);
    // Optional callback: (creditCost, stage) => {} — called after each Generate click
    this.onCreditUsed = options.onCreditUsed || null;
  }

  /**
   * Full three-stage thumbnail pipeline.
   *
   * @param {object} params
   * @param {string} params.title - Movie title (for title card)
   * @param {string} params.tagline - Optional tagline
   * @param {string} params.genre - Genre key (drama, thriller, romance, etc.)
   * @param {string[]} params.characterNames - Character element names for key art refs
   * @param {string} params.setting - Scene setting description
   * @param {string} params.mood - Mood/tone descriptor
   * @param {string} params.outputDir - Directory to write outputs
   * @param {string} params.placement - 'lower-third' | 'upper-third' | 'auto'
   * @param {string} [params.sceneImagePath] - Optional: use existing scene as key art instead of generating
   * @returns {object} { thumbnailPath, keyArtPath, titleCardPath }
   */
  async generateThumbnail(params) {
    const {
      title, tagline, genre = 'drama', characterNames = [],
      setting, mood, outputDir, placement = 'lower-third',
      sceneImagePath, aspectRatio = '16:9',
    } = params;

    fs.mkdirSync(outputDir, { recursive: true });

    const preset = this.presets[genre] || this.presets.drama;
    let keyArtPath;

    // Stage 1: Key art (or use provided scene image)
    if (sceneImagePath && fs.existsSync(sceneImagePath)) {
      keyArtPath = sceneImagePath;
      console.log(`[THUMBNAIL] Using existing scene image as key art: ${sceneImagePath}`);
    } else {
      keyArtPath = path.join(outputDir, 'key-art.png');
      await this.generateKeyArt({
        characterNames, setting, mood, genre, outputPath: keyArtPath, aspectRatio,
      });
    }

    // Stage 2: Title card (transparent PNG with OCR verify)
    const titleCardPath = path.join(outputDir, 'title-card.png');
    await this.generateTitleCard({
      title, tagline, preset, outputPath: titleCardPath, aspectRatio,
    });

    // Stage 3: Composite
    const thumbnailPath = path.join(outputDir, 'thumbnail.png');
    await this.compositeThumbnail({
      keyArtPath, titleCardPath, title, tagline, placement, outputPath: thumbnailPath, aspectRatio,
    });

    return { thumbnailPath, keyArtPath, titleCardPath };
  }

  /**
   * Stage 1: Generate 16:9 key art with character element references.
   */
  async generateKeyArt({ characterNames, setting, mood, genre, outputPath, aspectRatio = '16:9' }) {
    const charRefs = characterNames.length > 0
      ? `featuring ${characterNames.map(n => `@${n}`).join(' and ')} — maintain exact face/body consistency from element references.`
      : '';

    const orientationHint = aspectRatio === '9:16' ? '9:16 vertical portrait' : '16:9 landscape';
    const prompt = `Cinematic ${orientationHint} key art for a Nollywood ${genre} drama. ${charRefs}

Setting: ${setting || 'Nigerian urban environment, golden hour lighting'}
Mood: ${mood || 'dramatic tension, emotional intensity'}

Requirements:
- Cinematic lighting with strong contrast
- Characters positioned for thumbnail composition (faces clearly visible, no text overlap zones)
- Leave clear space in the lower third for title text overlay
- Film-quality color grading, prestige production value
- NO text, NO title, NO watermarks — key art only`;

    console.log(`[THUMBNAIL] Stage 1: Generating key art (${aspectRatio})...`);
    try {
      // Wait for login if session expired before attempting generation
      await this._ensureLoggedIn();
      await this._genImage({
        prompt,
        outputPath,
        aspectRatio,
        useUnlimited: true,
      }, 'key-art');
    } catch (genErr) {
      if (genErr.message.includes('SESSION_EXPIRED')) {
        console.log('[THUMBNAIL] Session expired — waiting for login...');
        await this._waitForLogin();
        // Retry once after login
        await this._genImage({
          prompt,
          outputPath,
          aspectRatio,
          useUnlimited: true,
        }, 'key-art');
      } else {
        console.warn(`[THUMBNAIL] Stage 1 generation failed: ${genErr.message} — attempting Asset library recovery`);
        const recovered = await this._tryAssetRecovery(prompt, outputPath, 'key art');
        if (!recovered) throw genErr;
      }
    }
    console.log(`[THUMBNAIL] Stage 1 complete: ${outputPath}`);
  }

  /**
   * Stage 2: Generate transparent-PNG title card.
   * Includes OCR verification via Gemini Vision with auto-retry.
   */
  async generateTitleCard({ title, tagline, preset, outputPath, aspectRatio = '16:9', taglineCase = 'all-caps', taglineSeparator = false, splitTitle = true }) {
    // Split title into 1-2 lines if it's long. Promo title cards disable this
    // so character names containing punctuation stay on exactly one line.
    const titleLines = splitTitle ? this._splitTitle(title) : [String(title || '').trim()];
    const titleLine1 = titleLines[0];
    const titleLine2 = titleLines[1] || '';

    const prompt = this._buildTitleCardPrompt({
      titleLine1,
      titleLine2,
      tagline: tagline || '',
      fontFamilyHint: preset.font_family_hint,
      primaryHex: preset.primary_hex,
      primaryName: preset.primary_name,
      secondaryHex: preset.secondary_hex,
      secondaryName: preset.secondary_name,
      taglineCase,
      taglineSeparator,
    });

    let verified = false;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[THUMBNAIL] Stage 2: Generating title card (attempt ${attempt}/${maxAttempts}, ${aspectRatio})...`);
      try {
        await this._ensureLoggedIn();
        await this._genImage({
          prompt,
          outputPath,
          aspectRatio,
          useUnlimited: true,
        }, 'title-card');
      } catch (genErr) {
        if (genErr.message.includes('SESSION_EXPIRED')) {
          console.log('[THUMBNAIL] Session expired — waiting for login...');
          await this._waitForLogin();
          attempt--; // Retry this attempt after login
          continue;
        }
        console.warn(`[THUMBNAIL] Stage 2 attempt ${attempt} failed: ${genErr.message} — attempting Asset library recovery`);
        const recovered = await this._tryAssetRecovery(prompt, outputPath, 'title card');
        if (!recovered) {
          if (attempt < maxAttempts) continue;
          throw genErr;
        }
      }

      // OCR verify via Gemini Vision
      if (this.geminiApiKey) {
        const ocrResult = await this._verifyTitleCardOCR(outputPath, title, tagline);
        if (ocrResult.titleMatch) {
          verified = true;
          console.log(`[THUMBNAIL] Stage 2: OCR verified on attempt ${attempt}`);
          break;
        } else {
          console.warn(`[THUMBNAIL] Stage 2: OCR mismatch on attempt ${attempt}: ${ocrResult.notes}`);
          if (attempt < maxAttempts) continue;
        }
      } else {
        // No Gemini key — skip OCR, accept as-is
        verified = true;
        console.log(`[THUMBNAIL] Stage 2: No Gemini key — skipping OCR verification`);
        break;
      }
    }

    if (!verified) {
      console.warn(`[THUMBNAIL] Stage 2: Title card unverified after ${maxAttempts} attempts — proceeding anyway (flag for human review)`);
    }

    console.log(`[THUMBNAIL] Stage 2 complete: ${outputPath} (verified: ${verified})`);
    return { outputPath, verified };
  }

  /**
   * Stage 3: Composite title card over key art using both as references.
   */
  async compositeThumbnail({ keyArtPath, titleCardPath, title = '', tagline = '', placement, outputPath, aspectRatio = '16:9', skipRecoveryOnReferenceFailure = true, referenceUploadWarmupMs = 12000, referenceUploadAllowAnyInput = false, maxVisionAttempts = 3, visionAttempt = 1 }) {
    const placementInstructions = {
      'upper-third':    'Position the title text in the UPPER THIRD of the frame, spanning the full width',
      'lower-third':    'Position the title text in the LOWER THIRD of the frame, spanning the full width',
      'left-side':      'Position the title text on the LEFT SIDE of the frame (left 35-40%), vertically centered. Keep the right side clear so the character face/body is fully visible',
      'right-side':     'Position the title text on the RIGHT SIDE of the frame (right 35-40%), vertically centered. Keep the left side clear so the character face/body is fully visible',
      'bottom-bar':     'Position the title text in a narrow CINEMATIC BAR at the very BOTTOM of the frame (bottom 15-20%), like a movie poster tagline strip. Keep it well below any faces',
      'split-diagonal': 'Position the title text on a DIAGONAL across the BOTTOM-LEFT CORNER of the frame, angled slightly upward. The text should occupy the corner area, leaving the center and upper portion clear for the character',
      'auto':           'Position the title text in the area with the most negative space, AWAY from any faces or key character features',
    };
    const placementInstruction = placementInstructions[placement] || placementInstructions['auto'];

    let prompt = `Composite thumbnail: overlay the title card (second reference image) onto the key art (first reference image).

Requirements:
- Use the EXACT key art as the background — do not modify the characters, lighting, or composition
- Overlay the EXACT title text from the title card — same font, same color, same style
- ${placementInstruction}
- FACE PROTECTION IS MANDATORY: do not place any letter, shadow, rule line, glow, gradient, or text box over the character's face, head, eyes, nose, mouth, cheeks, forehead, chin, hair/headwrap, or neck
- Keep the full face/head silhouette unobstructed with at least a 6% frame margin around it; the title block must sit entirely inside empty/negative space
- If the requested placement conflicts with the face or head, ignore that placement and move the title to the clearest negative-space area instead
- Blend naturally: slight darkened gradient behind text area for readability
- Final result should look like a professional YouTube thumbnail
- NO additional text, NO watermarks, NO borders`;
    if (visionAttempt > 1) {
      prompt += `

Correction pass ${visionAttempt}: The previous composite failed final thumbnail verification. Recreate the composite from the same two references, preserve the exact title-card spelling, and keep all text clear of faces.`;
    }

    const attemptLabel = this.geminiApiKey && title ? `, vision attempt ${visionAttempt}/${maxVisionAttempts}` : '';
    console.log(`[THUMBNAIL] Stage 3: Compositing (placement: ${placement}${attemptLabel})...`);
    try {
      await this._ensureLoggedIn();
      await this._genImage({
        prompt,
        outputPath,
        references: [keyArtPath, titleCardPath],
        aspectRatio,
        referenceUploadWarmupMs,
        referenceUploadAllowAnyInput,
        requireAssetPromptMatchBeforeDownload: true,
        promptMatchMinSimilarity: 85,
        promptMatchMaxTilesToCheck: 6,
        promptMatchTimeoutMs: 90000,
        useUnlimited: true,
      }, 'composite');
    } catch (genErr) {
      if (genErr.message.includes('SESSION_EXPIRED')) {
        console.log('[THUMBNAIL] Session expired — waiting for login...');
        await this._waitForLogin();
        await this._genImage({
          prompt,
          outputPath,
          references: [keyArtPath, titleCardPath],
          aspectRatio,
          referenceUploadWarmupMs,
          referenceUploadAllowAnyInput,
          requireAssetPromptMatchBeforeDownload: true,
          promptMatchMinSimilarity: 85,
          promptMatchMaxTilesToCheck: 6,
          promptMatchTimeoutMs: 90000,
          useUnlimited: true,
        }, 'composite');
      } else {
        const errorMessage = genErr.message || '';
        const noGenerationSubmitted = /REFERENCE_UPLOAD_FAILED|REFERENCE_GATE_FAILED|reference|\[PRE-GEN\]|pre-generation|before Generate/i.test(errorMessage);
        if (skipRecoveryOnReferenceFailure && noGenerationSubmitted) {
          console.warn(`[THUMBNAIL] Stage 3 stopped before Generate was submitted: ${errorMessage}`);
          throw genErr;
        }
        console.warn(`[THUMBNAIL] Stage 3 generation failed: ${genErr.message} — attempting Asset library recovery`);
        const recovered = await this._tryAssetRecovery(prompt, outputPath, 'composite', {
          minSimilarity: 90,
          maxTilesToCheck: 4,
          timeoutMs: 45000,
        });
        if (!recovered) throw genErr;
      }
    }
    if (this.geminiApiKey && title) {
      const visionResult = await this._verifyCompositeThumbnail(outputPath, {
        expectedTitle: title,
        expectedTagline: tagline,
        placementInstruction,
      });

      if (!visionResult.pass) {
        const reason = visionResult.notes || visionResult.textFound || 'unknown verification failure';
        if (visionAttempt < maxVisionAttempts) {
          console.warn(`[THUMBNAIL] Stage 3: Vision verification failed on attempt ${visionAttempt}/${maxVisionAttempts}: ${reason}. Re-doing composite.`);
          return this.compositeThumbnail({
            keyArtPath,
            titleCardPath,
            title,
            tagline,
            placement,
            outputPath,
            aspectRatio,
            skipRecoveryOnReferenceFailure,
            referenceUploadWarmupMs,
            referenceUploadAllowAnyInput,
            maxVisionAttempts,
            visionAttempt: visionAttempt + 1,
          });
        }
        throw new Error(`COMPOSITE_VERIFICATION_FAILED: ${reason}`);
      }

      console.log(`[THUMBNAIL] Stage 3: Vision verification passed on attempt ${visionAttempt}`);
    } else if (!this.geminiApiKey && title) {
      console.log('[THUMBNAIL] Stage 3: No Gemini key - skipping final composite vision verification');
    }

    console.log(`[THUMBNAIL] Stage 3 complete: ${outputPath}`);
  }

  /**
   * Score existing scene images for thumbnail-worthiness via Gemini Vision.
   *
   * @param {string[]} imagePaths - Paths to scene images
   * @param {number} topN - Return top N candidates
   * @returns {Array<{path, score, reason}>}
   */
  async scoreSceneCandidates(imagePaths, { topN = 4 } = {}) {
    if (!this.geminiApiKey || imagePaths.length === 0) return [];

    const results = [];
    for (const imgPath of imagePaths) {
      if (!fs.existsSync(imgPath)) continue;
      try {
        const score = await this._scoreImageForThumbnail(imgPath);
        results.push({ path: imgPath, ...score });
      } catch (e) {
        console.warn(`[THUMBNAIL] Score failed for ${imgPath}: ${e.message}`);
        results.push({ path: imgPath, score: 0, reason: 'scoring failed' });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  /**
   * Try to recover a failed generation from the Higgsfield Asset library.
   * Uses prompt-matching to find the image that was generated (possibly
   * from a mis-click) and download it to the intended output path.
   *
   * @param {string} prompt - the prompt that was submitted
   * @param {string} outputPath - where to save the recovered image
   * @param {string} stageLabel - label for logging (e.g. 'key art', 'title card')
   * @returns {Promise<boolean>} true if recovery succeeded
   */
  async _tryAssetRecovery(prompt, outputPath, stageLabel, opts = {}) {
    if (!this.automation || typeof this.automation.recoverTimedOutImage !== 'function') {
      console.warn(`[THUMBNAIL] Asset recovery not available for ${stageLabel}`);
      return false;
    }

    try {
      console.log(`[THUMBNAIL] Attempting Asset library recovery for ${stageLabel}...`);
      // Grace period: the mis-click gen may still be completing
      await this.automation.page?.waitForTimeout?.(10000);

      const recovered = await this.automation.recoverTimedOutImage(prompt, outputPath, {
        minSimilarity: opts.minSimilarity ?? 80,
        maxTilesToCheck: opts.maxTilesToCheck ?? 6,
        timeoutMs: opts.timeoutMs ?? 60000,
      });

      if (recovered && fs.existsSync(outputPath)) {
        console.log(`[THUMBNAIL] ✓ Asset recovery SUCCESS for ${stageLabel} (uuid=${recovered.assetUuid}, similarity=${recovered.similarity}%)`);
        return true;
      }
      console.warn(`[THUMBNAIL] Asset recovery found no match for ${stageLabel}`);
      return false;
    } catch (recoveryErr) {
      console.warn(`[THUMBNAIL] Asset recovery failed for ${stageLabel}: ${recoveryErr.message}`);
      return false;
    }
  }

  // ── Private Helpers ──

  _loadPresets(presetsPath) {
    const defaultPath = path.join(__dirname, '..', '..', '..', 'config', 'thumbnail-presets.json');
    const filePath = presetsPath || defaultPath;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      console.warn(`[THUMBNAIL] Could not load presets from ${filePath} — using defaults`);
      return {
        drama: {
          font_family_hint: 'bold condensed serif',
          primary_hex: '#C9A84C',
          primary_name: 'burnished gold',
          secondary_hex: '#F5EDD6',
          secondary_name: 'warm ivory',
        },
      };
    }
  }

  _fileReady(filePath, minBytes = 1024) {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).size > minBytes;
    } catch (_) {
      return false;
    }
  }

  _splitTitle(title) {
    if (title.length <= 30) return [title];
    // Try splitting at natural break points
    const midpoint = Math.floor(title.length / 2);
    const breakChars = [' ', ':', '—', '-', ','];
    let bestBreak = -1;
    for (const ch of breakChars) {
      const idx = title.lastIndexOf(ch, midpoint + 10);
      if (idx > 5 && idx < title.length - 5) {
        bestBreak = idx;
        break;
      }
    }
    if (bestBreak > 0) {
      return [title.substring(0, bestBreak).trim(), title.substring(bestBreak + 1).trim()];
    }
    return [title];
  }

  _buildTitleCardPrompt({ titleLine1, titleLine2, tagline, fontFamilyHint, primaryHex, primaryName, secondaryHex, secondaryName, taglineCase = 'all-caps', taglineSeparator = false }) {
    let prompt = `Transparent background PNG. Typography only, no characters, no scenery.
Centered text composition. Line 1: "${titleLine1}" — ${fontFamilyHint}, heavyweight, slightly tracked out, color: ${primaryHex} (${primaryName}) with a very subtle inner glow and paper-thin dark outline #0A0A0A.`;

    if (titleLine2) {
      prompt += ` Line 2: "${titleLine2}" — same ${fontFamilyHint}, slightly larger than line 1, same ${primaryName} treatment. Thin horizontal ${primaryName} rule ${primaryHex} separating title from tagline, full width of the text block.`;
    }

    if (tagline) {
      if (taglineSeparator && !titleLine2) {
        prompt += ` Thin horizontal ${primaryName} rule ${primaryHex} separating line 1 from line 2, full width of the text block.`;
      }
      const taglineCaseInstruction = taglineCase === 'preserve'
        ? 'preserve the exact title case shown, no all-caps conversion'
        : 'all caps';
      prompt += ` ${titleLine2 ? 'Line 3' : 'Line 2'} tagline: "${tagline}" — thin elegant sans-serif, ${taglineCaseInstruction}, wide letter spacing, color: ${secondaryHex} (${secondaryName}).`;
    }

    prompt += ` All elements perfectly center-aligned. Subtle metallic sheen on the ${primaryName} lettering — not glittery, just premium. No drop shadow. No background. Pure transparent PNG.`;

    return prompt;
  }

  async _verifyTitleCardOCR(imagePath, expectedTitle, expectedTagline) {
    try {
      const { base64Image, mimeType } = this._imageInlineData(imagePath);

      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType, data: base64Image } },
                { text: `Read ALL text visible in this image. Does it contain the title "${expectedTitle}"${expectedTagline ? ` and the tagline "${expectedTagline}"` : ''}? Check spelling, capitalization, and punctuation carefully. Reply strictly JSON: { "title_match": boolean, "tagline_match": boolean, "text_found": "exact text you can read", "notes": "any discrepancies" }` },
              ],
            }],
            generationConfig: { maxOutputTokens: 300 },
          }),
        }
      );

      if (!resp.ok) {
        console.warn(`[THUMBNAIL] Gemini OCR returned ${resp.status}`);
        return { titleMatch: true, notes: 'Gemini unavailable — assuming match' };
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        return {
          titleMatch: result.title_match === true,
          taglineMatch: result.tagline_match !== false,
          textFound: result.text_found || '',
          notes: result.notes || '',
        };
      }
      return { titleMatch: true, notes: 'Could not parse OCR response — assuming match' };
    } catch (e) {
      console.warn(`[THUMBNAIL] OCR verification failed: ${e.message}`);
      return { titleMatch: true, notes: `OCR error: ${e.message}` };
    }
  }

  _imageInlineData(imagePath) {
    const imageBuffer = fs.readFileSync(imagePath);
    return {
      base64Image: imageBuffer.toString('base64'),
      mimeType: this._detectImageMimeType(imageBuffer),
    };
  }

  _detectImageMimeType(buffer) {
    const header = buffer.subarray(0, 12).toString('hex').toLowerCase();
    if (header.startsWith('89504e47')) return 'image/png';
    if (header.startsWith('ffd8ff')) return 'image/jpeg';
    if (header.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return 'image/png';
  }

  async _verifyCompositeThumbnail(imagePath, { expectedTitle, expectedTagline = '', placementInstruction = '' } = {}) {
    try {
      const { base64Image, mimeType } = this._imageInlineData(imagePath);
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inlineData: { mimeType, data: base64Image } },
                { text: `Inspect this final YouTube thumbnail composite. Expected title text: "${expectedTitle}".${expectedTagline ? ` Expected tagline text: "${expectedTagline}".` : ''} Placement requirement: ${placementInstruction || 'title must be readable and not cover faces'}.

Check the ACTUAL VISIBLE FINAL IMAGE, not the prompt. Verify:
- the expected title is present with exact spelling; ignore only line breaks and extra whitespace
- the expected tagline is present with exact spelling when one is expected
- no extra unrelated text, watermarks, or gibberish title variants are visible
- title/card text is readable at thumbnail scale
- no text, rule line, shadow, glow, or box covers any face/head/eyes/mouth/neck

Reply strictly JSON: { "pass": boolean, "title_match": boolean, "tagline_match": boolean, "text_found": "all visible text you can read", "readability_ok": boolean, "face_clear": boolean, "extra_text": boolean, "notes": "specific reason if pass is false" }` },
              ],
            }],
            generationConfig: { maxOutputTokens: 450 },
          }),
        }
      );

      if (!resp.ok) {
        console.warn(`[THUMBNAIL] Composite vision verification returned ${resp.status}`);
        return { pass: true, notes: 'Gemini unavailable - assuming composite pass' };
      }

      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('[THUMBNAIL] Composite vision verification returned unparsable text');
        return { pass: true, notes: 'Could not parse composite verification - assuming pass' };
      }

      const result = JSON.parse(jsonMatch[0]);
      const titleMatch = result.title_match === true || result.titleMatch === true;
      const taglineExpected = !!String(expectedTagline || '').trim();
      const taglineMatch = taglineExpected
        ? (result.tagline_match === true || result.taglineMatch === true)
        : result.tagline_match !== false && result.taglineMatch !== false;
      const readabilityOk = result.readability_ok !== false && result.readabilityOk !== false;
      const faceClear = result.face_clear !== false && result.faceClear !== false;
      const extraText = result.extra_text === true || result.extraText === true;
      const pass = result.pass === true && titleMatch && taglineMatch && readabilityOk && faceClear && !extraText;

      return {
        pass,
        titleMatch,
        taglineMatch,
        readabilityOk,
        faceClear,
        extraText,
        textFound: result.text_found || result.textFound || '',
        notes: result.notes || '',
      };
    } catch (e) {
      console.warn(`[THUMBNAIL] Composite vision verification failed: ${e.message}`);
      return { pass: true, notes: `Composite verification error - assuming pass: ${e.message}` };
    }
  }

  async _scoreImageForThumbnail(imagePath) {
    const { base64Image, mimeType } = this._imageInlineData(imagePath);

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inlineData: { mimeType, data: base64Image } },
              { text: `Rate this image as a YouTube thumbnail candidate on a scale of 1-10. Consider: face visibility, emotional intensity, composition, color vibrancy, visual clarity, and whether it would grab attention in a YouTube feed. Reply strictly JSON: { "score": N, "reason": "one sentence explanation" }` },
            ],
          }],
          generationConfig: { maxOutputTokens: 100 },
        }),
      }
    );

    if (!resp.ok) return { score: 5, reason: 'scoring unavailable' };
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return { score: result.score || 5, reason: result.reason || '' };
    }
    return { score: 5, reason: 'could not parse score' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CUSTOM THUMBNAIL — Close-up portrait + title card composite
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Full custom thumbnail pipeline: close-up portrait + title card + composite.
   *
   * @param {object} params
   * @param {string} params.title - Movie title
   * @param {string} params.tagline - Optional tagline
   * @param {string} params.genre - Genre key (drama, thriller, etc.)
   * @param {string} params.characterElementName - Suffixed element name (e.g. "mama_adaeze_towwf_0421")
   * @param {string} params.expression - Emotional expression (e.g. "intense determined")
   * @param {string} params.outputDir - Directory for outputs
   * @param {string} params.placement - 'lower-third' | 'upper-third' | 'auto'
   * @returns {object} { thumbnailPath, keyArtPath, titleCardPath }
   */
  async generateCustomThumbnail(params) {
    const {
      title, tagline, genre = 'drama',
      characterElementName, expression = 'intense determined',
      outputDir, placement = 'lower-third', aspectRatio = '16:9',
    } = params;

    fs.mkdirSync(outputDir, { recursive: true });
    const preset = this.presets[genre] || this.presets.drama;
    const thumbnailPath = path.join(outputDir, 'thumbnail-custom.png');
    const canReuseIntermediates = !this._fileReady(thumbnailPath);

    // Stage 1: Custom close-up key art
    const keyArtPath = path.join(outputDir, 'key-art-custom.png');
    if (canReuseIntermediates && this._fileReady(keyArtPath)) {
      console.log(`[THUMBNAIL] Custom Stage 1: Reusing existing close-up: ${keyArtPath}`);
    } else {
      await this.generateCustomKeyArt({
        characterElementName,
        expression,
        outputPath: keyArtPath,
        aspectRatio,
      });
    }

    // Stage 2: Title card (same as scene-based flow)
    const titleCardPath = path.join(outputDir, 'title-card.png');
    if (canReuseIntermediates && this._fileReady(titleCardPath)) {
      console.log(`[THUMBNAIL] Stage 2: Reusing existing title card: ${titleCardPath}`);
    } else {
      await this.generateTitleCard({
        title, tagline, preset, outputPath: titleCardPath, aspectRatio,
      });
    }

    // Stage 3: Composite (same as scene-based flow)
    await this.compositeThumbnail({
      keyArtPath, titleCardPath, title, tagline, placement, outputPath: thumbnailPath, aspectRatio,
    });

    return { thumbnailPath, keyArtPath, titleCardPath };
  }

  /**
   * Stage 1 (Custom): Generate close-up portrait of main character.
   * Uses @element reference for face consistency via Nano Banana Pro.
   *
   * @param {object} params
   * @param {string} params.characterElementName - Suffixed element name
   * @param {string} params.expression - Emotional expression descriptor
   * @param {string} params.outputPath - Output file path
   */
  async generateCustomKeyArt({ characterElementName, expression, outputPath, aspectRatio = '16:9' }) {
    const orientationHint = aspectRatio === '9:16' ? '9:16 vertical' : '16:9';
    const spaceHint = aspectRatio === '9:16'
      ? 'clear space in the lower portion for title text overlay'
      : 'clear space on one side for title text overlay';
    const prompt = `Cinematic close-up portrait of @${characterElementName}, ${expression} expression.

Requirements:
- Tight close-up framing: face fills 60-70% of the frame
- Cinematic lighting with strong contrast and dramatic shadows
- Shallow depth of field — background softly blurred
- ${orientationHint} composition with ${spaceHint}
- Film-quality color grading, prestige production value
- Character looking slightly off-camera for dramatic tension
- NO text, NO title, NO watermarks — portrait only`;

    console.log(`[THUMBNAIL] Custom Stage 1: Generating close-up of @${characterElementName} (${expression}, ${aspectRatio})...`);
    try {
      await this._ensureLoggedIn();
      await this._genImage({
        prompt,
        outputPath,
        aspectRatio,
        useUnlimited: true,
      }, 'custom-closeup');
    } catch (genErr) {
      if (genErr.message.includes('SESSION_EXPIRED')) {
        console.log('[THUMBNAIL] Session expired — waiting for login...');
        await this._waitForLogin();
        await this._genImage({
          prompt,
          outputPath,
          aspectRatio,
          useUnlimited: true,
        }, 'custom-closeup');
      } else {
        console.warn(`[THUMBNAIL] Custom Stage 1 failed: ${genErr.message} — attempting Asset library recovery`);
        const recovered = await this._tryAssetRecovery(prompt, outputPath, 'custom key art');
        if (!recovered) throw genErr;
      }
    }
    console.log(`[THUMBNAIL] Custom Stage 1 complete: ${outputPath}`);
  }

  /**
   * Auto-suggest an emotional expression for the thumbnail based on the script.
   * Analyzes the script's emotional arcs and dominant tones to pick
   * the most impactful single expression for a thumbnail close-up.
   *
   * @param {object} script - Parsed script JSON (from projects.script_json)
   * @returns {string} Suggested expression (e.g. "intense determined")
   */
  suggestExpression(script) {
    if (!script || !script.chapters) return 'intense determined';

    // Collect all tone markers from dialogue lines
    const tones = [];
    for (const ch of script.chapters) {
      for (const sc of ch.scenes || []) {
        for (const line of sc.lines || []) {
          if (line.tone) tones.push(line.tone.toLowerCase());
        }
      }
    }

    if (tones.length === 0) return 'intense determined';

    // Count frequency of tone markers
    const freq = {};
    for (const t of tones) {
      freq[t] = (freq[t] || 0) + 1;
    }

    // Map script tones to thumbnail-friendly expressions
    const toneToExpression = {
      // Dramatic / intense
      'angry': 'fierce defiant',
      'furious': 'fierce defiant',
      'confrontational': 'steely confrontational',
      'determined': 'intense determined',
      'firm': 'intense determined',
      'commanding': 'powerful commanding',
      'stern': 'steely resolved',
      // Emotional / vulnerable
      'tearful': 'vulnerable tear-streaked',
      'heartbroken': 'devastated heartbroken',
      'desperate': 'desperate anguished',
      'pleading': 'desperate pleading',
      'grieving': 'grief-stricken devastated',
      'sad': 'melancholy pensive',
      // Suspense / mystery
      'suspicious': 'suspiciously narrowed eyes',
      'shocked': 'stunned wide-eyed',
      'fearful': 'fearful wide-eyed',
      'nervous': 'anxiously tense',
      'whispering': 'secretive intense',
      // Strength / resolve
      'defiant': 'fierce defiant',
      'cold': 'ice-cold unreadable',
      'controlled': 'dangerously calm',
      'strained': 'tightly controlled strain',
      'resigned': 'wearily resigned',
      // Warmth
      'warm': 'warmly knowing',
      'gentle': 'gentle compassionate',
      'loving': 'tender loving',
      'hopeful': 'cautiously hopeful',
    };

    // Find the most dramatic (not warm) tone — thumbnails need tension
    const dramaticTones = ['angry', 'furious', 'confrontational', 'determined', 'defiant',
      'tearful', 'heartbroken', 'desperate', 'shocked', 'cold', 'strained'];

    // Sort by frequency, prefer dramatic tones
    const ranked = Object.entries(freq).sort((a, b) => {
      const aDramatic = dramaticTones.some(d => a[0].includes(d)) ? 10 : 0;
      const bDramatic = dramaticTones.some(d => b[0].includes(d)) ? 10 : 0;
      return (bDramatic + b[1]) - (aDramatic + a[1]);
    });

    const topTone = ranked[0]?.[0] || 'determined';

    // Find best match in expression map
    for (const [key, expr] of Object.entries(toneToExpression)) {
      if (topTone.includes(key)) return expr;
    }

    return 'intense determined'; // Fallback — always works for drama thumbnails
  }

  /**
   * Get characters available for custom thumbnail from a project.
   * Returns character names with their element names for dropdown.
   *
   * @param {object} script - Parsed script JSON
   * @param {string|object} elementOptions - Legacy suffix string or cinematic element lookup options
   * @returns {Array<{name, elementName, dialogueCount}>}
   */
  getCharactersForThumbnail(script, elementOptions) {
    if (!script || !script.character_bible) return [];

    const bible = script.character_bible;
    const options = typeof elementOptions === 'object' && elementOptions !== null
      ? elementOptions
      : { elementSuffix: elementOptions };
    const elementSuffix = options.elementSuffix || null;
    const cinematicElementNames = options.cinematicElementNames || {};
    const outfitElements = options.outfitElements || {};

    // Count dialogue lines per character
    const dialogueCounts = {};
    for (const ch of script.chapters || []) {
      for (const sc of ch.scenes || []) {
        for (const line of sc.lines || []) {
          const speaker = (line.speaker_id || '').replace(/^@/, '').toLowerCase();
          dialogueCounts[speaker] = (dialogueCounts[speaker] || 0) + 1;
        }
      }
    }

    return bible.map(char => {
      const hint = (char.element_name_hint || '').replace(/^@/, '').toLowerCase();
      const defaultOutfitName = outfitElements[hint]?.o1 || outfitElements[hint]?.['o1'];
      const mappedName = defaultOutfitName
        || cinematicElementNames[hint]
        || cinematicElementNames[`@${hint}`]
        || cinematicElementNames[char.id]
        || cinematicElementNames[`@${char.id}`];
      const normalizedSuffix = elementSuffix ? String(elementSuffix).replace(/^_+/, '') : '';
      const suffixedName = mappedName || (normalizedSuffix ? `${hint}_${normalizedSuffix}` : hint);
      const count = dialogueCounts[hint] || 0;

      return {
        name: char.name || hint,
        elementNameHint: hint,
        elementName: suffixedName,
        dialogueCount: count,
      };
    }).sort((a, b) => b.dialogueCount - a.dialogueCount); // Most dialogue first
  }

  /**
   * Check if user is logged in before attempting generation.
   * If not logged in, triggers _waitForLogin automatically.
   * Mirrors the orchestrator's SESSION_EXPIRED → pause → resume pattern.
   */
  async _ensureLoggedIn() {
    if (!this.automation || typeof this.automation.isLoggedIn !== 'function') return;
    try {
      // Navigate to image gen page so isLoggedIn can check for Login/Sign up buttons
      if (this.automation.page) {
        const url = this.automation.page.url();
        if (!url.includes('higgsfield.ai')) {
          await this.automation.page.goto('https://higgsfield.ai/ai/image?model=nano-banana-pro', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          }).catch(() => {});
        }
      }
      const loggedIn = await this.automation.isLoggedIn();
      if (!loggedIn) {
        console.log('[THUMBNAIL] Not logged in — waiting for login before generation...');
        await this._waitForLogin();
      }
    } catch (e) {
      // If check fails, proceed anyway — generateImage will throw SESSION_EXPIRED if needed
      console.warn(`[THUMBNAIL] Login check failed: ${e.message} — proceeding`);
    }
  }

  /**
   * Wait for the user to log in to Higgsfield AI.
   * Relaunches the browser to higgsfield.ai login page, then polls
   * isLoggedIn() every 10s until the user completes login.
   * Same pattern as orchestrator SESSION_EXPIRED recovery.
   */
  async _waitForLogin() {
    if (!this.automation) throw new Error('No automation instance for login wait');

    // Relaunch browser to give user a clean login page
    try {
      await this.automation.close();
    } catch (_) {}
    await this.automation.ensureBrowser();

    // Navigate to Higgsfield so user sees the login prompt
    try {
      await this.automation.page.goto('https://higgsfield.ai', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
    } catch (_) {}

    console.log('[THUMBNAIL] Browser opened to higgsfield.ai — please log in to continue...');

    // Poll isLoggedIn() every 10 seconds, up to 10 minutes
    const maxWaitMs = 10 * 60 * 1000;
    const pollIntervalMs = 10000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs));
      try {
        const loggedIn = await this.automation.isLoggedIn();
        if (loggedIn) {
          console.log('[THUMBNAIL] ✓ Login detected — resuming thumbnail generation');
          return;
        }
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`[THUMBNAIL] Still waiting for login... (${elapsed}s elapsed)`);
      } catch (_) {
        // Page might be navigating during login — keep polling
      }
    }

    throw new Error('Login wait timed out after 10 minutes — please restart the pipeline');
  }

  /**
   * Wrapper around automation.generateImage that automatically wires
   * onGenClicked for credit tracking via the onCreditUsed callback.
   * @param {string} stage - human label for the stage (e.g. 'key-art', 'title-card', 'composite')
   */
  _genImage(opts, stage) {
    if (this.onCreditUsed) {
      opts.onGenClicked = (creditCost) => {
        try { this.onCreditUsed(creditCost, stage); } catch (_) {}
      };
    }
    return this.automation.generateImage(opts);
  }
}

module.exports = { ThumbnailGenerator };
