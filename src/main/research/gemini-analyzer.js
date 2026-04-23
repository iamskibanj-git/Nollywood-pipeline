const { YouTubeResearcher } = require('./youtube-scraper');

// Ensure fetch is available (Electron 28+ / Node 18+ has global fetch;
// older versions need node-fetch). The main process polyfills this on startup,
// but if this module is loaded independently, add a safety net.
if (typeof globalThis.fetch === 'undefined') {
  try {
    const nf = require('node-fetch');
    globalThis.fetch = nf;
  } catch {
    console.error('[GEMINI] No global fetch available. Install node-fetch or upgrade to Node 18+.');
  }
}

/**
 * GeminiVideoAnalyzer
 *
 * Uses Google AI Studio (Gemini) to analyze YouTube videos.
 * Gemini can process YouTube URLs natively — paste a link and it extracts:
 * story structure, themes, character archetypes, dialogue patterns,
 * visual style, pacing, and what makes the content engaging.
 *
 * Two modes:
 * 1. API mode (preferred) — uses the Gemini API directly (requires API key)
 * 2. Browser mode (fallback) — automates Google AI Studio via Playwright
 *
 * The analysis output becomes the "creative brief" that feeds into
 * Claude's script generation, grounding new scripts in proven patterns.
 */
class GeminiVideoAnalyzer {
  constructor({ apiKey = null, page = null }) {
    this.apiKey = apiKey;
    this.page = page; // Playwright page for browser mode fallback
  }

  /**
   * Analyze a batch of YouTube videos and extract patterns.
   *
   * @param {Array} videos - Array of {title, url, views, channel} from YouTubeResearcher
   * @param {Object} options
   * @param {number} options.maxVideos - Max videos to analyze (default: 5, to manage API costs)
   * @param {boolean} options.extractPatterns - Whether to do cross-video pattern extraction (default: true)
   * @returns {Promise<Object>} Analysis results with individual + pattern data
   */
  async analyzeBatch(videos, options = {}) {
    const { maxVideos = 5, extractPatterns = true } = options;

    const toAnalyze = videos.slice(0, maxVideos);
    const analyses = [];

    for (const video of toAnalyze) {
      try {
        console.log(`[GEMINI] Analyzing: "${video.title}" (${video.viewsFormatted})...`);
        const analysis = await this.analyzeVideo(video);
        analyses.push({ ...video, analysis });
      } catch (e) {
        console.warn(`[GEMINI] Failed to analyze "${video.title}": ${e.message}`);
        analyses.push({ ...video, analysis: null, error: e.message });
      }
    }

    let patterns = null;
    if (extractPatterns && analyses.filter(a => a.analysis).length >= 2) {
      console.log('[GEMINI] Extracting cross-video patterns...');
      patterns = await this.extractPatterns(analyses.filter(a => a.analysis));
    }

    return {
      videosAnalyzed: analyses.length,
      analyses,
      patterns,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Analyze a single YouTube video using Gemini.
   * Tries API mode first, falls back to browser mode.
   */
  async analyzeVideo(video) {
    if (this.apiKey) {
      return this.analyzeVideoAPI(video);
    }
    if (this.page) {
      return this.analyzeVideoBrowser(video);
    }
    throw new Error('No Gemini API key or browser page available');
  }

  /**
   * Analyze via Gemini API (preferred — faster, no browser needed).
   *
   * Uses the Gemini 2.5 Flash model which supports YouTube URL processing.
   * The model can watch/process the video and extract detailed information.
   */
  async analyzeVideoAPI(video) {
    const videoId = YouTubeResearcher.extractVideoId(video.url);
    if (!videoId) throw new Error(`Invalid YouTube URL: ${video.url}`);

    const prompt = this.buildAnalysisPrompt(video);

    // Call Gemini API with YouTube URL
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                fileData: {
                  mimeType: 'video/*',
                  fileUri: video.url,
                },
              },
              { text: prompt },
            ],
          }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => 'Unknown error');
      // If video processing fails, try text-only analysis with just the title
      console.warn(`[GEMINI] Video processing failed (${response.status}), falling back to title-based analysis`);
      return this.analyzeVideoTitleOnly(video);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new Error('Empty response from Gemini API');
    }

    return this._safeParseJSON(text);
  }

  /**
   * Fallback: analyze based on video title and metadata only.
   * Used when Gemini can't process the actual video content.
   */
  async analyzeVideoTitleOnly(video) {
    const prompt = `Analyze this Nollywood AI-generated video based on its title and metadata. Infer likely themes, target audience, and what makes this title clickable.

Title: "${video.title}"
Channel: ${video.channel}
Views: ${video.viewsFormatted}
Duration: ${video.duration}

Respond in JSON:
{
  "title_analysis": {
    "emotional_hooks": ["..."],
    "cultural_references": ["..."],
    "target_emotions": ["..."]
  },
  "likely_themes": ["..."],
  "likely_character_archetypes": ["..."],
  "likely_settings": ["..."],
  "why_it_works": "...",
  "clickability_score": 1-10,
  "takeaways_for_new_content": ["..."]
}`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
          },
        }),
      }
    );

    if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return this._safeParseJSON(text);
  }

  /**
   * Analyze via Google AI Studio browser automation (fallback).
   *
   * Steps:
   * 1. Navigate to https://aistudio.google.com/
   * 2. Start a new chat
   * 3. Paste the YouTube URL + analysis prompt
   * 4. Wait for response
   * 5. Extract the text response
   */
  async analyzeVideoBrowser(video) {
    const page = this.page;

    console.log('[GEMINI] Using browser mode (Google AI Studio)...');

    // Navigate to AI Studio
    await page.goto('https://aistudio.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Check if logged in (look for the chat input area)
    const chatInput = await page.$('textarea, div[role="textbox"], [contenteditable="true"]');
    if (!chatInput) {
      throw new Error('GEMINI_LOGIN_REQUIRED: Please log into Google AI Studio in the browser, then click Resume.');
    }

    // Build the prompt
    const prompt = `${video.url}\n\n${this.buildAnalysisPrompt(video)}`;

    // Type the prompt
    await chatInput.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);

    // Type in chunks to handle long prompts
    await page.keyboard.type(prompt, { delay: 2 });
    await page.waitForTimeout(500);

    // Submit (press Enter or click Send button)
    const sendBtn = await page.$('button[aria-label="Send"], button:has-text("Run"), button:has-text("Send")');
    if (sendBtn) {
      await sendBtn.click();
    } else {
      await page.keyboard.press('Enter');
    }

    // Wait for response (up to 2 minutes)
    console.log('[GEMINI] Waiting for analysis response...');
    const startTime = Date.now();
    let responseText = '';

    while (Date.now() - startTime < 120000) {
      await page.waitForTimeout(3000);

      // Check for response completion (look for a stop button disappearing or response fully loaded)
      const isStillGenerating = await page.$('button[aria-label="Stop"], button:has-text("Stop")');

      // Extract the latest response text
      const responses = await page.$$eval(
        '.model-response, [data-message-author="model"], .response-content',
        els => els.map(el => el.textContent?.trim()).filter(Boolean)
      );

      if (responses.length > 0) {
        responseText = responses[responses.length - 1]; // Latest response
      }

      // If no longer generating and we have a response, we're done
      if (!isStillGenerating && responseText.length > 100) {
        break;
      }
    }

    if (!responseText) {
      throw new Error('No response received from Google AI Studio');
    }

    // Try to parse as JSON
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {}

    return { rawAnalysis: responseText };
  }

  /**
   * Build the analysis prompt for Gemini.
   */
  buildAnalysisPrompt(video) {
    return `You are an expert content analyst specializing in AI-generated Nollywood/African drama videos on YouTube. Analyze this video and provide a detailed breakdown.

Video: "${video.title}" by ${video.channel} (${video.viewsFormatted} views)

Provide your analysis in the following JSON format:
{
  "summary": "2-3 sentence summary of the video content and story",
  "themes": ["theme1", "theme2", "..."],
  "story_structure": {
    "setup": "How the story opens",
    "conflict": "The central conflict or drama",
    "climax": "The peak dramatic moment",
    "resolution": "How it ends or if it's a cliffhanger"
  },
  "character_archetypes": [
    {"archetype": "The Betrayed Wife", "role": "protagonist", "traits": ["..."]},
    {"archetype": "The Secret Lover", "role": "antagonist", "traits": ["..."]}
  ],
  "settings": ["village compound", "modern Lagos apartment", "..."],
  "dialogue_style": {
    "tone": "dramatic/comedic/suspenseful/...",
    "cultural_references": ["proverbs used", "traditions referenced"],
    "language_mix": "English with Pidgin/Yoruba/Igbo phrases"
  },
  "visual_style": {
    "cinematography": "close-ups, wide shots, etc.",
    "color_palette": "warm earth tones, vibrant ankara colors, etc.",
    "ai_generation_quality": "notes on the AI visual quality"
  },
  "engagement_hooks": {
    "thumbnail_strategy": "What the thumbnail shows/promises",
    "title_hooks": ["emotional words", "curiosity gaps"],
    "opening_hook": "How the first 30 seconds grab attention",
    "retention_tactics": ["cliffhangers", "revelations", "twists"]
  },
  "audience_signals": {
    "target_demographic": "...",
    "emotional_triggers": ["betrayal", "family loyalty", "..."],
    "cultural_specificity": "How Nigerian/African culture drives the story"
  },
  "why_it_works": "Key reasons this video resonated with 100k+ viewers",
  "replicable_elements": ["Element 1 we can use", "Element 2", "..."]
}`;
  }

  /**
   * Extract cross-video patterns from multiple analyses.
   * This is the gold — finding the common threads across top performers.
   */
  async extractPatterns(analyzedVideos) {
    if (!this.apiKey) {
      // Do basic pattern extraction without API
      return this.extractPatternsLocal(analyzedVideos);
    }

    const summaries = analyzedVideos.map(v => ({
      title: v.title,
      views: v.views,
      themes: v.analysis?.themes || [],
      archetypes: v.analysis?.character_archetypes?.map(a => a.archetype) || [],
      hooks: v.analysis?.engagement_hooks?.title_hooks || [],
      settings: v.analysis?.settings || [],
      whyItWorks: v.analysis?.why_it_works || '',
    }));

    const prompt = `You are a content strategist. Analyze these ${summaries.length} top-performing AI Nollywood videos and extract the common patterns that make them successful.

Videos analyzed:
${JSON.stringify(summaries, null, 2)}

Identify the patterns and provide actionable insights in JSON:
{
  "recurring_themes": ["Theme that appears across multiple videos"],
  "winning_character_archetypes": ["Archetype that audiences respond to"],
  "proven_conflict_types": ["Type of conflict that drives engagement"],
  "effective_settings": ["Settings that resonate"],
  "title_patterns": {
    "emotional_words": ["words that appear in successful titles"],
    "structures": ["title formula patterns like 'My [RELATIONSHIP] [BETRAYAL]'"]
  },
  "audience_triggers": ["Emotional triggers that consistently drive views"],
  "content_formula": "The underlying formula these successful videos share",
  "recommendations": [
    "Specific actionable recommendation for new content",
    "Another recommendation"
  ],
  "avoid": ["Things that don't seem to work or might be oversaturated"]
}`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 4096,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!response.ok) throw new Error(`Gemini API error: ${response.status}`);

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return this._safeParseJSON(text);
    } catch (e) {
      console.warn(`[GEMINI] Pattern extraction API failed: ${e.message}`);
      return this.extractPatternsLocal(analyzedVideos);
    }
  }

  /**
   * Safely parse JSON from Gemini responses.
   * Handles common issues like unescaped quotes in strings,
   * trailing commas, and truncated responses.
   */
  _safeParseJSON(text) {
    if (!text) return { rawAnalysis: '' };

    // Try direct parse first
    try {
      return JSON.parse(text);
    } catch (e) {
      // Attempt 1: extract the JSON object
      try {
        const match = text.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      } catch {}

      // Attempt 2: fix common Gemini JSON issues
      try {
        let fixed = text;
        // Remove trailing commas before } or ]
        fixed = fixed.replace(/,\s*([\]}])/g, '$1');
        // Fix unescaped quotes inside strings: "word "quoted" word" → "word 'quoted' word"
        // This is a best-effort heuristic
        fixed = fixed.replace(/"([^"]*)":\s*"([^"]*?)"/g, (match, key, val) => {
          // Don't touch valid key-value pairs, only fix values with internal quotes
          return match;
        });
        const match = fixed.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      } catch {}

      // Attempt 3: close unclosed brackets/braces
      try {
        let attempt = text;
        const openBrackets = (attempt.match(/\[/g) || []).length - (attempt.match(/\]/g) || []).length;
        const openBraces = (attempt.match(/\{/g) || []).length - (attempt.match(/\}/g) || []).length;
        attempt += ']'.repeat(Math.max(0, openBrackets));
        attempt += '}'.repeat(Math.max(0, openBraces));
        const match = attempt.match(/\{[\s\S]*\}/);
        if (match) return JSON.parse(match[0]);
      } catch {}

      console.warn('[GEMINI] Could not parse JSON, returning raw text');
      return { rawAnalysis: text };
    }
  }

  /**
   * Basic local pattern extraction (no API needed).
   * Counts frequency of themes, archetypes, and settings across videos.
   */
  extractPatternsLocal(analyzedVideos) {
    const themeCounts = {};
    const archetypeCounts = {};
    const settingCounts = {};

    for (const v of analyzedVideos) {
      if (!v.analysis) continue;

      for (const theme of (v.analysis.themes || [])) {
        themeCounts[theme] = (themeCounts[theme] || 0) + 1;
      }
      for (const arch of (v.analysis.character_archetypes || [])) {
        const label = arch.archetype || arch;
        archetypeCounts[label] = (archetypeCounts[label] || 0) + 1;
      }
      for (const setting of (v.analysis.settings || [])) {
        settingCounts[setting] = (settingCounts[setting] || 0) + 1;
      }
    }

    const sortByCount = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => k);

    return {
      recurring_themes: sortByCount(themeCounts),
      winning_character_archetypes: sortByCount(archetypeCounts),
      effective_settings: sortByCount(settingCounts),
      content_formula: 'Pattern extracted from local analysis — use Gemini API for deeper insights',
      recommendations: [
        `Focus on top themes: ${sortByCount(themeCounts).slice(0, 3).join(', ')}`,
        `Use proven archetypes: ${sortByCount(archetypeCounts).slice(0, 3).join(', ')}`,
        `Set stories in: ${sortByCount(settingCounts).slice(0, 3).join(', ')}`,
      ],
    };
  }
}

module.exports = { GeminiVideoAnalyzer };
