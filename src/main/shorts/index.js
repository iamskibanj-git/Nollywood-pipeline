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

    let assembled = 0;
    for (const short of planned) {
      // Reconstruct clip objects from source_clips (asset IDs)
      const clipIds = JSON.parse(short.source_clips || '[]');
      const clips = clipIds.map(id => {
        const assets = db.getAssets(projectId, { type: 'video_clip_cinematic' });
        return assets.find(a => a.id === id);
      }).filter(Boolean);

      if (clips.length === 0) {
        this.log(`[SHORTS] Short #${short.short_number}: no valid clips found, skipping`);
        continue;
      }

      // Assemble via FFmpeg
      const plan = { clips, shortNumber: short.short_number };
      const { filePath, duration } = await this.scheduler.assembleShort(plan, shortsDir);

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
      this.log(`[SHORTS] Assembled ${assembled}/${planned.length}: short #${short.short_number} (${duration.toFixed(1)}s)`);
    }

    return {
      shorts: this.scheduler.getShortsForProject(projectId),
      assembled,
      total: planned.length,
    };
  }

  /**
   * Start a Playwright upload session.
   * Launches browser — user must be logged into Facebook.
   */
  async startUploadSession() {
    if (this.uploader) {
      await this.uploader.close();
    }
    this.uploader = new FacebookUploader(this.uploaderOptions);
    await this.uploader.launch();
    this.log('[SHORTS] Upload session started — ensure you are logged into Facebook');
    return { status: 'ready' };
  }

  /**
   * Upload the next pending short for a project.
   * One at a time — caller confirms before moving to next.
   *
   * @param {string} projectId
   * @returns {object} { shortId, success, error?, remaining }
   */
  async uploadNext(projectId) {
    if (!this.uploader) {
      throw new Error('Upload session not started. Call startUploadSession() first.');
    }

    const nextShort = this.scheduler.getNextPendingUpload(projectId);
    if (!nextShort) {
      // All done — mark project as repurposed
      this.scheduler.markProjectRepurposed(projectId);
      return { shortId: null, success: true, remaining: 0, message: 'All shorts scheduled. Project marked as repurposed.' };
    }

    // Build the full description with hashtags
    const description = this._buildFullDescription(nextShort);

    // Schedule via Playwright
    const result = await this.uploader.scheduleReel({
      filePath: nextShort.file_path,
      description,
      scheduledDate: nextShort.scheduled_date,
      scheduledTime: nextShort.scheduled_time,
    });

    if (result.success) {
      this.scheduler.markUploaded(nextShort.id, result.facebookPostId || null);
    } else {
      this.scheduler.markFailed(nextShort.id, result.error);
    }

    // Count remaining
    const remaining = db.queryOne(
      `SELECT COUNT(*) as cnt FROM shorts WHERE project_id = ? AND status = 'seo_done'`,
      [projectId]
    );

    return {
      shortId: nextShort.id,
      shortNumber: nextShort.short_number,
      scheduledDate: nextShort.scheduled_date,
      success: result.success,
      error: result.error || null,
      remaining: remaining?.cnt || 0,
    };
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
      failed: shorts.filter(s => s.status === 'failed').length,
    };
    return { shorts, summary };
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
