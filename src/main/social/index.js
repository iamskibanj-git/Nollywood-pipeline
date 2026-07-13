const { SocialPlanner } = require('./social-planner');
const { SocialCopyGenerator } = require('./social-copy-generator');
const { SocialFacebookUploader } = require('./social-facebook-uploader');
const { SocialPublishJobStore } = require('./social-publish-jobs');
const {
  YOUTUBE_COMMUNITY_PLATFORM,
  YouTubeCommunityPostPublisher,
  prepareYouTubeCommunityPostJob,
  normalizeCommunityMediaPaths,
} = require('./youtube-community-posts');

const ENGAGEMENT_POST_TYPES = new Set(['character_intro', 'pre_short_teaser', 'post_short_recap']);

class SocialPostsController {
  constructor(db, options = {}) {
    this.db = db;
    this.apiKey = options.apiKey || '';
    this.log = options.log || console.log;
    this.onProgress = options.onProgress || null;
    this.nowProvider = options.nowProvider || (() => new Date());
    this.planner = new SocialPlanner(db, { log: this.log });
    this.generator = this.apiKey ? new SocialCopyGenerator(this.apiKey) : null;
    this.uploader = null;
    this.uploaderOptions = {
      userDataDir: options.userDataDir || null,
      headless: false,
      log: this.log,
      nowProvider: this.nowProvider,
      onStepComplete: (step) => this._emitProgress({ phase: 'upload', status: 'step', step }),
    };
    this.uploaderFactory = options.uploaderFactory || ((uploaderOptions) => new SocialFacebookUploader(uploaderOptions));
    this.socialPublishJobs = options.socialPublishJobs || new SocialPublishJobStore(db);
    this.youtubeCommunityPublisherFactory = options.youtubeCommunityPublisherFactory || (publisherOptions => new YouTubeCommunityPostPublisher(publisherOptions));
    this.youtubeOptions = {
      userDataDir: options.userDataDir || null,
      headless: false,
      dashboardUrl: options.youtubeDashboardUrl,
      loginWaitMs: options.youtubeLoginWaitMs,
      log: this.log,
    };
  }

  getProjects() {
    return this.planner.getProjects();
  }

  getStatus(projectId) {
    const status = this.planner.getStatus(projectId);
    status.youtubeCommunityJobs = this.socialPublishJobs.listForProject(projectId, YOUTUBE_COMMUNITY_PLATFORM);
    status.youtubeCommunitySummary = this._summarizePublishJobs(status.youtubeCommunityJobs);
    return status;
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
      .filter(p => ENGAGEMENT_POST_TYPES.has(p.post_type))
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
    const scheduleWindow = SocialFacebookUploader.getScheduleWindow(this.nowProvider());
    const allPosts = this.db.getPendingSocialUploads(projectId)
      .filter(p => ENGAGEMENT_POST_TYPES.has(p.post_type))
      .filter(p => p.status === 'content_done' || p.status === 'upload_failed')
      .filter(p => !targetDate || p.scheduled_date === targetDate);
    const posts = allPosts.filter(p => SocialFacebookUploader.isWithinScheduleWindow(p.scheduled_date, this.nowProvider()));
    let deferred = allPosts.length - posts.length;
    if (posts.length === 0) {
      if (deferred > 0) {
        const message = `Facebook schedule window is ${scheduleWindow.today} through ${scheduleWindow.maxDate} (${scheduleWindow.maxDaysAhead} days ahead).`;
        this.log(`[SOCIAL] ${deferred} engagement post(s) deferred. ${message}`);
        this._emitProgress({
          phase: 'upload',
          status: 'deferred',
          projectId,
          deferred,
          maxScheduleDate: scheduleWindow.maxDate,
          message,
        });
      }
      const status = this.getStatus(projectId);
      return { uploaded: 0, failed: 0, deferred, total: allPosts.length, maxScheduleDate: scheduleWindow.maxDate, posts: status.posts, summary: status.summary, stats: status.stats };
    }

    this.db.backup('pre-social-upload');
    if (this.uploader) await this.closeUploadSession();
    this.uploader = this.uploaderFactory(this.uploaderOptions);

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
      if (deferred > 0) {
        this.log(`[SOCIAL] Scheduling ${posts.length} engagement post(s); ${deferred} deferred beyond ${scheduleWindow.maxDate}.`);
      }

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
          status: post.status,
        });

        if (result.success) {
          this.db.markSocialPostScheduled(post.id, result.facebookPostId || null);
          uploaded++;
          this.log(`[SOCIAL] Post ${post.id} scheduled for ${post.scheduled_date} ${post.scheduled_time}`);
        } else if (result.deferred) {
          deferred++;
          this.log(`[SOCIAL] Post ${post.id} deferred: ${result.error}`);
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
    this._emitProgress({ phase: 'upload', status: 'done', projectId, uploaded, failed, deferred, maxScheduleDate: scheduleWindow.maxDate });
    return { uploaded, failed, deferred, total: uploaded + failed + deferred, maxScheduleDate: scheduleWindow.maxDate, posts: status.posts, summary: status.summary, stats: status.stats };
  }

  prepareYouTubeCommunityPosts(projectId, options = {}) {
    const targetDate = this._normalizeDate(options.targetDate);
    this.db.backup('pre-youtube-community-post-prep');
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const posts = this.db.getSocialPostsForProject(projectId)
      .filter(p => ENGAGEMENT_POST_TYPES.has(p.post_type))
      .filter(p => p.status === 'content_done' || p.status === 'upload_failed' || p.status === 'scheduled')
      .filter(p => !targetDate || p.scheduled_date === targetDate);

    let ready = 0;
    let blocked = 0;
    const jobs = [];
    for (const post of posts) {
      const prepared = prepareYouTubeCommunityPostJob(this.socialPublishJobs, post, project, {
        scheduledDate: options.scheduledDate || post.scheduled_date,
        scheduledTime: options.scheduledTime || post.scheduled_time,
        validationOptions: options.validationOptions || {},
      });
      jobs.push(prepared.job);
      if (prepared.validation.ok) ready++;
      else blocked++;
    }

    const status = this.getStatus(projectId);
    return {
      prepared: jobs.length,
      ready,
      blocked,
      jobs: status.youtubeCommunityJobs,
      youtubeCommunitySummary: status.youtubeCommunitySummary,
      posts: status.posts,
      summary: status.summary,
      stats: status.stats,
    };
  }

  async inspectYouTubeCommunityComposer(options = {}) {
    const publisher = this.youtubeCommunityPublisherFactory(this.youtubeOptions);
    try {
      return await publisher.inspectComposer({
        openComposer: options.openComposer === true,
        closeComposer: options.closeComposer !== false,
      });
    } finally {
      if (publisher && typeof publisher.close === 'function') await publisher.close();
    }
  }

  async scheduleYouTubeCommunityPostJob(jobId, options = {}) {
    if (options.confirmSchedule !== true) {
      throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_REQUIRES_CONFIRMATION: pass confirmSchedule=true for the live schedule-only proof.');
    }
    const job = this.socialPublishJobs.getById(jobId);
    if (!job) throw new Error(`Social publish job not found: ${jobId}`);
    if (job.platform !== YOUTUBE_COMMUNITY_PLATFORM) throw new Error(`Publish job ${jobId} is not a YouTube Community job`);
    if (job.status !== 'ready' && job.status !== 'upload_failed') {
      throw new Error(`YOUTUBE_COMMUNITY_JOB_NOT_READY: job ${jobId} status is ${job.status}`);
    }

    const scheduledDate = options.scheduledDate || job.scheduled_date;
    const scheduledTime = options.scheduledTime || job.scheduled_time || '12:00';
    if (!scheduledDate) throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_DATE_REQUIRED');

    this.db.backup('pre-youtube-community-post-schedule');
    this.socialPublishJobs.update(job.id, {
      status: 'scheduling',
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      error_message: null,
    });

    const metadata = this._parseJson(job.metadata_json, {});
    const mediaPaths = normalizeCommunityMediaPaths(metadata.mediaPaths || job.media_path);
    const publisher = this.youtubeCommunityPublisherFactory(this.youtubeOptions);
    try {
      const result = await publisher.schedulePost({
        caption: job.body,
        mediaPaths,
        scheduledDate,
        scheduledTime,
        validationOptions: options.validationOptions || {},
      }, {
        ...options,
        confirmSchedule: true,
      });

      const proof = {
        remote_post_id: result.remotePostId || result.remote_post_id || null,
        remote_url: result.remoteUrl || result.remote_url || null,
        upload_confirmed_at: new Date().toISOString(),
        proof: result,
      };
      const updatedJob = this.socialPublishJobs.markScheduled(job.id, proof);
      return { success: true, job: updatedJob, proof: result };
    } catch (error) {
      const failedJob = this.socialPublishJobs.markFailed(job.id, error.message || String(error));
      return { success: false, job: failedJob, error: error.message || String(error) };
    } finally {
      if (publisher && typeof publisher.close === 'function') await publisher.close();
    }
  }

  async scheduleAllYouTubeCommunityPosts(projectId, options = {}) {
    if (options.confirmSchedule !== true) {
      throw new Error('YOUTUBE_COMMUNITY_SCHEDULE_REQUIRES_CONFIRMATION: pass confirmSchedule=true for live schedule-only proof.');
    }
    const targetDate = this._normalizeDate(options.targetDate);
    const jobs = this.socialPublishJobs.getPending(projectId, YOUTUBE_COMMUNITY_PLATFORM, ['ready', 'upload_failed'])
      .filter(job => !targetDate || job.scheduled_date === targetDate);

    let uploaded = 0;
    let failed = 0;
    const results = [];
    for (const job of jobs) {
      const result = await this.scheduleYouTubeCommunityPostJob(job.id, options);
      results.push(result);
      if (result.success) uploaded++;
      else failed++;
    }

    const status = this.getStatus(projectId);
    return {
      uploaded,
      failed,
      total: jobs.length,
      results,
      jobs: status.youtubeCommunityJobs,
      youtubeCommunitySummary: status.youtubeCommunitySummary,
      posts: status.posts,
      summary: status.summary,
      stats: status.stats,
    };
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

  _summarizePublishJobs(jobs = []) {
    const summary = { total: jobs.length };
    for (const job of jobs) {
      const status = job.status || 'unknown';
      summary[status] = (summary[status] || 0) + 1;
    }
    return summary;
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
