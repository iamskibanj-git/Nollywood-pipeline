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
    // Launch browser
    if (this.uploader) {
      await this.uploader.close();
    }
    this.uploader = new FacebookUploader(this.uploaderOptions);
    await this.uploader.launch();
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
          `SELECT COUNT(*) as cnt 