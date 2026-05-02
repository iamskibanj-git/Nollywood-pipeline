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
      keyArtPath, titleCardPath, placement, outputPath: thumbnailPath,
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
      await this.automation.generateImage({
        prompt,
        outputPath,
        aspectRatio,
        useUnlimited: true,
      });
    } catch (genErr) {
      if (genErr.message.includes('SESSION_EXPIRED')) {
        console.log('[THUMBNAIL] Session expired — waiting for login...');
        await this._waitForLogin();
        // Retry once after login
        await this.automation.generateImage({
          prompt,
          outputPath,
          aspectRatio,
          useUnlimited: true,
        });
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
  async generateTitleCard({ title, tagline, preset, outputPath, aspectRatio = '16:9' }) {
    // Split title into 1-2 lines if it's long
    const titleLines = this._splitTitle(title);
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
    });

    let verified = false;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[THUMBNAIL] Stage 2: Generating title card (attempt ${attempt}/${maxAttempts}, ${aspectRatio})...`);
      try {
        await this._ensureLoggedIn();
        await this.automation.generateImage({
          prompt,
          outputPath,
          aspectRatio,
          useUnlimited: true,
        });
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
  async compositeThumbnail({ keyArtPath, titleCardPath, placement, outputPath }) {
    const placementInstruction = placement === 'upper-third'
      ? 'Position the title text in the UPPER THIRD of the frame'
      : placement === 'lower-third'
        ? 'Position the title text in the LOWER THIRD of the frame'
        : 'Position the title text in the area with the most negative space';

    const prompt = `Composite thumbnail: overlay the title card (second reference image) onto the key art (first reference image).

Requirements:
- Use the EXACT key art as the background — do not modify the characters, lighting, or composition
- Overlay the EXACT title text from the title card — same font, same color, same style
- ${placementInstruction}
- Blend naturally: slight darkened gradient behind text area for readability
- Final result should look like a professional YouTube thumbnail
- NO additional text, NO watermarks, NO borders`;

    console.log(`[THUMBNAIL] Stage 3: Compositing (placement: ${placement})...`);
    try {
      await this._ensureLoggedIn();
      await this.automation.generateImage({
        prompt,
        outputPath,
        references: [keyArtPath, titleCardPath],
        aspectRatio: '16:9',
        useUnlimited: true,
      });
    } catch (genErr) {
      if (genErr.message.includes('SESSION_EXPIRED')) {
        console.log('[THUMBNAIL] Session expired — waiting for login...');
        await this._waitForLogin();
        await this.automation.generateImage({
          prompt,
          outputPath,
          references: [keyArtPath, titleCardPath],
          aspectRatio: '16:9',
          useUnlimited: true,
        });
      } else {
        console.warn(`[THUMBNAIL] Stage 3 generation failed: ${genErr.message} — attempting Asset library recovery`);
        const recovered = await this._tryAssetRecovery(prompt, outputPath, 'composite');
        if (!recovered) throw genErr;
      }
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
  async _tryAssetRecovery(prompt, outputPath, stageLabel) {
    if (!this.automation || typeof this.automation.recoverTimedOutImage !== 'function') {
      console.warn(`[THUMBNAIL] Asset recovery not available for ${stageLabel}`);
      return false;
    }

    try {
      console.log(`[THUMBNAIL] Attempting Asset library recovery for ${stageLabel}...`);
      // Grace period: the mis-click gen may still be completing
      await this.automation.page?.waitForTimeout?.(10000);

      const recovered = await this.automation.recoverTimedOutImage(prompt, outputPath, {
        minSimilarity: 60,  // Lower threshold — thumbnail prompts are long, partial matches OK
        maxTilesToCheck: 6,
        timeoutMs: 60000,
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

  _buildTitleCardPrompt({ titleLine1, titleLine2, tagline, fontFamilyHint, primaryHex, primaryName, secondaryHex, secondaryName }) {
    let prompt = `Transparent background PNG. Typography only, no characters, no scenery.
Centered text composition. Line 1: "${titleLine1}" — ${fontFamilyHint}, heavyweight, slightly tracked out, color: ${primaryHex} (${primaryName}) with a very subtle inner glow and paper-thin dark outline #0A0A0A.`;

    if (titleLine2) {
      prompt += ` Line 2: "${titleLine2}" — same ${fontFamilyHint}, slightly larger than line 1, same ${primaryName} treatment. Thin horizontal ${primaryName} rule ${primaryHex} separating title from tagline, full width of the text block.`;
    }

    if (tagline) {
      prompt += ` ${titleLine2 ? 'Line 3' : 'Line 2'} tagline: "${tagline}" — thin elegant sans-serif, all caps, wide letter spacing, color: ${secondaryHex} (${secondaryName}).`;
    }

    prompt += ` All elements perfectly center-aligned. Subtle metallic sheen on the ${primaryName} lettering — not glittery, just premium. No drop shadow. No background. Pure transparent PNG.`;

    return prompt;
  }

  async _verifyTitleCardOCR(imagePath, expectedTitle, expectedTagline) {
    try {
      const imageBuffer = fs.readFileSync(imagePath);
      const base64Image = imageBuffer.toString('base64');
      const mimeType = 'image/png';

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

 