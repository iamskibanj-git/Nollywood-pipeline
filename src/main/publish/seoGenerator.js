/**
 * SEO Generator — YouTube + Facebook metadata generation via Claude.
 *
 * Takes a completed project (script, characters, research brief) and
 * generates platform-specific SEO metadata:
 *   - YouTube: title, description, tags, hashtags, category
 *   - Facebook: caption with first-line hook, hashtags
 *
 * All output is persisted as JSON in the projects table and written to
 * human-readable .txt files in the output folder.
 */

const Anthropic = require('@anthropic-ai/sdk');

class SEOGenerator {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Generate YouTube metadata package.
   *
   * @param {object} project - Project data with script, characters, research brief
   * @param {object} options - { channelName, subscribeUrl }
   * @returns {object} { title, titleShort, description, tags, hashtags, category }
   */
  async generateYouTubeMetadata(project, options = {}) {
    const { channelName, subscribeUrl } = options;
    const scriptTitle = project.title || 'Untitled';
    const characters = this._extractCharacters(project);
    const themes = this._extractThemes(project);
    const synopsis = this._buildSynopsis(project);

    const prompt = `You are a YouTube SEO expert for Nollywood drama content. Generate metadata for a video upload.

PROJECT DETAILS:
- Title: "${scriptTitle}"
- Characters: ${characters}
- Themes: ${themes}
- Synopsis: ${synopsis}
${channelName ? `- Channel: ${channelName}` : ''}

REQUIREMENTS:

1. **title** (string): YouTube-optimized title, 60-100 characters. Hook within first 50 chars. Must feel like a real Nollywood YouTube title — dramatic, emotional, intriguing. NO clickbait lies, NO all-caps shouting, NO fake urgency like "WATCH BEFORE DELETED". The title should make viewers curious about the story.

2. **titleShort** (string): Shorter variant under 60 characters for mobile-friendly display. Same hook, tighter wording.

3. **hashtags** (array of 5 strings): Above-title hashtags. Include #nollywood and 4 genre/theme-specific tags. No spaces in tags. Lowercase.

4. **description** (string): 300-800 word YouTube description. Structure:
   - Line 1: One-sentence hook that creates curiosity (NOT the title repeated)
   - Blank line
   - 2-3 paragraph synopsis that teases the story without spoiling the ending
   - Blank line
   - "CHARACTERS:" section listing main characters and their role in the story
   - Blank line
   - Relevant hashtags (same 5 from above)
   ${channelName ? `- Blank line\n   - "Subscribe to ${channelName} for more Nollywood drama: ${subscribeUrl || '[channel link]'}"` : ''}

5. **tags** (array of 15-20 strings): YouTube tags for discoverability. Mix of broad ("nollywood movie", "african drama") and specific (character names, themes). Total under 500 characters combined.

6. **category** (string): YouTube category. Almost always "Entertainment" or "Film & Animation" for Nollywood content.

Reply with ONLY valid JSON matching this schema:
{
  "title": "...",
  "titleShort": "...",
  "hashtags": ["#nollywood", ...],
  "description": "...",
  "tags": ["nollywood movie", ...],
  "category": "Entertainment"
}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '';
    return this._parseJSON(text, 'YouTube metadata');
  }

  /**
   * Generate Facebook caption and hashtags.
   *
   * @param {object} project - Project data
   * @param {object} youtubeMetadata - Previously generated YouTube metadata for cross-reference
   * @returns {object} { caption, hashtags }
   */
  async generateFacebookCaption(project, youtubeMetadata = {}) {
    const scriptTitle = project.title || 'Untitled';
    const synopsis = this._buildSynopsis(project);

    const prompt = `You are a social media expert for Nollywood drama content. Generate a Facebook video post caption.

PROJECT:
- Title: "${scriptTitle}"
- Synopsis: ${synopsis}
- YouTube title (for reference, don't copy): "${youtubeMetadata.title || scriptTitle}"

REQUIREMENTS:

1. **caption** (string): Facebook caption for a native video upload. Structure:
   - Line 1: Bold hook that stops the scroll. Short, punchy, emotional. This is the ONLY line visible before "See more" — it must create curiosity.
   - Blank line
   - 2-3 sentences expanding on the hook. Conversational tone, like talking to a friend. Ask a question or pose a dilemma the viewer relates to.
   - Blank line
   - Call to action: "Watch till the end" or similar organic CTA
   - Blank line
   - Hashtags on the last line

2. **hashtags** (array of 3-5 strings): Facebook hashtags. Fewer than YouTube — quality over quantity. Include #nollywood and 2-4 relevant tags. Spammy hashtag walls reduce Facebook reach.

Facebook style is DIFFERENT from YouTube:
- More conversational, less SEO-focused
- First line is everything (it's the only thing shown before "See more")
- Shorter overall — 100-200 words max
- Questions and emotional hooks work better than descriptions

Reply with ONLY valid JSON:
{
  "caption": "...",
  "hashtags": ["#nollywood", ...]
}`;

    const response = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '';
    return this._parseJSON(text, 'Facebook caption');
  }

  /**
   * Write metadata files to the output directory.
   */
  writeOutputFiles(outputDir, youtubeMetadata, facebookMetadata) {
    const fs = require('fs');
    const path = require('path');

    fs.mkdirSync(outputDir, { recursive: true });

    // metadata.json — machine-readable, all platforms
    const combined = {
      generatedAt: new Date().toISOString(),
      youtube: youtubeMetadata,
      facebook: facebookMetadata,
    };
    fs.writeFileSync(
      path.join(outputDir, 'metadata.json'),
      JSON.stringify(combined, null, 2),
      'utf-8'
    );

    // youtube.txt — copy/paste ready
    const ytLines = [];
    if (youtubeMetadata.hashtags?.length) {
      ytLines.push(youtubeMetadata.hashtags.join(' '));
      ytLines.push('');
    }
    ytLines.push(`TITLE: ${youtubeMetadata.title}`);
    if (youtubeMetadata.titleShort) {
      ytLines.push(`TITLE (short): ${youtubeMetadata.titleShort}`);
    }
    ytLines.push('');
    ytLines.push('DESCRIPTION:');
    ytLines.push(youtubeMetadata.description || '');
    ytLines.push('');
    ytLines.push(`TAGS: ${(youtubeMetadata.tags || []).join(', ')}`);
    ytLines.push('');
    ytLines.push(`CATEGORY: ${youtubeMetadata.category || 'Entertainment'}`);
    fs.writeFileSync(path.join(outputDir, 'youtube.txt'), ytLines.join('\n'), 'utf-8');

    // facebook.txt — copy/paste ready
    const fbLines = [];
    fbLines.push('CAPTION:');
    fbLines.push(facebookMetadata.caption || '');
    fs.writeFileSync(path.join(outputDir, 'facebook.txt'), fbLines.join('\n'), 'utf-8');
  }

  // ── Helpers ──

  _extractCharacters(project) {
    try {
      const script = typeof project.scriptJson === 'string'
        ? JSON.parse(project.scriptJson) : project.scriptJson;
      if (script?.character_bible) {
        return script.character_bible
          .map(c => `${c.name} (${c.role || c.archetype || 'character'})`)
          .join(', ');
      }
    } catch (_) {}
    return 'N/A';
  }

  _extractThemes(project) {
    try {
      const script = typeof project.scriptJson === 'string'
        ? JSON.parse(project.scriptJson) : project.scriptJson;
      if (script?.themes) return script.themes.join(', ');
      if (script?.story_brief?.themes) return script.story_brief.themes.join(', ');
    } catch (_) {}
    return 'drama, family, betrayal';
  }

  _buildSynopsis(project) {
    try {
      const script = typeof project.scriptJson === 'string'
        ? JSON.parse(project.scriptJson) : project.scriptJson;
      if (script?.synopsis) return script.synopsis;
      if (script?.logline) return script.logline;
      // Build from chapters
      if (script?.chapters) {
        return script.chapters
          .map((ch, i) => `Chapter ${i + 1}: ${ch.title || ''} — ${ch.scenes?.[0]?.description || ''}`)
          .join('. ');
      }
    } catch (_) {}
    return project.title || 'A Nollywood drama.';
  }

  _parseJSON(text, label) {
    // Extract JSON from potential markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
    const cleaned = jsonMatch[1].trim();
    try {
      return JSON.parse(cleaned);
    } catch (e) {
      console.error(`[SEO] Failed to parse ${label} JSON:`, e.message);
      console.error(`[SEO] Raw text:`, text.substring(0, 500));
      throw new Error(`Failed to parse ${label} response as JSON`);
    }
  }
}

module.exports = { SEOGenerator };
