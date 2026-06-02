const Anthropic = require('@anthropic-ai/sdk');

class PromoCopyGenerator {
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('Claude API key required for promo copy generation');
    this.client = new Anthropic({ apiKey });
    this.model = options.model || 'claude-sonnet-4-6';
  }

  async generateCharacterSpotlight({ project, character, post }) {
    let lastError = null;
    let parsed = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = this._buildPrompt({ project, character, post, lastError });
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1000,
        temperature: 0.7,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content?.[0]?.text || '';
      try {
        parsed = this._parseJson(text);
        this._validate(parsed);
        break;
      } catch (error) {
        lastError = error.message;
        if (attempt === 2) throw error;
      }
    }

    return {
      title: parsed.title,
      body: parsed.caption,
      hashtags: parsed.hashtags,
      caption_json: {
        title: parsed.title,
        caption: parsed.caption,
        hashtags: parsed.hashtags,
        hook: parsed.hook || '',
        cta: parsed.cta || '',
        post_type: post.post_type,
        generated_by: this.model,
      },
    };
  }

  _buildPrompt({ project, character, post, lastError }) {
    const projectTitle = project.title || 'Untitled Nollywood Drama';
    const projectTag = this._tagFromTitle(projectTitle);
    const retryNote = lastError
      ? `\nIMPORTANT: Your previous draft was rejected because: ${lastError}. Fix that issue in this response.\n`
      : '';

    return `You are writing a Facebook image post for a Nollywood/African drama page.
${retryNote}

Write a SPOILER-FREE "meet the cast" character spotlight for the movie/script "${projectTitle}".

POST SCHEDULE:
- Date: ${post.scheduled_date || ''}
- Time: ${post.scheduled_time || ''}

CHARACTER:
${JSON.stringify({
  name: character?.name || post.source_character_id || 'Character',
  role: character?.role || '',
  description_label: character?.description_label || '',
  physical_description: character?.physical_description || '',
  speech_style: character?.speech_style || '',
  speech_notes: character?.speech_notes || '',
  element_name_hint: character?.elementNameHint || post.source_character_element_name || '',
}, null, 2)}

STYLE:
- Open with a natural "Meet [Name]" or equivalent cast-introduction hook.
- Conversational, emotionally direct, and comment-driven.
- Nigerian/Nollywood drama audience.
- Use the project title/tag naturally.
- Build curiosity from the character description, public face, private pressure, loyalty, flaw, fear, or power.
- Ask a question that invites comments.
- Emojis are allowed but keep them tasteful and sparse.
- Do not use Markdown formatting. No **bold**, bullet lists, headings, or numbered lists.
- Length: 70-120 words.

STRICT SPOILER RULES:
- Do not reveal outcomes, twists, betrayals, arrests, deaths, court/legal results, final choices, reconciliations, or endings.
- Do not claim a specific story event unless it is in the character description above.
- Do not mention Reels, episodes, clips, chapter numbers, scene numbers, source clips, or any internal production structure.
- Do not say "coming soon", "new movie", or imply the movie has not started.
- Do not hardcode BLOODLINES unless the project title is Bloodlines.
- Do not use weekday-specific hashtags.

Return ONLY valid JSON:
{
  "title": "short internal title under 60 chars",
  "hook": "opening hook line",
  "caption": "full Facebook caption with line breaks and hashtags at the end",
  "cta": "comment question or CTA",
  "hashtags": ["#${projectTag}", "#NollywoodDrama"]
}`;
  }

  _parseJson(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Promo copy generation returned invalid JSON');
    return JSON.parse(match[0]);
  }

  _validate(value) {
    if (!value || typeof value !== 'object') throw new Error('Promo copy JSON is not an object');
    if (!value.caption || typeof value.caption !== 'string') throw new Error('Promo copy JSON missing caption');
    if (!Array.isArray(value.hashtags) || value.hashtags.length === 0) throw new Error('Promo copy JSON missing hashtags');
    if (!value.title || typeof value.title !== 'string') value.title = 'Character spotlight';

    const caption = value.caption.replace(/\u00ad/g, '').trim();
    const words = caption.replace(/(^|\s)#[^\s#]+/g, ' ').split(/\s+/).filter(Boolean).length;
    if (words > 135) throw new Error(`promo caption too long (${words} words; max 135)`);
    if (/\bchapter\s+\d+|\bscene\s+\d+|\bclip\s+\d+|source clips?|reels?\b|episodes?\b/i.test(caption)) {
      throw new Error('caption mentions internal production or Reel structure');
    }
    if (/\b(coming soon|is coming|new movie)\b/i.test(caption)) {
      throw new Error('caption implies the movie/campaign has not started');
    }
    if (/\b(dies?|death|dead|arrested|cleared her name|forgeries?|walked out|walks out|finally|ending|twist|betrays?|betrayal|reconciles?|wins?|loses?|confesses?)\b/i.test(caption)) {
      throw new Error('caption may reveal a plot outcome or spoiler');
    }

    const weekdayTag = /^#?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(drama|movie|reel|reels|story|stories)?$/i;
    value.hashtags = value.hashtags
      .map(tag => String(tag || '').trim())
      .filter(Boolean)
      .map(tag => tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`)
      .filter(tag => !weekdayTag.test(tag))
      .slice(0, 7);

    const captionWithoutTags = caption
      .replace(/(^|\s)#[^\s#]+/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    value.caption = `${captionWithoutTags}\n\n${value.hashtags.join(' ')}`.trim();
  }

  _tagFromTitle(title) {
    const raw = String(title || 'NollywoodDrama')
      .replace(/[^a-z0-9]+/gi, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join('');
    return raw || 'NollywoodDrama';
  }
}

module.exports = { PromoCopyGenerator };
