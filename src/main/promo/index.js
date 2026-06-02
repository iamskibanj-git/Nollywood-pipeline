const fs = require('fs');
const path = require('path');
const { ThumbnailGenerator } = require('../publish/thumbnailGenerator');
const { HiggsFieldAutomation } = require('../automation/higgsfield');
const { SocialFacebookUploader } = require('../social/social-facebook-uploader');
const { SocialPlanner } = require('../social/social-planner');
const { PromoCopyGenerator } = require('./promo-copy-generator');

const PROMO_POST_TYPE = 'standalone_character_spotlight';
const PROMO_SCHEDULE_TIME = '10:00';
const DEFAULT_SCHEDULE_BUFFER_MINUTES = 60;

class PromoController {
  constructor(db, options = {}) {
    this.db = db;
    this.apiKey = options.apiKey || '';
    this.geminiApiKey = options.geminiApiKey || '';
    this.userDataDir = options.userDataDir || null;
    this.log = options.log || console.log;
    this.onProgress = options.onProgress || null;
    this.copyGenerator = this.apiKey ? new PromoCopyGenerator(this.apiKey) : null;
    this.scheduleBufferMinutes = options.scheduleBufferMinutes ?? DEFAULT_SCHEDULE_BUFFER_MINUTES;
    this.uploader = null;
  }

  getProjects() {
    return this.db.getPublishableProjects()
      .map(project => {
        const characters = this._getCharactersForProject(project.id);
        const existing = this._getPromoPosts(project.id);
        const ready = existing.filter(p => p.status === 'content_done' || p.status === 'upload_failed').length;
        return {
          ...project,
          character_count: characters.length,
          promo_post_count: existing.length,
          promo_ready_count: ready,
          promo_scheduled_count: existing.filter(p => p.status === 'scheduled').length,
        };
      })
      .filter(project => project.character_count > 0);
  }

  getStatus(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const characters = this._getCharactersForProject(projectId);
    const posts = this._getPromoPosts(projectId);
    const summary = {
      total: posts.length,
      planned: posts.filter(p => p.status === 'planned').length,
      asset_done: posts.filter(p => p.status === 'asset_done').length,
      content_done: posts.filter(p => p.status === 'content_done').length,
      scheduled: posts.filter(p => p.status === 'scheduled').length,
      upload_failed: posts.filter(p => p.status === 'upload_failed').length,
    };
    const dates = posts.map(p => p.scheduled_date).filter(Boolean).sort();
    return {
      project: {
        id: project.id,
        title: project.title,
        aspectRatio: project.aspect_ratio || '16:9',
      },
      characters,
      posts,
      summary,
      stats: {
        characterCount: characters.length,
        startDate: dates[0] || null,
        endDate: dates[dates.length - 1] || null,
        promoTime: PROMO_SCHEDULE_TIME,
        aspectRatio: project.aspect_ratio || '16:9',
      },
    };
  }

  plan(projectId, options = {}) {
    this.db.backup('pre-promo-plan');
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const characters = this._getCharactersForProject(projectId);
    if (characters.length === 0) throw new Error('No speaking characters with completed portraits found');

    const startDate = this._resolveStartDate(options.startDate);
    const planned = characters.map((character, index) => {
      const date = this._addDays(startDate, index);
      return {
        project_id: projectId,
        short_id: null,
        post_type: PROMO_POST_TYPE,
        sequence: index + 1,
        title: `Character spotlight: ${character.name}`,
        body: `Character spotlight planned for ${character.name}.`,
        hashtags: '[]',
        media_path: this._promoImagePath(project.project_dir, character),
        scheduled_date: date,
        scheduled_time: PROMO_SCHEDULE_TIME,
        status: 'planned',
        source_character_id: character.id,
        source_character_element_name: character.elementName || character.elementNameHint || null,
        error_message: (character.elementName || character.elementNameHint) ? null : 'Missing Higgsfield element name',
      };
    });

    let inserted = 0;
    for (const post of planned) {
      const id = this.db.insertSocialPost(post);
      if (id) inserted++;
    }

    const status = this.getStatus(projectId);
    this._emitProgress({ phase: 'plan', status: 'done', projectId, inserted, planned: planned.length });
    return { inserted, planned: planned.length, posts: status.posts, summary: status.summary, stats: status.stats };
  }

  async generateAssets(projectId, options = {}) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (!project.project_dir) throw new Error('Project has no project_dir');
    const aspectRatio = project.aspect_ratio || '16:9';
    const charactersById = new Map(this._getCharactersForProject(projectId).map(c => [String(c.id), c]));
    const posts = this._getPromoPosts(projectId)
      .filter(p => p.status === 'planned')
      .filter(p => !options.targetDate || p.scheduled_date === options.targetDate);
    if (posts.length === 0) return { generated: 0, failed: 0, posts: this.getStatus(projectId).posts };

    this.db.backup('pre-promo-assets');
    const automation = await this._launchHiggsfield(project.project_dir);
    const thumbGen = new ThumbnailGenerator(automation, {
      geminiApiKey: this.geminiApiKey,
      onCreditUsed: (creditCost, stage) => {
        this.log(`[PROMO] Promo card credit: ${creditCost ?? 0} (${stage})`);
        this.db.runSql(
          `INSERT INTO project_assets (project_id, type, status, credit_cost, prompt_used, completed_at)
           VALUES (?, 'promo_card', 'done', ?, ?, datetime('now'))`,
          [project.id, creditCost, `promo-${stage}`]
        );
      },
    });

    let generated = 0;
    let failed = 0;
    try {
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        const character = charactersById.get(String(post.source_character_id));
        if (!character?.elementName && !character?.elementNameHint) {
          this.db.updateSocialPost(post.id, { error_message: 'Missing Higgsfield element name' });
          failed++;
          continue;
        }

        this._emitProgress({
          phase: 'asset',
          status: 'generating',
          projectId,
          postId: post.id,
          current: i + 1,
          total: posts.length,
          message: `Generating promo card ${i + 1}/${posts.length} (${character.name})...`,
        });

        try {
          const elementName = character.elementName || character.elementNameHint;
          if (!elementName) {
            throw new Error(`Missing Higgsfield element name for ${character.name}`);
          }

          const outputDir = path.join(project.project_dir, 'output', 'promo', this._safeName(character.id || character.name));
          const result = await this._generatePromoThumbnailWithRetry({
            thumbGen,
            automation,
            project,
            character,
            elementName,
            outputDir,
            aspectRatio,
          });
          this.db.updateSocialPost(post.id, {
            media_path: result.thumbnailPath,
            status: 'asset_done',
            error_message: null,
          });
          generated++;
        } catch (error) {
          this.db.updateSocialPost(post.id, { error_message: error.message || 'Promo image generation failed' });
          failed++;
          this.log(`[PROMO] Asset generation failed for post ${post.id}: ${error.message}`);
        }
      }
    } finally {
      await automation.close().catch(() => {});
    }

    const status = this.getStatus(projectId);
    this._emitProgress({ phase: 'asset', status: 'done', projectId, generated, failed });
    return { generated, failed, posts: status.posts, summary: status.summary, stats: status.stats };
  }

  async generateCopy(projectId, options = {}) {
    if (!this.copyGenerator) throw new Error('Claude API key required for promo copy generation');
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const charactersById = new Map(this._getCharactersForProject(projectId).map(c => [String(c.id), c]));
    const posts = this._getPromoPosts(projectId)
      .filter(p => p.status === 'asset_done')
      .filter(p => !options.targetDate || p.scheduled_date === options.targetDate);
    if (posts.length === 0) return { generated: 0, failed: 0, posts: this.getStatus(projectId).posts };

    this.db.backup('pre-promo-copy');
    let generated = 0;
    let failed = 0;
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const character = charactersById.get(String(post.source_character_id));
      try {
        this._emitProgress({
          phase: 'copy',
          status: 'generating',
          projectId,
          postId: post.id,
          current: i + 1,
          total: posts.length,
          message: `Generating promo caption ${i + 1}/${posts.length} (${character?.name || post.source_character_id})...`,
        });
        const copy = await this.copyGenerator.generateCharacterSpotlight({ project, character, post });
        this.db.updateSocialPost(post.id, {
          title: copy.title,
          body: copy.body,
          hashtags: JSON.stringify(copy.hashtags),
          caption_json: JSON.stringify(copy.caption_json),
          status: 'content_done',
          generated_at: new Date().toISOString(),
          error_message: null,
        });
        generated++;
      } catch (error) {
        this.db.updateSocialPost(post.id, { error_message: error.message || 'Promo copy generation failed' });
        failed++;
        this.log(`[PROMO] Copy generation failed for post ${post.id}: ${error.message}`);
      }
    }

    const status = this.getStatus(projectId);
    this._emitProgress({ phase: 'copy', status: 'done', projectId, generated, failed });
    return { generated, failed, posts: status.posts, summary: status.summary, stats: status.stats };
  }

  async scheduleAll(projectId, options = {}) {
    this.db.backup('pre-promo-upload');
    const posts = this._getPromoPosts(projectId)
      .filter(p => p.status === 'content_done' || p.status === 'upload_failed')
      .filter(p => !options.targetDate || p.scheduled_date === options.targetDate);
    if (posts.length === 0) return { uploaded: 0, failed: 0, total: 0, posts: this.getStatus(projectId).posts };

    if (this.uploader) await this.closeUploadSession();
    this.uploader = new SocialFacebookUploader({
      userDataDir: this.userDataDir,
      headless: false,
      log: this.log,
      onStepComplete: (step) => this._emitProgress({ phase: 'upload', status: 'step', step }),
    });

    this._emitProgress({ phase: 'upload', status: 'logging_in', projectId, message: 'Waiting for Facebook login + 2FA...' });
    await this.uploader.launch();

    let uploaded = 0;
    let failed = 0;
    try {
      for (let i = 0; i < posts.length; i++) {
        const post = posts[i];
        this._emitProgress({
          phase: 'upload',
          status: 'uploading',
          projectId,
          postId: post.id,
          current: i + 1,
          total: posts.length,
          message: `Scheduling promo post ${i + 1}/${posts.length} (${post.source_character_id})...`,
        });
        const result = await this.uploader.scheduleImagePost({
          mediaPath: post.media_path,
          caption: this._buildCaption(post),
          scheduledDate: post.scheduled_date,
          scheduledTime: post.scheduled_time,
        });
        if (result.success) {
          this.db.markSocialPostScheduled(post.id, result.facebookPostId || null);
          uploaded++;
        } else {
          this.db.markSocialPostFailed(post.id, result.error);
          failed++;
        }
      }
    } finally {
      await this.closeUploadSession();
    }

    const status = this.getStatus(projectId);
    this._emitProgress({ phase: 'upload', status: 'done', projectId, uploaded, failed });
    return { uploaded, failed, total: posts.length, posts: status.posts, summary: status.summary, stats: status.stats };
  }

  async closeUploadSession() {
    if (this.uploader) {
      await this.uploader.close();
      this.uploader = null;
    }
  }

  async _generatePromoThumbnailWithRetry({ thumbGen, automation, project, character, elementName, outputDir, aspectRatio }) {
    const maxAttempts = 3;
    let lastError = null;
    fs.mkdirSync(outputDir, { recursive: true });

    const preset = thumbGen.presets?.drama || Object.values(thumbGen.presets || {})[0] || {};
    const keyArtPath = path.join(outputDir, 'key-art-custom.png');
    const titleCardPath = path.join(outputDir, 'title-card.png');
    const titleCardSpecPath = path.join(outputDir, 'title-card.json');
    const thumbnailPath = path.join(outputDir, 'thumbnail-custom.png');
    const placement = aspectRatio === '9:16' ? 'bottom-bar' : 'lower-third';
    const scriptDisplayTitle = this._promoScriptDisplayTitle(project.title);
    const titleCardTitle = this._promoCharacterDisplayName(character);
    const titleCardSpec = {
      version: 3,
      title: titleCardTitle,
      subtitle: scriptDisplayTitle,
      aspectRatio,
    };

    if (!this._fileReady(keyArtPath)) {
      await thumbGen.generateCustomKeyArt({
        characterElementName: elementName,
        expression: 'intense dignified presence',
        outputPath: keyArtPath,
        aspectRatio,
      });
    } else {
      this.log(`[PROMO] Reusing existing promo key art: ${keyArtPath}`);
    }

    if (!this._fileReady(titleCardPath) || !this._jsonFileMatches(titleCardSpecPath, titleCardSpec)) {
      await thumbGen.generateTitleCard({
        title: titleCardTitle,
        tagline: scriptDisplayTitle,
        preset,
        outputPath: titleCardPath,
        aspectRatio,
        taglineCase: 'preserve',
        taglineSeparator: true,
        splitTitle: false,
      });
      this._writeJsonFile(titleCardSpecPath, titleCardSpec);
    } else {
      this.log(`[PROMO] Reusing existing promo title card: ${titleCardPath}`);
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          this.log(`[PROMO] Retrying promo composite for ${character.name} with a fresh Higgsfield context (${attempt}/${maxAttempts})`);
          await automation.recreateContext().catch(err => {
            this.log(`[PROMO] Fresh-context retry setup warning: ${err.message}`);
          });
        }

        await thumbGen.compositeThumbnail({
          keyArtPath,
          titleCardPath,
          placement,
          outputPath: thumbnailPath,
          aspectRatio,
          skipRecoveryOnReferenceFailure: true,
          referenceUploadWarmupMs: 12000,
          referenceUploadAllowAnyInput: true,
        });

        return { thumbnailPath, keyArtPath, titleCardPath };
      } catch (error) {
        lastError = error;
        if (!this._isRetryablePromoImageError(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw lastError || new Error('Promo image generation failed');
  }

  _isRetryablePromoImageError(error) {
    const message = String(error?.message || '');
    return /REFERENCE_UPLOAD_FAILED|REFERENCE_GATE_FAILED|GENERATION_FAILED|credits refunded|please try again|server-side failure|timed out|Target page, context or browser has been closed|Target.*closed|page\.waitForTimeout/i.test(message);
  }

  _fileReady(filePath) {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).size > 1024;
    } catch (_) {
      return false;
    }
  }

  async _launchHiggsfield(projectDir) {
    const automation = new HiggsFieldAutomation(null, projectDir);
    await automation.ensureBrowser();
    await automation.page.goto('https://higgsfield.ai/studio', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    const loggedIn = await automation.isLoggedIn();
    if (!loggedIn) {
      this.log('[PROMO] Higgsfield login not detected; thumbnail generator will wait for login.');
    }
    return automation;
  }

  _getPromoPosts(projectId) {
    return this.db.getSocialPostsForProject(projectId).filter(p => p.post_type === PROMO_POST_TYPE);
  }

  _getCharactersForProject(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) return [];
    const script = this._parseJson(project.script_json, null);
    if (!script) return [];
    const assets = this.db.getAssets(projectId);
    const settings = this._parseJson(project.settings, {});
    const cinematicElementNames = settings._cinematicElementNames || {};
    const outfitElements = settings._outfitElements || {};
    const elementSuffix = settings.element_name_suffix || null;
    return new SocialPlanner(this.db)._getSpeakingCharacters(script, assets)
      .map(character => {
        const hint = this._normalizeElementKey(character.elementNameHint || character.id || character.name);
        const portrait = assets.find(a =>
          a.type === 'portrait' &&
          a.status === 'done' &&
          a.character_id === character.id
        );
        const elementName = portrait?.element_name
          || outfitElements[hint]?.o1
          || outfitElements[hint]?.['o1']
          || cinematicElementNames[hint]
          || cinematicElementNames[`@${hint}`]
          || cinematicElementNames[character.id]
          || cinematicElementNames[`@${character.id}`]
          || (elementSuffix && hint ? `${hint}_${String(elementSuffix).replace(/^_+/, '')}` : null)
          || character.elementNameHint;
        return { ...character, elementName };
      });
  }

  _normalizeElementKey(value) {
    return String(value || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  _promoScriptDisplayTitle(title) {
    let text = String(title || 'Untitled').trim();
    text = text.replace(/\s*\([^)]*characters?[^)]*\)\s*$/i, '').trim();
    text = text.replace(/\s*\|\s*(?:ai\s+)?(?:nollywood\s+)?(?:short\s+)?(?:film|movie|drama)\s*$/i, '').trim();

    const suffixSplit = text.split(/\s+[—-]\s+/);
    if (suffixSplit.length > 1) {
      const suffix = suffixSplit.slice(1).join(' ');
      if (/(nigerian|animated|folktale|ai|drama|film|movie|full)/i.test(suffix)) {
        text = suffixSplit[0].trim();
      }
    }

    text = text.replace(/\s+/g, ' ').trim() || 'Untitled';
    if (/[a-z]/.test(text)) return text;

    const smallWords = new Set(['of', 'the', 'and', 'a', 'an', 'in', 'on', 'to', 'for', 'with', 'from', 'by']);
    return text.toLowerCase().replace(/\b[a-z0-9']+\b/g, (word, offset) => {
      if (offset > 0 && smallWords.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    });
  }

  _promoCharacterDisplayName(character) {
    let text = String(character?.name || character?.id || 'Character Spotlight').trim();
    text = text.split(/\s+[—-]\s+/)[0].trim();
    text = text.split(/\s+\|\s+/)[0].trim();
    return text.replace(/\s+/g, ' ').trim() || 'Character Spotlight';
  }

  _jsonFileMatches(filePath, expected) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const actual = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return JSON.stringify(actual) === JSON.stringify(expected);
    } catch (_) {
      return false;
    }
  }

  _writeJsonFile(filePath, value) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    } catch (error) {
      this.log(`[PROMO] Could not write title-card spec: ${error.message}`);
    }
  }

  _promoImagePath(projectDir, character) {
    const safeId = this._safeName(character.id || character.name || 'character');
    return path.join(projectDir, 'output', 'promo', safeId, 'thumbnail-custom.png');
  }

  _resolveStartDate(value) {
    const explicit = this._normalizeDate(value);
    let date = explicit ? new Date(`${explicit}T${PROMO_SCHEDULE_TIME}:00`) : new Date();
    if (!explicit) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    }
    if (!this._isSlotEligible(this._formatDate(date), PROMO_SCHEDULE_TIME)) {
      date.setDate(date.getDate() + 1);
    }
    return this._formatDate(date);
  }

  _isSlotEligible(date, time) {
    const scheduled = new Date(`${date}T${time}:00`);
    if (Number.isNaN(scheduled.getTime())) return false;
    return scheduled >= new Date(Date.now() + this.scheduleBufferMinutes * 60 * 1000);
  }

  _addDays(dateStr, days) {
    const date = new Date(`${dateStr}T00:00:00`);
    date.setDate(date.getDate() + days);
    return this._formatDate(date);
  }

  _formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  _normalizeDate(value) {
    const text = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  }

  _parseJson(value, fallback) {
    if (value == null || value === '') return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }

  _safeName(value) {
    return String(value || 'character')
      .replace(/^@/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'character';
  }

  _buildCaption(post) {
    let caption = post.body || '';
    let hashtags = [];
    try { hashtags = JSON.parse(post.hashtags || '[]'); } catch (_) {}
    const missingTags = hashtags
      .map(tag => String(tag || '').trim())
      .filter(Boolean)
      .filter(tag => !caption.includes(tag));
    if (missingTags.length > 0) caption = `${caption.trim()}\n\n${missingTags.join(' ')}`;
    return caption.trim();
  }

  _emitProgress(data) {
    if (this.onProgress) this.onProgress(data);
  }
}

module.exports = { PromoController, PROMO_POST_TYPE, PROMO_SCHEDULE_TIME };
