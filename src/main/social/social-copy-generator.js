const Anthropic = require('@anthropic-ai/sdk');

class SocialCopyGenerator {
  constructor(apiKey, options = {}) {
    if (!apiKey) throw new Error('Claude API key required for social post copy generation');
    this.client = new Anthropic({ apiKey });
    this.model = options.model || 'claude-sonnet-4-6';
  }

  async generatePost({ post, project, character, shortContext }) {
    let lastError = null;
    let parsed = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = this._buildPrompt({ post, project, character, shortContext, lastError });
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 1200,
        temperature: 0.75,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content?.[0]?.text || '';
      try {
        parsed = this._parseJson(text);
        this._validate(parsed, post.post_type, { isSceneFocusedCharacter: post.post_type === 'character_intro' && !!shortContext });
        lastError = null;
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

  _buildPrompt({ post, project, character, shortContext, lastError }) {
    const projectTitle = project.title || 'Untitled Nollywood Drama';
    const projectTag = this._tagFromTitle(projectTitle);
    const retryNote = lastError
      ? `\nIMPORTANT: Your previous draft was rejected because: ${lastError}. Fix that issue in this response.\n`
      : '';

    const isSceneFocusedCharacter = post.post_type === 'character_intro' && shortContext;
    if (post.post_type === 'character_intro') {
      const dialogue = (shortContext?.dialogueLines || [])
        .map(l => `${l.speaker_id || 'Speaker'}: ${l.dialogue}`)
        .join('\n');
      const scenes = (shortContext?.scenes || [])
        .map(s => `${s.location} ${s.location_details}`)
        .join('\n');
      return `You are writing a Facebook image post for a Nollywood/African drama page.
${retryNote}

Write a ${isSceneFocusedCharacter ? 'SCENE-FOCUSED CHARACTER SPOTLIGHT' : 'CHARACTER INTRODUCTION'} post for the movie/script "${projectTitle}".

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

${isSceneFocusedCharacter ? `THIS POST GOES OUT BEFORE THE REEL:
- This is a 12 PM Type 1B post before the 3 PM teaser, 6 PM Reel, and 9 PM recap.
- Use the Reel context only to understand the character's emotional tension.
- Do not reveal the outcome, resolution, twist, legal result, final decision, or last-scene payoff.
- Avoid outcome phrases such as "walked out", "cleared her name", "free", "forgeries", "never going back", "finally exhales", or "final walk".
- Frame the character through what they are carrying, about to face, or struggling to decide.
- Type 2 will tease the Reel directly. Type 4 is the only post allowed to discuss what happened.

REEL DIALOGUE, IN CHRONOLOGICAL ORDER:
${dialogue || '(No dialogue resolved.)'}

SCENE CONTEXT:
${scenes || '(No scene context resolved.)'}
` : ''}

STYLE:
- Similar energy to a Facebook drama fan-page post.
- Conversational, emotionally direct, and comment-driven.
- Nigerian/Nollywood drama audience.
- Build curiosity around the character, but do not claim a specific episode event unless provided.
- Mention the character by name.
- Ask a question that invites comments.
- Emojis are allowed but keep them tasteful and sparse.
- Do not use Markdown formatting. No **bold**, bullet lists, headings, or numbered lists.
- Length: 80-140 words.
- Do not say "coming", "coming soon", "new movie", or imply the whole movie has not started.
- Make the character feel vivid: public face vs private behavior, secret, flaw, loyalty, fear, or power.
- Do not hardcode BLOODLINES unless the project title is Bloodlines.
- Use the project title/tag naturally.
- Do not use weekday-specific hashtags like #FridayDrama unless explicitly requested.
- Never mention internal production structure such as chapter numbers, scene numbers, clip numbers, source clips, or "Chapter 9".

Return ONLY valid JSON:
{
  "title": "short internal title under 60 chars",
  "hook": "opening hook line",
  "caption": "full Facebook caption with line breaks and hashtags at the end",
  "cta": "comment question or CTA",
  "hashtags": ["#${projectTag}", "#DramaSeries"]
}`;
    }

    const isPre = post.post_type === 'pre_short_teaser';
    const dialogue = (shortContext?.dialogueLines || [])
      .map(l => `${l.speaker_id || 'Speaker'}: ${l.dialogue}`)
      .join('\n');
    const scenes = (shortContext?.scenes || [])
      .map(s => `Chapter ${s.chapter}, Scene ${s.scene}: ${s.location} ${s.location_details}`)
      .join('\n');

    return `You are writing a Facebook image post for a Nollywood/African drama page.
${retryNote}

Write a ${isPre ? 'PRE-REEL TEASER' : 'POST-REEL RECAP'} post for the movie/script "${projectTitle}".

This post is tied to a scheduled Facebook Reel:
- Reel date: ${post.scheduled_date}
- Reel time: ${shortContext?.scheduledTime || '18:00'}
- This image post time: ${post.scheduled_time}

REEL DIALOGUE, IN CHRONOLOGICAL ORDER:
${dialogue || '(No dialogue resolved.)'}

SCENE CONTEXT:
${scenes || '(No scene context resolved.)'}

STYLE:
- Similar energy to a Facebook drama fan-page post.
- Conversational, emotionally direct, and comment-driven.
- Nigerian/Nollywood drama audience.
- Use short paragraphs with line breaks.
- Emojis are allowed but keep them tasteful and sparse.
- Do not use Markdown formatting. No **bold**, bullet lists, headings, or numbered lists.
- Do not hardcode BLOODLINES unless the project title is Bloodlines.
- Use the project title/tag naturally.
- Do not use weekday-specific hashtags like #FridayDrama unless explicitly requested.
- Never mention internal production structure such as chapter numbers, scene numbers, clip numbers, source clips, or "Chapter 9".
- Write as if the audience only knows this as today's/new upcoming video, not as a numbered chapter.

${isPre ? `PRE-REEL TEASER RULES:
- Length: 70-130 words.
- Tease that a new video/Reel is coming later today.
- Ask "what will happen?" energy without spoiling the Reel.
- Do not summarize the full outcome.
- Avoid outcome phrases such as "walked out", "cleared her name", "free", "forgeries", "never going back", "finally exhales", or "final walk".
- Avoid broken fragments like "Adaeze has —" or unfinished dash clauses.` : `POST-REEL RECAP RULES:
- Length: 120-180 words.
- React to what happened in the Reel.
- Ask viewers what they think about a character's choice, silence, words, or behavior.
- Focus on one emotional question instead of retelling every beat.
- Do not write a full blow-by-blow recap.
- It can be opinionated, but do not invent events outside the dialogue/context.`}

Return ONLY valid JSON:
{
  "title": "short internal title under 60 chars",
  "hook": "opening hook line",
  "caption": "full Facebook caption with line breaks and hashtags at the end",
  "cta": "comment question or CTA",
  "hashtags": ["#${projectTag}", "#DramaSeries"]
}`;
  }

  _parseJson(text) {
    const cleaned = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Social copy generation returned invalid JSON');
    return JSON.parse(match[0]);
  }

  _validate(value, postType, options = {}) {
    if (!value || typeof value !== 'object') throw new Error('Social copy JSON is not an object');
    if (!value.caption || typeof value.caption !== 'string') throw new Error('Social copy JSON missing caption');
    if (!Array.isArray(value.hashtags) || value.hashtags.length === 0) throw new Error('Social copy JSON missing hashtags');
    if (!value.title || typeof value.title !== 'string') value.title = 'Social engagement post';

    const caption = value.caption.replace(/\u00ad/g, '').trim();
    const words = caption.replace(/(^|\s)#[^\s#]+/g, ' ').split(/\s+/).filter(Boolean).length;
    const maxWords = postType === 'post_short_recap' ? 190 : postType === 'pre_short_teaser' ? 145 : 155;
    if (words > maxWords) throw new Error(`${postType} caption too long (${words} words; max ${maxWords})`);
    if (/\b(has|is|was|were|did|does|do|will|can|could|should|would)\s+[—-]/i.test(caption)) {
      throw new Error('caption contains an unfinished dash fragment');
    }
    if (/\bchapter\s+\d+|\bscene\s+\d+|\bclip\s+\d+|source clips?/i.test(caption)) {
      throw new Error('caption mentions internal production structure');
    }
    if (/\baidNo\b|\bSaidNo\b(?!\s*#)/.test(caption.replace(/#[^\s#]+/g, ''))) {
      throw new Error('caption contains a broken hashtag/title fragment');
    }
    if (/\bin\s+and\s+i\s+am\s+not\s+okay\b/i.test(caption)) {
      throw new Error('caption contains an empty title/series fragment');
    }
    if (postType === 'character_intro' && /\bcoming soon\b|\bis coming\b|\bnew movie\b/i.test(caption)) {
      throw new Error('character intro implies the movie/campaign has not started');
    }
    if ((postType === 'pre_short_teaser' || options.isSceneFocusedCharacter) && /\b(walked out|walks out|cleared her name|free woman|completely free|forgeries?|never going back|finally exhales|final walk|got her name back)\b/i.test(caption)) {
      throw new Error(`${postType} reveals too much outcome for a pre-Reel post`);
    }

    const weekdayTag = /^#?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(drama|movie|reel|reels|story|stories)?$/i;
    value.hashtags = value.hashtags
      .map(tag => String(tag || '').trim())
      .filter(Boolean)
      .map(tag => tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`)
      .filter(tag => !weekdayTag.test(tag))
      .slice(0, 7);

    const captionWithoutTags = caption.replace(/(^|\s)#[^\s#]+/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
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

module.exports = { SocialCopyGenerator };
