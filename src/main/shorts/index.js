/**
 * Shorts Tab Controller — Entry point for the Electron "Shorts" tab.
 *
 * Exposes IPC-ready methods for the renderer process:
 *   - getProjects()           → list completed projects
 *   - planShorts(projectId, options)  → plan 30-day calendar
 *   - assembleAll(projectId)  → FFmpeg all shorts for a project
 *   - generateAllSEO(projectId) → generate descriptions for all shorts
 *   - startUploadSession(projectId, options) → launch Playwright + begin uploads
 *   - uploadNext(projectId)   → upload next pending short
 *   - getStatus(projectId)    → get all shorts with status
 *
 * Usage from main process (IPC handlers):
 *   const { ShortsController } = require('./shorts');
 *   const controller = new ShortsController(db, { apiKey });
 *   ipcMain.handle('shorts:getProjects', () => controller.getProjects());
 *   ipcMain.handle('shorts:plan', (e, projectId, opts) => controller.planShorts(projectId, opts));
 *   // etc.
 */

const { ShortsScheduler } = require('./shorts-scheduler');
const { FacebookUploader } = require('./facebook-uploader');
const {
  FacebookShortPublisherAdapter,
  YouTubeShortPublisherAdapter,
} = require('./publish-adapters');
const {
  SHORT_PLATFORM_PROFILES,
  getShortPlatformProfile,
  normalizeShortPlatform,
  validateShortMetadataForPlatform,
} = require('./platform-profiles');
const {
  YouTubeStudioUploader,
  extractYouTubeStudioChannelId,
} = require('./youtube-studio-uploader');
const {
  buildYouTubeShortMetadata,
  buildYouTubeHashtags,
  prepareYouTubeShortPublishJob,
  probeShortVideoFile,
} = require('./youtube-job-prep');
const path = require('path');
const db = require('../database/db');

class ShortsController {
  constructor(_db, options = {}) {
    // Note: _db param kept for API compat — we use the singleton import directly
    this.scheduler = new ShortsScheduler(_db, options);
    this.uploader = null; // Lazy-initialized on first upload session
    this.uploaderOptions = {
      userDataDir: options.userDataDir || null,
      headless: false, // Always visible — user confirms each upload
      log: options.log || console.log,
      nowProvider: options.nowProvider || (() => new Date()),
    };
    this.uploaderFactory = options.uploaderFactory || (uploaderOptions => new FacebookUploader(uploaderOptions));
    this.publisherFactory = options.publisherFactory || (publisherOptions => new FacebookShortPublisherAdapter({
      ...publisherOptions,
      uploaderFactory: this.uploaderFactory,
    }));
    this.nowProvider = options.nowProvider || (() => new Date());
    this.log = options.log || console.log;
    this.onProgress = options.onProgress || null;
  }

  /**
   * Get completed projects eligible for repurposing.
   */
  getProjects() {
    return this.scheduler.getEligibleProjects();
  }

  /**
   * Plan-only: probe durations, compute calendar, persist to DB, return for UI review.
   * No assembly or SEO — just the math. Plan survives app restarts.
   */
  planCalendar(projectId, options = {}) {
    const { mode = 'standalone_impact', startDate, calendarDays = 30 } = options;
    const result = this.scheduler.planCalendar(projectId, { mode, startDate, calendarDays });
    this.scheduler.savePlan(projectId, result.calendar);
    return result;
  }

  /**
   * Plan + assemble + SEO for a full project in one go.
   * Returns the calendar with status of each short.
   *
   * @param {string} projectId
   * @param {object} options - { mode, startDate, postsPerDay }
   */
  /**
   * Assemble + SEO: reads planned shorts from DB, runs FFmpeg + Claude API.
   * Updates each row in place as it completes. Resumable — skips already-assembled shorts.
   */
  async assembleShorts(projectId) {
    // Backup DB before assembly — bulk status changes ahead
    db.backup('pre-assembly');

    const project = db.queryOne('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const planned = this.scheduler.getPlannedShorts(projectId);
    const assembledBeforeRun = this.scheduler.getAssembledShortsNeedingSEO(projectId);
    if (planned.length === 0 && assembledBeforeRun.length === 0) {
      throw new Error('No planned shorts or assembled shorts needing SEO. Run Plan Calendar first.');
    }

    this.log(`[SHORTS] Processing ${planned.length} planned shorts and ${assembledBeforeRun.length} SEO-only retry shorts for "${project.title}"`);

    const projectDir = project.project_dir || path.join(process.cwd(), 'output', projectId);
    const shortsDir = path.join(projectDir, 'shorts');

    // Load all cinematic clip assets once (avoid N+1 queries per short)
    const allClipAssets = db.getAssets(projectId, { type: 'video_clip_cinematic' });
    const clipById = new Map(allClipAssets.map(a => [a.id, a]));

    let assembled = 0;
    let seoRecovered = 0;
    let seoFailed = 0;
    let skipped = 0;
    const total = planned.length;
    const startTime = Date.now();

    for (const short of planned) {
      // Reconstruct clip objects from source_clips (asset IDs)
      const clipIds = JSON.parse(short.source_clips || '[]');
      const clips = clipIds.map(id => clipById.get(id)).filter(Boolean);

      if (clips.length === 0) {
        this.log(`[SHORTS] Short #${short.short_number}: no valid clips found, skipping`);
        skipped++;
        this._emitProgress({ phase: 'assembly', current: assembled + skipped, total, shortNumber: short.short_number, status: 'skipped' });
        continue;
      }

      this._emitProgress({ phase: 'assembly', current: assembled + skipped, total, shortNumber: short.short_number, status: 'assembling', startTime });

      // Assemble via FFmpeg
      const plan = { clips, shortNumber: short.short_number };
      const { filePath, duration } = await this.scheduler.assembleShort(plan, shortsDir);

      this._emitProgress({ phase: 'seo', current: assembled + skipped, total, shortNumber: short.short_number, status: 'generating_seo', startTime });

      // Generate SEO
      let seo = null;
      try {
        seo = await this.scheduler.generateSEO(plan, project);
      } catch (e) {
        this.log(`[SHORTS] SEO generation failed for short #${short.short_number}: ${e.message}`);
      }

      // Update the existing DB row
      this.scheduler.updateShortAssembled(short.id, filePath, duration, seo);
      assembled++;

      // Compute ETA
      const elapsed = (Date.now() - startTime) / 1000;
      const perShort = elapsed / (assembled + skipped);
      const remaining = Math.round(perShort * (total - assembled - skipped));

      this.log(`[SHORTS] Assembled ${assembled}/${total}: short #${short.short_number} (${duration.toFixed(1)}s) — ETA ${remaining}s`);
      this._emitProgress({ phase: 'assembly', current: assembled + skipped, total, shortNumber: short.short_number, status: 'done', elapsed: Math.round(elapsed), eta: remaining });
    }

    const seoRetryShorts = this.scheduler.getAssembledShortsNeedingSEO(projectId);
    if (seoRetryShorts.length > 0) {
      this.log(`[SHORTS] Retrying SEO for ${seoRetryShorts.length} assembled short(s)`);
    }

    for (const short of seoRetryShorts) {
      const clipIds = JSON.parse(short.source_clips || '[]');
      const clips = clipIds.map(id => clipById.get(id)).filter(Boolean);
      if (clips.length === 0) {
        const message = 'No valid source clips found for SEO retry';
        this.scheduler.markShortSEOFailed(short.id, message);
        this.log(`[SHORTS] SEO retry skipped for short #${short.short_number}: ${message}`);
        seoFailed++;
        continue;
      }

      const current = seoRecovered + seoFailed + 1;
      this._emitProgress({ phase: 'seo', current, total: seoRetryShorts.length, shortNumber: short.short_number, status: 'retrying_seo', startTime });

      const plan = { clips, shortNumber: short.short_number };
      try {
        const seo = await this.scheduler.generateSEO(plan, project);
        this.scheduler.updateShortSEO(short.id, seo);
        seoRecovered++;
        this.log(`[SHORTS] SEO recovered ${seoRecovered}/${seoRetryShorts.length}: short #${short.short_number}`);
      } catch (e) {
        this.scheduler.markShortSEOFailed(short.id, e.message);
        seoFailed++;
        this.log(`[SHORTS] SEO retry failed for short #${short.short_number}: ${e.message}`);
      }
    }

    return {
      shorts: this.scheduler.getShortsForProject(projectId),
      assembled,
      seoRecovered,
      seoFailed,
      skipped,
      total: planned.length + seoRetryShorts.length,
    };
  }

  /**
   * Upload all seo_done shorts for a project to Facebook.
   * Launches browser, loops through every pending short, closes browser when done.
   * Resumable — only processes status='seo_done', skips already-scheduled.
   *
   * @param {string} projectId
   * @param {function} onProgress - optional callback({ current, total, shortNumber, scheduledDate, success, error })
   * @returns {object} { uploaded, failed, total }
   */
  async uploadAll(projectId, onProgress) {
    const incomplete = this.scheduler.getIncompleteShortsBeforeUpload(projectId);
    if (incomplete.length > 0) {
      const pending = incomplete.filter(s => s.status === 'pending');
      const assembled = incomplete.filter(s => s.status === 'assembled');
      const planned = incomplete.filter(s => s.status === 'planned');
      const parts = [];
      if (pending.length > 0) parts.push(`${pending.length} pending short(s) still need planning`);
      if (planned.length > 0) parts.push(`${planned.length} planned short(s) still need assembly`);
      if (assembled.length > 0) parts.push(`${assembled.length} assembled short(s) still need SEO`);
      throw new Error(`SHORTS_NOT_READY: ${parts.join('; ')}. Finish Assemble + SEO before upload.`);
    }

    const scheduleWindow = FacebookUploader.getScheduleWindow(this.nowProvider());
    const uploadableNow = this._countPendingUploads(projectId, { maxScheduledDate: scheduleWindow.maxDate });
    const pendingUploads = this._countPendingUploads(projectId);
    const deferred = Math.max(0, pendingUploads - uploadableNow);
    const deferredMessage = `Facebook schedule window is ${scheduleWindow.today} through ${scheduleWindow.maxDate} (${scheduleWindow.maxDaysAhead} days ahead).`;

    if (uploadableNow === 0) {
      if (deferred > 0) {
        this.log(`[SHORTS] ${deferred} short(s) deferred. ${deferredMessage}`);
        this._emitProgress({
          phase: 'upload',
          status: 'deferred',
          deferred,
          maxScheduleDate: scheduleWindow.maxDate,
          message: deferredMessage,
        });
      }
      return { uploaded: 0, failed: 0, deferred, total: pendingUploads, maxScheduleDate: scheduleWindow.maxDate };
    }

    // Backup DB before upload session — status changes are hard to undo
    db.backup('pre-upload');

    // Launch browser
    if (this.uploader) {
      await this.uploader.close();
    }
    this.uploader = this.publisherFactory({
      platform: 'facebook_reels',
      uploaderOptions: this.uploaderOptions,
      log: this.log,
      nowProvider: this.nowProvider,
    });
    this._emitProgress({ phase: 'upload', status: 'logging_in', message: 'Waiting for Facebook login + 2FA...' });
    await this.uploader.launch(); // Waits for login + 2FA before returning
    this.log(`[SHORTS] Upload session started — uploading ${uploadableNow} short(s). ${deferred > 0 ? `${deferred} deferred beyond ${scheduleWindow.maxDate}.` : ''}`);

    let uploaded = 0;
    let failed = 0;
    let current = 0;
    const failedThisSession = new Set();

    try {
      while (true) {
        const nextShort = this.scheduler.getNextPendingUpload(projectId, [...failedThisSession], {
          maxScheduledDate: scheduleWindow.maxDate,
        });
        if (!nextShort) break;

        current++;
        const failedIds = [...failedThisSession];
        const exclusionSql = failedIds.length ? ` AND id NOT IN (${failedIds.map(() => '?').join(',')})` : '';
        const remainingRow = db.queryOne(
          `SELECT COUNT(*) as cnt FROM shorts
           WHERE project_id = ? AND status IN ('seo_done', 'upload_failed')${exclusionSql}
             AND scheduled_date <= ?`,
          [projectId, ...failedIds, scheduleWindow.maxDate]
        );
        const total = current + (remainingRow?.cnt || 0);

        this.log(`[SHORTS] Uploading short #${nextShort.short_number} (${current} of batch) → ${nextShort.scheduled_date}`);
        this._emitProgress({ phase: 'upload', current, total, shortNumber: nextShort.short_number, scheduledDate: nextShort.scheduled_date, status: 'uploading' });

        const description = this._buildFullDescription(nextShort);

        const result = await this.uploader.scheduleShort({
          filePath: nextShort.file_path,
          description,
          scheduledDate: nextShort.scheduled_date,
          scheduledTime: nextShort.scheduled_time,
          status: nextShort.status,
          short: nextShort,
        });

        if (result.success) {
          this.scheduler.markUploaded(nextShort.id, result.facebookPostId || null);
          uploaded++;
          this.log(`[SHORTS] Short #${nextShort.short_number} scheduled for ${nextShort.scheduled_date}`);
        } else if (result.deferred) {
          failedThisSession.add(nextShort.id);
          this.log(`[SHORTS] Short #${nextShort.short_number} deferred: ${result.error}`);
        } else {
          this.scheduler.markFailed(nextShort.id, result.error);
          failedThisSession.add(nextShort.id);
          failed++;
          this.log(`[SHORTS] Short #${nextShort.short_number} failed: ${result.error}`);
        }

        if (onProgress) {
          onProgress({
            current, total,
            shortNumber: nextShort.short_number,
            scheduledDate: nextShort.scheduled_date,
            success: result.success,
            error: result.error || null,
            deferred: result.deferred === true,
          });
        }
      }

      // All done — mark project as repurposed if everything uploaded
      const unscheduled = this.scheduler.getUnscheduledShorts(projectId);
      if (failed === 0 && uploaded > 0 && unscheduled.length === 0) {
        this.scheduler.markProjectRepurposed(projectId);
        this.log(`[SHORTS] All ${uploaded} shorts scheduled. Project marked as repurposed.`);
      } else if (failed === 0 && uploaded > 0) {
        this.log(`[SHORTS] Uploaded ${uploaded} shorts, ${deferred} deferred, ${unscheduled.length} short(s) remain unscheduled. Project not marked repurposed.`);
      }
    } finally {
      // Always close browser when done
      await this.closeUploadSession();
    }

    return { uploaded, failed, deferred, total: uploaded + failed + deferred, maxScheduleDate: scheduleWindow.maxDate };
  }

  /**
   * Prepare a YouTube Shorts publish job for a specific assembled short.
   * This is metadata/file validation only; it never opens YouTube Studio.
   */
  prepareYouTubePublishJob(shortId, options = {}) {
    const short = db.queryOne('SELECT * FROM shorts WHERE id = ?', [shortId]);
    if (!short) throw new Error(`Short not found: ${shortId}`);
    const project = db.queryOne('SELECT * FROM projects WHERE id = ?', [short.project_id]) || {};
    db.backup('pre-youtube-short-job-prep');
    return prepareYouTubeShortPublishJob(db, short, project, options);
  }

  /**
   * Pick the next eligible short for YouTube job prep and persist its job row.
   * Keeps existing Facebook status untouched.
   */
  prepareNextYouTubePublishJob(projectId, options = {}) {
    const project = db.queryOne('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const short = db.queryOne(`
      SELECT s.* FROM shorts s
      LEFT JOIN short_publish_jobs spj
        ON spj.short_id = s.id AND spj.platform = 'youtube_shorts'
      WHERE s.project_id = ?
        AND s.file_path IS NOT NULL
        AND s.status IN ('seo_done', 'scheduled', 'upload_failed')
        AND (spj.id IS NULL OR spj.status IN ('planned', 'blocked', 'upload_failed'))
      ORDER BY
        CASE WHEN s.duration_seconds IS NOT NULL AND s.duration_seconds <= 60 THEN 0 ELSE 1 END,
        s.short_number ASC
      LIMIT 1
    `, [projectId]);

    if (!short) throw new Error(`No eligible assembled short found for YouTube job prep: ${projectId}`);
    db.backup('pre-youtube-short-job-prep');
    return prepareYouTubeShortPublishJob(db, short, project, options);
  }

  /**
   * Prepare and schedule the next eligible YouTube Shorts job.
   * Live schedule still requires confirmSchedule=true in options.
   */
  async scheduleNextYouTubePublishJob(projectId, options = {}) {
    const prepared = this.prepareNextYouTubePublishJob(projectId, options.jobPrepOptions || options);
    if (!prepared || !prepared.job || !prepared.job.id) {
      throw new Error(`YOUTUBE_NEXT_JOB_PREP_FAILED`);
    }
    return this.scheduleYouTubePublishJob(prepared.job.id, options);
  }

  /**
   * Dry-run inspect the YouTube Studio upload entry for a prepared publish job.
   * Defaults to channel + Create entry proof only; pass { openWizard: true }
   * to inspect the upload dialog while still stopping before file selection.
   */
  async inspectYouTubeUploadWizard(jobId, options = {}) {
    const job = db.getShortPublishJobById(jobId);
    if (!job) throw new Error(`Short publish job not found: ${jobId}`);
    if (job.platform !== 'youtube_shorts') {
      throw new Error(`Publish job ${jobId} is not a YouTube Shorts job`);
    }
    if (!['ready', 'planned', 'blocked', 'upload_failed'].includes(job.status)) {
      throw new Error(`Publish job ${jobId} is not inspectable in status ${job.status}`);
    }

    const adapter = new YouTubeShortPublisherAdapter({
      dashboardUrl: options.dashboardUrl,
      userDataDir: options.userDataDir || this.uploaderOptions.userDataDir || null,
      headless: options.headless === true,
      loginWaitMs: options.loginWaitMs,
      log: this.log,
    });

    try {
      return await adapter.inspectUploadWizard({
        ...options,
        job,
        openWizard: options.openWizard === true,
      });
    } finally {
      await adapter.close();
    }
  }
  /**
   * Live one-short YouTube proof: upload, fill metadata, schedule, and persist
   * proof on short_publish_jobs. This does not update legacy Facebook fields.
   */
  async scheduleYouTubePublishJob(jobId, options = {}) {
    if (options.confirmSchedule !== true) {
      throw new Error('YOUTUBE_SCHEDULE_REQUIRES_CONFIRMATION: pass confirmSchedule=true for the live e2e schedule proof.');
    }

    const job = db.queryOne(`
      SELECT spj.*, s.file_path, s.duration_seconds, s.project_id, s.short_number
      FROM short_publish_jobs spj
      JOIN shorts s ON s.id = spj.short_id
      WHERE spj.id = ?
    `, [jobId]);
    if (!job) throw new Error(`Short publish job not found: ${jobId}`);
    if (job.platform !== 'youtube_shorts') throw new Error(`Publish job ${jobId} is not a YouTube Shorts job`);
    if (!['ready', 'draft_uploaded', 'upload_failed'].includes(job.status)) {
      throw new Error(`Publish job ${jobId} is not schedulable in status ${job.status}`);
    }

    const metadata = parseShortPublishJson(job.metadata_json, {});
    const validation = parseShortPublishJson(job.validation_json, {});
    const settings = metadata.settings || {};
    const videoInfo = validation.videoInfo || {};
    const scheduledDate = options.scheduledDate || job.scheduled_date;
    const scheduledTime = options.scheduledTime || job.scheduled_time || settings.defaultScheduleTime || '18:00';
    if (!scheduledDate) throw new Error('YOUTUBE_SCHEDULE_DATE_REQUIRED');

    const payload = {
      filePath: job.file_path,
      title: options.title || job.title || metadata.title,
      description: options.description || job.description || metadata.description,
      scheduledDate,
      scheduledTime,
      madeForKids: options.madeForKids ?? settings.madeForKids ?? false,
      aiDisclosure: options.aiDisclosure ?? settings.aiDisclosure ?? true,
      durationSeconds: videoInfo.durationSeconds || job.duration_seconds,
      width: videoInfo.width,
      height: videoInfo.height,
      validationOptions: options.validationOptions || {},
    };

    const adapter = new YouTubeShortPublisherAdapter({
      dashboardUrl: options.dashboardUrl,
      userDataDir: options.userDataDir || this.uploaderOptions.userDataDir || null,
      headless: options.headless === true,
      loginWaitMs: options.loginWaitMs,
      log: this.log,
    });

    db.backup('pre-youtube-short-live-schedule');
    db.updateShortPublishJob(job.id, {
      status: 'uploading',
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      error_message: null,
    });

    try {
      const result = await adapter.uploadAndScheduleShort(payload, {
        ...options,
        confirmDraftUpload: true,
        confirmSchedule: true,
        existingDraftPolicy: options.existingDraftPolicy || `resume`,
        setStudioDate: options.setStudioDate !== false,
        verifyInContentTab: options.verifyInContentTab !== false,
        contentVerifyDelayMs: Number.isFinite(Number(options.contentVerifyDelayMs)) ? Number(options.contentVerifyDelayMs) : 45000,
      });
      const proof = {
        ...result,
        jobId: job.id,
        shortId: job.short_id,
        scheduledDate,
        scheduledTime,
      };
      const updatedJob = db.updateShortPublishJob(job.id, {
        status: 'scheduled',
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        remote_post_id: result.remoteVideoId || null,
        remote_url: result.remoteUrl || null,
        upload_confirmed_at: new Date().toISOString(),
        proof_json: proof,
        error_message: null,
      });
      return {
        success: true,
        job: updatedJob,
        proof,
      };
    } catch (error) {
      const failedJob = db.markShortPublishJobFailed(job.id, error.message || String(error));
      return {
        success: false,
        job: failedJob,
        error: error.message || String(error),
      };
    } finally {
      await adapter.close();
    }
  }
  /**
   * Permanently delete a previously confirmed YouTube Shorts upload from Studio.
   * The remote target must come from remote_post_id; title-only deletion is forbidden.
   */
  async deleteYouTubePublishJob(jobId, options = {}) {
    if (options.confirmDelete !== true) {
      throw new Error('YOUTUBE_DELETE_REQUIRES_CONFIRMATION: pass confirmDelete=true for the permanent YouTube Studio delete action.');
    }

    const job = db.queryOne('SELECT spj.*, s.file_path, s.duration_seconds, s.project_id, s.short_number FROM short_publish_jobs spj JOIN shorts s ON s.id = spj.short_id WHERE spj.id = ?', [jobId]);
    if (!job) throw new Error('Short publish job not found: ' + jobId);
    if (job.platform !== 'youtube_shorts') throw new Error('Publish job ' + jobId + ' is not a YouTube Shorts job');
    if (!job.remote_post_id) {
      throw new Error('YOUTUBE_DELETE_REMOTE_ID_REQUIRED: publish job ' + jobId + ' has no remote_post_id proof');
    }

    const adapter = new YouTubeShortPublisherAdapter({
      dashboardUrl: options.dashboardUrl,
      userDataDir: options.userDataDir || this.uploaderOptions.userDataDir || null,
      headless: options.headless === true,
      loginWaitMs: options.loginWaitMs,
      log: this.log,
    });

    db.backup('pre-youtube-short-delete');
    try {
      const result = await adapter.deleteShort({
        remoteVideoId: job.remote_post_id,
        title: job.title,
        jobId: job.id,
      }, {
        ...options,
        confirmDelete: true,
      });
      const message = 'Deleted YouTube Shorts remote upload ' + job.remote_post_id + ' at user request; remote proof cleared.';
      const deletedJob = db.markShortPublishJobDeleted(job.id, message);
      return { success: true, job: deletedJob, proof: { ...result, jobId: job.id, shortId: job.short_id, previousRemotePostId: job.remote_post_id } };
    } catch (error) {
      const failedJob = db.updateShortPublishJob(job.id, { error_message: 'YouTube delete failed: ' + (error.message || String(error)) });
      return { success: false, job: failedJob, error: error.message || String(error) };
    } finally {
      await adapter.close();
    }
  }
  /**
   * Get status of all shorts for a project.
   */
  getStatus(projectId) {
    const shorts = this.scheduler.getShortsForProject(projectId);
    const summary = {
      total: shorts.length,
      planned: shorts.filter(s => s.status === 'planned').length,
      pending: shorts.filter(s => s.status === 'pending').length,
      assembled: shorts.filter(s => s.status === 'assembled').length,
      seo_done: shorts.filter(s => s.status === 'seo_done').length,
      scheduled: shorts.filter(s => s.status === 'scheduled').length,
      upload_failed: shorts.filter(s => s.status === 'upload_failed').length,
    };

    // Reconstruct stats from persisted shorts (survives restart)
    let stats = null;
    if (shorts.length > 0) {
      const totalDuration = shorts.reduce((sum, s) => sum + (s.duration_seconds || 0), 0);
      const dates = shorts.map(s => s.scheduled_date).filter(Boolean).sort();
      const startDate = dates[0] || null;
      const endDate = dates[dates.length - 1] || null;
      const calendarDays = (startDate && endDate)
        ? Math.round((new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24)) + 1
        : 0;

      // Count unique source clips across all shorts
      let totalClips = 0;
      const allClipIds = new Set();
      for (const s of shorts) {
        try {
          const ids = JSON.parse(s.source_clips || '[]');
          ids.forEach(id => allClipIds.add(id));
        } catch (_) {}
      }
      totalClips = allClipIds.size;

      const avgDuration = shorts.length > 0 ? Math.round(totalDuration / shorts.length) : 0;
      const postsPerDay = calendarDays > 0 ? Math.max(1, Math.ceil(shorts.length / calendarDays)) : 1;

      stats = {
        totalClips,
        totalDuration: Math.round(totalDuration),
        totalShorts: shorts.length,
        targetPerShort: avgDuration,
        postsPerDay,
        startDate,
        endDate,
        calendarDays,
      };
    }

    const youtubeJobs = typeof db.getShortPublishJobsForProject === `function`
      ? db.getShortPublishJobsForProject(projectId)
      : [];

    return { shorts, summary, stats, youtubeJobs };
  }

  /**
   * Close Playwright session.
   */
  async closeUploadSession() {
    if (this.uploader) {
      await this.uploader.close();
      this.uploader = null;
    }
  }

  // ── Private ──

  _emitProgress(data) {
    if (this.onProgress) this.onProgress(data);
  }

  _countPendingUploads(projectId, options = {}) {
    const maxDateSql = options.maxScheduledDate ? ' AND scheduled_date <= ?' : '';
    const params = [projectId];
    if (options.maxScheduledDate) params.push(options.maxScheduledDate);
    const row = db.queryOne(
      `SELECT COUNT(*) as cnt FROM shorts
       WHERE project_id = ?
         AND status IN ('seo_done', 'upload_failed')${maxDateSql}`,
      params
    );
    return row?.cnt || 0;
  }

  _buildFullDescription(short) {
    let desc = short.description || '';
    // Append hashtags if not already in description
    if (short.hashtags) {
      try {
        const tags = JSON.parse(short.hashtags);
        if (tags.length > 0 && !desc.includes(tags[0])) {
          desc += '\n\n' + tags.join(' ');
        }
      } catch (_) {}
    }
    return desc;
  }
}

function parseShortPublishJson(value, fallback) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}
module.exports = {
  ShortsController,
  ShortsScheduler,
  FacebookUploader,
  FacebookShortPublisherAdapter,
  YouTubeShortPublisherAdapter,
  YouTubeStudioUploader,
  extractYouTubeStudioChannelId,
  buildYouTubeShortMetadata,
  buildYouTubeHashtags,
  prepareYouTubeShortPublishJob,
  probeShortVideoFile,
  SHORT_PLATFORM_PROFILES,
  getShortPlatformProfile,
  normalizeShortPlatform,
  validateShortMetadataForPlatform,
};
