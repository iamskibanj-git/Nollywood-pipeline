/**
 * Shorts Scheduler — Repurpose cinematic clips into 30-day Facebook Reel calendar.
 *
 * Standalone module (not part of the pipeline). Accessed via dedicated tab in the Electron app.
 * Workflow:
 *   1. Select completed project from dropdown
 *   2. Curate clips for standalone impact (exclude REDO backups)
 *   3. Combine clips into short-form reels via FFmpeg (watermarked)
 *   4. Generate SEO descriptions (dialogue-driven hooks + hashtags + CTA)
 *   5. Schedule via Playwright → Facebook Reel upload flow
 *   6. Tag project as repurposed once all shorts are scheduled
 *
 * Architecture:
 *   - Reads from the same SQLite DB as the main pipeline
 *   - FFmpeg for clip assembly + watermark
 *   - Claude API for SEO generation (dialogue-driven)
 *   - Playwright for Facebook automation (separate module: facebook-uploader.js)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('../database/db');

// ── Configuration ──
const BRANDING_OVERLAY_9_16 = path.join(__dirname, '..', '..', '..', 'config', 'branding 916.fw.png');
const MIN_SHORT_DURATION = 30;    // Minimum 30s per reel
const MAX_SHORT_DURATION = 90;    // Maximum 90s per reel (FB Reels sweet spot)
const CLIPS_PER_SHORT_MIN = 2;    // At least 2 clips combined
const CLIPS_PER_SHORT_MAX = 8;    // Hard ceiling per short
const CALENDAR_DAYS = 30;         // Target: fill a full month of content
const DEFAULT_SCHEDULE_TIME = '18:00'; // 6 PM — peak engagement for African content on FB
const FALLBACK_CLIP_DURATION = 10; // Seconds — if ffprobe fails on a clip

class ShortsScheduler {
  /**
   * @param {object} db - Database instance (same as pipeline)
   * @param {object} options - { apiKey, ffmpegPath }
   */
  constructor(_db, options = {}) {
    // Note: _db param kept for API compat but we use the singleton import directly
    this.ffmpegPath = options.ffmpegPath || findFFmpeg();
    this.anthropic = options.apiKey ? new Anthropic({ apiKey: options.apiKey }) : null;
    this.log = options.log || console.log;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get projects eligible for repurposing — any project with cinematic clips done.
   * Doesn't require completed_at because projects at the publish gate already
   * have all clips assembled and ready for shorts.
   * @returns {Array} [{ id, title, completedAt, repurposedAt, clipCount }]
   */
  getEligibleProjects() {
    const projects = db.queryAll(`
      SELECT * FROM (
        SELECT p.id, p.title, p.completed_at, p.repurposed_at,
          (SELECT COUNT(*) FROM project_assets pa
           WHERE pa.project_id = p.id
           AND pa.type = 'video_clip_cinematic'
           AND pa.status = 'done') as clip_count
        FROM projects p
        WHERE p.project_dir IS NOT NULL
          AND p.stage NOT IN ('abandoned')
      ) WHERE clip_count > 0
      ORDER BY completed_at DESC, clip_count DESC
    `);
    return projects;
  }

  /**
   * Get clips available for shorts from a project.
   * Excludes REDO backups (naming convention: *_redo_backup_*).
   *
   * @param {string} projectId
   * @param {string} mode - 'standalone_impact' | 'chronological'
   * @returns {Array} Clip objects with metadata
   */
  getAvailableClips(projectId, mode = 'standalone_impact') {
    const clips = db.queryAll(`
      SELECT pa.id, pa.file_path, pa.chapter, pa.scene, pa.line,
             pa.kling_clip_id, pa.prompt_used, pa.completed_at,
             pa.character_id, pa.line_refs
      FROM project_assets pa
      WHERE pa.project_id = ?
        AND pa.type = 'video_clip_cinematic'
        AND pa.status = 'done'
        AND pa.file_path IS NOT NULL
      ORDER BY pa.chapter, pa.scene, pa.line
    `, [projectId]);

    // Filter out REDO backups (soft-deleted clips renamed by verify stage)
    const validClips = clips.filter(clip => {
      if (!clip.file_path) return false;
      const basename = path.basename(clip.file_path);
      if (basename.includes('_redo_backup_')) return false;
      // Verify file actually exists on disk
      return fs.existsSync(clip.file_path);
    });

    if (mode === 'standalone_impact') {
      return this._rankForStandaloneImpact(validClips);
    }
    return validClips; // chronological is default order from SQL
  }

  /**
   * Plan a calendar of shorts from a project's clips.
   * Uses real ffprobe durations. Calendar length (default 30 days) drives
   * how clips are grouped — total duration ÷ calendar days = target per short.
   *
   * @param {string} projectId
   * @param {object} options - { mode, startDate, calendarDays, postsPerDay }
   * @returns {object} { calendar, stats }
   */
  planCalendar(projectId, options = {}) {
    const {
      mode = 'standalone_impact',
    } = options;
    const calendarDays = normalizePositiveInteger(options.calendarDays, CALENDAR_DAYS);

    // Resolve start date: explicit > day after durable scheduled short > tomorrow.
    // Draft planned rows are replaced after this calculation, so ignore them here.
    let startDate = normalizeDateOnly(options.startDate, 'startDate');
    if (!startDate) {
      const lastShort = db.queryOne(`
        SELECT scheduled_date FROM shorts
        WHERE project_id = ?
          AND scheduled_date IS NOT NULL
          AND status <> 'planned'
        ORDER BY scheduled_date DESC LIMIT 1
      `, [projectId]);
      if (lastShort?.scheduled_date) {
        startDate = addDaysDateOnly(lastShort.scheduled_date, 1);
      } else {
        startDate = getTomorrowDateOnly();
      }
    }

    const clips = this.getAvailableClips(projectId, mode);
    if (clips.length === 0) {
      throw new Error(`No eligible clips found for project ${projectId}`);
    }

    // Probe real durations for every clip
    this.log(`[SHORTS] Probing durations for ${clips.length} clips...`);
    this._probeClipDurations(clips);

    const totalDuration = clips.reduce((sum, c) => sum + c._duration, 0);

    // Target duration per short = total available ÷ calendar days
    // Clamp between MIN and MAX
    let targetPerShort = totalDuration / calendarDays;
    targetPerShort = Math.max(MIN_SHORT_DURATION, Math.min(MAX_SHORT_DURATION, targetPerShort));

    this.log(`[SHORTS] Total clip duration: ${totalDuration.toFixed(1)}s | ${calendarDays} day calendar | Target per short: ${targetPerShort.toFixed(1)}s`);

    // Prefer one whole-clip short per calendar day when the clip inventory supports it.
    let groupingMode = 'duration-target';
    let shorts = this._groupClipsForCalendarWindow(clips, calendarDays);
    if (shorts) {
      groupingMode = 'calendar-window';
      this.log(`[SHORTS] Calendar-aware grouping: ${clips.length} clips -> ${shorts.length} shorts (${calendarDays} requested day(s))`);
    } else {
      shorts = this._groupClipsIntoShorts(clips, targetPerShort);
    }

    // Compute posts per day from how many shorts vs calendar days
    const postsPerDay = Math.max(1, Math.ceil(shorts.length / calendarDays));

    // Assign schedule dates — spread shorts evenly across calendar
    const calendar = shorts.map((short, idx) => {
      const dayOffset = this._getScheduleDayOffset(idx, shorts.length, calendarDays, postsPerDay);

      return {
        shortNumber: idx + 1,
        clips: short.clips,
        clipIds: short.clips.map(c => c.id),
        duration: short.duration,
        scheduledDate: addDaysDateOnly(startDate, dayOffset),
        scheduledTime: DEFAULT_SCHEDULE_TIME,
      };
    });

    const endDate = calendar.length > 0 ? calendar[calendar.length - 1].scheduledDate : startDate;
    const actualDays = calendar.length > 0 ? diffDaysInclusive(startDate, endDate) : 0;

    const stats = {
      totalClips: clips.length,
      totalDuration: Math.round(totalDuration),
      totalShorts: shorts.length,
      targetPerShort: Math.round(targetPerShort),
      postsPerDay,
      groupingMode,
      requestedCalendarDays: calendarDays,
      startDate,
      endDate,
      calendarDays: actualDays,
    };

    this.log(`[SHORTS] Planned ${shorts.length} shorts (${postsPerDay}/day): ${startDate} → ${endDate} (${actualDays} days)`);

    return { calendar, stats };
  }

  /**
   * Probe real duration (seconds) for each clip via ffprobe.
   * Attaches _duration to each clip object in place.
   */
  _probeClipDurations(clips) {
    for (const clip of clips) {
      clip._duration = this._probeDuration(clip.file_path);
      if (clip._duration <= 0) {
        this.log(`[SHORTS] Warning: could not probe "${path.basename(clip.file_path)}", using ${FALLBACK_CLIP_DURATION}s fallback`);
        clip._duration = FALLBACK_CLIP_DURATION;
      }
    }
  }

  /**
   * Assemble a single short from its constituent clips via FFmpeg.
   * Concatenates clips + applies 9:16 watermark overlay.
   *
   * @param {object} shortPlan - From planCalendar: { clips, shortNumber }
   * @param {string} outputDir - Directory for assembled shorts
   * @returns {string} Path to assembled short video
   */
  async assembleShort(shortPlan, outputDir) {
    const { clips, shortNumber } = shortPlan;
    fs.mkdirSync(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, `short_${String(shortNumber).padStart(3, '0')}.mp4`);
    const concatListPath = path.join(outputDir, `concat_${shortNumber}.txt`);

    // Build FFmpeg concat demuxer file
    const concatEntries = clips.map(clip =>
      `file '${clip.file_path.replace(/'/g, "'\\''")}'`
    ).join('\n');
    fs.writeFileSync(concatListPath, concatEntries, 'utf-8');

    // Step 1: Concatenate clips
    const concatTempPath = path.join(outputDir, `concat_temp_${shortNumber}.mp4`);
    this._runFFmpeg([
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-y', concatTempPath,
    ]);

    // Step 2: Apply watermark overlay
    const hasOverlay = BRANDING_OVERLAY_9_16 && fs.existsSync(BRANDING_OVERLAY_9_16);

    if (hasOverlay) {
      // Overlay watermark on concatenated video
      const filterComplex = [
        '[0:v]scale=1080:1920:flags=lanczos[base]',
        '[1:v]scale=1080:1920:flags=lanczos,format=rgba[ovr]',
        '[base][ovr]overlay=0:0:format=auto,format=yuv420p[out]',
      ].join(';');

      this._runFFmpeg([
        '-i', concatTempPath,
        '-i', BRANDING_OVERLAY_9_16,
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-map', '0:a',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-y', outputPath,
      ]);
    } else {
      // No watermark — just scale to 1080x1920 for FB Reels
      this._runFFmpeg([
        '-i', concatTempPath,
        '-vf', 'scale=1080:1920:flags=lanczos,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '20',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-y', outputPath,
      ]);
    }

    // Cleanup temp files
    try { fs.unlinkSync(concatTempPath); } catch (_) {}
    try { fs.unlinkSync(concatListPath); } catch (_) {}

    // Probe final duration
    const duration = this._probeDuration(outputPath);
    this.log(`[SHORTS] Assembled short #${shortNumber}: ${clips.length} clips → ${duration.toFixed(1)}s @ ${outputPath}`);

    return { filePath: outputPath, duration };
  }

  /**
   * Generate SEO description for a short (dialogue-driven).
   *
   * @param {object} shortPlan - { clips }
   * @param {object} project - Project data with title
   * @returns {object} { title, description, hashtags }
   */
  async generateSEO(shortPlan, project) {
    if (!this.anthropic) throw new Error('Anthropic API key required for SEO generation');

    const { clips } = shortPlan;
    const dialogueLines = this._extractDialogue(clips);
    const sceneContext = this._extractSceneContext(clips);
    const projectTitle = project.title || 'Untitled';

    const prompt = `You are a Facebook Reels SEO specialist for Nollywood drama content.

Generate metadata for a short-form reel (30-90 second clip) extracted from the full movie "${projectTitle}".

DIALOGUE IN THIS REEL:
${dialogueLines.join('\n')}

SCENE CONTEXT:
${sceneContext}

REQUIREMENTS:

1. **description** (string): Facebook Reel caption. Structure:
   - Line 1: Hook — the single most impactful/intriguing dialogue line or moment from the reel, framed as a question or provocative statement (under 125 characters so it shows above "...more")
   - Line 2-3: Brief tease of what's happening in the clip (1-2 sentences max)
   - Line 4: CTA — "Follow for the next episode" or "Comment 'FULL' for the full movie link"
   - Line 5+: Hashtags

2. **hashtags** (array of 8-12 strings): Mix of:
   - Broad: #nollywood #nollywoodmovies #africandrama #naijamovies
   - Emotional: based on clip tone (#betrayal #love #secrets #revenge etc.)
   - Discovery: #reels #fbreels #shortfilm #drama
   - No spaces in tags. Lowercase. Include # prefix.

3. **title** (string): Short hook title for the reel (under 40 characters). Dramatic, curiosity-driven.

Reply with ONLY valid JSON:
{
  "title": "...",
  "description": "...",
  "hashtags": ["#nollywood", ...]
}`;

    const response = await this.anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('SEO generation returned invalid JSON');
    }
    return JSON.parse(jsonMatch[0]);
  }

  /**
   * Persist the entire plan to DB. Clears any previous unassembled plan first.
   * Each short gets status = 'planned' — no FFmpeg work yet.
   */
  savePlan(projectId, calendar) {
    // Clear previous planned (not yet assembled) shorts — don't touch assembled/scheduled ones
    db.runSql(`DELETE FROM shorts WHERE project_id = ? AND status = 'planned'`, [projectId]);

    for (const entry of calendar) {
      db.runSql(`
        INSERT INTO shorts (project_id, short_number, source_clips, duration_seconds,
                            scheduled_date, scheduled_time, status)
        VALUES (?, ?, ?, ?, ?, ?, 'planned')
      `, [
        projectId,
        entry.shortNumber,
        JSON.stringify(entry.clipIds),
        entry.duration,
        entry.scheduledDate,
        entry.scheduledTime || DEFAULT_SCHEDULE_TIME,
      ]);
    }
    this.log(`[SHORTS] Saved plan: ${calendar.length} shorts persisted to DB`);
  }

  /**
   * Persist a planned + assembled short to the DB.
   */
  saveShort(projectId, shortData) {
    const { shortNumber, clipIds, filePath, duration, scheduledDate, scheduledTime, seo } = shortData;

    db.runSql(`
      INSERT INTO shorts (project_id, short_number, title, description, hashtags,
                          source_clips, file_path, duration_seconds,
                          scheduled_date, scheduled_time, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      projectId,
      shortNumber,
      seo?.title || null,
      seo?.description || null,
      JSON.stringify(seo?.hashtags || []),
      JSON.stringify(clipIds),
      filePath,
      duration,
      scheduledDate,
      scheduledTime || DEFAULT_SCHEDULE_TIME,
      seo ? 'seo_done' : 'assembled',
    ]);

    const row = db.queryOne(`SELECT last_insert_rowid() as id`);
    return row?.id;
  }

  /**
   * Update a planned short after assembly + SEO.
   */
  updateShortAssembled(shortId, filePath, duration, seo) {
    db.runSql(`
      UPDATE shorts SET file_path = ?,
                        duration_seconds = ?,
                        title = ?,
                        description = ?,
                        hashtags = ?,
                        status = ?,
                        updated_at = datetime('now')
      WHERE id = ?
    `, [
      filePath,
      duration,
      seo?.title || null,
      seo?.description || null,
      JSON.stringify(seo?.hashtags || []),
      seo ? 'seo_done' : 'assembled',
      shortId,
    ]);
  }

  /**
   * Update SEO metadata for an already-assembled short without re-encoding video.
   */
  updateShortSEO(shortId, seo) {
    if (!seo) throw new Error('SEO metadata is required');
    db.runSql(`
      UPDATE shorts SET title = ?,
                        description = ?,
                        hashtags = ?,
                        status = 'seo_done',
                        error_message = NULL,
                        updated_at = datetime('now')
      WHERE id = ?
    `, [
      seo.title || null,
      seo.description || null,
      JSON.stringify(seo.hashtags || []),
      shortId,
    ]);
  }

  markShortSEOFailed(shortId, errorMessage) {
    db.runSql(`
      UPDATE shorts SET error_message = ?,
                        updated_at = datetime('now')
      WHERE id = ? AND status = 'assembled'
    `, [errorMessage || 'SEO generation failed', shortId]);
  }

  /**
   * Get all planned (not yet assembled) shorts for a project.
   */
  getPlannedShorts(projectId) {
    return db.queryAll(`
      SELECT * FROM shorts WHERE project_id = ? AND status = 'planned'
      ORDER BY short_number
    `, [projectId]);
  }

  /**
   * Get assembled shorts that have video files but still need SEO metadata.
   */
  getAssembledShortsNeedingSEO(projectId) {
    return db.queryAll(`
      SELECT * FROM shorts
      WHERE project_id = ?
        AND status = 'assembled'
        AND file_path IS NOT NULL
      ORDER BY short_number
    `, [projectId]);
  }

  getIncompleteShortsBeforeUpload(projectId) {
    return db.queryAll(`
      SELECT * FROM shorts
      WHERE project_id = ?
        AND status IN ('pending', 'planned', 'assembled')
      ORDER BY short_number
    `, [projectId]);
  }

  getUnscheduledShorts(projectId) {
    return db.queryAll(`
      SELECT * FROM shorts
      WHERE project_id = ?
        AND status <> 'scheduled'
      ORDER BY short_number
    `, [projectId]);
  }

  /**
   * Mark a short as successfully uploaded/scheduled on Facebook.
   */
  markUploaded(shortId, facebookPostId = null) {
    db.runSql(`
      UPDATE shorts SET status = 'scheduled',
                        upload_confirmed_at = datetime('now'),
                        facebook_post_id = ?,
                        updated_at = datetime('now')
      WHERE id = ?
    `, [facebookPostId, shortId]);
  }

  /**
   * Mark a short upload as failed.
   */
  markFailed(shortId, errorMessage) {
    db.runSql(`
      UPDATE shorts SET status = 'upload_failed',
                        error_message = ?,
                        updated_at = datetime('now')
      WHERE id = ?
    `, [errorMessage, shortId]);
  }

  /**
   * Tag project as fully repurposed (all shorts scheduled).
   */
  markProjectRepurposed(projectId) {
    db.runSql(`
      UPDATE projects SET repurposed_at = datetime('now'),
                          updated_at = datetime('now')
      WHERE id = ?
    `, [projectId]);
  }

  /**
   * Get all shorts for a project with their status.
   */
  getShortsForProject(projectId) {
    return db.queryAll(`
      SELECT * FROM shorts WHERE project_id = ? ORDER BY short_number
    `, [projectId]);
  }

  /**
   * Get the next short that needs uploading.
   * Picks up both fresh (seo_done) and retryable (upload_failed) shorts.
   * Order: short_number ASC — short_001 always goes first.
   */
  getNextPendingUpload(projectId, excludeIds = [], options = {}) {
    const excluded = Array.isArray(excludeIds) ? excludeIds.filter(id => id !== null && id !== undefined) : [];
    const exclusionSql = excluded.length ? ` AND id NOT IN (${excluded.map(() => '?').join(',')})` : '';
    const maxDateSql = options.maxScheduledDate ? ' AND scheduled_date <= ?' : '';
    const params = [projectId, ...excluded];
    if (options.maxScheduledDate) params.push(options.maxScheduledDate);
    return db.queryOne(`
      SELECT * FROM shorts
      WHERE project_id = ? AND status IN ('seo_done', 'upload_failed')${exclusionSql}${maxDateSql}
      ORDER BY short_number ASC
      LIMIT 1
    `, params);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE — CLIP RANKING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Rank clips for standalone impact (most engaging first).
   * Scoring: dialogue word count, emotional tone markers, scene variety.
   */
  _rankForStandaloneImpact(clips) {
    const scored = clips.map(clip => {
      let score = 0;
      const prompt = clip.prompt_used || '';

      // Dialogue density — more dialogue = more engaging for short-form
      const dialogueMatches = prompt.match(/\]:\s*"([^"]*)"/g) || [];
      const dialogueText = dialogueMatches.map(m => {
        const q = m.match(/"([^"]*)"/);
        return q ? q[1] : '';
      }).join(' ');
      const wordCount = dialogueText.split(/\s+/).filter(w => w.length > 0).length;
      score += Math.min(wordCount * 2, 40); // cap at 40 pts for dialogue

      // Emotional intensity markers in shot directions
      const emotionMarkers = (prompt.match(/\b(confronts?|betrayal|secret|lies?|tears?|shock|rage|pleads?|screams?|whispers?|trembl|heartbreak|revenge)\b/gi) || []).length;
      score += emotionMarkers * 5;

      // Camera variety (push-in, CU = more dramatic = better standalone)
      const pushIns = (prompt.match(/push-in|CLOSE-UP|EXTREME CLOSE/gi) || []).length;
      score += pushIns * 3;

      // Penalize clips that are just establishing shots / less dialogue
      if (wordCount < 10) score -= 20;

      return { ...clip, _score: score, _dialogueText: dialogueText };
    });

    // Sort by score descending
    scored.sort((a, b) => b._score - a._score);
    return scored;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE — CLIP GROUPING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Group clips into shorts using real durations and a computed target.
   * Fills each short until it hits the target, respecting min/max constraints.
   *
   * @param {Array} clips - Clips with _duration attached
   * @param {number} targetDuration - Target seconds per short (computed from calendar)
   */
  _groupClipsForCalendarWindow(clips, calendarDays) {
    if (!Number.isInteger(calendarDays) || calendarDays <= 0) return null;
    if (clips.length < calendarDays * CLIPS_PER_SHORT_MIN) return null;
    if (clips.length > calendarDays * CLIPS_PER_SHORT_MAX) return null;

    const baseClipCount = Math.floor(clips.length / calendarDays);
    const extraClipDays = clips.length % calendarDays;
    if (baseClipCount < CLIPS_PER_SHORT_MIN) return null;
    if (baseClipCount > CLIPS_PER_SHORT_MAX) return null;
    if (extraClipDays > 0 && baseClipCount + 1 > CLIPS_PER_SHORT_MAX) return null;

    const shorts = [];
    let cursor = 0;
    for (let day = 0; day < calendarDays; day++) {
      const extraForDay = Math.floor(((day + 1) * extraClipDays) / calendarDays)
        - Math.floor((day * extraClipDays) / calendarDays);
      const clipCount = baseClipCount + extraForDay;
      const group = clips.slice(cursor, cursor + clipCount);
      cursor += clipCount;

      shorts.push({
        clips: group,
        duration: this._sumClipDurations(group),
      });
    }

    return cursor === clips.length ? shorts : null;
  }

  _getScheduleDayOffset(index, totalShorts, calendarDays, postsPerDay) {
    if (totalShorts >= calendarDays) {
      return Math.min(calendarDays - 1, Math.floor((index * calendarDays) / totalShorts));
    }
    return Math.floor(index / postsPerDay);
  }

  _sumClipDurations(clips) {
    return clips.reduce((sum, clip) => sum + (clip._duration || FALLBACK_CLIP_DURATION), 0);
  }

  _groupClipsIntoShorts(clips, targetDuration) {
    const shorts = [];
    let currentGroup = [];
    let currentDuration = 0;

    for (const clip of clips) {
      const clipDur = clip._duration || FALLBACK_CLIP_DURATION;
      currentGroup.push(clip);
      currentDuration += clipDur;

      // Check if we've hit the target or clip ceiling
      if (currentDuration >= targetDuration || currentGroup.length >= CLIPS_PER_SHORT_MAX) {
        shorts.push({
          clips: [...currentGroup],
          duration: currentDuration,
        });
        currentGroup = [];
        currentDuration = 0;
      }
    }

    // Handle remainder
    if (currentGroup.length > 0) {
      if (currentGroup.length >= CLIPS_PER_SHORT_MIN) {
        shorts.push({ clips: currentGroup, duration: currentDuration });
      } else if (shorts.length > 0) {
        // Merge remainder into last short if it won't blow past MAX_SHORT_DURATION too badly
        const last = shorts[shorts.length - 1];
        if (last.clips.length + currentGroup.length <= CLIPS_PER_SHORT_MAX) {
          last.clips.push(...currentGroup);
          last.duration += currentDuration;
        } else {
          shorts.push({ clips: currentGroup, duration: currentDuration });
        }
      } else {
        // Only a few clips total — create a single short
        shorts.push({ clips: currentGroup, duration: currentDuration });
      }
    }

    return shorts;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE — DIALOGUE / CONTEXT EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract dialogue lines from clip prompts for SEO generation.
   */
  _extractDialogue(clips) {
    const lines = [];
    for (const clip of clips) {
      const prompt = clip.prompt_used || '';
      const matches = prompt.match(/\[@([^,\]]+)[^\]]*\]:\s*"([^"]*)"/g) || [];
      for (const m of matches) {
        const parsed = m.match(/\[@([^,\]]+)[^\]]*\]:\s*"([^"]*)"/);
        if (parsed) {
          const charName = parsed[1].replace(/_[a-z]{2,5}_\d{4}$/, '').replace(/_/g, ' ');
          lines.push(`${charName}: "${parsed[2]}"`);
        }
      }
    }
    return lines;
  }

  /**
   * Extract scene context from clip prompts.
   */
  _extractSceneContext(clips) {
    const contexts = new Set();
    for (const clip of clips) {
      const prompt = clip.prompt_used || '';
      // First line usually describes location/setting
      const firstLine = prompt.split('\n')[0];
      if (firstLine && firstLine.length > 10 && !firstLine.startsWith('CHARACTER')) {
        contexts.add(firstLine.trim());
      }
    }
    return [...contexts].join('\n');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE — UTILITIES
  // ═══════════════════════════════════════════════════════════════════════

  _probeDuration(filePath) {
    // Try ffprobe first (clean, reliable)
    const ffprobePath = this.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    try {
      const output = execSync(
        `"${ffprobePath}" -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
        { encoding: 'utf-8', timeout: 15000 }
      ).trim();
      const dur = parseFloat(output);
      if (!isNaN(dur) && dur > 0) return dur;
    } catch (_) {}

    // Fallback: parse ffmpeg -i stderr (Duration: HH:MM:SS.ms)
    try {
      execSync(`"${this.ffmpegPath}" -i "${filePath}" -f null - 2>&1`, {
        encoding: 'utf-8', timeout: 15000,
      });
    } catch (e) {
      const msg = e.stderr || e.stdout || e.message || '';
      const match = msg.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (match) {
        return parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseFloat(match[3]);
      }
    }
    return 0;
  }

  _runFFmpeg(args) {
    const cmd = `"${this.ffmpegPath}" ${args.map(a => `"${a}"`).join(' ')}`;
    try {
      execSync(cmd, { timeout: 120000, stdio: 'pipe' });
    } catch (e) {
      const stderr = e.stderr ? e.stderr.toString() : e.message;
      throw new Error(`FFmpeg failed: ${stderr.slice(-500)}`);
    }
  }
}

// Date-only helpers keep schedule math out of UTC/local timezone edge cases.
function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return fallback;
  return Math.floor(number);
}

function normalizeDateOnly(value, fieldName = 'date') {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid ${fieldName}: expected YYYY-MM-DD`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(`Invalid ${fieldName}: ${text}`);
  }

  return formatDateOnly(date);
}

function addDaysDateOnly(value, days) {
  const date = parseDateOnly(value);
  date.setDate(date.getDate() + days);
  return formatDateOnly(date);
}

function diffDaysInclusive(startDate, endDate) {
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate);
  return Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

function getTomorrowDateOnly() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return formatDateOnly(tomorrow);
}

function parseDateOnly(value) {
  const normalized = normalizeDateOnly(value);
  if (!normalized) {
    throw new Error('Invalid date: expected YYYY-MM-DD');
  }
  const [year, month, day] = normalized.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateOnly(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// FFmpeg discovery (same pattern as assembler.js)
function findFFmpeg() {
  const candidates = [
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const cmd of candidates) {
    try {
      execSync(`"${cmd}" -version`, { stdio: 'ignore', timeout: 5000 });
      return cmd;
    } catch (_) {}
  }
  throw new Error('FFmpeg not found. Install FFmpeg and ensure it is on PATH.');
}

module.exports = { ShortsScheduler };
