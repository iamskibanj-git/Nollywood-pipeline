const fs = require('fs');
const path = require('path');

/**
 * ClipVerifier
 *
 * Uses Gemini multimodal to transcribe generated video clips and compare
 * the actual spoken dialogue against the expected dialogue. Flags clips
 * where Veo produced wrong words, wrong characters speaking, or silence
 * where there should be dialogue.
 *
 * This is the post-MVP Verify Clip stage — runs between videos-done and
 * assembly. Blocks assembly on genuinely bad clips, lets humans review
 * borderline cases, auto-accepts strong matches.
 *
 * Pipeline position:
 *   scenes-done → videos-done → VERIFY → assembly → export
 *
 * Signals Gemini provides per clip (one API call):
 *   - transcript          verbatim spoken text with word-level timestamps
 *   - mouth_sync_quality  "matches" | "off" | "partial" | "silent"
 *   - artifacts           array: ["silence", "background music", "wrong language", ...]
 *   - character_count     number of distinct people visible in frame
 *   - notes               freeform issues (e.g., "last word cut off")
 *
 * Comparison:
 *   - Strip punctuation, lowercase, collapse whitespace on both sides
 *   - Levenshtein similarity (0-100)
 *   - Trailing-word forgiveness: last 15% of expected text weighted lower
 *     (Veo commonly drops/slurs the final 1-2 words)
 *
 * Tiers (safe-by-default — transcription is not reliable enough to auto-reject):
 *   >= ACCEPT_THRESHOLD   auto-accept    (green)  — clear transcript match
 *   <  ACCEPT_THRESHOLD   review         (yellow) — human eyeballs it
 *   (hard reject)         reject         (red)    — ONLY for silent clips or
 *                                                   explicit wrong-language flag
 *                                                   from Gemini (not Whisper
 *                                                   auto-detection)
 *
 * Real-world data showed 3/4 similarity-based auto-rejects were false positives
 * (Whisper garbled the transcription of accented English on perfectly good clips).
 * So similarity is used only for auto-accept / send-to-review, never auto-reject.
 */
class ClipVerifier {
  /**
   * @param {Object} opts
   * @param {string} opts.apiKey    - API key for the chosen backend
   * @param {string} [opts.backend] - "gemini" (default, multimodal — richer signals
   *                                  + better accent handling) or "whisper" (audio-only,
   *                                  cheaper/faster but garbles accented English)
   * @param {string} [opts.model]   - Override model name (whisper-1 / gemini-2.5-flash)
   */
  constructor({ apiKey, backend = 'gemini', model } = {}) {
    if (!apiKey) throw new Error('ClipVerifier requires apiKey');
    if (!['whisper', 'gemini'].includes(backend)) {
      throw new Error(`Unknown backend "${backend}" — use "whisper" or "gemini"`);
    }
    this.apiKey = apiKey;
    this.backend = backend;
    this.model = model || (backend === 'whisper' ? 'whisper-1' : 'gemini-2.5-flash');
    // Thresholds — tune as we get real-world data
    //
    // IMPORTANT: Whisper's transcription of Nigerian-accented English is unreliable.
    // Real-world test: 3 out of 4 auto-rejected clips were actually FINE on human
    // eyeball — Whisper just garbled the transcription.
    //
    // Design philosophy: auto-accept the CLEAR wins (high similarity), send EVERYTHING
    // else to human review. Never auto-reject on similarity alone. The only hard
    // rejects are truly unambiguous signals (silent audio, explicit errors).
    this.ACCEPT_THRESHOLD = 85;  // ≥85% similarity → auto-accept (green)
                                 // <85% → review (yellow), human decides accept or redo
    this.TAIL_FORGIVE_PCT = 0.15; // last 15% of expected text weighted lower
    // Silence detection (whisper backend): if verbose_json's overall
    // no_speech_prob avg exceeds this, flag as silent
    this.SILENCE_NO_SPEECH_THRESHOLD = 0.9;
  }

  /**
   * Verify a single clip against its expected dialogue.
   *
   * @param {Object} args
   * @param {string} args.clipPath          - Absolute path to .mp4 file on disk
   * @param {string} args.expectedDialogue  - The dialogue line the clip should contain
   * @param {string} [args.clipLabel]       - Human-readable label like "Ch1 L3" (for logs)
   * @returns {Promise<Object>} verification result
   *   {
   *     clipPath, clipLabel,
   *     transcript,           verbatim spoken text
   *     words,                [{ word, startMs, endMs }, ...] (may be [] if not provided)
   *     mouthSync,            "matches" | "off" | "partial" | "silent" | "unknown"
   *     artifacts,            string[]
   *     characterCount,       integer or null
   *     notes,                string
   *     expectedDialogue,     (echoed)
   *     similarity,           0-100
   *     tier,                 "accept" | "review" | "reject"
   *     error,                null or string
   *   }
   */
  async verifyClip({ clipPath, expectedDialogue, clipLabel = path.basename(clipPath) }) {
    const result = {
      clipPath,
      clipLabel,
      transcript: '',
      words: [],
      mouthSync: 'unknown',
      artifacts: [],
      characterCount: null,
      notes: '',
      expectedDialogue: expectedDialogue || '',
      similarity: 0,
      tier: 'reject',
      error: null,
    };

    try {
      if (!fs.existsSync(clipPath)) {
        throw new Error(`Clip not found: ${clipPath}`);
      }
      const stat = fs.statSync(clipPath);
      if (stat.size < 1000) {
        throw new Error(`Clip too small (${stat.size} bytes): ${clipPath}`);
      }

      console.log(`[VERIFY] ${clipLabel}: uploading ${Math.round(stat.size / 1024)}KB to Gemini...`);

      const analysis = await this._analyzeClip(clipPath);
      result.transcript    = analysis.transcript || '';
      result.words         = analysis.words || [];
      result.mouthSync     = analysis.mouth_sync_quality || 'unknown';
      result.artifacts     = analysis.artifacts || [];
      result.characterCount = typeof analysis.character_count === 'number' ? analysis.character_count : null;
      result.notes         = analysis.notes || '';

      // Compute similarity with expected dialogue
      result.similarity = this._computeSimilarity(result.transcript, expectedDialogue);
      result.tier = this._tierForScore(result.similarity, result.mouthSync, result.artifacts);

      console.log(`[VERIFY] ${clipLabel}: similarity=${result.similarity}% mouth=${result.mouthSync} tier=${result.tier}`);
    } catch (e) {
      result.error = e.message;
      result.tier  = 'reject';
      console.warn(`[VERIFY] ${clipLabel} FAILED: ${e.message}`);
    }

    return result;
  }

  /**
   * Verify a CINEMATIC clip — one Kling-generated multi-shot file containing
   * 2-4 dialogue lines + visible cuts. Phase 5 of the cinematic workflow.
   *
   * Different from verifyClip() because:
   *   - Multiple expected lines per clip, each spoken by a different character
   *   - Visible shot cuts within the clip
   *   - Per-line scoring + per-line speaker attribution
   *
   * Strategy:
   *   1. Send clip to Gemini with a CINEMATIC-specific prompt that asks for
   *      a list of detected spoken lines (with approximate timing + visible
   *      speaker), shot cut count, and overall quality artifacts.
   *   2. Match Gemini's detected spoken lines to expected lines in JS by
   *      Levenshtein similarity. Each expected line gets its own score.
   *   3. Aggregate: overall similarity = mean of per-line scores. Overall
   *      tier = worst per-line tier (so any single failed line forces review).
   *
   * @param {Object} opts
   * @param {string} opts.clipPath
   * @param {Array<{line_number: number, speaker_id: string, dialogue: string, tone: string}>} opts.expectedLines
   * @param {string} [opts.clipLabel]
   * @returns {Promise<{
   *   clipPath, clipLabel,
   *   transcript,                   // all detected speech concatenated
   *   linesVerified: Array<{
   *     line_number, expected, expected_speaker, transcribed_segment,
   *     similarity, speaker_match, accent_detected, accent_match, tier
   *   }>,
   *   accentConsistent,              // boolean — false if any accent drift detected
   *   shotCutsObserved,             // integer
   *   mouthSync, artifacts, notes,
   *   similarity,                   // aggregate 0-100
   *   tier,                          // worst per-line tier
   *   error
   * }>}
   */
  async verifyCinematicClip({ clipPath, expectedLines, clipLabel = path.basename(clipPath) }) {
    const result = {
      clipPath,
      clipLabel,
      transcript: '',
      linesVerified: [],
      shotCutsObserved: null,
      mouthSync: 'unknown',
      accentConsistent: true,
      artifacts: [],
      characterCount: null,
      notes: '',
      similarity: 0,
      tier: 'reject',
      error: null,
      _cinematic: true, // hint for downstream consumers
    };

    if (!Array.isArray(expectedLines) || expectedLines.length === 0) {
      result.error = 'verifyCinematicClip: expectedLines required';
      return result;
    }

    try {
      if (!fs.existsSync(clipPath)) throw new Error(`Clip not found: ${clipPath}`);
      const stat = fs.statSync(clipPath);
      if (stat.size < 1000) throw new Error(`Clip too small (${stat.size} bytes)`);

      console.log(`[VERIFY-CINEMATIC] ${clipLabel}: ${expectedLines.length} expected line(s), ${Math.round(stat.size / 1024)}KB`);

      // Cinematic mode uses Gemini exclusively — Whisper can't tell us speaker
      // attribution per line, only a flat transcript.
      const analysis = await this._analyzeCinematicWithGemini(clipPath, expectedLines);

      result.transcript = (analysis.spoken_lines || []).map(l => l.transcript).join(' ').trim();
      result.shotCutsObserved = typeof analysis.shot_cuts_observed === 'number' ? analysis.shot_cuts_observed : null;
      result.mouthSync = analysis.mouth_sync_quality || 'unknown';
      result.artifacts = analysis.artifacts || [];
      result.characterCount = typeof analysis.character_count === 'number' ? analysis.character_count : null;
      result.notes = analysis.notes || '';

      // Per-line matching: greedy assignment by similarity.
      // Each Gemini-detected spoken line gets matched to its best expected
      // line; each expected line is reported with its matched-against score.
      const detected = (analysis.spoken_lines || []).map((d, i) => ({
        idx: i,
        transcript: (d.transcript || '').trim(),
        speaker_visible: (d.speaker_visible || '').toLowerCase().trim(),
        accent: (d.accent || '').trim(),
        startMs: d.approximate_start_ms || 0,
        consumed: false,
      }));

      // Extract accent consistency signal
      const accentConsistent = analysis.accent_consistent !== false; // default true if missing

      for (const exp of expectedLines) {
        const expectedText = (exp.dialogue || '').trim();
        const expectedSpeaker = (exp.speaker_id || '').toLowerCase().replace(/^@+/, '').replace(/^character_/, '').trim();

        // Find best-matching unconsumed detected line
        let best = null;
        for (const d of detected) {
          if (d.consumed) continue;
          if (!d.transcript) continue;
          const sim = this._computeSimilarity(d.transcript, expectedText);
          if (!best || sim > best.sim) best = { d, sim };
        }

        const transcribedSegment = best?.d?.transcript || '';
        const similarity = best?.sim || 0;
        const detectedSpeaker = best?.d?.speaker_visible || '';
        const detectedAccent = best?.d?.accent || '';
        const speakerMatch = !expectedSpeaker || !detectedSpeaker
          || detectedSpeaker.includes(expectedSpeaker)
          || expectedSpeaker.includes(detectedSpeaker);

        // Accent match: Nigerian English or West African English are acceptable.
        // Anything else (American, British, etc.) is a mismatch.
        const accentNorm = detectedAccent.toLowerCase();
        const accentMatch = !detectedAccent
          || accentNorm.includes('nigerian')
          || accentNorm.includes('west african')
          || accentNorm.includes('unclear');

        const lineTier = this._tierForScore(similarity, result.mouthSync, result.artifacts);

        result.linesVerified.push({
          line_number: exp.line_number,
          expected: expectedText,
          expected_speaker: exp.speaker_id || null,
          transcribed_segment: transcribedSegment,
          similarity: Math.round(similarity),
          speaker_match: speakerMatch,
          accent_detected: detectedAccent || null,
          accent_match: accentMatch,
          tier: lineTier,
        });

        if (best) best.d.consumed = true;
      }

      // Aggregate: overall similarity = mean; overall tier = worst per-line tier
      const sims = result.linesVerified.map(l => l.similarity);
      result.similarity = sims.length ? Math.round(sims.reduce((a, b) => a + b, 0) / sims.length) : 0;

      const tierRank = { accept: 3, review: 2, reject: 1 };
      const worstTier = result.linesVerified.reduce((worst, l) => {
        return (tierRank[l.tier] || 0) < (tierRank[worst] || 4) ? l.tier : worst;
      }, 'accept');
      result.tier = worstTier;

      // Speaker mismatch on any line bumps tier down to 'review' minimum
      const anySpeakerMiss = result.linesVerified.some(l => !l.speaker_match);
      if (anySpeakerMiss && result.tier === 'accept') result.tier = 'review';

      // ── Accent drift detection ──
      // Any line with a non-Nigerian accent = auto-reject (redo trigger).
      // Accent drift is worse than lip sync failure — it breaks immersion entirely.
      const anyAccentMiss = result.linesVerified.some(l => l.accent_match === false);
      const accentDriftArtifact = (result.artifacts || []).includes('accent drift');
      result.accentConsistent = accentConsistent && !anyAccentMiss && !accentDriftArtifact;

      if (anyAccentMiss || !accentConsistent || accentDriftArtifact) {
        result.tier = 'reject';
        if (!result.artifacts.includes('accent drift')) {
          result.artifacts.push('accent drift');
        }
        const driftLines = result.linesVerified
          .filter(l => l.accent_match === false)
          .map(l => `L${l.line_number}:${l.accent_detected}`)
          .join(', ');
        console.log(`[VERIFY-CINEMATIC] ${clipLabel}: ⚠ ACCENT DRIFT DETECTED → auto-reject (${driftLines || 'inconsistent'})`);
      }

      console.log(`[VERIFY-CINEMATIC] ${clipLabel}: agg similarity=${result.similarity}% tier=${result.tier} accent=${result.accentConsistent ? '✓' : '⚠DRIFT'} (lines: ${result.linesVerified.map(l => l.tier[0].toUpperCase()).join('')})${anySpeakerMiss ? ' SPEAKER-MISS' : ''}`);
    } catch (e) {
      result.error = e.message;
      result.tier = 'reject';
      console.warn(`[VERIFY-CINEMATIC] ${clipLabel} FAILED: ${e.message}`);
    }

    return result;
  }

  /**
   * Cinematic-specific Gemini analysis. Returns a list of detected spoken
   * lines with timing + visible-speaker hints, plus shot cut count.
   */
  async _analyzeCinematicWithGemini(clipPath, expectedLines) {
    const fileUri = await this._uploadToGemini(clipPath);
    const prompt = this._buildCinematicVerifyPrompt(expectedLines);

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: 'video/mp4', fileUri } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini cinematic analyze failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini (cinematic)');
    return this._safeParseJSON(text);
  }

  _buildCinematicVerifyPrompt(expectedLines) {
    // Hint Gemini about expected line count + speakers so its segmentation
    // matches our matching logic. Don't show actual dialogue — we want
    // independent transcription, not biased matching.
    const expectedSpeakerList = [...new Set(
      expectedLines.map(l => (l.speaker_id || '').replace(/^@+/, '').replace(/^character_/, '')).filter(Boolean)
    )];

    return `You are verifying a short AI-generated cinematic video clip that contains MULTIPLE shots cut together with dialogue from MULTIPLE characters.

Expected: roughly ${expectedLines.length} dialogue line(s), spoken by character(s): ${expectedSpeakerList.join(', ') || '(unknown)'}.
Expected accent: Nigerian English (West African English). Any sudden switch to American, British, or other non-Nigerian accent is a critical defect.

Return ONLY a JSON object with this exact schema (no prose, no markdown):

{
  "spoken_lines": [
    {
      "approximate_start_ms": <integer milliseconds when this line begins>,
      "speaker_visible": "<character name or descriptor of the speaker visible on screen, e.g. 'woman in green dress' or 'man in suit' or 'unclear'>",
      "transcript": "<exact verbatim words spoken in this line>",
      "accent": "<accent classification for THIS specific line>"
    }
  ],
  "shot_cuts_observed": <integer count of visible shot cuts within the clip>,
  "mouth_sync_quality": "matches" | "off" | "partial" | "silent",
  "accent_consistent": <boolean: true if all spoken lines maintain the same accent throughout, false if accent switches between lines>,
  "artifacts": ["silence", "background music", "wrong language", "accent drift", "echo", "static", "speaker shifts mid-line", "last word cut off", "stutter"],
  "character_count": <integer: distinct people visible across the whole clip>,
  "notes": "<freeform observations: cuts mistimed, character drift across cuts, mismatched lip-sync per line, accent issues>"
}

Critical rules:
- spoken_lines: ONE entry per distinct dialogue line. If a character speaks 2 sentences in the same shot, those count as 1 line. If 2 characters speak in the same shot, that's 2 lines. Order chronologically.
- speaker_visible: describe the speaker by visible characteristics. Match against the expected speakers above when possible. Use 'unclear' if you can't tell from the visuals.
- transcript: VERBATIM. No paraphrasing. If a word is unclear, put [unclear].
- accent: classify the accent of EACH line independently. Use one of: "Nigerian English", "West African English", "American English", "British English", "neutral/unclear", or another specific accent if clearly identifiable. Pay close attention to sudden shifts — a character speaking Nigerian English in one line and American English in the next is a critical defect ("accent drift").
- accent_consistent: false if ANY line's accent differs from the others. This is the primary accent drift signal.
- shot_cuts_observed: count visible cuts (not camera moves). 0 = single continuous shot.
- mouth_sync_quality: aggregate across the whole clip — does the audio align with visible lip movement throughout?
- artifacts: only include observed issues; empty array if none. Include "accent drift" if accent switches between lines.
- notes: highlight inconsistencies useful for human review (character face drift across cuts, dialogue from wrong character, audio gaps, accent switches, etc.).

Do NOT include prose, markdown, or commentary. Output ONLY the JSON object.`;
  }

  /**
   * Verify multiple clips, respecting a concurrency cap (Gemini rate limits).
   *
   * Dispatches to verifyCinematicClip() when an item has expectedLines (array),
   * verifyClip() otherwise. Items can be mixed in the same batch.
   *
   * @param {Array} items
   *   Staged form:    { clipPath, expectedDialogue, clipLabel, ... }
   *   Cinematic form: { clipPath, expectedLines, clipLabel, ... }
   * @param {Object} [options]
   * @param {number} [options.concurrency] - Parallel request cap (default 3)
   * @param {Function} [options.onProgress]
   */
  async verifyBatch(items, { concurrency = 3, onProgress } = {}) {
    const results = new Array(items.length);
    let inFlight = 0;
    let nextIndex = 0;
    let completed = 0;

    return new Promise((resolve) => {
      const tryLaunch = () => {
        while (inFlight < concurrency && nextIndex < items.length) {
          const i = nextIndex++;
          inFlight++;
          // Detect cinematic-shape items by presence of expectedLines (array)
          const item = items[i];
          const verifyFn = (Array.isArray(item.expectedLines) && item.expectedLines.length > 0)
            ? () => this.verifyCinematicClip(item)
            : () => this.verifyClip(item);
          verifyFn()
            .then((r) => {
              results[i] = r;
              completed++;
              inFlight--;
              if (onProgress) onProgress({ current: completed, total: items.length, result: r });
              if (completed === items.length) return resolve(results);
              tryLaunch();
            });
        }
      };
      tryLaunch();
    });
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL: Backend router
  // ══════════════════════════════════════════════════════════

  async _analyzeClip(clipPath) {
    if (this.backend === 'whisper') return this._analyzeWithWhisper(clipPath);
    return this._analyzeWithGemini(clipPath);
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL: OpenAI Whisper backend (default)
  // ══════════════════════════════════════════════════════════

  /**
   * Transcribe a clip via OpenAI Whisper API.
   *
   * Whisper accepts .mp4 directly (up to 25 MB) — no ffmpeg audio extraction
   * needed. We request verbose_json + word-level timestamps to get:
   *   - full transcript
   *   - per-word timing (for future SRT generation)
   *   - per-segment no_speech_prob (for silence detection)
   *   - detected language (for "wrong language" artifact detection)
   *
   * Fields not available from Whisper (mouth_sync_quality, character_count)
   * are returned as "unknown"/null — human eyeball at the approval gate
   * catches those. The dialogue-match similarity score is the primary signal.
   */
  async _analyzeWithWhisper(clipPath) {
    const fileBuffer = fs.readFileSync(clipPath);
    const fileSize = fileBuffer.length;
    if (fileSize > 25 * 1024 * 1024) {
      throw new Error(`Clip too large for Whisper (${Math.round(fileSize / 1024 / 1024)}MB > 25MB). Extract audio or compress.`);
    }

    // Node 18+ global FormData + Blob
    const blob = new Blob([fileBuffer], { type: 'video/mp4' });
    const form = new FormData();
    form.append('file', blob, path.basename(clipPath));
    form.append('model', this.model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    // Force English transcription. Our scripts are English-only, and Whisper's
    // auto-detection misidentifies Nigerian-accented English as Yoruba, leading
    // to perfect transcripts getting rejected. Explicit language param fixes this.
    form.append('language', 'en');

    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Whisper API failed (${resp.status}): ${body.slice(0, 300)}`);
    }

    const data = await resp.json();
    const transcript = (data.text || '').trim();

    // Words with timestamps (if returned)
    const words = (data.words || []).map(w => ({
      word: w.word,
      startMs: Math.round((w.start || 0) * 1000),
      endMs: Math.round((w.end || 0) * 1000),
    }));

    // Silence detection via segments' no_speech_prob average
    const segments = data.segments || [];
    const avgNoSpeech = segments.length
      ? segments.reduce((sum, s) => sum + (s.no_speech_prob || 0), 0) / segments.length
      : (transcript ? 0 : 1);

    // Detect artifacts from signals we DO have
    const artifacts = [];
    if (avgNoSpeech > this.SILENCE_NO_SPEECH_THRESHOLD || !transcript) {
      artifacts.push('silence');
    }
    // Whisper's detected language. If non-English and expected is English, flag it.
    // We don't know the expected language here, so just note detection;
    // the caller can compare against storyBrief.accent if needed.
    const detectedLanguage = data.language || '';
    if (detectedLanguage && detectedLanguage.toLowerCase() !== 'english' && detectedLanguage.toLowerCase() !== 'en') {
      artifacts.push(`detected_language:${detectedLanguage}`);
    }

    const notesLines = [];
    if (detectedLanguage) notesLines.push(`language=${detectedLanguage}`);
    if (avgNoSpeech > 0.5) notesLines.push(`avg_no_speech=${avgNoSpeech.toFixed(2)}`);

    return {
      transcript,
      words,
      // Signals Whisper can't provide — human review at approval gate covers them
      mouth_sync_quality: 'unknown',
      character_count: null,
      artifacts,
      notes: notesLines.join(', '),
    };
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL: Gemini backend (fallback / richer analysis)
  // ══════════════════════════════════════════════════════════

  /**
   * Upload a clip to Gemini's File API, then request analysis.
   *
   * Two-step flow:
   *   1. POST to /upload to register the file and get a URI
   *   2. POST to /generateContent with the URI + prompt
   *
   * File API is required because video clips exceed the 20MB inline-base64
   * cap once MIME-encoded, and a single multipart upload is simpler than
   * inline encoding for variable clip sizes.
   */
  async _analyzeWithGemini(clipPath) {
    const fileUri = await this._uploadToGemini(clipPath);

    const prompt = this._buildVerifyPrompt();

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { fileData: { mimeType: 'video/mp4', fileUri } },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.1, // low temp = deterministic transcription
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini analyze failed (${response.status}): ${body.slice(0, 200)}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty response from Gemini');

    return this._safeParseJSON(text);
  }

  async _uploadToGemini(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const mimeType = 'video/mp4';

    // Step 1: Start a resumable upload session
    const startResp = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(fileBuffer.length),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { display_name: fileName } }),
      }
    );
    if (!startResp.ok) {
      const body = await startResp.text().catch(() => '');
      throw new Error(`Gemini upload start failed (${startResp.status}): ${body.slice(0, 200)}`);
    }
    const uploadUrl = startResp.headers.get('x-goog-upload-url') || startResp.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('Gemini upload start: no upload URL returned');

    // Step 2: Upload bytes and finalize
    const uploadResp = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Content-Length': String(fileBuffer.length),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: fileBuffer,
    });
    if (!uploadResp.ok) {
      const body = await uploadResp.text().catch(() => '');
      throw new Error(`Gemini upload bytes failed (${uploadResp.status}): ${body.slice(0, 200)}`);
    }
    const uploadData = await uploadResp.json();
    const fileUri = uploadData?.file?.uri;
    const fileState = uploadData?.file?.state;
    if (!fileUri) throw new Error('Gemini upload: no file URI returned');

    // Step 3: Wait for file to become ACTIVE (Gemini processes video async)
    // Poll up to 60s for ACTIVE state
    if (fileState !== 'ACTIVE') {
      const fileName2 = uploadData.file.name;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const stateResp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/${fileName2}?key=${this.apiKey}`
        );
        if (stateResp.ok) {
          const stateData = await stateResp.json();
          if (stateData.state === 'ACTIVE') break;
          if (stateData.state === 'FAILED') {
            throw new Error(`Gemini file processing failed: ${JSON.stringify(stateData).slice(0, 200)}`);
          }
        }
      }
    }

    return fileUri;
  }

  _buildVerifyPrompt() {
    return `You are verifying a short AI-generated video clip. Transcribe the spoken dialogue VERBATIM and assess quality issues.

Return ONLY a JSON object with this exact schema (no prose, no markdown):

{
  "transcript": "verbatim spoken dialogue with punctuation",
  "words": [{ "word": "hello", "startMs": 100, "endMs": 450 }],
  "mouth_sync_quality": "matches" | "off" | "partial" | "silent",
  "artifacts": ["silence", "background music", "wrong language", "foreign accent", ...],
  "character_count": <integer: number of visible people in frame>,
  "notes": "freeform issues like 'final word cut off' or 'speaker unclear'"
}

Rules:
- transcript: exact words spoken, no paraphrasing. Include punctuation natural to speech.
- words: optional; if you can infer timing, include it. Otherwise return [].
- mouth_sync_quality:
    "matches"  - speaker's lips align with audio
    "partial"  - mostly aligned but some drift
    "off"      - lips and audio are clearly mismatched
    "silent"   - no audible dialogue / only ambient sound
- artifacts: list any of: "silence", "background music", "wrong language", "foreign accent", "echo", "static", "speaker shifts mid-clip", "last word cut off", "stutter", "repeat". Empty array if none.
- character_count: integer — how many distinct people are visible.
- notes: any extra observations in plain English. Empty string if none.

Do NOT include prose, markdown, or commentary. Output ONLY the JSON object.`;
  }

  _safeParseJSON(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      // Try to extract JSON from markdown code fences or trailing prose
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch (_) {}
      }
      throw new Error(`Gemini returned unparseable JSON: ${text.slice(0, 200)}`);
    }
  }

  // ══════════════════════════════════════════════════════════
  // INTERNAL: Similarity + tiering
  // ══════════════════════════════════════════════════════════

  /**
   * Compute a similarity score (0-100) between the actual transcribed dialogue
   * and the expected dialogue, with trailing-word forgiveness.
   */
  _computeSimilarity(transcribed, expected) {
    if (!expected || !expected.trim()) return 100; // no expected text = nothing to fail
    if (!transcribed || !transcribed.trim()) return 0;

    const norm = s => (s || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s']/gu, ' ') // keep letters/digits/apostrophes, rest → space
      .replace(/\s+/g, ' ')
      .trim();

    const a = norm(transcribed);
    const b = norm(expected);
    if (a === b) return 100;

    // Trailing-word forgiveness: trim last TAIL_FORGIVE_PCT of expected
    const bWords = b.split(' ');
    const keepCount = Math.max(1, Math.ceil(bWords.length * (1 - this.TAIL_FORGIVE_PCT)));
    const bCore = bWords.slice(0, keepCount).join(' ');

    // Compute similarity against both full expected and core (trimmed tail)
    const simFull = this._levenshteinSimilarity(a, b);
    const simCore = this._levenshteinSimilarity(
      a.split(' ').slice(0, keepCount).join(' '),
      bCore
    );

    // Take the better score (gives tail-forgive benefit without requiring it)
    return Math.round(Math.max(simFull, simCore));
  }

  _levenshteinSimilarity(a, b) {
    if (!a && !b) return 100;
    if (!a || !b) return 0;
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 100;
    const distance = this._levenshtein(a, b);
    return Math.max(0, (1 - distance / maxLen) * 100);
  }

  _levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    // Two-row dynamic programming
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,        // deletion
          curr[j - 1] + 1,    // insertion
          prev[j - 1] + cost  // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  /**
   * Decide the tier (accept/review/reject) based on similarity + soft signals.
   * Even a perfect transcript match gets downgraded if mouth_sync is "off" or
   * artifacts indicate silence, because those are genuinely unwatchable.
   */
  _tierForScore(similarity, mouthSync, artifacts) {
    // ── HARD REJECTS (only truly unambiguous signals) ──
    // These are cases where we know for certain something is broken:
    //   - mouth_sync=silent: Gemini explicitly said no dialogue audio
    //   - artifacts.silence: audio track is genuinely empty
    //   - artifacts.wrong language (explicit, not auto-detected): Gemini confirmed wrong language
    // Notably we do NOT reject on `detected_language:*` from Whisper — auto-detection
    // is wrong too often on accented English to trust.
    if (mouthSync === 'silent') return 'reject';
    if (artifacts && artifacts.includes('silence')) return 'reject';
    if (artifacts && artifacts.includes('wrong language')) return 'reject';

    // ── TWO-TIER SIMILARITY ──
    // Clear win → auto-accept. Anything else → human review.
    // We never auto-reject based on similarity alone because transcription
    // errors cause false positives (real-world test: 3/4 auto-rejects were
    // false — Whisper garbled accented English, clips were actually fine).
    let tier = similarity >= this.ACCEPT_THRESHOLD ? 'accept' : 'review';

    // ── SOFT DOWNGRADES ON ACCEPT-TIER CLIPS ──
    // Don't blindly accept if Gemini flagged secondary concerns. Move to review.
    if (tier === 'accept' && mouthSync === 'off') tier = 'review';
    if (tier === 'accept' && artifacts && artifacts.includes('speaker shifts mid-clip')) tier = 'review';
    if (tier === 'accept' && artifacts && artifacts.some(a => a.startsWith('detected_language:'))) {
      tier = 'review';
    }

    return tier;
  }
}

module.exports = { ClipVerifier };
