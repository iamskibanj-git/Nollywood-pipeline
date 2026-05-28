const { SocialPlanner } = require('./social-planner');
const { SocialCopyGenerator } = require('./social-copy-generator');
const { SocialFacebookUploader } = require('./social-facebook-uploader');

class SocialPostsController {
  constructor(db, options = {}) {
    this.db = db;
    this.apiKey = options.apiKey || '';
    this.log = options.log || console.log;
    this.onProgress = options.onProgress || null;
    this.planner = new SocialPlanner(db, { log: this.log });
    this.generator = this.apiKey ? new SocialCopyGenerator(this.apiKey) : null;
    this.uploader = null;
    this.uploaderOptions = {
      userDataDir: options.userDataDir || null,
      headless: false,
      log: this.log,
      onStepComplete: (step) => this._emitProgress({ phase: 'upload', status: 'step', step }),
    };
  }

  getProjects() {
    return this.planner.getProjects();
  }

  getStatus(projectId) {
    return this.planner.getStatus(projectId);
  }

  plan(projectId, options = {}) {
    this.db.backup('pre-social-plan');
    this._emitProgress({ phase: 'plan', status: 'running', projectId, scope: options.scope || 'all_future' });
    const result = this.planner.plan(projectId, options);
    this._emitProgress({
      phase: 'plan',
      status: 'done',
      projectId,
      inserted: result.inserted,
      planned: result.planned,
    });
    return result;
  }

  async generate(projectId, options = {}) {
    if (!this.generator) throw new Error('Claude API key required for social post copy generation');
    const targetDate = this._normalizeDate(options.targetDate);

    this.db.backup('pre-social-generate');
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const script = this._parseJson(project.script_json, null);
    if (!script) throw new Error(`Project ${projectId} has no script_json`);

    const assets = this.db.getAssets(projectId);
    const posts = this.db.getSocialPostsForProject(projectId)
      .filter(p => p.status === 'planned')
      .filter(p => !targetDate || p.scheduled_date === targetDate);

    if (posts.length === 0) {
      return { generated: 0, failed: 0, posts: this.getStatus(projectId).posts, summary: this.getStatus(projectId).summary };
    }

    const shorts = this.db.getFutureScheduledShorts(projectId);
    const shortsById = new Map(shorts.map(s => [Number(s.id), s]));
    const characters = this.planner._getSpeakingCharacters(script, assets);
    const charactersById = new Map();
    for (const character of characters) {
      [
        character.id,
        character.elementNameHint,
        character.name,
        this.planner._normalizeKey(character.id),
        this.planner._normalizeKey(character.elementNameHint),
      ].filter(Boolean).forEach(key => charactersById.set(String(key), character));
    }
    const characterList = characters;

    let generated = 0;
    let failed = 0;
    this._emitProgress({ phase: 'generate', status: 'running', projectId, total: posts.length });

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      try {
        this._emitProgress({
          phase: 'generate',
          status: 'generating',
          projectId,
          postId: post.id,
          current: i + 1,
          total: posts.length,
          message: `Generating copy ${i + 1}/${posts.length} (${post.post_type})...`,
        });

        const context = this._buildGenerationContext(post, {
          script,
          assets,
          shortsById,
          charactersById,
          characterList,
        });
        const copy = await this.generator.generatePost({
          post,
          project,
          character: context.character,
          shortContext: context.shortContext,
        });

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
        failed++;
        this.db.updateSocialPost(post.id, {
          error_message: error.message || 'Social copy generation failed',
        });
        this.log(`[SOCIAL] Copy generation failed for post ${post.id}: ${error.message}`);
      }
    }

    const status = this.getStatus(projectId);
    this._emitProgress({ phase: 'generate', status: 'done', projectId, generated, failed });
    return { generated, failed, posts: status.posts, summary: status.summary, stats: status.stats };
  }

  async scheduleAll(projectId, options = {}) {
    const targetDate = this._normalizeDate(options.targetDate);
    this.db.backup('pre-social-upload');

    const posts = this.db.getPendingSocialUploads(projectId)
      .filter(p => p.status === 'content_done' || p.status === 'upload_failed')
      .filter(p => !targetDate || p.scheduled_date === targetDate);
    if (posts.length === 0) {
      return { uploaded: 0, failed: 0, total: 0, posts: this.getStatus(projectId).posts };
    }

    if (this.uploader) await this.closeUploadSession();
    this.uploader = new SocialFacebookUploader(this.uploaderOptions);

    this._emitProgress({
      phase: 'upload',
      status: 'logging_in',
      projectId,
      message: 'Waiting for Facebook login + 2FA...',
    });
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
          message: `Scheduling engagement post ${i + 1}/${posts.length} (${post.post_type})...`,
        });

        const caption = this._buildCaption(post);
        const result = await this.uploader.scheduleImagePost({
          mediaPath: post.media_path,
          caption,
          scheduledDate: post.scheduled_date,
          scheduledTime: post.scheduled_time,
        });

        if (result.success) {
          this.db.markSocialPostScheduled(post.id, result.facebookPostId || null);
          uploaded++;
          this.log(`[SOCIAL] Post ${post.id} scheduled for ${post.scheduled_date} ${post.scheduled_time}`);
        } else {
          this.db.markSocialPostFailed(post.id, result.error);
          failed++;
          this.log(`[SOCIAL] Post ${post.id} failed: ${result.error}`);
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

  _emitProgress(data) {
    if (this.onProgress) this.onProgress(data);
  }

  _buildGenerationContext(post, { script, assets, shortsById, charactersById, characterList }) {
    if (post.post_type === 'character_intro') {
      const short = shortsById.get(Number(post.short_id));
      const shortContext = short ? this.planner._buildShortContext(short, script, assets) : null;
      const dominantCharacter = shortContext
        ? this.planner._selectDominantCharacterForShort(shortContext, characterList || [])
        : null;
      const candidates = [
        post.source_character_id,
        post.source_character_element_name,
        this.planner._normalizeKey(post.source_character_id),
        this.planner._normalizeKey(post.source_character_element_name),
      ].filter(Boolean).map(String);
      return {
        character: dominantCharacter || candidates.map(key => charactersById.get(key)).find(Boolean) || null,
        shortContext,
      };
    }

    const short = shortsById.get(Number(post.short_id));
    if (!short) throw new Error(`Scheduled short not found for social post ${post.id}`);
    return {
      character: null,
      shortContext: this.planner._buildShortContext(short, script, assets),
    };
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

  _buildCaption(post) {
    let caption = post.body || '';
    let hashtags = [];
    try {
      hashtags = JSON.parse(post.hashtags || '[]');
    } catch (_) {}

    const missingTags = hashtags
      .map(tag => String(tag || '').trim())
      .filter(Boolean)
      .filter(tag => !caption.includes(tag));

    if (missingTags.length > 0) {
      caption = `${caption.trim()}\n\n${missingTags.join(' ')}`;
    }
    return caption.trim();
  }
}

module.exports = { SocialPostsController };
