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
    };
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
    const { mode = 'standalone_impact', calendarDays = 30 } = options;
    const result = this.scheduler.planCalendar(projectId, { mode, calendarDays });
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

    // Get planned shorts from DB
    const planned = this.scheduler.getPlannedShorts(projectId);
    if (planned.length === 0) {
      throw new Error('No planned shorts to assemble. Run Plan Calendar first.');
    }

    this.log(`[SHORTS] Assembling ${planned.length} planned shorts for "${project.title}"`);

    const projectDir = project.project_dir || path.join(process.cwd(), 'output', projectId);
    const shortsDir = path.join(projectDir, 'shorts');

    // Load all cinematic clip assets once (avoid N+1 queries per short)
    const allClipAssets = db.getAssets(projectId, { type: 'video_clip_cinematic' });
    const clipById = new Map(allClipAssets.map(a => [a.id, a]));

    let assembled = 0;
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

    return {
      shorts: this.scheduler.getShortsForProject(projectId),
      assembled,
      total: planned.length,
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
    // Backup DB before upload session — status changes are hard to undo
    db.backup('pre-upload');

    // Launch browser
    if (this.uploader) {
      await this.uploader.close();
    }
    this.uploader = new FacebookUploader(this.uploaderOptions);
    this._emitProgress({ phase: 'upload', status: 'logging_in', message: 'Waiting for Facebook login + 2FA...' });
    await this.uploader.launch(); // Waits for login + 2FA before returning
    this.log('[SHORTS] Upload session started — uploading all shorts');

    let uploaded = 0;
    let failed = 0;
    let current = 0;

    try {
      while (true) {
        const nextShort = this.scheduler.getNextPendingUpload(projectId);
        if (!nextShort) break;

        current++;
        const total = current + db.queryOne(
          `SELECT COUNT(*) as cnt FROM shorts WHERE project_id = ? AND status IN ('seo_done', 'upload_failed')`,
          [projectId]
        )?.cnt || 0;

        this.log(`[SHORTS] Uploading short #${nextShort.short_number} (${current} of batch) → ${nextShort.scheduled_date}`);
        this._emitProgress({ phase: 'upload', current, total, shortNumber: nextShort.short_number, scheduledDate: nextShort.scheduled_date, status: 'uploading' });

        const description = this._buildFullDescription(nextShort);

        const result = await this.uploader.scheduleReel({
          filePath: nextShort.file_path,
          description,
          scheduledDate: nextShort.scheduled_date,
          scheduledTime: nextShort.scheduled_time,
        });

        if (result.success) {
          this.scheduler.markUploaded(nextShort.id, result.facebookPostId || null);
          uploaded++;
          this.log(`[SHORTS] Short #${nextShort.short_number} scheduled for ${nextShort.scheduled_date}`);
        } else {
          this.scheduler.markFailed(nextShort.id, result.error);
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
          });
        }
      }

      // All done — mark project as repurposed if everything uploaded
      if (failed === 0 && uploaded > 0) {
        this.scheduler.markProjectRepurposed(projectId);
        this.log(`[SHORTS] All ${uploaded} shorts scheduled. Project marked as repurposed.`);
      }
    } finally {
      // Always close browser when done
      await this.closeUploadSession();
    }

    return { uploaded, failed, total: uploaded + failed };
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

    return { shorts, summary, stats };
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

module.exports = { ShortsController, ShortsScheduler, FacebookUploader };
