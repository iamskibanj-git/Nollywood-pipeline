const fs = require('fs');

const SOCIAL_POST_TIMES = {
  character_intro: '12:00',
  pre_short_teaser: '15:00',
  post_short_recap: '21:00',
};

const DEFAULT_SCHEDULE_BUFFER_MINUTES = 60;

class SocialPlanner {
  constructor(db, options = {}) {
    this.db = db;
    this.log = options.log || console.log;
    this.scheduleBufferMinutes = options.scheduleBufferMinutes ?? DEFAULT_SCHEDULE_BUFFER_MINUTES;
  }

  getProjects() {
    return this.db.getSocialPostProjects();
  }

  getStatus(projectId) {
    const posts = this.db.getSocialPostsForProject(projectId);
    const summary = {
      total: posts.length,
      planned: posts.filter(p => p.status === 'planned').length,
      content_done: posts.filter(p => p.status === 'content_done').length,
      scheduled: posts.filter(p => p.status === 'scheduled').length,
      upload_failed: posts.filter(p => p.status === 'upload_failed').length,
      skipped: posts.filter(p => p.status === 'skipped').length,
    };

    const dates = posts.map(p => p.scheduled_date).filter(Boolean).sort();
    const stats = posts.length > 0 ? {
      startDate: dates[0] || null,
      endDate: dates[dates.length - 1] || null,
      characterIntros: posts.filter(p => p.post_type === 'character_intro').length,
      teasers: posts.filter(p => p.post_type === 'pre_short_teaser').length,
      recaps: posts.filter(p => p.post_type === 'post_short_recap').length,
    } : null;

    return { posts, summary, stats };
  }

  plan(projectId, options = {}) {
    const targetDate = this._normalizeDate(options.targetDate);
    const scope = targetDate ? 'target_date' : (options.scope === 'next_day' ? 'next_day' : 'all_future');
    const includeType1 = options.includeType1 === true;
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const script = this._parseJson(project.script_json, null);
    if (!script) throw new Error(`Project ${projectId} has no script_json`);

    const candidateShorts = this._filterFutureShorts(this.db.getFutureScheduledShorts(projectId));
    let eligibleShorts = candidateShorts.filter(short => this._isShortDayEligible(short));
    if (scope === 'target_date') {
      eligibleShorts = eligibleShorts.filter(short => short.scheduled_date === targetDate);
    } else if (scope === 'next_day' && eligibleShorts.length > 0) {
      const nextDate = eligibleShorts[0].scheduled_date;
      eligibleShorts = eligibleShorts.filter(short => short.scheduled_date === nextDate);
    }
    const introShorts = eligibleShorts.filter(short => this._isSlotEligible(short.scheduled_date, SOCIAL_POST_TIMES.character_intro));
    if (eligibleShorts.length === 0) {
      throw new Error(`No eligible future engagement slots found. Run earlier or reduce the ${this.scheduleBufferMinutes}-minute scheduling buffer.`);
    }

    const assets = this.db.getAssets(projectId);
    const planned = [];

    const speakingCharacters = this._getSpeakingCharacters(script, assets);
    if (includeType1) {
      introShorts.slice(0, speakingCharacters.length).forEach((short, idx) => {
        const context = this._buildShortContext(short, script, assets);
        const character = this._selectDominantCharacterForShort(context, speakingCharacters) || speakingCharacters[idx];
        planned.push(this._buildCharacterIntro(projectId, short, character, idx + 1));
      });
    }

    for (const short of eligibleShorts) {
      const context = this._buildShortContext(short, script, assets);
      planned.push(this._buildShortPost(projectId, short, context, 'pre_short_teaser'));
      planned.push(this._buildShortPost(projectId, short, context, 'post_short_recap'));
    }

    let inserted = 0;
    for (const post of planned) {
      const id = this.db.insertSocialPost(post);
      if (id) inserted++;
    }

    const status = this.getStatus(projectId);
    return {
      inserted,
      planned: planned.length,
      posts: status.posts,
      summary: status.summary,
      stats: {
        scope,
        targetDate,
        includeType1,
        candidateShorts: candidateShorts.length,
        eligibleShorts: eligibleShorts.length,
        skippedShorts: candidateShorts.length - eligibleShorts.length,
        introSlots: introShorts.length,
        scheduleBufferMinutes: this.scheduleBufferMinutes,
        speakingCharacters: speakingCharacters.length,
        characterIntrosPlanned: includeType1 ? Math.min(introShorts.length, speakingCharacters.length) : 0,
        teasersPlanned: eligibleShorts.length,
        recapsPlanned: eligibleShorts.length,
      },
      traceSample: eligibleShorts[0] ? this._buildShortContext(eligibleShorts[0], script, assets) : null,
    };
  }

  _buildCharacterIntro(projectId, short, character, sequence) {
    const title = `Character intro: ${character.name}`;
    const body = [
      `Character intro planned for ${character.name}.`,
      '',
      'Copy generation will fill this caption.',
    ].join('\n');

    return {
      project_id: projectId,
      short_id: short.id,
      post_type: 'character_intro',
      sequence,
      title,
      body,
      hashtags: '[]',
      media_path: character.portraitPath || null,
      scheduled_date: short.scheduled_date,
      scheduled_time: SOCIAL_POST_TIMES.character_intro,
      status: 'planned',
      source_character_id: character.id,
      source_character_element_name: character.elementNameHint || null,
      error_message: character.portraitPath ? null : 'Missing portrait media path',
    };
  }

  _buildShortPost(projectId, short, context, postType) {
    const isPre = postType === 'pre_short_teaser';
    const title = `${isPre ? 'Pre-Reel teaser' : 'Post-Reel recap'}: short #${short.short_number}`;
    const body = [
      `${isPre ? 'Teaser' : 'Recap'} planned for short #${short.short_number}.`,
      '',
      'Copy generation will fill this caption.',
    ].join('\n');

    return {
      project_id: projectId,
      short_id: short.id,
      post_type: postType,
      sequence: short.short_number || 1,
      title,
      body,
      hashtags: '[]',
      media_path: context.selectedSceneImagePath || null,
      scheduled_date: short.scheduled_date,
      scheduled_time: isPre ? SOCIAL_POST_TIMES.pre_short_teaser : SOCIAL_POST_TIMES.post_short_recap,
      status: 'planned',
      source_scene_asset_id: context.selectedSceneAssetId || null,
      error_message: context.selectedSceneImagePath ? null : 'Missing scene image media path',
    };
  }

  _buildShortContext(short, script, assets) {
    const clipIds = this._parseJson(short.source_clips, []);
    const clipAssets = clipIds
      .map(id => assets.find(a => Number(a.id) === Number(id)))
      .filter(Boolean);

    const dialogueLines = [];
    const scenes = [];
    const sceneAssetCandidates = [];

    for (const clip of clipAssets) {
      const scriptScene = this._findScriptScene(script, clip.chapter, clip.scene);
      const lineRefs = this._parseJson(clip.line_refs, []);
      const sceneKey = `${clip.chapter}_${clip.scene}`;

      if (scriptScene && !scenes.some(s => s.key === sceneKey)) {
        scenes.push({
          key: sceneKey,
          chapter: clip.chapter,
          scene: clip.scene,
          location: scriptScene.location || '',
          location_details: scriptScene.location_details || '',
          characters_present: scriptScene.characters_present || [],
        });
      }

      for (const lineRef of lineRefs) {
        const line = (scriptScene?.lines || []).find(l => Number(l.line_number) === Number(lineRef));
        if (line?.dialogue) {
          dialogueLines.push({
            chapter: clip.chapter,
            scene: clip.scene,
            line: lineRef,
            speaker_id: line.speaker_id || null,
            dialogue: line.dialogue,
            tone: line.tone || null,
          });
        }
      }

      const sceneAsset = this._findSceneImageAsset(assets, clip.chapter, clip.scene);
      if (sceneAsset) sceneAssetCandidates.push(sceneAsset);
    }

    const selectedScene = this._selectSceneImage(sceneAssetCandidates, dialogueLines);

    return {
      shortId: short.id,
      shortNumber: short.short_number,
      scheduledDate: short.scheduled_date,
      scheduledTime: short.scheduled_time,
      clipIds,
      clipAssets: clipAssets.map(c => ({
        id: c.id,
        chapter: c.chapter,
        scene: c.scene,
        line_refs: this._parseJson(c.line_refs, []),
        kling_clip_id: c.kling_clip_id || null,
      })),
      dialogueLines,
      scenes,
      selectedSceneAssetId: selectedScene?.id || null,
      selectedSceneImagePath: selectedScene?.file_path || null,
    };
  }

  _getSpeakingCharacters(script, assets) {
    const bible = script.character_bible || script.characters || [];
    const byId = new Map();
    bible.forEach((char, index) => {
      const normalized = this._characterKeys(char);
      byId.set(char.id || char.element_name_hint || `character_${index + 1}`, {
        ...char,
        _index: index,
        _keys: normalized,
        _dialogueCount: 0,
        _firstSeen: Number.MAX_SAFE_INTEGER,
      });
    });

    let order = 0;
    for (const ch of script.chapters || []) {
      for (const sc of ch.scenes || []) {
        for (const line of sc.lines || []) {
          if (!line.dialogue) continue;
          order++;
          const speaker = this._resolveCharacter(line.speaker_id, byId);
          if (!speaker) continue;
          speaker._dialogueCount++;
          speaker._firstSeen = Math.min(speaker._firstSeen, order);
        }
      }
    }

    return [...byId.values()]
      .filter(c => c._dialogueCount > 0)
      .map(c => {
        const portrait = assets.find(a =>
          a.type === 'portrait' &&
          a.status === 'done' &&
          a.character_id === c.id &&
          a.file_path &&
          fs.existsSync(a.file_path)
        );
        return {
          id: c.id,
          name: c.name || c.description_label || c.element_name_hint || c.id,
          role: c.role || c.archetype || '',
          description_label: c.description_label || '',
          physical_description: c.physical_description || c.full_prompt_description || '',
          speech_style: c.speech_style || '',
          speech_notes: c.speech_notes || '',
          elementNameHint: c.element_name_hint || null,
          dialogueCount: c._dialogueCount,
          firstSeen: c._firstSeen,
          portraitPath: portrait?.file_path || null,
        };
      })
      .sort((a, b) => (a.firstSeen - b.firstSeen) || (b.dialogueCount - a.dialogueCount));
  }

  _resolveCharacter(speakerId, characterMap) {
    const clean = this._normalizeKey(speakerId || '');
    if (!clean) return null;
    for (const char of characterMap.values()) {
      if (char._keys.has(clean)) return char;
    }
    return null;
  }

  _characterKeys(char) {
    const keys = new Set();
    [
      char.id,
      char.element_name_hint,
      char.name,
      char.description_label,
    ].forEach(v => {
      const key = this._normalizeKey(v || '');
      if (key) keys.add(key);
    });
    return keys;
  }

  _normalizeKey(value) {
    return String(value || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase()
      .replace(/^(the|a|an)\s+/i, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  _findScriptScene(script, chapterNumber, sceneNumber) {
    const chapter = (script.chapters || []).find(ch => Number(ch.chapter_number) === Number(chapterNumber));
    if (!chapter) return null;
    return (chapter.scenes || []).find(sc => Number(sc.scene_number) === Number(sceneNumber)) || null;
  }

  _findSceneImageAsset(assets, chapter, scene) {
    return assets.find(a =>
      a.type === 'scene_image_cinematic' &&
      a.status === 'done' &&
      Number(a.chapter) === Number(chapter) &&
      Number(a.scene) === Number(scene) &&
      a.file_path &&
      fs.existsSync(a.file_path)
    ) || null;
  }

  _selectSceneImage(sceneAssets) {
    if (!sceneAssets || sceneAssets.length === 0) return null;
    return sceneAssets[0];
  }

  _selectDominantCharacterForShort(shortContext, characters) {
    if (!shortContext || !Array.isArray(shortContext.dialogueLines) || !Array.isArray(characters)) return null;
    const counts = new Map();
    for (const line of shortContext.dialogueLines) {
      const key = this._normalizeKey(line.speaker_id || '');
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return characters
      .map(character => ({
        character,
        count: Math.max(
          counts.get(this._normalizeKey(character.id)) || 0,
          counts.get(this._normalizeKey(character.elementNameHint)) || 0,
          counts.get(this._normalizeKey(character.name)) || 0
        ),
      }))
      .filter(item => item.count > 0)
      .sort((a, b) => (b.count - a.count) || (a.character.firstSeen - b.character.firstSeen))[0]?.character || null;
  }

  _filterFutureShorts(shorts) {
    const now = new Date();
    return (shorts || []).filter(short => {
      if (!short.scheduled_date) return false;
      const scheduled = new Date(`${short.scheduled_date}T${short.scheduled_time || '00:00'}:00`);
      if (Number.isNaN(scheduled.getTime())) {
        return new Date(`${short.scheduled_date}T23:59:59`) >= now;
      }
      return scheduled >= now;
    });
  }

  _isShortDayEligible(short) {
    return (
      this._isSlotEligible(short.scheduled_date, SOCIAL_POST_TIMES.pre_short_teaser) &&
      this._isSlotEligible(short.scheduled_date, SOCIAL_POST_TIMES.post_short_recap)
    );
  }

  _isSlotEligible(date, time) {
    if (!date || !time) return false;
    const scheduled = new Date(`${date}T${time}:00`);
    if (Number.isNaN(scheduled.getTime())) return false;
    const cutoff = new Date(Date.now() + this.scheduleBufferMinutes * 60 * 1000);
    return scheduled >= cutoff;
  }

  _parseJson(value, fallback) {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  _normalizeDate(value) {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  }
}

module.exports = { SocialPlanner, SOCIAL_POST_TIMES };
