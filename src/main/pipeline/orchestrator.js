const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { ScriptEngine } = require('./script-engine');
const { HiggsFieldAutomation } = require('../automation/higgsfield');
const { VideoAssembler } = require('../assembly/assembler');
const { YouTubeResearcher } = require('../research/youtube-scraper');
const { GeminiVideoAnalyzer } = require('../research/gemini-analyzer');
const db = require('../database/db');

const STAGES = ['research', 'script', 'portraits', 'scenes', 'video', 'assembly', 'publish', 'export'];

// ── Duration Calculation ──
const AVG_CLIP_DURATION = 7;         // 6-8 seconds per clip, average 7 (staged/Veo)
const CREDITS_PER_CLIP = 12;         // Veo 3.1 Lite: 12 credits per 8s clip (staged)

// ── Cinematic (Kling) Duration Constants ──
const KLING_CLIP_DURATION = 11;      // 10-12 seconds per Kling clip, average 11
const KLING_CREDITS_PER_CLIP = 11;   // ~11 credits per Kling multi-shot clip
const KLING_CREDITS_PER_SCENE = 2;   // ~2 credits per scene image (Nano Banana Pro)
const KLING_CREDITS_PER_PORTRAIT = 2; // ~2 credits per character portrait grid

/**
 * Duration presets. Each defines the target and matching story structures.
 * Structures are tried in order — first one that meets or exceeds targetClips wins.
 */
const DURATION_PRESETS = {
  '1min': {
    label: '1 min (~108 credits)',
    targetSeconds: 60,
    structures: [
      { chapters: 1, scenesPerChapter: 3, linesPerScene: 3 },  //  9 lines → ~1.05 min
      { chapters: 1, scenesPerChapter: 2, linesPerScene: 5 },  // 10 lines → ~1.16 min
      { chapters: 2, scenesPerChapter: 2, linesPerScene: 3 },  // 12 lines → ~1.4 min
    ],
  },
  '2min': {
    label: '2 min (~216 credits)',
    targetSeconds: 120,
    structures: [
      { chapters: 2, scenesPerChapter: 3, linesPerScene: 3 },  // 18 lines → ~2.1 min
      { chapters: 3, scenesPerChapter: 2, linesPerScene: 3 },  // 18 lines → ~2.1 min
      { chapters: 2, scenesPerChapter: 2, linesPerScene: 5 },  // 20 lines → ~2.3 min
    ],
  },
  '5min': {
    label: '5 min (~540 credits)',
    targetSeconds: 300,
    structures: [
      { chapters: 3, scenesPerChapter: 3, linesPerScene: 5 },  // 45 lines → ~5.25 min
      { chapters: 3, scenesPerChapter: 4, linesPerScene: 4 },  // 48 lines → ~5.6 min
      { chapters: 4, scenesPerChapter: 3, linesPerScene: 4 },  // 48 lines → ~5.6 min
    ],
  },
  '10min': {
    label: '10 min (~1080 credits)',
    targetSeconds: 600,
    structures: [
      { chapters: 6, scenesPerChapter: 3, linesPerScene: 5 },  // 90 lines → ~10.5 min
      { chapters: 5, scenesPerChapter: 4, linesPerScene: 5 },  // 100 lines → ~11.7 min
      { chapters: 7, scenesPerChapter: 3, linesPerScene: 4 },  // 84 lines → ~9.8 min
      { chapters: 6, scenesPerChapter: 4, linesPerScene: 4 },  // 96 lines → ~11.2 min
      { chapters: 8, scenesPerChapter: 3, linesPerScene: 4 },  // 96 lines → ~11.2 min
    ],
  },
  // Long-form: fewer chapters with MORE lines per scene is structurally stronger.
  // Nollywood YouTube long-form typically uses 7-10 "parts" with extended dramatic
  // scenes, not 18+ micro-chapters. These presets reflect that convention.
  '20min': {
    label: '20 min (~2160 credits)',
    targetSeconds: 1200,
    structures: [
      { chapters: 8, scenesPerChapter: 3, linesPerScene: 8 },  // 192 lines → ~22.4 min
      { chapters: 7, scenesPerChapter: 3, linesPerScene: 9 },  // 189 lines → ~22.1 min
      { chapters: 9, scenesPerChapter: 3, linesPerScene: 7 },  // 189 lines → ~22.1 min
    ],
  },
  '30min': {
    label: '30 min (~3240 credits)',
    targetSeconds: 1800,
    structures: [
      { chapters: 10, scenesPerChapter: 3, linesPerScene: 9 },  // 270 lines → ~31.5 min
      { chapters: 9, scenesPerChapter: 3, linesPerScene: 10 }, // 270 lines → ~31.5 min
      { chapters: 11, scenesPerChapter: 3, linesPerScene: 8 }, // 264 lines → ~30.8 min
    ],
  },
};

/**
 * Cinematic (Kling) duration presets — story-driven, clip-budget model.
 * Scenes, lines per scene, and characters are UNLIMITED (story decides).
 * The clip count is the budget constraint, derived from target duration ÷ 11s.
 * Chapters provide a recommended range; Claude distributes freely.
 *
 * Only used when generatorMode === 'cinematic'. Staged (Veo) uses DURATION_PRESETS above.
 */
const CINEMATIC_DURATION_PRESETS = {
  '1min': {
    label: '1 min (~100 credits)',
    targetSeconds: 60,
    targetClips: 6,         // 60s ÷ 11s
    chapters: 1,            // recommended
    estimatedScenes: 3,     // for credit estimation only
    estimatedCharacters: 3, // for credit estimation only
  },
  '2min': {
    label: '2 min (~200 credits)',
    targetSeconds: 120,
    targetClips: 11,
    chapters: 2,
    estimatedScenes: 6,
    estimatedCharacters: 3,
  },
  '5min': {
    label: '5 min (~500 credits)',
    targetSeconds: 300,
    targetClips: 27,
    chapters: 3,
    estimatedScenes: 12,
    estimatedCharacters: 4,
  },
  '10min': {
    label: '10 min (~1000 credits)',
    targetSeconds: 600,
    targetClips: 55,
    chapters: 6,
    estimatedScenes: 20,
    estimatedCharacters: 5,
  },
  '20min': {
    label: '20 min (~1800 credits)',
    targetSeconds: 1200,
    targetClips: 109,
    chapters: 8,
    estimatedScenes: 30,
    estimatedCharacters: 6,
  },
  '30min': {
    label: '30 min (~2100 credits)',
    targetSeconds: 1800,
    targetClips: 164,
    chapters: 10,
    estimatedScenes: 40,
    estimatedCharacters: 8,
  },
};

/**
 * Classify a duration preset into a tier for structural scaffolding purposes.
 *
 *   test       — 1-5 min: lightweight hook + escalation + punch
 *   standard   — 10 min: classic 3-act with midpoint
 *   long-form  — 20-30 min: 3-act + midpoint + B-plot + ensemble
 */
function getDurationTier(preset) {
  if (preset === '1min' || preset === '2min' || preset === '5min') return 'test';
  if (preset === '10min') return 'standard';
  if (preset === '20min' || preset === '30min') return 'long-form';
  return 'standard';
}

/**
 * Auto-calculate chapter/scene/line structure to hit the target duration.
 * @param {string} preset - '5min' or '10min' (default '10min')
 * @param {string} generatorMode - 'staged' or 'cinematic' (default 'staged')
 * Returns { chapters, scenesPerChapter, linesPerScene, totalLines, estimatedDuration, estimatedCredits }
 *   (staged mode) or { chapters, targetClips, estimatedDuration, estimatedCredits, ... } (cinematic mode)
 */
function calculateStoryStructure(preset = '10min', generatorMode = 'staged') {
  // ── CINEMATIC (Kling) — clip-budget, story-driven ──
  if (generatorMode === 'cinematic') {
    const config = CINEMATIC_DURATION_PRESETS[preset] || CINEMATIC_DURATION_PRESETS['10min'];
    const clipCredits = config.targetClips * KLING_CREDITS_PER_CLIP;
    const sceneCredits = config.estimatedScenes * KLING_CREDITS_PER_SCENE;
    const portraitCredits = config.estimatedCharacters * KLING_CREDITS_PER_PORTRAIT;
    const buffer = Math.ceil(clipCredits * 0.1); // 10% retry buffer
    return {
      chapters: config.chapters,
      targetClips: config.targetClips,
      estimatedScenes: config.estimatedScenes,
      estimatedCharacters: config.estimatedCharacters,
      // Keep scenesPerChapter/linesPerScene for backward compat in log messages,
      // but mark them as flexible (not enforced for cinematic)
      scenesPerChapter: 'unlimited',
      linesPerScene: 'unlimited',
      totalLines: config.targetClips * 3, // max lines (3 per clip), for estimation only
      estimatedDuration: Math.round((config.targetClips * KLING_CLIP_DURATION) / 60 * 10) / 10,
      estimatedCredits: clipCredits + sceneCredits + portraitCredits + buffer,
      preset,
      storyDriven: true,
    };
  }

  // ── STAGED (Veo) — fixed grid model ──
  const config = DURATION_PRESETS[preset] || DURATION_PRESETS['10min'];
  const targetClips = Math.ceil(config.targetSeconds / AVG_CLIP_DURATION);

  for (const s of config.structures) {
    const total = s.chapters * s.scenesPerChapter * s.linesPerScene;
    if (total >= targetClips) {
      return {
        ...s,
        totalLines: total,
        estimatedDuration: Math.round((total * AVG_CLIP_DURATION) / 60 * 10) / 10,
        estimatedCredits: total * CREDITS_PER_CLIP,
        preset,
      };
    }
  }

  // Fallback for the preset
  const fallback = config.structures[0];
  const total = fallback.chapters * fallback.scenesPerChapter * fallback.linesPerScene;
  return {
    ...fallback,
    totalLines: total,
    estimatedDuration: Math.round((total * AVG_CLIP_DURATION) / 60 * 10) / 10,
    estimatedCredits: total * CREDITS_PER_CLIP,
    preset,
  };
}

class PipelineOrchestrator {
  constructor(store, mainWindow) {
    this.store = store;
    this.mainWindow = mainWindow;
    this.state = {
      status: 'idle', // idle | running | paused | waiting_approval | error | complete
      currentStage: null,
      stageProgress: {},
      project: null,
      researchData: null,       // YouTube research + Gemini analysis results
      topVideos: [],             // Top-performing YouTube videos found
      storyStructure: null,     // Auto-calculated chapters/scenes/lines
      script: null,
      titles: null,
      selectedTitle: null,
      portraits: [],
      sceneImages: [],
      videoClips: [],
      flaggedAssets: { portraits: [], scenes: [], clips: [] },
      error: null,
    };
    this.paused = false;
    this.cancelled = false;
    this.scriptEngine = null;
    this.automation = null;
    this.assembler = null;
    // History recovery state — per-run, in-memory
    this._historyRecovery = null; // lazy-loaded HiggsfieldHistory instance
    this._historyAttempted = new Set(); // asset IDs that already tried history (avoid loops)
    this._jobIdsSeen = new Set(); // asset IDs whose Generate click definitely fired
  }

  // ── Research Cache (delegates to db module) ──

  getResearchCache() { return db.getResearchCache(); }
  getResearchPoolById(poolId) { return db.getResearchPoolById(poolId); }
  listResearchPools() { return db.listResearchPoolSummaries(); }
  /**
   * Save a fresh research pool. Returns the new pool's id so the caller can
   * link the new project to it via projects.research_cache_id.
   */
  saveResearchCache(youtubeData, analysisData) {
    const newId = db.saveResearchCache(youtubeData, analysisData);
    this.log(`Research pool #${newId} saved: ${youtubeData.all.length} videos, expires in 7 days`);
    return newId;
  }
  deleteResearchPool(poolId) {
    db.deleteResearchPool(poolId);
    this.log(`Deleted research pool #${poolId}`);
  }
  clearResearchCache() {
    db.clearResearchCache();
    this.log('All research pools cleared — next run will fetch fresh data');
  }
  getResearchCacheStatus(poolId = null) { return db.getResearchCacheStatus(poolId); }

  // ── Used Videos (delegates to db module) ──

  markVideosUsed(videoIds, projectId) {
    db.markVideosUsed(videoIds, projectId);
    this.log(`Marked ${videoIds.length} video(s) as used`);
  }
  getUnusedVideos(poolId = null) { return db.getUnusedVideos(poolId); }

  // ── Deduplication (delegates to db module) ──

  getProducedStories(poolId = null) {
    // Return produced titles. When poolId is provided, scope to titles of projects
    // that came from that pool (used for per-pool dedup / UI counts).
    // When omitted, returns the global list (back-compat for any caller that
    // doesn't care about pool scoping — primarily the launcher's fallback view).
    const rows = poolId ? db.getProducedTitlesForPool(poolId) : db.getProducedTitles();
    return rows.map(row => ({
      title: row.title,
      themes: JSON.parse(row.themes || '[]'),
      projectId: row.project_id,
      date: row.created_at,
    }));
  }

  recordProducedStory(storyRecord) {
    db.recordProducedTitle(
      storyRecord.projectId,
      storyRecord.title,
      storyRecord.themes,
      null,
    );

    // Pattern library model: no videos get marked "used".
    // The library is reusable across stories — title dedup prevents repetition.
  }

  checkDuplicate(title, themes = []) {
    const stories = this.getProducedStories();
    const normalizedTitle = title.toLowerCase().trim();
    const normalizedThemes = themes.map(t => t.toLowerCase().trim()).sort();

    return stories.find(s => {
      const sTitle = s.title.toLowerCase().trim();
      const sThemes = (s.themes || []).map(t => t.toLowerCase().trim()).sort();

      // Exact title match
      if (sTitle === normalizedTitle) return true;

      // High overlap in themes (>60%)
      if (normalizedThemes.length > 0 && sThemes.length > 0) {
        const overlap = normalizedThemes.filter(t => sThemes.includes(t)).length;
        const overlapRatio = overlap / Math.max(normalizedThemes.length, sThemes.length);
        if (overlapRatio > 0.6 && sTitle.includes(normalizedTitle.split(' ')[0])) return true;
      }

      return false;
    });
  }

  // ── Active Project ──

  /**
   * Get the active (in-progress) project from the database.
   * Returns null if no project is in progress.
   */
  getActiveProject() {
    const row = db.getActiveProject();
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      stage: row.stage,
      durationPreset: row.duration_preset,
      aspectRatio: (row.aspect_ratio === '9:16' || row.aspect_ratio === '16:9') ? row.aspect_ratio : '16:9',
      generatorMode: (row.generator_mode === 'cinematic' || row.generator_mode === 'staged') ? row.generator_mode : 'staged',
      researchCacheId: row.research_cache_id || null,
      settings: (() => {
        let s = JSON.parse(row.settings || '{}');
        // Guard against double-encoded JSON (e.g. from earlier script bug)
        if (typeof s === 'string') { try { s = JSON.parse(s); } catch (_) { s = {}; } }
        return s;
      })(),
      projectDir: row.project_dir,
      sourceVideoIds: JSON.parse(row.source_video_ids || '[]'),
      scriptJson: row.script_json ? JSON.parse(row.script_json) : null,
      createdAt: row.created_at,
    };
  }

  /**
   * Get a summary of the active project for the UI launcher.
   * Returns { hasActiveProject, title, stage, stageLabel, durationPreset } or { hasActiveProject: false }
   */
  getActiveProjectStatus() {
    const project = this.getActiveProject();
    if (!project) return { hasActiveProject: false };

    const stageLabels = {
      'research-done': 'Research complete — pick a title',
      'title-chosen': 'Title chosen — generate script',
      'script-done': 'Script ready — generate portraits',
      'portraits-done': 'Portraits done — generate scene images',
      'scenes-done': 'Scenes done — generate video clips',
      'videos-done': 'Videos done — run clip verification',
      'verified': 'Verification done — assemble final video',
    };

    // Get asset progress for the current stage
    let progress = null;
    const typeMap = {
      'portraits-done': 'scene_image',
      'scenes-done': 'video_clip',
      'script-done': 'portrait',
    };
    const assetType = typeMap[project.stage];
    if (assetType) {
      progress = db.getAssetCounts(project.id, assetType);
    }

    // Get resume context — what happened in the previous session
    const resumeContext = db.getResumeContext(project.id);

    return {
      hasActiveProject: true,
      id: project.id,
      title: project.title || '(untitled)',
      stage: project.stage,
      stageLabel: stageLabels[project.stage] || project.stage,
      durationPreset: project.durationPreset,
      aspectRatio: project.aspectRatio,
      generatorMode: project.generatorMode,
      progress,
      resumeContext,
    };
  }

  getState() {
    return { ...this.state };
  }

  /**
   * Abandon the currently-active project so the user can start a new one with
   * different settings (generator mode, aspect ratio, duration). The abandoned
   * project's DB rows and on-disk assets are preserved — use
   * `scripts/wipe-project.js` for hard deletion. Only valid when the pipeline
   * is NOT currently running — refuse if a stage is mid-generation.
   *
   * Returns { success: boolean, reason?: string }.
   */
  abandonActiveProject() {
    if (this.state.status === 'running') {
      return { success: false, reason: 'Pipeline is currently running. Cancel it first, then abandon.' };
    }
    const active = this.getActiveProject();
    if (!active) {
      return { success: false, reason: 'No active project to abandon.' };
    }
    db.abandonProject(active.id);
    this.log(`Project "${active.title || active.id}" abandoned by user — new project can now be started`);
    // Reset in-memory state so the renderer sees a clean slate
    this.state = {
      status: 'idle',
      currentStage: null,
      stageProgress: {},
      project: null,
      researchData: null,
      topVideos: [],
      storyStructure: null,
      script: null,
      selectedTitle: null,
      titles: [],
      portraits: [],
      sceneImages: [],
      videoClips: [],
    };
    return { success: true, abandonedId: active.id };
  }

  /**
   * Update duration, aspect ratio, and/or generator mode on the active project.
   * Safe to call during research approval (before credits are burned).
   * Updates both the DB row and in-memory state so the next stage picks up
   * the new settings. Story structure is recalculated from the new duration.
   */
  updateProjectSettings({ duration, aspectRatio, generatorMode }) {
    const active = this.getActiveProject();
    if (!active) {
      return { success: false, reason: 'No active project.' };
    }
    // Only allow changes before script generation (research or title stage)
    const earlyStages = [null, 'new', 'research-done', 'title-chosen'];
    if (!earlyStages.includes(active.stage)) {
      return { success: false, reason: `Cannot change settings after stage "${active.stage}" — script already generated.` };
    }

    const projectId = active.id;
    if (duration) {
      const structure = calculateStoryStructure(duration);
      this.state.storyStructure = structure;
      this.state.durationTier = getDurationTier(duration);
      db.updateProject(projectId, { duration_preset: duration });
      this.log(`[SETTINGS] Duration updated → ${duration} (${structure.totalLines} clips, ~${structure.estimatedDuration} min)`);
    }
    if (aspectRatio && (aspectRatio === '16:9' || aspectRatio === '9:16')) {
      db.setProjectAspectRatio(projectId, aspectRatio);
      this.state.aspectRatio = aspectRatio;
      this.log(`[SETTINGS] Aspect ratio updated → ${aspectRatio}`);
    }
    if (generatorMode && (generatorMode === 'cinematic' || generatorMode === 'staged')) {
      db.setProjectGeneratorMode(projectId, generatorMode);
      this.state.generatorMode = generatorMode;
      this.log(`[SETTINGS] Generator mode updated → ${generatorMode}`);
    }
    return { success: true };
  }

  emit(event) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('pipeline-event', event);
    }
  }

  log(message, level = 'info') {
    const entry = { timestamp: new Date().toISOString(), level, message };
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('log-message', entry);
    }
    console.log(`[${level.toUpperCase()}] ${message}`);

    // Persist to SQLite
    const projectId = this.state?.project?.id;
    if (projectId) {
      try { db.insertLog(projectId, level, message); } catch (_) { /* ignore */ }
    }

    // Append to disk log file
    const projectDir = this.state?.project?.dir;
    if (projectDir) {
      try {
        const logFile = path.join(projectDir, 'pipeline.log');
        const line = `[${entry.timestamp}] [${level.toUpperCase()}] ${message}\n`;
        fs.appendFileSync(logFile, line, 'utf-8');
      } catch (_) { /* ignore — dir may not exist yet */ }
    }
  }

  /**
   * Start a NEW pipeline run or RESUME an existing in-progress project.
   *
   * Resume logic:
   * - If there's an active project in the DB, load its state and jump to the
   *   appropriate stage. Assets already marked 'done' are skipped.
   * - If no active project, create a new one and start from research.
   */
  async start(options = {}) {
    // Prevent double execution — if already running, ignore
    if (this.state.status === 'running' || this.state.status === 'waiting_approval') {
      console.warn('[PIPELINE] start() called while already running — ignoring duplicate');
      return { success: false, reason: 'Pipeline already running' };
    }

    try {
      this.cancelled = false;
      this.paused = false;
      // Fresh per-run state for inline history recovery
      this._historyAttempted.clear();
      this._jobIdsSeen.clear();
      if (this._historyRecovery) {
        try { this._historyRecovery.invalidateCache(); } catch (_) {}
      }

      // ── Check for in-progress project to resume ──
      const activeProject = this.getActiveProject();
      const isResume = !!activeProject && !options.forceNew;

      let projectId, projectDir, storyBrief, structure;

      if (isResume) {
        // ── RESUME existing project ──
        projectId = activeProject.id;
        projectDir = activeProject.projectDir;
        this.state.aspectRatio = activeProject.aspectRatio || '16:9';
        this.state.generatorMode = activeProject.generatorMode || 'staged';
        structure = calculateStoryStructure(activeProject.durationPreset, this.state.generatorMode);
        this.state.storyStructure = structure;
        this.state.selectedPoolId = activeProject.researchCacheId || null;
        this.state.durationTier = getDurationTier(activeProject.durationPreset);

        const settings = activeProject.settings;
        // Note: no project-level tone/setting. Setting is per-scene (Claude
        // fills scene.location based on narrative); tone is per-line (line.tone).
        // Research patterns drive both at generation time via the script-prompt.
        storyBrief = {
          nationality: 'Nigerian',
          accent: 'Nigerian accent',
          chapters: structure.chapters,
          scenesPerChapter: structure.scenesPerChapter,
          linesPerScene: structure.linesPerScene,
          totalLines: structure.totalLines,
          estimatedDuration: structure.estimatedDuration,
          concept: settings.concept || '',
          aspectRatio: this.state.aspectRatio || '16:9',
          generatorMode: this.state.generatorMode,
        };

        // Cinematic story-driven: add clip budget fields to storyBrief
        if (structure.storyDriven) {
          storyBrief.targetClips = structure.targetClips;
          storyBrief.estimatedScenes = structure.estimatedScenes;
          storyBrief.estimatedCharacters = structure.estimatedCharacters;
          storyBrief.storyDriven = true;
        }

        this.state.project = { id: projectId, dir: projectDir, brief: storyBrief };
        this.state.selectedTitle = activeProject.title;

        // Restore Higgsfield Cinema Studio project ID from DB settings
        if (settings.higgsfield_cinema_project_id) {
          this.state.higgsfield_project_id = settings.higgsfield_cinema_project_id;
          this.log(`[RESUME] Restored Higgsfield project ID from DB: ${settings.higgsfield_cinema_project_id}`);
        }

        // Restore element name suffix — locked at project creation time so it
        // doesn't change if the pipeline resumes after midnight (date rollover).
        if (settings.element_name_suffix) {
          this.state.elementSuffix = settings.element_name_suffix;
          this.log(`[RESUME] Restored element name suffix from DB: _${settings.element_name_suffix}`);
        }

        // Restore script from DB if available
        if (activeProject.scriptJson) {
          this.state.script = activeProject.scriptJson;
        }

        // Restore completed assets from DB
        const donePortraits = db.getAssets(projectId, { type: 'portrait', status: 'done' });
        this.state.portraits = donePortraits.map(a => ({
          characterId: a.character_id,
          path: a.file_path,
          status: 'complete',
        }));

        const doneScenes = db.getAssets(projectId, { type: 'scene_image', status: 'done' });
        const doneCinematicScenes = db.getAssets(projectId, { type: 'scene_image_cinematic', status: 'done' });
        this.state.sceneImages = [...doneScenes, ...doneCinematicScenes].map(a => ({
          chapter: a.chapter,
          line: a.line || a.scene,
          path: a.file_path,
          status: 'complete',
        }));

        const doneClips = db.getAssets(projectId, { type: 'video_clip', status: 'done' });
        const doneCinematicClips = db.getAssets(projectId, { type: 'video_clip_cinematic', status: 'done' });
        this.state.videoClips = [...doneClips, ...doneCinematicClips].map(a => ({
          chapter: a.chapter,
          line: a.line,
          path: a.file_path,
          status: 'complete',
        }));

        const totalScenes = doneScenes.length + doneCinematicScenes.length;
        const totalClips = doneClips.length + doneCinematicClips.length;
        this.log(`Resuming project "${activeProject.title || projectId}" at stage: ${activeProject.stage}`);
        this.log(`Assets loaded: ${donePortraits.length} portraits, ${totalScenes} scenes, ${totalClips} clips`);

        // Log resume context from previous session
        const resumeCtx = db.getResumeContext(projectId);
        if (resumeCtx) {
          if (resumeCtx.interruptedAsset) {
            this.log(`[RESUME] Last session interrupted during: ${resumeCtx.interruptedAsset.label} (${resumeCtx.interruptedAsset.stage}) — will retry`, 'warn');
          }
          if (resumeCtx.sessionStats.completed > 0 || resumeCtx.sessionStats.failed > 0) {
            this.log(`[RESUME] Previous session: ${resumeCtx.sessionStats.completed} completed, ${resumeCtx.sessionStats.failed} failed, ${resumeCtx.sessionStats.deduped} deduped`);
          }
          if (resumeCtx.lastEvent) {
            this.log(`[RESUME] Last recorded action: ${resumeCtx.lastEvent.type} — ${resumeCtx.lastEvent.label || resumeCtx.lastEvent.stage || ''} (${resumeCtx.lastEvent.at})`);
          }
          // Send to UI so the resume card can show what happened
          this.emit({ type: 'resume-context', context: resumeCtx });
        }

        db.logEvent(projectId, 'session_start', { stage: activeProject.stage, detail: `Resuming at ${activeProject.stage} — ${donePortraits.length}P/${doneScenes.length}S/${doneClips.length}C done` });

      } else {
        // ── NEW project ──
        projectId = `${new Date().toISOString().slice(0, 10)}_${uuidv4().slice(0, 8)}`;
        const projectsDir = this.store.get('projectsDir',
          path.join(require('electron').app.getPath('documents'), 'NollywoodAI', 'projects'));
        projectDir = path.join(projectsDir, projectId);

        fs.mkdirSync(path.join(projectDir, 'assets', 'portraits'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'assets', 'scenes'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'assets', 'clips'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'output'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'logs'), { recursive: true });

        // Auto-calculate story structure based on duration preset
        const durationPreset = options.duration || '10min';
        // Generator mode — locked once Research starts. Default 'staged' (Veo pipeline).
        // 'cinematic' routes through the Cinema Studio 3.5 + Kling 3.0 parallel pipeline
        const generatorMode = (options.generatorMode === 'cinematic' || options.generatorMode === 'staged')
          ? options.generatorMode
          : 'staged';
        this.state.generatorMode = generatorMode;
        structure = calculateStoryStructure(durationPreset, generatorMode);
        this.state.storyStructure = structure;
        this.state.durationTier = getDurationTier(durationPreset);
        // Aspect ratio — locked once Research starts, default 16:9 for back-compat
        const aspectRatio = (options.aspectRatio === '9:16' || options.aspectRatio === '16:9')
          ? options.aspectRatio
          : '16:9';
        this.state.aspectRatio = aspectRatio;

        if (structure.storyDriven) {
          this.log(`Target [${durationPreset}, ${aspectRatio}, ${generatorMode}]: ~${structure.targetClips} clips (~${structure.estimatedDuration} min, ~${structure.estimatedCredits} credits) = ${structure.chapters}ch × unlimited scenes × unlimited lines (story-driven)`);
        } else {
          this.log(`Target [${durationPreset}, ${aspectRatio}, ${generatorMode}]: ${structure.totalLines} clips (~${structure.estimatedDuration} min, ~${structure.estimatedCredits} credits) = ${structure.chapters}ch × ${structure.scenesPerChapter}sc × ${structure.linesPerScene}ln`);
        }

        // Research-driven brief — nationality/accent are always Nigerian,
        // tone/setting will be derived from Gemini research patterns later
        // Note: no project-level tone/setting — see resume path comment above.
        storyBrief = {
          nationality: 'Nigerian',
          accent: 'Nigerian accent',
          chapters: structure.chapters,
          scenesPerChapter: structure.scenesPerChapter,
          linesPerScene: structure.linesPerScene,
          totalLines: structure.totalLines,
          estimatedDuration: structure.estimatedDuration,
          concept: '', // Will be filled from research selections
          aspectRatio,
          generatorMode,
        };

        // Cinematic story-driven: add clip budget fields to storyBrief
        if (structure.storyDriven) {
          storyBrief.targetClips = structure.targetClips;
          storyBrief.estimatedScenes = structure.estimatedScenes;
          storyBrief.estimatedCharacters = structure.estimatedCharacters;
          storyBrief.storyDriven = true;
        }

        this.state.project = { id: projectId, dir: projectDir, brief: storyBrief };
        this.state.status = 'running';

        // Create project in DB. research_cache_id starts null — if the user
        // picked a specific pool via options.researchCacheId, we carry that in
        // via this.state.selectedPoolId and the research stage attaches it.
        // For fresh runs, the research stage writes it after saving the pool.
        this.state.selectedPoolId = options.researchCacheId || null;
        db.createProject({
          id: projectId,
          durationPreset: options.duration || '10min',
          aspectRatio,
          generatorMode,
          stage: 'research-done',
          settings: {
            nationality: storyBrief.nationality,
            accent: storyBrief.accent,
            // tone/setting intentionally omitted — chosen per-scene/per-line by Claude
          },
          projectDir,
          researchCacheId: this.state.selectedPoolId,
        });

        // Also save project.json to disk for debugging
        fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
          id: projectId,
          brief: storyBrief,
          structure,
          created: new Date().toISOString(),
          status: 'in_progress',
        }, null, 2));

        this.log(`Project created: ${projectId}`);
        db.logEvent(projectId, 'session_start', { stage: 'research', detail: 'New project started' });
      }

      // ── Pre-flight API connectivity check ──
      const apiKey = this.store.get('claudeApiKey');
      if (!apiKey) throw new Error('Claude API key not set. Go to Settings and enter your API key.');

      this.log('Pre-flight check: verifying API connectivity...');
      this.emit({ type: 'stage', stage: 'preflight', substage: 'api-check' });

      // Quick Claude ping — fail fast if the key is invalid or network is down
      try {
        const Anthropic = require('@anthropic-ai/sdk');
        const testClient = new Anthropic({ apiKey });
        await testClient.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Reply OK' }],
        });
        this.log('Claude API: connected');
      } catch (e) {
        const msg = e.message || 'Unknown error';
        if (msg.includes('401') || msg.includes('authentication') || msg.includes('invalid')) {
          throw new Error(`Claude API key is invalid. Go to Settings and fix your API key.\n\nDetails: ${msg}`);
        }
        throw new Error(`Cannot reach Claude API. Check your internet connection.\n\nDetails: ${msg}`);
      }

      // Quick Gemini ping (non-fatal — browser fallback available)
      const geminiKey = this.store.get('geminiApiKey');
      if (geminiKey) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: 'Reply OK' }] }],
                generationConfig: { maxOutputTokens: 10 },
              }),
            }
          );
          if (resp.ok) {
            this.log('Gemini API: connected');
          } else {
            this.log(`Gemini API returned ${resp.status} — will fall back to browser mode`, 'warn');
          }
        } catch (e) {
          this.log(`Gemini API unreachable (${e.message}) — will fall back to browser mode`, 'warn');
        }
      } else {
        this.log('No Gemini API key — will use Google AI Studio browser mode for video analysis', 'warn');
      }

      // Initialize engines
      this.scriptEngine = new ScriptEngine(apiKey);
      this.automation = new HiggsFieldAutomation(null, projectDir);
      const brandingCardPath = this.store.get('brandingCardPath',
        path.join(__dirname, '..', '..', '..', 'config', 'branding.fw.png'));
      this.assembler = new VideoAssembler(projectDir, { brandingCardPath });

      // Send dedup data to UI so it can mark already-produced combos.
      // Scoped to the current pool when one is selected (prevents titles from
      // pool A showing as "already produced" when user is working in pool B).
      const producedStories = this.getProducedStories(this.state.selectedPoolId || null);
      this.emit({ type: 'dedup-data', stories: producedStories });

      // ── Determine starting stage for resume ──
      const resumeStage = isResume ? activeProject.stage : null;

      // Stage ordering for resume: skip stages already completed
      const shouldRunStage = (stage) => {
        if (!isResume) return true;
        const stageOrder = {
          'research-done': 0,
          'title-chosen': 1,
          'script-done': 2,
          'portraits-done': 3,
          'scenes-done': 4,
          'videos-done': 5,
          'verified': 6,   // post-MVP Verify Clip stage — runs Gemini multimodal checks
          'assembled': 7,
          'published': 8,
        };
        const currentIdx = stageOrder[resumeStage] || 0;
        const stageIdx = stageOrder[stage] || 0;
        // Run stages AT or AFTER the current resume point
        return stageIdx >= currentIdx;
      };

      // ── PENDING APPROVAL GATE: re-enter on resume ──
      // If the app was closed while waiting for user approval, re-show the
      // gate UI and wait again. This prevents gates from being skipped on restart.
      // Track which gate the generic resume system handled, so stage-specific
      // resume blocks don't double-fire gates the user already approved.
      // Gate order within the cinematic video stage:
      //   scenes → dialogue-triage → prompt-preview → clip-review
      // If the generic resume resolves gate N, all gates ≤ N are already done.
      this._resumedGateOrder = -1;
      const GATE_ORDER = { 'scenes': 0, 'dialogue-triage': 1, 'prompt-preview': 2, 'clip-review': 3 };

      if (isResume) {
        const settings = activeProject.settings || {};
        const pendingGate = settings.pending_approval_gate;
        if (pendingGate) {
          // Per-clip gates (prompt-preview, clip-review) fire inside the video
          // gen loop with specific clip context (prompt text, start frame, clip
          // path). The generic resume can't reconstruct this — clear the gate
          // and let the video gen loop re-encounter the clip naturally.
          const PER_CLIP_GATES = ['prompt-preview', 'clip-review'];

          // ── STALE GATE CHECK ──
          // If clips have already been generated, earlier gates (scenes, dialogue-triage)
          // are stale — the user already passed them in a previous session. Clear them
          // and skip, same as per-clip gates. This prevents re-showing dialogue triage
          // after 60+ clips are generated just because the DB still has the gate stored.
          const existingDoneClips = db.getAssets(projectId, { type: 'video_clip_cinematic' })
            .filter(a => a.status === 'done');
          const STALE_GATES_WHEN_CLIPS_EXIST = ['dialogue-triage', 'scenes'];
          const isStaleGate = existingDoneClips.length > 0 && STALE_GATES_WHEN_CLIPS_EXIST.includes(pendingGate);

          if (PER_CLIP_GATES.includes(pendingGate) || isStaleGate) {
            this.log(`[RESUME] Pending ${isStaleGate ? 'stale' : 'per-clip'} gate "${pendingGate}" — clearing (${isStaleGate ? existingDoneClips.length + ' clips already done' : 'video loop will re-fire with clip data'})`);
            try {
              delete settings.pending_approval_gate;
              db.updateProject(projectId, { settings: JSON.stringify(settings) });
            } catch (_) {}
            // Set order so earlier stage-level gates (scenes, dialogue-triage)
            // are skipped — the user already passed them before reaching this clip gate
            this._resumedGateOrder = GATE_ORDER[pendingGate] ?? -1;
          } else {
            this.log(`[RESUME] Pending approval gate found: "${pendingGate}" — re-entering wait`);

            // Re-emit gate-specific data so the UI can render the approval view
            await this._reEmitGateData(pendingGate, projectId, projectDir);

            this.state.status = 'waiting_approval';
            this.emit({ type: 'waiting', gate: pendingGate });
            await this.waitForApproval(pendingGate);
            if (this.cancelled) return { success: false, reason: 'cancelled' };
            this._resumedGateOrder = GATE_ORDER[pendingGate] ?? -1;
            this.log(`[RESUME] Pending gate "${pendingGate}" approved (order=${this._resumedGateOrder}) — continuing pipeline`);
          }
        }
      }

      // ── Stage 1: Research & Inspiration ──
      if (shouldRunStage('research-done')) {
        await this.runStage('research', async () => {
          const forceRefresh = options.forceRefresh === true;
          // Pick the pool to use: explicit selection wins; otherwise fall back to the
          // most-recent active pool (back-compat behavior for any legacy callers).
          const selectedPoolId = this.state.selectedPoolId || null;
          const existingCache = forceRefresh
            ? null
            : (selectedPoolId ? this.getResearchPoolById(selectedPoolId) : this.getResearchCache());
          const cacheStatus = this.getResearchCacheStatus(existingCache?.id || null);

          let research = null;
          let researchData = null;

          if (existingCache && !forceRefresh) {
            // ── Reuse cached research pool + pattern library ──
            // Pattern library is analyzed once and reused across all stories.
            // Variety comes from Claude picking different theme combos + title dedup.
            this.log(`Using research pool #${existingCache.id} (${cacheStatus.totalVideos} videos, expires in ${cacheStatus.expiresInHours}h)`);
            this.emit({ type: 'stage', stage: 'research', substage: 'cached' });

            // Persist the pool association on the project row so downstream
            // per-pool queries (unused-videos, produced-titles, stories-produced)
            // can filter correctly. Harmless no-op if already set.
            db.updateProject(projectId, { research_cache_id: existingCache.id });
            this.state.selectedPoolId = existingCache.id;

            research = existingCache.youtube;
            researchData = existingCache.analysis;

            this.state.topVideos = research.all;
            this.emit({
              type: 'research-videos',
              aiOriginals: research.aiOriginals || [],
              remakeCandidates: research.remakeCandidates || [],
              all: research.all,
              fromCache: true,
              cacheStatus,
            });
            this.log(`Showing cached pool: ${(research.aiOriginals || []).length} AI originals + ${(research.remakeCandidates || []).length} remake candidates`);

          } else {
            // ── Fresh research ──
            if (forceRefresh) {
              this.log('Force refresh requested — fetching fresh research');
            }

            this.log('Starting YouTube market research...');
            this.emit({ type: 'stage', stage: 'research', substage: 'youtube' });

            await this.automation.ensureBrowser();
            const ytResearcher = new YouTubeResearcher(this.automation.page);

            const searchQueries = [
              'AI Nollywood movie',
              'AI African drama full movie',
              'AI generated Nollywood',
              'AI Nigerian movie 2026',
            ];

            research = await ytResearcher.searchTopPerformers({
              aiQueries: searchQueries,
              maxResults: 10,
            });

            this.state.topVideos = research.all;
            this.emit({
              type: 'research-videos',
              aiOriginals: research.aiOriginals,
              remakeCandidates: research.remakeCandidates,
              all: research.all,
              fromCache: false,
            });
            this.log(`Found ${research.aiOriginals.length} AI originals + ${research.remakeCandidates.length} remake candidates`);

            fs.writeFileSync(
              path.join(projectDir, 'research-youtube.json'),
              JSON.stringify(research, null, 2)
            );

            // Analyze ALL unique videos with Gemini — weighted interleave (AI + remake alternating)
            // This builds a rich pattern library from both pools at once.
            const interleaved = this._interleaveVideos(research.aiOriginals, research.remakeCandidates);
            if (interleaved.length > 0) {
              this.emit({ type: 'stage', stage: 'research', substage: 'gemini' });
              this.log(`Analyzing ${Math.min(10, interleaved.length)} videos with Gemini (interleaved AI + remakes)...`);

              const geminiKey = this.store.get('geminiApiKey');
              const analyzer = new GeminiVideoAnalyzer({
                apiKey: geminiKey || null,
                page: !geminiKey ? this.automation.page : null,
              });

              researchData = await analyzer.analyzeBatch(interleaved, {
                maxVideos: 10, // Analyze more upfront — this library serves many stories
                extractPatterns: true,
              });

              const successCount = researchData.analyses.filter(a => a.analysis).length;
              this.log(`Analyzed ${successCount}/${researchData.videosAnalyzed} videos — pattern library built`);

              fs.writeFileSync(
                path.join(projectDir, 'research-analysis.json'),
                JSON.stringify(researchData, null, 2)
              );
            } else {
              this.log('No qualifying videos found — proceeding without research data', 'warn');
            }

            // Save everything to cache as a NEW pool (doesn't overwrite existing).
            // The returned id is linked to this project so downstream per-pool
            // queries work correctly.
            const newPoolId = this.saveResearchCache(research, researchData);
            if (newPoolId) {
              db.updateProject(projectId, { research_cache_id: newPoolId });
              this.state.selectedPoolId = newPoolId;
            }
          }

          // Set state for downstream stages
          this.state.researchData = researchData;

          // Tone and setting are NOT locked at the project level anymore.
          // Settings are chosen per-scene by Claude (schema has scene.location +
          // scene.location_details); tones are chosen per-line (line.tone). Both
          // draw from the research patterns in the system prompt — the story can
          // move between locations (village → Lagos → palace) as the plot warrants.
          // See script-prompt.txt's SETTING clause.
          if (researchData?.patterns) {
            this.log('Research patterns loaded — Claude will choose per-scene locations and per-line tones based on story context');
          } else {
            this.log('No research patterns — Claude will choose settings/tones without research guidance', 'warn');
          }

          if (researchData) {
            this.emit({ type: 'research-complete', data: researchData });
          }

          // Wait for operator to review research and approve (with selections)
          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'research' });
          this.log('Waiting for research approval + selections...');
          await this.waitForApproval('research');
        });

        if (this.cancelled) return { success: false, reason: 'cancelled' };
      }

      // ── Stage 2: Script Generation (informed by research selections) ──
      if (shouldRunStage('title-chosen')) {
        await this.runStage('script', async () => {
          // If resuming with title already chosen, skip title generation
          if (isResume && resumeStage === 'title-chosen' && activeProject.title) {
            this.state.selectedTitle = activeProject.title;
            this.log(`Resuming with previously chosen title: "${activeProject.title}"`);
          } else {
            // Generate title candidates using research data
            this.log('Generating title candidates from research...');
            this.emit({ type: 'stage', stage: 'script', substage: 'titles' });

            // Inject source video titles into research data for originality checking
            if (this.state.researchData && this.state.topVideos?.length) {
              this.state.researchData.sourceVideoTitles = this.state.topVideos
                .map(v => v.title)
                .filter(Boolean);
            }

            // Mark titles that are duplicates of already-produced stories
            const titles = await this.scriptEngine.generateTitles(storyBrief, this.state.researchData);

            // Tag duplicates and similarity warnings
            const taggedTitles = titles.map(t => {
              const dup = this.checkDuplicate(t.title, this.state.researchData?.patterns?.recurring_themes);
              if (dup) {
                t.isDuplicate = true;
                t.dupInfo = `Already produced on ${dup.date?.slice(0, 10)}`;
              }
              // tooSimilar flag is already set by script-engine's findSimilarSourceTitle()
              return t;
            });

            const similarCount = taggedTitles.filter(t => t.tooSimilar).length;
            if (similarCount > 0) {
              this.log(`WARNING: ${similarCount} title(s) flagged as too similar to source videos`, 'warn');
            }

            this.state.titles = taggedTitles;
            this.emit({ type: 'titles-ready', titles: taggedTitles });
            this.log(`Generated ${taggedTitles.length} title candidates`);

            // Wait for operator to approve title
            this.state.status = 'waiting_approval';
            this.emit({ type: 'waiting', gate: 'title' });
            this.log('Waiting for title approval...');
            await this.waitForApproval('title');
          }

          // Persist title choice to DB
          db.updateProject(projectId, {
            title: this.state.selectedTitle,
            stage: 'title-chosen',
          });

          // Skip script gen if resuming with script already done
          if (isResume && activeProject.scriptJson) {
            this.state.script = activeProject.scriptJson;
            this.log('Resuming with previously generated script');
            // Resume path skips the generate+review loop; the approval gate below
            // runs without a review attached (script was already approved before).
          } else {
            // Generate-review-approve loop. If the user hits "Regenerate" from
            // the review panel (because review failed), we loop back and produce
            // a fresh script + fresh review. Cap at MAX_SCRIPT_REGEN so a
            // pathological story concept doesn't loop forever.
            const MAX_SCRIPT_REGEN = parseInt(process.env.MAX_SCRIPT_REGEN_ITERATIONS, 10) || 3;
            const brief = { ...storyBrief, title: this.state.selectedTitle, durationTier: this.state.durationTier, generatorMode: this.state.generatorMode || 'staged' };
            let attempt = 0;
            while (true) {
              attempt++;
              const attemptLabel = attempt > 1 ? ` (attempt ${attempt}/${MAX_SCRIPT_REGEN})` : '';
              this.log(`Generating full script with character bible${attemptLabel}...`);
              this.emit({ type: 'stage', stage: 'script', substage: 'script' });

              const script = await this.scriptEngine.generateScript(brief, (partial) => {
                this.emit({ type: 'script-progress', partial });
              }, this.state.researchData);

              this.state.script = script;
              fs.writeFileSync(path.join(projectDir, 'script.json'), JSON.stringify(script, null, 2));
              this.emit({ type: 'script-ready', script });
              this.log('Script generation complete');

              // ── Structural review — grades the script against its tier rubric.
              // Hard-blocks the approval gate if the score falls below the tier
              // threshold. Saves 1000-3000 credits when a structurally weak
              // script would otherwise proceed to video generation.
              this.emit({ type: 'stage', stage: 'script', substage: 'review' });
              this.log(`Running structural review (tier: ${this.state.durationTier})...`);
              let review;
              try {
                review = await this.scriptEngine.reviewScriptStructure(script, this.state.durationTier, brief);
                fs.writeFileSync(path.join(projectDir, 'script-review.json'), JSON.stringify(review, null, 2));
                this.log(`Review: score=${review.score}/100 (threshold ${review.threshold}), ${review.pass ? 'PASS' : 'FAIL'} — ${review.issues.length} issue(s)`);
                if (!review.pass) {
                  const critical = review.issues.filter(i => i.severity === 'critical').length;
                  this.log(`[REVIEW] HARD-BLOCK: ${critical} critical + ${review.issues.length - critical} other issue(s). See script review panel.`, 'warn');
                }
              } catch (e) {
                this.log(`[REVIEW] Grader failed: ${e.message} — defaulting to neutral pass so approval isn't blocked by infra`, 'warn');
                review = { score: 65, pass: true, tier: this.state.durationTier, issues: [], strengths: [], summary: `Grader errored: ${e.message}` };
              }
              this.state.scriptReview = review;
              this.emit({ type: 'script-review-ready', review });

              // Persist script + review to DB
              db.updateProject(projectId, {
                script_json: script,
                stage: 'script-done',
              });

              // Reset expected assets for this attempt (wipes any pending rows
              // from a previous failed attempt's insert — avoids duplicate
              // constraint conflicts).
              this._insertExpectedAssets(projectId, script, structure);

              // Wait for operator decision. resolve value distinguishes approve vs
              // regenerate. Undefined === approve (no arg from approveScript()).
              this.state.status = 'waiting_approval';
              this.emit({ type: 'waiting', gate: 'script', review });
              this.log('Waiting for script approval...');
              const decision = await this.waitForApproval('script');
              if (decision?.regenerate && attempt < MAX_SCRIPT_REGEN) {
                this.log(`[REVIEW] Regenerating script (${attempt}/${MAX_SCRIPT_REGEN})...`, 'warn');
                continue; // loop back to regenerate
              }
              if (decision?.regenerate) {
                this.log(`[REVIEW] Regen cap reached (${MAX_SCRIPT_REGEN}) — proceeding with current script`, 'warn');
              }
              db.updateProjectStage(projectId, 'script-done');
              break;
            }
          }

          // Resume-path approval gate — original script already approved; just
          // short-circuit the waiting loop when resuming past script generation.
          if (isResume && resumeStage === 'title-chosen' && activeProject.scriptJson) {
            this.state.status = 'waiting_approval';
            this.emit({ type: 'waiting', gate: 'script', review: null });
            this.log('Waiting for script approval (resume)...');
            await this.waitForApproval('script');
            db.updateProjectStage(projectId, 'script-done');
          }
        });

        if (this.cancelled) return { success: false, reason: 'cancelled' };
      }

      // ── Early SEO generation (fire-and-forget after script approval) ──
      // The script contains everything needed for SEO (title, characters,
      // plot, themes). Generate now so it's ready at publish time. If it
      // fails, the publish stage can still regenerate on demand.
      if (shouldRunStage('script-done')) {
        const project = db.getProject(projectId);
        const hasYtMeta = project?.youtube_metadata && project.youtube_metadata !== '{}';
        if (!hasYtMeta) {
          this._generateEarlySEO(projectId, projectDir).catch(err => {
            this.log(`[SEO] Early SEO generation failed (non-fatal): ${err.message}`, 'warn');
          });
        } else {
          this.log(`[SEO] YouTube metadata already exists — skipping early generation`);
        }
      }

      // ── Stage 3A: Character Portraits ──
      if (shouldRunStage('script-done')) {
        await this.runStage('portraits', async () => {
          this.log('Starting character portrait generation...');
          const characters = this.state.script.character_bible;
          const portraitDir = path.join(projectDir, 'assets', 'portraits');

          // Get incomplete portrait assets from DB
          const incompletePortraits = db.getIncompleteAssets(projectId, 'portrait');
          const doneCount = characters.length - incompletePortraits.length;
          if (doneCount > 0) {
            this.log(`Resuming portraits: ${doneCount}/${characters.length} already done`);
          }

          for (const asset of incompletePortraits) {
            if (this.cancelled) return;
            await this.checkPause();

            const char = characters.find(c => c.id === asset.character_id);
            if (!char) continue;

            const idx = characters.indexOf(char);
            const assetLabel = `portrait ${idx + 1}/${characters.length}: ${char.description_label}`;
            this.log(`Generating ${assetLabel}`);
            this.emit({ type: 'progress', stage: 'portraits', current: doneCount + incompletePortraits.indexOf(asset) + 1, total: characters.length });

            const portraitPath = path.join(portraitDir, `portrait_${char.id}.png`);
            // HARD RULE: No aspect ratio or orientation in prompt text.
            // The Higgsfield UI selector (aspectRatio param) is the sole authority.
            const portraitAspect = this.state.aspectRatio || '9:16';
            const prompt = `Photorealistic cinematic portrait, studio-quality lighting. ${char.full_prompt_description}. Standing in a natural pose, looking directly at camera. Clean background with soft bokeh. Hyper-detailed, 8K quality.`;

            // Dedup check — skip generation if identical prompt already produced a file
            const existing = db.findExistingGeneration(prompt, 'portrait');
            if (existing.found) {
              this.log(`[DEDUP] Reusing existing portrait for ${char.description_label}: ${existing.filePath}`);
              // Copy to expected path if it's a different file
              const fs = require('fs');
              if (existing.filePath !== portraitPath) {
                fs.mkdirSync(path.dirname(portraitPath), { recursive: true });
                fs.copyFileSync(existing.filePath, portraitPath);
              }
              db.markAssetDone(asset.id, portraitPath, { model: existing.model, sourceGenId: existing.sourceGenId, cdnUrl: existing.cdnUrl });
              db.logEvent(projectId, 'asset_dedup', { stage: 'portraits', assetId: asset.id, assetLabel, detail: `Reused from ${existing.filePath}` });
              this.state.portraits.push({ characterId: char.id, path: portraitPath, status: 'complete' });
              this.emit({ type: 'portrait-complete', index: idx, path: portraitPath });
              continue;
            }

            // ── RESUME RECOVERY: if Generate was already clicked in a previous run,
            // try to recover the image from the CDN URL (avoid re-generating + wasting credits).
            // gen_clicked_at survives resetStuckAssets() and persists across restarts.
            const isPreGenError = asset.error_message?.includes('[PRE-GEN]');
            const genWasClicked = asset.gen_clicked_at || (asset.prompt_used && !isPreGenError);
            if (genWasClicked && asset.cdn_url) {
              this.log(`[PORTRAIT RECOVERY] ${assetLabel}: Generate was clicked previously (gen_clicked_at=${asset.gen_clicked_at || 'inferred'}) — attempting CDN download`);
              try {
                const https = require('https');
                const downloadFile = (url, dest) => new Promise((resolve, reject) => {
                  const file = fs.createWriteStream(dest);
                  https.get(url, (response) => {
                    if (response.statusCode === 200) {
                      response.pipe(file);
                      file.on('finish', () => { file.close(); resolve(true); });
                    } else {
                      file.close(); fs.unlinkSync(dest); reject(new Error(`HTTP ${response.statusCode}`));
                    }
                  }).on('error', (e) => { file.close(); try { fs.unlinkSync(dest); } catch (_) {} reject(e); });
                });
                fs.mkdirSync(path.dirname(portraitPath), { recursive: true });
                await downloadFile(asset.cdn_url, portraitPath);
                db.markAssetDone(asset.id, portraitPath, { model: 'nano-banana-pro', cdnUrl: asset.cdn_url, recovered: true });
                db.logEvent(projectId, 'asset_recovered', { stage: 'portraits', assetId: asset.id, assetLabel, detail: `CDN recovery from ${asset.cdn_url}` });
                this.log(`[PORTRAIT RECOVERY] ✓ ${assetLabel} recovered from CDN`);
                this.state.portraits.push({ characterId: char.id, path: portraitPath, status: 'complete' });
                this.emit({ type: 'portrait-complete', index: idx, path: portraitPath });
                continue;
              } catch (recoveryErr) {
                this.log(`[PORTRAIT RECOVERY] CDN download failed for ${assetLabel}: ${recoveryErr.message} — trying Asset library...`, 'warn');
                // CDN failed — try Asset library as second fallback
                try {
                  const recovered = await this.automation.recoverTimedOutImage(
                    asset.prompt_used || prompt,
                    portraitPath,
                    { minSimilarity: 75, maxTilesToCheck: 8, timeoutMs: 90000 }
                  );
                  if (recovered) {
                    db.markAssetDone(asset.id, portraitPath, {
                      model: 'nano-banana-pro',
                      sourceGenId: recovered.sourceGenId,
                      recovered: true,
                    });
                    db.logEvent(projectId, 'asset_recovered', { stage: 'portraits', assetId: asset.id, assetLabel, detail: `Asset library fallback (uuid=${recovered.assetUuid})` });
                    this.log(`[PORTRAIT RECOVERY] ✓ ${assetLabel} recovered from Asset library (CDN fallback)`);
                    this.state.portraits.push({ characterId: char.id, path: portraitPath, status: 'complete' });
                    this.emit({ type: 'portrait-complete', index: idx, path: portraitPath });
                    continue;
                  }
                } catch (_) { /* Asset library also failed — fall through to generation */ }
                // Fall through to normal generation
              }
            } else if (genWasClicked) {
              // No CDN URL stored — try Asset library recovery (browse /asset/image, match prompt)
              this.log(`[PORTRAIT RECOVERY] ${assetLabel}: Generate was clicked but no CDN URL — attempting Asset library recovery...`);
              try {
                const recovered = await this.automation.recoverTimedOutImage(
                  asset.prompt_used || prompt,
                  portraitPath,
                  { minSimilarity: 75, maxTilesToCheck: 8, timeoutMs: 90000 }
                );
                if (recovered) {
                  db.markAssetDone(asset.id, portraitPath, {
                    model: 'nano-banana-pro',
                    sourceGenId: recovered.sourceGenId,
                    cdnUrl: recovered.cdnUrl || null,
                    recovered: true,
                  });
                  db.logEvent(projectId, 'asset_recovered', { stage: 'portraits', assetId: asset.id, assetLabel, detail: `Asset library recovery (uuid=${recovered.assetUuid}, similarity=${recovered.similarity}%)` });
                  this.log(`[PORTRAIT RECOVERY] ✓ ${assetLabel} recovered from Asset library (similarity=${recovered.similarity}%)`);
                  this.state.portraits.push({ characterId: char.id, path: portraitPath, status: 'complete' });
                  this.emit({ type: 'portrait-complete', index: idx, path: portraitPath });
                  continue;
                } else {
                  this.log(`[PORTRAIT RECOVERY] No matching image found in Asset library — will re-generate (credits may be wasted)`, 'warn');
                }
              } catch (recoveryErr) {
                this.log(`[PORTRAIT RECOVERY] Asset library recovery failed: ${recoveryErr.message} — will re-generate`, 'warn');
              }
            }

            db.markAssetGenerating(asset.id, prompt);
            db.logEvent(projectId, 'asset_start', { stage: 'portraits', assetId: asset.id, assetLabel });

            try {
              const genMeta = await this._withSessionRetry(
                () => this.automation.generateImage({
                  prompt,
                  outputPath: portraitPath,
                  references: [],
                  aspectRatio: portraitAspect,
                  useUnlimited: true,
                  onGenClicked: (creditCost) => db.markAssetGenClicked(asset.id, creditCost),
                }),
                assetLabel
              );

              db.markAssetDone(asset.id, portraitPath, genMeta);
              db.logEvent(projectId, 'asset_done', { stage: 'portraits', assetId: asset.id, assetLabel, detail: portraitPath });
              this.state.portraits.push({ characterId: char.id, path: portraitPath, status: 'complete' });
              this.emit({ type: 'portrait-complete', index: idx, path: portraitPath });
            } catch (err) {
              // Save CDN URL if detected — enables recovery on next restart
              if (err.detectedCdnUrl) {
                db.markAssetCdnUrl(asset.id, err.detectedCdnUrl);
                this.log(`[PORTRAIT] Saved CDN URL for recovery: ${err.detectedCdnUrl}`);
              }

              // If we were cancelled OR user closed the browser, bail cleanly
              // (Playwright throws "Target closed" errors on abort — don't mark asset failed)
              if (this.cancelled || (err.message && err.message.includes('Target') && err.message.includes('closed'))) {
                db.resetAsset(asset.id);
                // CRITICAL: set cancelled flag so the pipeline halts after runStage completes.
                // Without this, the check on `if (this.cancelled)` after the portraits stage
                // passes through, and downstream stages (elements-setup, scenes, video) all
                // attempt to run with a dead browser — cascading errors.
                this.cancelled = true;
                this.log(`Portrait generation aborted (cancelled or browser closed) — asset reset to pending, pipeline halting`, 'warn');
                return { success: false, reason: 'cancelled' };
              }

              // ── NSFW REJECTION: rewrite character description + retry ──
              // Higgsfield flagged the character as "Restricted content" (likely resembles
              // a real person too closely). Rewrite the description with more fictional/
              // stylized traits via Claude, then retry portrait generation.
              // Max 2 rewrites per character to prevent infinite loops.
              if (err.nsfwRejected) {
                const nsfwKey = `nsfw_${char.id}`;
                this._nsfwRetries = this._nsfwRetries || {};
                this._nsfwRetries[nsfwKey] = (this._nsfwRetries[nsfwKey] || 0) + 1;

                if (this._nsfwRetries[nsfwKey] > 2) {
                  this.log(`[NSFW] ${assetLabel}: Already rewrote description ${this._nsfwRetries[nsfwKey] - 1} times — giving up`, 'error');
                  // Fall through to normal failure handling below
                } else {
                this.log(`[NSFW] ${assetLabel}: Restricted content detected — rewriting character description (attempt ${this._nsfwRetries[nsfwKey]}/2)...`, 'warn');
                db.logEvent(projectId, 'nsfw_rejected', { stage: 'portraits', assetId: asset.id, assetLabel, detail: err.message });

                try {
                  const newDesc = await this._rewriteCharacterDescription(char);
                  if (newDesc && newDesc !== char.full_prompt_description) {
                    const oldDesc = char.full_prompt_description;
                    char.full_prompt_description = newDesc;

                    // Persist updated character_bible to disk
                    this._saveScriptState(projectId);

                    this.log(`[NSFW] ✓ Description rewritten for ${char.description_label}`);
                    this.log(`[NSFW]   Old: "${oldDesc.slice(0, 100)}..."`);
                    this.log(`[NSFW]   New: "${newDesc.slice(0, 100)}..."`);
                    db.logEvent(projectId, 'nsfw_rewrite', {
                      stage: 'portraits', assetId: asset.id, assetLabel,
                      detail: `Rewrote description: ${oldDesc.slice(0, 80)} → ${newDesc.slice(0, 80)}`,
                    });

                    // Reset asset to pending and retry in this same loop iteration
                    db.resetAsset(asset.id);
                    // Re-add to incomplete list so we retry (since we're iterating incompletePortraits,
                    // we need to just not throw — the outer for loop will skip to the next asset.
                    // Instead, we splice this asset back in to retry it.)
                    incompletePortraits.splice(incompletePortraits.indexOf(asset) + 1, 0, asset);
                    continue;
                  } else {
                    this.log(`[NSFW] Claude could not produce a sufficiently different description — marking as failed`, 'error');
                  }
                } catch (rewriteErr) {
                  this.log(`[NSFW] Description rewrite failed: ${rewriteErr.message}`, 'error');
                }
                // If rewrite failed, fall through to normal failure handling
                } // end else (retry count check)
              }

              db.markAssetFailed(asset.id, err.message);
              db.logEvent(projectId, 'asset_failed', { stage: 'portraits', assetId: asset.id, assetLabel, detail: err.message });
              this.log(`Portrait failed for ${char.description_label}: ${err.message}`, 'error');
              throw err; // Bubble up — user can resume later
            }
          }

          // Verify ALL portraits are done before advancing.
          // If files are missing (e.g. user deleted a bad portrait from disk),
          // verifyStageComplete resets them to pending and throws. Instead of
          // crashing, catch it and re-run the portrait generation loop so the
          // pipeline self-heals without requiring a restart.
          try {
            this.verifyStageComplete('portrait', 'Portraits');
          } catch (verifyErr) {
            if (verifyErr.message.includes('missing files')) {
              this.log(`[PORTRAITS] ${verifyErr.message} — re-entering generation loop to regenerate`, 'warn');
              const retryAssets = db.getIncompleteAssets(projectId, 'portrait');
              for (const asset of retryAssets) {
                if (this.cancelled) return;
                await this.checkPause();
                const char = characters.find(c => c.id === asset.character_id);
                if (!char) continue;
                const idx = characters.indexOf(char);
                const assetLabel = `portrait ${idx + 1}/${characters.length}: ${char.description_label} (retry)`;
                const retryPath = path.join(portraitDir, `portrait_${char.id}.png`);
                const portraitAspect = (this.state.project?.brief?.aspect_ratio === '9:16') ? '9:16' : '16:9';
                const prompt = char.full_prompt_description || char.visual_description || `Portrait of ${char.name}`;
                this.log(`Regenerating ${assetLabel}...`);
                this.emit({ type: 'progress', stage: 'portraits', current: retryAssets.indexOf(asset) + 1, total: retryAssets.length });
                db.markAssetGenerating(asset.id, prompt);
                try {
                  const genMeta = await this._withSessionRetry(
                    () => this.automation.generateImage({
                      prompt,
                      outputPath: retryPath,
                      references: [],
                      aspectRatio: portraitAspect,
                      useUnlimited: true,
                      onGenClicked: (creditCost) => db.markAssetGenClicked(asset.id, creditCost),
                    }),
                    assetLabel
                  );
                  db.markAssetDone(asset.id, retryPath, genMeta);
                  this.state.portraits.push({ characterId: char.id, path: retryPath, status: 'complete' });
                  this.emit({ type: 'portrait-complete', index: idx, path: retryPath });
                } catch (retryErr) {
                  if (retryErr.detectedCdnUrl) db.markAssetCdnUrl(asset.id, retryErr.detectedCdnUrl);
                  if (this.cancelled || (retryErr.message && retryErr.message.includes('Target') && retryErr.message.includes('closed'))) {
                    db.resetAsset(asset.id);
                    this.cancelled = true;
                    return { success: false, reason: 'cancelled' };
                  }
                  db.markAssetFailed(asset.id, retryErr.message);
                  this.log(`Portrait retry failed for ${char.description_label}: ${retryErr.message}`, 'error');
                  throw retryErr;
                }
              }
              // Re-verify after retry
              this.verifyStageComplete('portrait', 'Portraits');
            } else {
              throw verifyErr;
            }
          }

          // ── CREATE HIGGSFIELD PROJECT EARLY ──
          // Create the Cinema Studio project NOW, before portrait approval.
          // This ensures a valid project ID exists before any element or scene
          // work begins. The element setup stage will reuse this project.
          if ((this.state.generatorMode || 'staged') === 'cinematic') {
            await this._ensureCinematicProject(projectId);
          }

          db.updateProjectStage(projectId, 'portraits-done');

          // ── PORTRAIT APPROVAL LOOP ──
          // User can either "Approve & Continue" or "Re-render Flagged" to
          // regenerate specific portraits they're unhappy with. The loop
          // continues until the user approves without requesting re-renders.
          let portraitDecision;
          do {
            this.state.status = 'waiting_approval';
            this.emit({ type: 'waiting', gate: 'portraits' });
            this.log('Waiting for portrait approval...');
            portraitDecision = await this.waitForApproval('portraits');

            if (portraitDecision && portraitDecision.rerender) {
              const flagged = this.state.flaggedAssets['portraits'] || [];
              if (flagged.length === 0) {
                this.log('[PORTRAIT RE-RENDER] No portraits flagged — nothing to re-render', 'warn');
                continue;
              }

              this.log(`[PORTRAIT RE-RENDER] Re-rendering ${flagged.length} flagged portrait(s): indices [${flagged.join(', ')}]`);
              this.state.status = 'running';
              this.emit({ type: 'stage', stage: 'portraits' });

              for (const idx of flagged) {
                if (this.cancelled) return;
                await this.checkPause();

                const char = characters[idx];
                if (!char) {
                  this.log(`[PORTRAIT RE-RENDER] No character at index ${idx} — skipping`, 'warn');
                  continue;
                }

                // Find the portrait asset for this character
                const allPortraitAssets = db.getAssets(projectId, { type: 'portrait' });
                const asset = allPortraitAssets.find(a => a.character_id === char.id);
                if (!asset) {
                  this.log(`[PORTRAIT RE-RENDER] No asset found for character ${char.description_label} — skipping`, 'warn');
                  continue;
                }

                const portraitPath = path.join(portraitDir, `portrait_${char.id}.png`);
                const assetLabel = `portrait ${idx + 1}/${characters.length}: ${char.description_label}`;

                // Delete existing file from disk
                try { fs.unlinkSync(portraitPath); } catch (_) {}

                // Reset asset in DB to pending
                db.resetAsset(asset.id);
                db.logEvent(projectId, 'portrait_rerender', { assetId: asset.id, assetLabel });

                // Remove from state.portraits
                this.state.portraits = this.state.portraits.filter(p => p.characterId !== char.id);

                this.log(`[PORTRAIT RE-RENDER] Regenerating ${assetLabel}...`);
                this.emit({ type: 'progress', stage: 'portraits', current: flagged.indexOf(idx) + 1, total: flagged.length });

                const portraitAspect = (this.state.project?.brief?.aspect_ratio === '9:16') ? '9:16' : '16:9';
                const prompt = char.full_prompt_description || char.visual_description || `Portrait of ${char.name}`;

                db.markAssetGenerating(asset.id, prompt);

                try {
                  const genMeta = await this._withSessionRetry(
                    () => this.automation.generateImage({
                      prompt,
                      outputPath: portraitPath,
                      references: [],
                      aspectRatio: portraitAspect,
                      useUnlimited: true,
                      onGenClicked: (creditCost) => db.markAssetGenClicked(asset.id, creditCost),
                    }),
                    assetLabel
                  );

                  db.markAssetDone(asset.id, portraitPath, genMeta);
                  db.logEvent(projectId, 'asset_done', { stage: 'portrait_rerender', assetId: asset.id, assetLabel, detail: portraitPath });
                  this.state.portraits.push({ characterId: char.id, path: portraitPath, status: 'complete' });
                  this.emit({ type: 'portrait-complete', index: idx, path: portraitPath });
                  this.log(`[PORTRAIT RE-RENDER] ✓ ${assetLabel} complete`);
                } catch (err) {
                  if (err.detectedCdnUrl) {
                    db.markAssetCdnUrl(asset.id, err.detectedCdnUrl);
                  }
                  if (this.cancelled || (err.message && err.message.includes('Target') && err.message.includes('closed'))) {
                    db.resetAsset(asset.id);
                    this.cancelled = true;
                    this.log(`[PORTRAIT RE-RENDER] Aborted — browser closed`, 'warn');
                    return { success: false, reason: 'cancelled' };
                  }
                  db.markAssetFailed(asset.id, err.message);
                  this.log(`[PORTRAIT RE-RENDER] Failed for ${char.description_label}: ${err.message}`, 'error');
                  throw err;
                }
              }

              // Clear flagged list after re-rendering
              this.state.flaggedAssets['portraits'] = [];
              this.log(`[PORTRAIT RE-RENDER] All flagged portraits re-rendered — returning to approval gate`);
            }
          } while (portraitDecision && portraitDecision.rerender);
        });

        if (this.cancelled) return { success: false, reason: 'cancelled' };
      }

      // ── Stage 3A.5: Cinematic Element Setup ──
      // Only runs when generator_mode = 'cinematic'. Generates character grids
      // (Nano Banana, portrait as reference, 4-column reference sheet) and
      // creates Higgsfield Character elements that downstream Cinema Studio
      // 2.0 + Kling 3.0 stages reference via @charactername.
      //
      // Best-effort automation with graceful fallback to manual creation:
      // if the 7-click UI path fails, we print a detailed checklist and pause
      // at an approval gate so the user can finish manually in Higgsfield's UI
      // and then click "Elements Ready — Continue."
      //
      // Staged mode is a no-op passthrough. Stage runs only once per project
      // (idempotent): if all elements already exist, the stage completes
      // immediately on resume.
      if (shouldRunStage('portraits-done') && (this.state.generatorMode || 'staged') === 'cinematic') {
        await this.runStage('elements-setup', async () => {
          this.log('[CINEMATIC] Element setup stage starting — character grids + character + location element creation');
          await this._runCinematicElementSetup(projectId, projectDir);

          // ── ELEMENT APPROVAL GATE ──
          // Hard gate: user must confirm elements exist in Higgsfield before
          // location generation burns credits. Never auto-approved, even on resume.
          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'elements-ready' });
          this.log('Waiting for element approval — confirm elements exist in Higgsfield before proceeding...');
          await this.waitForApproval('elements-ready');
          if (this.cancelled) return;

          // Phase 3 location setup runs as part of the same elements-setup
          // logical stage — locations are also Higgsfield Elements, just a
          // different category. Keeps stage topology identical between Phase
          // 2-only (chars) and Phase 2+3 (chars + locations) deployments.
          await this._runCinematicLocationSetup(projectId, projectDir);

          // ── LOCATION APPROVAL GATE ──
          // Hard gate: user must confirm location images exist locally and
          // location elements are registered in Higgsfield before scene gen.
          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'locations-ready' });
          this.log('Waiting for location approval — confirm location images and elements before scene generation...');
          await this.waitForApproval('locations-ready');
          if (this.cancelled) return;
        });
        if (this.cancelled) return { success: false, reason: 'cancelled' };
      }

      // ── Stage 3B: Scene Images ──
      // CINEMATIC MODE FORK: when generator_mode = 'cinematic', this stage
      // routes through Cinema Studio 3.5 + element references + blocking
      // (see _runCinematicSceneImageStage). Staged mode runs the standard
      // Nano Banana Pro per-line scene image generation below.
      if (shouldRunStage('portraits-done') && (this.state.generatorMode || 'staged') === 'cinematic') {
        await this.runStage('scenes', async () => {
          if (isResume && resumeStage === 'portraits-done') {
            const incompleteCheck = db.getIncompleteAssets(projectId, 'scene_image_cinematic');
            const allCheck = db.getAssets(projectId, { type: 'scene_image_cinematic' });
            const noneStarted = incompleteCheck.length === allCheck.length;
            if (noneStarted || allCheck.length === 0) {
              this.state.status = 'waiting_approval';
              this.emit({ type: 'waiting', gate: 'portraits' });
              this.log('Resuming at portraits-done — waiting for portrait approval (cinematic)...');
              await this.waitForApproval('portraits');
              if (this.cancelled) return;
            }
          }

          this.log('[CINEMATIC] Scene image stage starting — Cinema Studio 3.5 Cinematic Cameras with @location ref + @character elements + blocking');
          await this._runCinematicSceneImageStage(projectId, projectDir);

          this.verifyStageComplete('scene_image_cinematic', 'Scene Images (cinematic)');
          db.updateProjectStage(projectId, 'scenes-done');

          // ── Emit scene verification data grouped by location ──
          this._emitSceneVerificationData(projectId, projectDir);

          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'scenes' });
          this.log('Waiting for scene approval...');
          await this.waitForApproval('scenes');
        });
        if (this.cancelled) return { success: false, reason: 'cancelled' };
      } else if (shouldRunStage('portraits-done')) {
        await this.runStage('scenes', async () => {
          // ── Re-gate portrait approval on resume ──
          // When the app restarts at 'portraits-done', Stage 3A is skipped (its approval
          // gate lives inside that block). Re-present approval if no scenes started yet.
          if (isResume && resumeStage === 'portraits-done') {
            const incompleteScenesCheck = db.getIncompleteAssets(projectId, 'scene_image');
            const allScenesCheck = db.getAssets(projectId, { type: 'scene_image' });
            const noneStarted = incompleteScenesCheck.length === allScenesCheck.length;

            if (noneStarted || allScenesCheck.length === 0) {
              this.state.status = 'waiting_approval';
              this.emit({ type: 'waiting', gate: 'portraits' });
              this.log('Resuming at portraits-done — waiting for portrait approval...');
              await this.waitForApproval('portraits');
              if (this.cancelled) return;
            }
          }

          this.log('Starting scene image generation with reference staging...');
          const sceneDir = path.join(projectDir, 'assets', 'scenes');

          // Get incomplete scene assets from DB
          const incompleteScenes = db.getIncompleteAssets(projectId, 'scene_image');
          const allSceneAssets = db.getAssets(projectId, { type: 'scene_image' });
          const totalLines = allSceneAssets.length;
          const doneCount = totalLines - incompleteScenes.length;
          if (doneCount > 0) {
            this.log(`Resuming scenes: ${doneCount}/${totalLines} already done`);
          }

          // Build a set of done chapter+line combos for skipping
          const doneSet = new Set(
            db.getAssets(projectId, { type: 'scene_image', status: 'done' })
              .map(a => `${a.chapter}_${a.line}`)
          );

          // Scene image lookup map — used by stageSceneReferences() to resolve
          // continuity tags like "(Continuity: Using Image Prompt [Line X] as reference)"
          // Pre-populate with already-completed images from DB
          const sceneImageMap = {};
          for (const a of db.getAssets(projectId, { type: 'scene_image', status: 'done' })) {
            sceneImageMap[`${a.chapter}_${a.line}`] = a.file_path;
          }

          let currentLine = 0;

          for (const chapter of this.state.script.chapters) {
            for (const scene of chapter.scenes) {
              for (const line of scene.lines) {
                currentLine++;
                const key = `${chapter.chapter_number}_${line.line_number}`;
                const filename = `ch${String(chapter.chapter_number).padStart(2, '0')}_line${String(line.line_number).padStart(3, '0')}.png`;
                const outputPath = path.join(sceneDir, filename);

                // Skip if already done — but ensure it's in the map for future continuity refs
                if (doneSet.has(key)) {
                  sceneImageMap[key] = sceneImageMap[key] || outputPath;
                  continue;
                }

                if (this.cancelled) return;
                await this.checkPause();

                // Find the DB asset row
                const asset = incompleteScenes.find(a => a.chapter === chapter.chapter_number && a.line === line.line_number);
                if (!asset) continue;

                const sceneLabel = `scene Ch${chapter.chapter_number} L${line.line_number} (${currentLine}/${totalLines})`;
                this.log(`Scene image ${currentLine}/${totalLines}: Ch${chapter.chapter_number} Line ${line.line_number}`);
                this.emit({ type: 'progress', stage: 'scenes', current: currentLine, total: totalLines });

                // Sanitize continuity tag — fix garbled/interleaved tags from LLM output
                const sanitizedPrompt = this.sanitizeContinuityTag(line.image_prompt, line.line_number);
                if (sanitizedPrompt !== line.image_prompt) {
                  this.log(`[PROMPT] Original: ${line.image_prompt.slice(0, 120)}...`);
                  this.log(`[PROMPT] Sanitized: ${sanitizedPrompt.slice(0, 120)}...`);
                }

                // Stage references: character portraits (from scene.characters_present, ordered
                // by prompt position) + continuity image (parsed from prompt tag)
                const { references } = this.stageSceneReferences(sanitizedPrompt, sceneImageMap, chapter.chapter_number, scene.characters_present);

                // Dedup check — scoped by aspect ratio so a 16:9 scene never reuses a 9:16 scene (or vice versa)
                const existing = db.findExistingGeneration(sanitizedPrompt, 'scene_image', this.state.aspectRatio || '16:9');
                if (existing.found) {
                  this.log(`[DEDUP] Reusing existing scene image for Ch${chapter.chapter_number} L${line.line_number}`);
                  const fs = require('fs');
                  if (existing.filePath !== outputPath) {
                    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                    fs.copyFileSync(existing.filePath, outputPath);
                  }
                  db.markAssetDone(asset.id, outputPath, {
                    model: existing.model,
                    sourceGenId: existing.sourceGenId,
                    cdnUrl: existing.cdnUrl,
                    referencesUsed: existing.referencesUsed || references,
                  });
                  db.logEvent(projectId, 'asset_dedup', { stage: 'scenes', assetId: asset.id, assetLabel: sceneLabel, detail: `Reused from ${existing.filePath}` });
                  sceneImageMap[key] = outputPath;
                  this.state.sceneImages.push({
                    chapter: chapter.chapter_number,
                    line: line.line_number,
                    path: outputPath,
                    status: 'complete',
                  });
                  this.emit({ type: 'scene-complete', index: currentLine - 1, path: outputPath });
                  continue;
                }

                // HARD RULE: Strip all aspect ratio / orientation text from prompt.
                // The Higgsfield UI selector (aspectRatio param) is the sole authority.
                // Text like "9:16 aspect ratio" confuses the model into wrong orientation.
                const sceneAspect = this.state.aspectRatio || '16:9';
                const finalPrompt = this.sanitizeAspectRatio(sanitizedPrompt);

                db.markAssetGenerating(asset.id, finalPrompt);
                db.logEvent(projectId, 'asset_start', { stage: 'scenes', assetId: asset.id, assetLabel: sceneLabel });

                try {
                  const genMeta = await this._withSessionRetry(
                    () => this.automation.generateImage({ prompt: finalPrompt, outputPath, references, aspectRatio: sceneAspect }),
                    `scene Ch${chapter.chapter_number} L${line.line_number}`
                  );

                  db.markAssetDone(asset.id, outputPath, genMeta);
                  db.logEvent(projectId, 'asset_done', { stage: 'scenes', assetId: asset.id, assetLabel: sceneLabel, detail: outputPath });
                  sceneImageMap[key] = outputPath;
                  this.state.sceneImages.push({
                    chapter: chapter.chapter_number,
                    line: line.line_number,
                    path: outputPath,
                    status: 'complete',
                  });
                  this.emit({ type: 'scene-complete', index: currentLine - 1, path: outputPath });
                } catch (err) {
                  // Clean-abort path: cancelled OR user closed browser → reset asset, exit
                  if (this.cancelled || (err.message && err.message.includes('Target') && err.message.includes('closed'))) {
                    db.resetAsset(asset.id);
                    this.cancelled = true; // Ensure pipeline halts — don't cascade to downstream stages
                    this.log(`Scene image aborted (cancelled or browser closed) — asset reset to pending, pipeline halting`, 'warn');
                    return { success: false, reason: 'cancelled' };
                  }
                  if (err.detectedCdnUrl) {
                    db.markAssetCdnUrl(asset.id, err.detectedCdnUrl);
                  }
                  db.markAssetFailed(asset.id, err.message);
                  db.logEvent(projectId, 'asset_failed', { stage: 'scenes', assetId: asset.id, assetLabel: sceneLabel, detail: err.message });
                  this.log(`Scene image failed: Ch${chapter.chapter_number} L${line.line_number}: ${err.message}`, 'error');
                  throw err;
                }
              }
            }
          }

          // Verify ALL scene images are done before advancing
          this.verifyStageComplete('scene_image', 'Scene images');

          db.updateProjectStage(projectId, 'scenes-done');

          // Wait for scene approval
          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'scenes' });
          this.log('Waiting for scene image approval...');
          await this.waitForApproval('scenes');
        });

        if (this.cancelled) return { success: false, reason: 'cancelled' };
      }

      // ── Stage 4: Video Generation ──
      // CINEMATIC FORK: when generator_mode = 'cinematic', the video stage
      // packs N dialogue lines into M Kling clips per scene (M < N) instead
      // of the staged 1-line-per-Veo-clip model. See _runCinematicVideoStage.
      if (shouldRunStage('scenes-done') && (this.state.generatorMode || 'staged') === 'cinematic') {
        await this.runStage('video', async () => {
          if (isResume && resumeStage === 'scenes-done') {
            // Skip this gate if the generic resume already handled it or a later gate.
            // Gate order: scenes(0) → dialogue-triage(1) → prompt-preview(2) → clip-review(3)
            const SCENE_GATE_ORDER = 0;
            if (this._resumedGateOrder < SCENE_GATE_ORDER) {
              const incompleteCheck = db.getIncompleteAssets(projectId, 'video_clip_cinematic');
              const allCheck = db.getAssets(projectId, { type: 'video_clip_cinematic' });
              const noneStarted = incompleteCheck.length === allCheck.length;
              if (noneStarted || allCheck.length === 0) {
                // Emit scene verification data so the UI can show the verification tab
                this._emitSceneVerificationData(projectId, projectDir);
                this.state.status = 'waiting_approval';
                this.emit({ type: 'waiting', gate: 'scenes' });
                this.log('Resuming at scenes-done — waiting for scene image approval (cinematic)...');
                await this.waitForApproval('scenes');
                if (this.cancelled) return;
              }
            } else {
              this.log(`[RESUME] Skipping scene re-gate (already handled by generic resume, order=${this._resumedGateOrder})`);
            }
          }

          // ── RESTORE cinematicElementNames from DB on resume ──
          // This map is built during element creation but only lives in memory.
          // On resume (e.g. at scenes-done), the element stage is skipped, so
          // we rebuild it from portrait assets that have element_name set.
          if (!this.state.cinematicElementNames || Object.keys(this.state.cinematicElementNames).length === 0) {
            const portraitAssets = db.getAssets(projectId, { type: 'portrait' })
              .filter(a => a.element_name);
            if (portraitAssets.length > 0) {
              this.state.cinematicElementNames = {};
              const bible = this.state.script?.character_bible || [];
              for (const a of portraitAssets) {
                const name = a.element_name; // suffixed name e.g. "son_emeka_bpdr_0419"
                this.state.cinematicElementNames[name] = name;
                this.state.cinematicElementNames[`@${name}`] = name;
                // Derive base name by stripping suffix (_xxxx_MMDD)
                const baseMatch = name.match(/^(.+)_[a-z]{2,5}_\d{4}$/);
                if (baseMatch) {
                  this.state.cinematicElementNames[baseMatch[1]] = name;
                  this.state.cinematicElementNames[`@${baseMatch[1]}`] = name;
                }
                // Restore char.id and description_label slug keys so ALL
                // lookup patterns work on resume (matches element-setup build)
                const char = bible.find(c => c.element_name_hint === name ||
                  (baseMatch && c.element_name_hint === baseMatch[1]) ||
                  c.id === a.character_id);
                if (char) {
                  this.state.cinematicElementNames[char.id] = name;
                  if (char.element_name_hint) {
                    const hint = char.element_name_hint.toLowerCase().replace(/^@/, '');
                    this.state.cinematicElementNames[hint] = name;
                    this.state.cinematicElementNames[`@${hint}`] = name;
                  }
                  if (char.description_label) {
                    const labelSlug = char.description_label
                      .toLowerCase()
                      .replace(/^(the|a|an)\s+/i, '')
                      .replace(/[^a-z0-9]+/g, '_')
                      .replace(/^_+|_+$/g, '');
                    if (labelSlug) this.state.cinematicElementNames[labelSlug] = name;
                  }
                }
              }
              this.log(`[CINEMATIC] Restored cinematicElementNames from DB: ${portraitAssets.map(a => a.element_name).join(', ')}`);
              // Warn if count mismatch — at video stage this is informational
              // (elements should already exist since scenes were generated)
              if (portraitAssets.length < bible.length) {
                this.log(`[CINEMATIC] WARN: DB has ${portraitAssets.length} element names but bible has ${bible.length} characters — some @mentions may not resolve`, 'warn');
              }
            } else {
              this.log('[CINEMATIC] WARN: no portrait assets with element_name found — @-ref sanitization may strip character names', 'warn');
            }
          }

          // ── DIALOGUE TRIAGE GATE ──
          // Before expensive Kling generation, let the user review which clips
          // have dialogue vs. silent/b-roll. Silent clips default to 'skipped'
          // because Kling fabricates gibberish speech on no-dialogue scenes.
          // Skip if:
          //   1. The generic resume already handled this or a later gate, OR
          //   2. Any clips have already been generated (user already triaged in a
          //      previous session — re-showing triage after 60+ clips is pointless)
          const TRIAGE_GATE_ORDER = 1;
          const existingDoneClips = db.getAssets(projectId, { type: 'video_clip_cinematic' })
            .filter(a => a.status === 'done');
          const triageAlreadyDone = existingDoneClips.length > 0;

          if (triageAlreadyDone) {
            this.log(`[RESUME] Skipping dialogue triage — ${existingDoneClips.length} clips already generated (triage was done in a previous session)`);
          } else if (!isResume || this._resumedGateOrder < TRIAGE_GATE_ORDER) {
            this._emitDialogueTriageData(projectId);
            this.state.status = 'waiting_approval';
            this.emit({ type: 'waiting', gate: 'dialogue-triage' });
            this.log('Waiting for dialogue triage approval...');
            await this.waitForApproval('dialogue-triage');
            if (this.cancelled) return;
          } else {
            this.log(`[RESUME] Skipping dialogue triage re-gate (already handled by generic resume, order=${this._resumedGateOrder})`);
          }

          this.log('[CINEMATIC] Video stage starting — Kling 3.0 multi-shot generation');
          await this._runCinematicVideoStage(projectId, projectDir);

          this.verifyStageComplete('video_clip_cinematic', 'Video Clips (cinematic)');
          db.updateProjectStage(projectId, 'videos-done');

          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'clips' });
          this.log('Waiting for clip approval...');
          await this.waitForApproval('clips');
        });
        if (this.cancelled) return { success: false, reason: 'cancelled' };
      } else if (shouldRunStage('scenes-done')) {
        await this.runStage('video', async () => {
          // ── Re-gate scene approval on resume ──
          // When the app restarts at 'scenes-done', Stage 3B is skipped (its approval
          // gate lives inside that block). We must re-present the approval gate here
          // so the user can review scenes before video gen starts.
          if (isResume && resumeStage === 'scenes-done') {
            const incompleteClipsCheck = db.getIncompleteAssets(projectId, 'video_clip');
            const allClipsCheck = db.getAssets(projectId, { type: 'video_clip' });
            const noneStarted = incompleteClipsCheck.length === allClipsCheck.length;

            // Only re-gate if no video clips have been generated yet
            // (if some clips are done, user already approved in a previous session)
            if (noneStarted || allClipsCheck.length === 0) {
              this.state.status = 'waiting_approval';
              this.emit({ type: 'waiting', gate: 'scenes' });
              this.log('Resuming at scenes-done — waiting for scene image approval...');
              await this.waitForApproval('scenes');
              if (this.cancelled) return;
            }
          }

          this.log('Starting video generation with Veo 3.1 Lite...');
          const clipDir = path.join(projectDir, 'assets', 'clips');

          // Auto-retry configuration. The pipeline retries failed clips up to
          // MAX_RETRY_ROUNDS times before giving up. Approval gate is BLOCKED
          // until all clips are done — we never approve a partial set.
          const MAX_RETRY_ROUNDS = Number(process.env.VIDEO_RETRY_ROUNDS) || 3;
          let retryRound = 0;

          // Initial counts
          const allClipAssets = db.getAssets(projectId, { type: 'video_clip' });
          const totalClips = allClipAssets.length;

          // Build lookup of scene images by chapter+line (shared across retry rounds)
          const sceneImageMap = {};
          for (const si of this.state.sceneImages) {
            sceneImageMap[`${si.chapter}_${si.line}`] = si.path;
          }
          // Also load from DB in case state was partially restored
          for (const a of db.getAssets(projectId, { type: 'scene_image', status: 'done' })) {
            sceneImageMap[`${a.chapter}_${a.line}`] = a.file_path;
          }

          // ── RETRY LOOP: keep going until all clips done or retry budget exhausted ──
          // Each round, fetch current incomplete clips (pending + failed) and attempt them.
          // Failed clips from round N become the target of round N+1.
          while (true) {
            // Recount at start of each round — may differ from the initial count
            // if recovery/dedup/retry changed state
            const incompleteClips = db.getIncompleteAssets(projectId, 'video_clip');
            if (incompleteClips.length === 0) {
              this.log(`[RETRY] All video clips done — exiting retry loop`);
              break;
            }

            if (retryRound === 0) {
              const doneNow = totalClips - incompleteClips.length;
              if (doneNow > 0) {
                this.log(`Resuming videos: ${doneNow}/${totalClips} already done`);
              }
            } else {
              const failedForRetry = incompleteClips.filter(a => a.status === 'failed');
              if (failedForRetry.length === 0) {
                this.log(`[RETRY] No failed clips remaining — exiting retry loop`);
                break;
              }
              this.log(`[RETRY] Round ${retryRound}/${MAX_RETRY_ROUNDS} — retrying ${failedForRetry.length} failed clip(s)`, 'warn');
              // Reset failed clips to pending so the loop below treats them fresh
              // (but keep their saved cdn_url for the recovery-first path)
              for (const a of failedForRetry) {
                // resetAsset clears status/file_path/error; cdn_url is preserved
                db.resetAsset(a.id);
              }
            }

            const roundIncomplete = db.getIncompleteAssets(projectId, 'video_clip');
            let clipIndex = totalClips - roundIncomplete.length;

            for (const asset of roundIncomplete) {
            if (this.cancelled) return;
            await this.checkPause();

            clipIndex++;
            const startFramePath = sceneImageMap[`${asset.chapter}_${asset.line}`];
            if (!startFramePath) {
              this.log(`No scene image for Ch${asset.chapter} L${asset.line} — skipping`, 'warn');
              continue;
            }

            const clipFilename = `ch${String(asset.chapter).padStart(2, '0')}_line${String(asset.line).padStart(3, '0')}.mp4`;
            const clipPath = path.join(clipDir, clipFilename);

            // ── RECOVERY: If this clip failed previously but has a saved CDN URL,
            // try re-downloading before re-generating (saves credits + time) ──
            if (asset.status === 'failed' && asset.cdn_url) {
              this.log(`[RECOVERY] Attempting re-download of failed clip Ch${asset.chapter} L${asset.line} from saved CDN URL...`);
              try {
                fs.mkdirSync(path.dirname(clipPath), { recursive: true });
                const page = this.automation.page;
                const videoData = await page.evaluate(async (url) => {
                  const resp = await fetch(url);
                  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                  const blob = await resp.blob();
                  const buffer = await blob.arrayBuffer();
                  return Array.from(new Uint8Array(buffer));
                }, asset.cdn_url);

                fs.writeFileSync(clipPath, Buffer.from(videoData));
                if (fs.statSync(clipPath).size > 10000) { // Sanity check: >10KB
                  db.markAssetDone(asset.id, clipPath, { cdnUrl: asset.cdn_url });
                  db.logEvent(projectId, 'asset_done', { stage: 'video', assetId: asset.id, assetLabel: `clip Ch${asset.chapter} L${asset.line}`, detail: 'Recovered from CDN URL' });
                  this.log(`[RECOVERY] Successfully re-downloaded clip Ch${asset.chapter} L${asset.line} (${videoData.length} bytes)`);
                  this.state.videoClips.push({ chapter: asset.chapter, line: asset.line, path: clipPath, status: 'complete' });
                  this.emit({ type: 'clip-complete', index: clipIndex - 1, path: clipPath });
                  continue; // Skip to next clip — no need to re-generate
                } else {
                  this.log(`[RECOVERY] Downloaded file too small (${fs.statSync(clipPath).size} bytes) — will re-generate`, 'warn');
                }
              } catch (recoveryErr) {
                this.log(`[RECOVERY] Re-download failed: ${recoveryErr.message} — will re-generate`, 'warn');
              }
              // Reset asset status back to pending for re-generation
              db.resetAsset(asset.id);
            }

            // Find the matching line + scene context for lip-sync-safe prompt
            const { line, scene } = this.findLineAndScene(asset.chapter, asset.line);

            const clipLabel = `clip Ch${asset.chapter} L${asset.line} (${clipIndex}/${totalClips})`;
            this.log(`Video clip ${clipIndex}/${totalClips}: ${clipFilename}`);
            this.emit({ type: 'progress', stage: 'video', current: clipIndex, total: totalClips });

            // Build prompt with explicit speaker/non-speaker lip-sync instructions
            const videoPrompt = this.buildVideoPrompt(line, scene, this.state.project.brief.accent);

            // Dedup check — scoped by aspect ratio so a 16:9 clip never reuses a 9:16 clip (or vice versa)
            const existing = db.findExistingGeneration(videoPrompt, 'video_clip', this.state.aspectRatio || '16:9');
            if (existing.found) {
              this.log(`[DEDUP] Reusing existing video clip for Ch${asset.chapter} L${asset.line}`);
              const fs = require('fs');
              if (existing.filePath !== clipPath) {
                fs.mkdirSync(path.dirname(clipPath), { recursive: true });
                fs.copyFileSync(existing.filePath, clipPath);
              }
              db.markAssetDone(asset.id, clipPath, { model: existing.model, sourceGenId: existing.sourceGenId, cdnUrl: existing.cdnUrl });
              db.logEvent(projectId, 'asset_dedup', { stage: 'video', assetId: asset.id, assetLabel: clipLabel, detail: `Reused from ${existing.filePath}` });
              this.state.videoClips.push({
                chapter: asset.chapter,
                line: asset.line,
                path: clipPath,
                status: 'complete',
              });
              this.emit({ type: 'clip-complete', index: clipIndex - 1, path: clipPath });
              continue;
            }

            db.markAssetGenerating(asset.id, videoPrompt);
            db.logEvent(projectId, 'asset_start', { stage: 'video', assetId: asset.id, assetLabel: clipLabel });

            try {
              const genMeta = await this._withSessionRetry(
                () => this.automation.generateVideo({ startFramePath, animationPrompt: videoPrompt, outputPath: clipPath, duration: 8, audioOn: true, aspectRatio: this.state.aspectRatio || '16:9' }),
                clipLabel
              );

              db.markAssetDone(asset.id, clipPath, genMeta);
              db.logEvent(projectId, 'asset_done', { stage: 'video', assetId: asset.id, assetLabel: clipLabel, detail: clipPath });
              this.state.videoClips.push({
                chapter: asset.chapter,
                line: asset.line,
                path: clipPath,
                status: 'complete',
              });
              this.emit({ type: 'clip-complete', index: clipIndex - 1, path: clipPath });
            } catch (err) {
              // Clean-abort path: cancelled OR user closed browser → reset + exit
              if (this.cancelled || (err.message && err.message.includes('Target') && err.message.includes('closed'))) {
                db.resetAsset(asset.id);
                this.cancelled = true; // Ensure pipeline halts — don't cascade to downstream stages
                this.log(`Video clip aborted (cancelled or browser closed) — asset reset to pending, pipeline halting`, 'warn');
                return { success: false, reason: 'cancelled' };
              }

              // Save CDN URL if generation succeeded but download failed
              // (allows re-download on restart without re-generating)
              if (err.detectedCdnUrl) {
                db.markAssetCdnUrl(asset.id, err.detectedCdnUrl);
                this.log(`[RECOVERY] Saved CDN URL for failed clip — can retry download on restart`, 'warn');
              }

              // ─── Phase 4.5: Inline history recovery ───
              // If this failure looks like something Higgsfield MAY have actually
              // generated server-side (Generate click fired but we lost track of
              // the CDN URL), try to scrape Asset History and recover. This saves
              // the user credits for a clip they already paid for.
              if (this._shouldTryHistoryRecovery(asset, err)) {
                this._historyAttempted.add(asset.id);
                try {
                  if (!this._historyRecovery) {
                    const { HiggsfieldHistory } = require('../automation/higgsfield-history');
                    this._historyRecovery = new HiggsfieldHistory({
                      automation: this.automation,
                      logger: (msg) => this.log(`[RECOVERY] ${msg}`),
                    });
                  }

                  this.log(`[RECOVERY] Attempting history recovery for Ch${asset.chapter} L${asset.line}...`, 'warn');
                  const match = await this._historyRecovery.findMatchForAsset(
                    { ...asset, prompt_used: videoPrompt },
                    {
                      timestampWindowMs: 10 * 60 * 1000,
                      minPromptSimilarity: 85,
                      scrapeTimeoutMs: 30_000,
                    }
                  );

                  if (match) {
                    await this._historyRecovery.downloadAsset(match.uuid, clipPath, match.cdnUrl);
                    db.markAssetRecoveredFromHistory(asset.id, clipPath, {
                      cdnUrl: match.cdnUrl,
                      higgsfieldAssetId: match.uuid,
                    });
                    db.logEvent(projectId, 'asset_recovered', {
                      stage: 'video',
                      assetId: asset.id,
                      assetLabel: clipLabel,
                      detail: `Recovered from history ${match.uuid} (score=${match.score}%, tier=${match.confidence})`,
                    });
                    this.log(`[RECOVERY] ✓ Recovered Ch${asset.chapter} L${asset.line} from history — no credits wasted`);
                    this.state.videoClips.push({
                      chapter: asset.chapter,
                      line: asset.line,
                      path: clipPath,
                      status: 'complete',
                    });
                    this.emit({ type: 'clip-complete', index: clipIndex - 1, path: clipPath });
                    continue; // skip failure path — asset is now done
                  }

                  this.log(`[RECOVERY] No match found in history for Ch${asset.chapter} L${asset.line}`, 'warn');
                } catch (recErr) {
                  this.log(`[RECOVERY] History scrape failed: ${recErr.message} — falling through to normal failure path`, 'warn');
                }
              }

              db.markAssetFailed(asset.id, err.message);
              db.logEvent(projectId, 'asset_failed', { stage: 'video', assetId: asset.id, assetLabel: clipLabel, detail: err.message });
              this.log(`Video clip failed: Ch${asset.chapter} L${asset.line}: ${err.message}`, 'error');

              // Don't throw — mark as failed and continue to the next clip.
              // Failed clips can be retried later via redo-scenes.js or on resume.
              // Only abort if SESSION_EXPIRED (user needs to re-login).
              if (err.message.includes('SESSION_EXPIRED')) throw err;

              this.log(`Continuing to next clip (${roundIncomplete.length - (clipIndex - (totalClips - roundIncomplete.length))} remaining in this round)...`, 'warn');
              continue;
            }
          } // end of for-asset loop

            // Round complete — check results
            const failedAfterRound = db.getAssets(projectId, { type: 'video_clip', status: 'failed' });
            const doneAfterRound = db.getAssets(projectId, { type: 'video_clip', status: 'done' });
            this.log(`[RETRY] Round ${retryRound} complete — ${doneAfterRound.length}/${totalClips} done, ${failedAfterRound.length} failed`);

            // If no failed clips, we're done with retries
            if (failedAfterRound.length === 0) break;

            // Hit the retry cap — don't loop forever
            retryRound++;
            if (retryRound > MAX_RETRY_ROUNDS) {
              this.log(`[RETRY] Max retry rounds (${MAX_RETRY_ROUNDS}) reached — ${failedAfterRound.length} clip(s) still failing`, 'error');
              break;
            }

            // Brief pause between rounds to let the browser/network settle
            this.log(`[RETRY] Waiting 5s before retry round ${retryRound}...`);
            await new Promise(r => setTimeout(r, 5000));
          } // end of retry while loop

          // ── FINAL CHECK: approval gate only opens when ALL clips are done ──
          const failedClips = db.getAssets(projectId, { type: 'video_clip', status: 'failed' });
          const doneClips = db.getAssets(projectId, { type: 'video_clip', status: 'done' });

          if (failedClips.length > 0) {
            this.log(`${failedClips.length}/${totalClips} video clips STILL FAILED after ${retryRound} retry round(s)`, 'error');
            this.log(`${doneClips.length}/${totalClips} video clips succeeded`, 'warn');
            // Don't show approval gate. Throw so the pipeline stops and user can investigate.
            throw new Error(
              `CLIPS_STILL_FAILED: ${failedClips.length}/${totalClips} video clip(s) failed after ${retryRound} retry rounds. ` +
              `Fix the underlying issue (check logs for error patterns), then run ` +
              `'node scripts/redo-videos.js all-failed' and restart to continue.`
            );
          }

          // Block on any stuck (pending/generating) clips — something went sideways
          const stuckClips = db.getIncompleteAssets(projectId, 'video_clip');
          if (stuckClips.length > 0) {
            const statuses = stuckClips.map(a => `id=${a.id}:${a.status}`).join(', ');
            throw new Error(`Video clips incomplete: ${stuckClips.length} assets stuck [${statuses}]`);
          }

          // All clips done! Verify files on disk
          this.log(`[VERIFY] All ${doneClips.length}/${totalClips} video clips done, files verified on disk`);
          for (const clip of doneClips) {
            if (!clip.file_path || !fs.existsSync(clip.file_path)) {
              this.log(`[VERIFY] Missing file for clip id=${clip.id}: ${clip.file_path}`, 'warn');
            }
          }

          db.updateProjectStage(projectId, 'videos-done');
          // NOTE: approval gate moved out of this stage. The new 'verify' stage
          // (below) runs Gemini verification first, then opens a SMARTER approval
          // gate that only surfaces clips flagged for review or redo — clips
          // auto-accepted by verification pass through without human action.
        });

        if (this.cancelled) return { success: false, reason: 'cancelled' };
      }

      // ── Stage 4.5: Verify Clips (Gemini multimodal) ──
      // For each done clip, run ClipVerifier (Gemini by default). Persist results
      // per asset. Then show a human-approval gate listing only review/reject tiers.
      // All-accept case skips the gate entirely — straight to assembly.
      if (shouldRunStage('videos-done')) {
        // Wrap verify in an outer while loop so that if the user marks clips
        // for redo during the approval gate, we can regenerate them and re-verify
        // without restarting the whole pipeline. Max iterations = safety cap.
        const MAX_VERIFY_REDO_ITERATIONS = Number(process.env.VERIFY_REDO_ITERATIONS) || 3;
        let verifyIter = 0;

        while (true) {
          verifyIter++;
          if (verifyIter > MAX_VERIFY_REDO_ITERATIONS) {
            this.log(`[VERIFY] Max redo iterations (${MAX_VERIFY_REDO_ITERATIONS}) reached — proceeding to assembly with remaining clips`, 'warn');
            break;
          }

          // On iterations AFTER the first (meaning user rejected clips in the
          // previous round), regenerate the now-pending clips by running the
          // video generation loop again.
          if (verifyIter > 1) {
            const isCinematicRedo = (this.state.generatorMode || 'staged') === 'cinematic';
            const redoClipType = isCinematicRedo ? 'video_clip_cinematic' : 'video_clip';
            this.log(`[VERIFY] Redo round ${verifyIter - 1}: regenerating rejected ${redoClipType} clips...`);

            const pendingClips = db.getIncompleteAssets(projectId, redoClipType);
            if (pendingClips.length === 0) {
              this.log('[VERIFY] Nothing to regenerate — exiting loop');
              break;
            }

            if (isCinematicRedo) {
              // ── CINEMATIC REDO ──
              // _runCinematicVideoStage already handles resume: it skips done
              // clips and only generates pending ones. The rejected clips were
              // reset to 'pending' by setVerifyHumanDecision, so the stage
              // picks them up naturally. All prompt building, vision blocking,
              // smart duration, prompt-preview gate, etc. run as normal.
              this.log(`[VERIFY-REDO] Cinematic mode — re-entering _runCinematicVideoStage for ${pendingClips.length} pending clip(s)`);
              db.updateProjectStage(projectId, 'scenes-done');
              await this._runCinematicVideoStage(projectId, projectDir);
              db.updateProjectStage(projectId, 'videos-done');
            } else {
              // ── STAGED REDO ──
              // Inline loop for staged (Higgsfield) clips — simpler flow
              await this.runStage('video', async () => {
                this.log(`[VERIFY-REDO] Regenerating ${pendingClips.length} staged clip(s)...`);
                this.emit({ type: 'stage', stage: 'video' });
                const sceneImageMap = {};
                for (const si of this.state.sceneImages) sceneImageMap[`${si.chapter}_${si.line}`] = si.path;
                for (const a of db.getAssets(projectId, { type: 'scene_image', status: 'done' })) {
                  sceneImageMap[`${a.chapter}_${a.line}`] = a.file_path;
                }
                for (let idx = 0; idx < pendingClips.length; idx++) {
                  if (this.cancelled) return;
                  await this.checkPause();
                  const asset = pendingClips[idx];
                  const startFramePath = sceneImageMap[`${asset.chapter}_${asset.line}`];
                  if (!startFramePath) {
                    this.log(`[VERIFY-REDO] No scene image for Ch${asset.chapter} L${asset.line} — skipping`, 'warn');
                    continue;
                  }
                  const clipFilename = `ch${String(asset.chapter).padStart(2, '0')}_line${String(asset.line).padStart(3, '0')}.mp4`;
                  const clipPath = path.join(projectDir, 'assets', 'clips', clipFilename);
                  const { line: lineObj, scene } = this.findLineAndScene(asset.chapter, asset.line);
                  const videoPrompt = this.buildVideoPrompt(lineObj, scene, this.state.project.brief.accent);
                  const clipLabel = `clip Ch${asset.chapter} L${asset.line} (redo)`;
                  this.log(`[VERIFY-REDO] ${clipLabel}`);
                  this.emit({ type: 'progress', stage: 'video', current: idx + 1, total: pendingClips.length });
                  db.markAssetGenerating(asset.id, videoPrompt);
                  try {
                    const genMeta = await this._withSessionRetry(
                      () => this.automation.generateVideo({ startFramePath, animationPrompt: videoPrompt, outputPath: clipPath, duration: 8, audioOn: true, aspectRatio: this.state.aspectRatio || '16:9' }),
                      clipLabel
                    );
                    db.markAssetDone(asset.id, clipPath, genMeta);
                    this.emit({ type: 'clip-complete', index: idx, path: clipPath });
                  } catch (err) {
                    if (err.detectedCdnUrl) db.markAssetCdnUrl(asset.id, err.detectedCdnUrl);
                    db.markAssetFailed(asset.id, err.message);
                    this.log(`[VERIFY-REDO] Clip failed: ${clipLabel}: ${err.message}`, 'error');
                    if (err.message.includes('SESSION_EXPIRED')) throw err;
                  }
                }
                db.updateProjectStage(projectId, 'videos-done');
              });
            }
            if (this.cancelled) return { success: false, reason: 'cancelled' };
          }

          // VERIFY stage body — runs every iteration (verifies newly regenerated clips)
          await this.runStage('verify', async () => {
            this.log(`Starting clip verification with Gemini (iteration ${verifyIter})...`);
            this.emit({ type: 'stage', stage: 'verify' });

            const geminiKey = this.store.get('geminiApiKey');
            if (!geminiKey) {
              this.log('[VERIFY] No Gemini API key set — skipping verification (clips will go straight to approval)', 'warn');
            } else {
              const { ClipVerifier } = require('../verify/clipVerifier');
              const verifier = new ClipVerifier({ apiKey: geminiKey, backend: 'gemini' });

              // Build verification items. Cinematic mode reads
              // video_clip_cinematic + maps to expectedLines (multi-line per
              // clip via line_refs); staged mode reads video_clip + uses
              // expectedDialogue (single line per clip). Both shapes coexist
              // in the same batch — verifyBatch dispatches appropriately.
              const isCinematic = (this.state.generatorMode || 'staged') === 'cinematic';
              const items = [];

              if (isCinematic) {
                const doneClipsCine = db.getAssets(projectId, { type: 'video_clip_cinematic', status: 'done' });
                for (const clip of doneClipsCine) {
                  if (!clip.file_path || !fs.existsSync(clip.file_path)) continue;
                  if (clip.verify_human_decision === 'accepted') continue;
                  // Resolve line_refs to actual line objects from the script
                  let lineRefs = [];
                  try { lineRefs = JSON.parse(clip.line_refs || '[]'); } catch (_) {}
                  const expectedLines = [];
                  // Find the scene for this clip — clip rows have chapter+scene
                  const sceneObj = (this.state.script?.chapters || [])
                    .find(c => c.chapter_number === clip.chapter)
                    ?.scenes?.find(s => s.scene_number === clip.scene);
                  for (const lineNum of lineRefs) {
                    const lineObj = sceneObj?.lines?.find(l => l.line_number === lineNum);
                    if (lineObj) {
                      expectedLines.push({
                        line_number: lineObj.line_number,
                        speaker_id: lineObj.speaker_id,
                        dialogue: lineObj.dialogue || lineObj.line || lineObj.text || '',
                        tone: lineObj.tone,
                      });
                    }
                  }
                  if (expectedLines.length === 0) {
                    this.log(`[VERIFY] ${clip.kling_clip_id || clip.id}: no expectedLines resolvable from script — skipping cinematic verify`, 'warn');
                    continue;
                  }
                  items.push({
                    clipPath: clip.file_path,
                    expectedLines,
                    clipLabel: `${clip.kling_clip_id || ('Ch' + clip.chapter + ' Sc' + clip.scene)}`,
                    assetId: clip.id,
                  });
                }
              } else {
                const doneClips = db.getAssets(projectId, { type: 'video_clip', status: 'done' });
                for (const clip of doneClips) {
                  if (!clip.file_path || !fs.existsSync(clip.file_path)) continue;
                  if (clip.verify_human_decision === 'accepted') continue;
                  const { line: lineObj } = this.findLineAndScene(clip.chapter, clip.line);
                  const expected = (lineObj && (lineObj.line || lineObj.dialogue || lineObj.text)) || '';
                  items.push({
                    clipPath: clip.file_path,
                    expectedDialogue: expected,
                    clipLabel: `Ch${clip.chapter} L${clip.line}`,
                    assetId: clip.id,
                  });
                }
              }

              if (items.length === 0) {
                this.log('[VERIFY] No clips need verification (all already human-accepted)');
              } else {
                this.log(`[VERIFY] Verifying ${items.length} clip(s) via Gemini multimodal...`);
                this.emit({ type: 'progress', stage: 'verify', current: 0, total: items.length });

                const results = await verifier.verifyBatch(items, {
                  concurrency: 3,
                  onProgress: ({ current, total }) => {
                    this.emit({ type: 'progress', stage: 'verify', current, total });
                  },
                });

                let accepts = 0, reviews = 0, rejects = 0, errors = 0;
                for (const r of results) {
                  const item = items.find(i => i.clipPath === r.clipPath);
                  if (!item) continue;
                  if (r.error) { errors++; continue; }
                  db.saveClipVerification(item.assetId, r);
                  if (r.tier === 'accept') accepts++;
                  else if (r.tier === 'review') reviews++;
                  else if (r.tier === 'reject') rejects++;
                }
                this.log(`[VERIFY] Results: ${accepts} accept, ${reviews} review, ${rejects} reject${errors ? `, ${errors} error` : ''}`);
              }
            }

            db.updateProjectStage(projectId, 'verified');

            const verifications = db.getClipVerifications(projectId);
            const needsAttention = verifications.filter(v =>
              v.status === 'done' &&
              (v.verify_tier === 'review' || v.verify_tier === 'reject') &&
              v.verify_human_decision !== 'accepted'
            );

            if (needsAttention.length === 0) {
              this.log('[VERIFY] All clips auto-accepted — proceeding to assembly');
            } else {
              this.log(`[VERIFY] ${needsAttention.length} clip(s) need human review — opening Verify tab`);
              this.state.status = 'waiting_approval';
              this.emit({ type: 'waiting', gate: 'verify' });
              await this.waitForApproval('verify');
            }
          });

          if (this.cancelled) return { success: false, reason: 'cancelled' };

          // Did the user mark any clips for redo? If so, loop back to video gen.
          // Mode-aware: cinematic redos live on video_clip_cinematic.
          const redoType = (this.state.generatorMode || 'staged') === 'cinematic'
            ? 'video_clip_cinematic'
            : 'video_clip';
          const pendingAfterApproval = db.getAssets(projectId, { type: redoType, status: 'pending' });
          if (pendingAfterApproval.length === 0) {
            // No redos requested — we're done with verify
            break;
          }
          this.log(`[VERIFY] ${pendingAfterApproval.length} ${redoType} clip(s) marked for redo — looping back to video generation`);
          // Reset project stage so if the user closes + reopens mid-redo, resume works
          db.updateProjectStage(projectId, 'scenes-done');
          // Loop iteration continues → regenerates pending → re-verifies → re-gates
        }
      }

      // ── Stage 5: Assembly ──
      if (shouldRunStage('verified')) {
        await this.runStage('assembly', async () => {
          this.log('Starting video assembly with FFmpeg...');
          this.emit({ type: 'stage', stage: 'assembly' });

          // ── IDEMPOTENCY CHECK: skip if final video already exists ──
          const isCinematic = (this.state.generatorMode || 'staged') === 'cinematic';
          const projectAspect = this.state.aspectRatio || '16:9';
          const aspectTag = projectAspect === '9:16' ? '9x16' : '16x9';
          const modeTag = isCinematic ? 'cinematic_' : '';
          const outputPath = path.join(projectDir, 'output', `final_${modeTag}${aspectTag}_4K.mp4`);

          const existingFinalAsset = db.getAssets(projectId, { type: 'final_video', status: 'done' });
          if (existingFinalAsset.length > 0 && fs.existsSync(outputPath)) {
            this.log(`[ASSEMBLY] Final video already exists: ${path.basename(outputPath)} — skipping assembly`);
            this.emit({ type: 'assembly-complete', outputPath });
            return;
          }

          // Reload all done clips from DB. CINEMATIC FORK: read
          // video_clip_cinematic when generator_mode = 'cinematic', otherwise
          // staged video_clip. Each row shape includes chapter + scene +
          // (line OR kling_clip_id) so we can compute a stable sort key.
          const clipType = isCinematic ? 'video_clip_cinematic' : 'video_clip';
          const allDoneClips = db.getAssets(projectId, { type: clipType, status: 'done' });

          if (allDoneClips.length === 0) {
            throw new Error(`No done ${clipType} clips found — assembly cannot proceed`);
          }

          // Build clipList with a sortKey that handles both modes:
          //   Staged:    chapter * 1e6 + scene * 1e3 + line
          //   Cinematic: chapter * 1e6 + scene * 1e3 + (clip-suffix from kling_clip_id)
          //
          // The kling_clip_id format is "ch{N}_sc{M}_c{K}" — we extract K as
          // the within-scene order. Falls back to line (which is set to the
          // first line_ref) if clip_id isn't present.
          const clipList = allDoneClips.map(a => {
            let sortKey;
            if (isCinematic) {
              const clipNumMatch = (a.kling_clip_id || '').match(/_c(\d+)$/);
              const clipNum = clipNumMatch ? parseInt(clipNumMatch[1], 10) : (a.line || 1);
              sortKey = (a.chapter || 0) * 1_000_000 + (a.scene || 0) * 1_000 + clipNum;
            } else {
              sortKey = (a.chapter || 0) * 1_000_000 + (a.scene || 0) * 1_000 + (a.line || 0);
            }
            return {
              chapter: a.chapter,
              scene: a.scene,
              line: a.line,
              klingClipId: a.kling_clip_id || null,
              path: a.file_path,
              sortKey,
              status: 'complete',
            };
          });

          this.log(`[ASSEMBLY] Mode=${isCinematic ? 'cinematic' : 'staged'} — concatenating ${clipList.length} clip(s) (${clipType})`);

          await this.assembler.assemble({
            clips: clipList,
            script: this.state.script,
            outputPath,
            aspectRatio: projectAspect,
            onProgress: (progress) => {
              this.emit({ type: 'assembly-progress', progress });
            },
          });

          // Record final video as an asset
          db.insertExpectedAssets(projectId, [{ type: 'final_video' }]);
          const finalAsset = db.getAssets(projectId, { type: 'final_video' })[0];
          if (finalAsset) db.markAssetDone(finalAsset.id, outputPath);

          this.log(`Assembly complete! Output: ${outputPath}`);
          this.emit({ type: 'assembly-complete', outputPath });
        });
      }

      // ── Record for title deduplication ──
      // Pattern library is reusable — no videos get "consumed".
      // Title dedup prevents generating similar stories from the same pool.
      this.recordProducedStory({
        projectId,
        title: this.state.selectedTitle,
        themes: this.state.researchData?.patterns?.recurring_themes || [],
        summary: storyBrief.concept || this.state.selectedTitle,
        structure: this.state.storyStructure,
        totalClips: this.state.videoClips.length,
      });
      this.log('Story recorded for title dedup — pattern library remains available for next story');

      // ── Stage 6: Publish (thumbnail + SEO metadata) ──
      if (shouldRunStage('assembled')) {
        await this.runStage('publish', async () => {
          this.log('Starting publish stage — generating thumbnail + SEO metadata...');
          this.emit({ type: 'stage', stage: 'publish' });

          const outputDir = path.join(projectDir, 'output');
          fs.mkdirSync(outputDir, { recursive: true });

          // ── AUTO-CLOSE CHECK: if final video + at least 1 thumbnail exist, skip approval gate ──
          const project = db.getProject(projectId);
          const finalVideoAsset = db.getAssets(projectId, { type: 'final_video', status: 'done' });
          const hasFinalVideo = finalVideoAsset.length > 0 && finalVideoAsset[0].file_path && fs.existsSync(finalVideoAsset[0].file_path);
          const hasThumbnail = project?.thumbnail_path && fs.existsSync(project.thumbnail_path);

          if (hasFinalVideo && hasThumbnail) {
            this.log(`[PUBLISH] Project already has final video + thumbnail on disk — auto-closing`);
            this.log(`  Final video: ${path.basename(finalVideoAsset[0].file_path)}`);
            this.log(`  Thumbnail:   ${path.basename(project.thumbnail_path)}`);
            db.updateProjectStage(projectId, 'published');
            this.emit({ type: 'publish-auto-closed', reason: 'Final video and thumbnail already exist' });
            return;
          }

          // Score scene images for thumbnail candidates
          // Query both scene_image and scene_image_cinematic types (cinematic mode uses the latter)
          const sceneAssets = [
            ...db.getAssets(projectId, { type: 'scene_image', status: 'done' }),
            ...db.getAssets(projectId, { type: 'scene_image_cinematic', status: 'done' }),
          ].filter(a => a.file_path);
          const sceneImagePaths = sceneAssets.map(a => a.file_path).filter(p => fs.existsSync(p));
          this.log(`Found ${sceneImagePaths.length} scene images for thumbnail scoring`);

          let sceneCandidates = [];
          if (sceneImagePaths.length > 0) {
            const { ThumbnailGenerator } = require('../publish/thumbnailGenerator');
            const geminiKey = this.store.get('geminiApiKey', '');
            const thumbGen = new ThumbnailGenerator(this.automation, { geminiApiKey: geminiKey });
            sceneCandidates = await thumbGen.scoreSceneCandidates(sceneImagePaths);
            this.log(`Scene thumbnail scores: ${sceneCandidates.map(c => `${path.basename(c.path)}=${c.score}`).join(', ')}`);
          }

          // Store candidates in state for UI
          this.state.publishState = {
            sceneCandidates,
            selectedScenePath: sceneCandidates[0]?.path || null,
            thumbnailGenerated: false,
            seoGenerated: false,
            youtubeMetadata: null,
            facebookMetadata: null,
          };

          // Emit for renderer to show publish view with candidates
          this.emit({
            type: 'publish-ready',
            sceneCandidates,
            title: storyBrief?.title || this.state.selectedTitle,
          });

          // Wait for user approval (they pick scene, trigger thumbnail gen, review SEO, then approve)
          this.state.status = 'waiting_approval';
          this.state.currentApprovalGate = 'publish';
          await new Promise((resolve) => { this._publishResolver = resolve; });

          db.updateProjectStage(projectId, 'published');
          this.log('Publish stage complete — output package ready');
        });
      }

      // Mark project as completed in DB
      db.completeProject(projectId);

      const cacheStatus = this.getResearchCacheStatus();

      this.state.status = 'complete';
      this.state.currentStage = 'export';
      this.emit({
        type: 'pipeline-complete',
        project: this.state.project,
        cacheStatus,
      });
      this.log(`Pipeline complete! Pattern library active (${cacheStatus.storiesProduced} stories produced, expires in ${cacheStatus.expiresInHours}h)`);

      db.logEvent(projectId, 'session_end', { stage: 'complete', detail: 'Pipeline finished successfully' });

      return { success: true, projectDir, cacheStatus };

    } catch (err) {
      this.state.status = 'error';
      this.state.error = err.message;
      const pid = this.state.project?.id;
      if (pid) db.logEvent(pid, 'error', { stage: this.state.currentStage, detail: err.message });
      if (pid) db.logEvent(pid, 'session_end', { stage: this.state.currentStage, detail: `Error: ${err.message}` });
      this.log(`Pipeline error: ${err.message}`, 'error');
      this.emit({ type: 'error', message: err.message });
      return { success: false, reason: err.message };
    }
  }

  /**
   * Insert all expected assets into the DB after script generation.
   * This pre-populates portrait, scene_image, and video_clip rows as 'pending'
   * so crash recovery knows exactly what needs to be generated.
   */
  _insertExpectedAssets(projectId, script, structure) {
    const assets = [];
    const isCinematicStoryDriven = structure?.storyDriven && this.state.generatorMode === 'cinematic';

    // Portraits — one per character
    for (const char of script.character_bible || []) {
      assets.push({ type: 'portrait', character_id: char.id });
    }

    let sceneCount = 0;
    let clipOrLineCount = 0;

    for (const chapter of script.chapters || []) {
      for (const scene of chapter.scenes || []) {
        if (isCinematicStoryDriven) {
          // Cinematic story-driven: one scene_image_cinematic per SCENE, one video_clip_cinematic per KLING_CLIP
          assets.push({
            type: 'scene_image_cinematic',
            chapter: chapter.chapter_number,
            scene: scene.scene_number || null,
            line: null, // scene-level, not line-level
          });
          sceneCount++;
          for (const clip of scene.kling_clips || []) {
            assets.push({
              type: 'video_clip_cinematic',
              chapter: chapter.chapter_number,
              scene: scene.scene_number || null,
              line: clip.line_refs?.[0] || null, // first line of clip for reference
            });
            clipOrLineCount++;
          }
        } else {
          // Staged / fixed-grid: one scene_image + one video_clip per LINE
          for (const line of scene.lines || []) {
            assets.push({
              type: 'scene_image',
              chapter: chapter.chapter_number,
              scene: scene.scene_number || null,
              line: line.line_number,
            });
            assets.push({
              type: 'video_clip',
              chapter: chapter.chapter_number,
              scene: scene.scene_number || null,
              line: line.line_number,
            });
            clipOrLineCount++;
          }
          sceneCount += (scene.lines || []).length; // for staged, scene count = line count in log
        }
      }
    }

    db.insertExpectedAssets(projectId, assets);
    const portraits = script.character_bible?.length || 0;
    if (isCinematicStoryDriven) {
      this.log(`Inserted ${assets.length} expected assets into DB (${portraits} portraits, ${sceneCount} scene images, ${clipOrLineCount} video clips)`);
    } else {
      this.log(`Inserted ${assets.length} expected assets into DB (${portraits} portraits, ${clipOrLineCount} scenes + clips)`);
    }
  }

  /**
   * Find a script line and its parent scene by chapter + line number.
   * Returns { line, scene } so callers can access characters_present.
   */
  findLineAndScene(chapterNum, lineNum) {
    for (const ch of this.state.script.chapters) {
      if (ch.chapter_number === chapterNum) {
        for (const sc of ch.scenes) {
          for (const ln of sc.lines) {
            if (ln.line_number === lineNum) return { line: ln, scene: sc };
          }
        }
      }
    }
    return {
      line: { animation_prompt: '', dialogue: '', tone: 'Neutral', speaker_id: '' },
      scene: { characters_present: [] },
    };
  }

  // Backward-compat alias
  findLineByChapterAndLine(chapterNum, lineNum) {
    return this.findLineAndScene(chapterNum, lineNum).line;
  }

  /**
   * Derive the element-name suffix for this project.
   *
   * Convention: @{hint}_{title-initials} to avoid cross-project collisions.
   * Example: Claire in "The Heir's Probation" → @claire_thp.
   *
   * Title → initials: lowercase, first letter of each word, strip punctuation.
   * Capped at 5 letters so the suffix stays tractable.
   */
  _titleInitials(title) {
    if (!title) return 'proj';
    return title
      .toLowerCase()
      .replace(/[^a-z\s]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w[0])
      .join('')
      .slice(0, 5) || 'proj';
  }

  /**
   * Generate a unique element name suffix for this project.
   * Format: {acronym}_{MMDD} — e.g. "bpdr_0419" for "Born Poor, Died Respected" on April 19.
   * Used to avoid Higgsfield element name collisions across projects.
   *
   * @param {string} title - The project title
   * @returns {string} The suffix (no leading underscore)
   */
  _elementSuffix(title) {
    const acronym = this._titleInitials(title);
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${acronym}_${mm}${dd}`;
  }

  /**
   * Settle gate: poll the Higgsfield gallery URL count until it stabilises
   * for `stableSamples` consecutive checks (default 2). Used before the first
   * grid generation to ensure all portrait CDN URLs have propagated into
   * the gallery view — otherwise the late-arriving last-portrait URL races
   * with the grid_1 wait window and gets mis-attributed.
   *
   * Bug observed: Session 8 first cinematic run produced character_1_grid.png
   * containing the LAST portrait's image (single full-body shot, not gridded).
   * Root cause: portrait stage marked done before its CDN URL appeared in
   * gallery; element-setup advanced too fast; grid_1's snapshot+poll detected
   * the late portrait URL as a "new" generation.
   */
  async _settleHiggsfieldGallery({ stableSamples = 2, maxWaitMs = 15000, pollIntervalMs = 1500 } = {}) {
    if (!this.automation || !this.automation.page) return;
    const page = this.automation.page;
    const startedAt = Date.now();
    let lastCount = -1;
    let stableCount = 0;
    while (Date.now() - startedAt < maxWaitMs) {
      // Count visible image tiles on the current page (works whether we're
      // on the image-gen page or an asset gallery — both render images.higgs.ai
      // tiles). We don't care about the exact count, only that it's stable.
      const count = await page.evaluate(() => {
        return document.querySelectorAll('img[src*="images.higgs.ai"], img[src*="cdn.higgsfield.ai"]').length;
      }).catch(() => -1);
      if (count >= 0 && count === lastCount) {
        stableCount++;
        if (stableCount >= stableSamples) {
          this.log(`[CINEMATIC] Gallery settled at ${count} tiles after ${Math.round((Date.now() - startedAt) / 1000)}s`);
          return;
        }
      } else {
        stableCount = 0;
      }
      lastCount = count;
      await page.waitForTimeout(pollIntervalMs);
    }
    this.log(`[CINEMATIC] Gallery settle hit ${maxWaitMs}ms cap (last count=${lastCount}); proceeding`, 'warn');
  }

  /**
   * Verify a downloaded character grid has the expected wide aspect ratio.
   *
   * Real character grids are generated 16:9 with 4 columns of full-body +
   * close-up — actual aspect is ~1.7-1.8x wider than tall. A portrait
   * mis-attributed by the gallery race condition (Session 8 bug) lands as
   * a single full-body image with portrait/square aspect (~0.6-1.0x).
   *
   * Returns true if the file's aspect looks like a grid; false otherwise.
   * On any read error we return true (don't block on infrastructure issues).
   */
  async _verifyGridDimensions(filePath) {
    try {
      const fs = require('fs');
      if (!fs.existsSync(filePath)) return true;
      const stat = fs.statSync(filePath);
      if (stat.size < 1024) return true; // treat as separate failure mode
      // Read the first ~200 bytes to extract image dimensions from PNG/JPEG header
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(2048);
      const bytesRead = fs.readSync(fd, buf, 0, 2048, 0);
      fs.closeSync(fd);
      const dims = this._extractImageDimensions(buf, bytesRead, filePath);
      if (!dims) return true; // can't tell, don't block
      const ratio = dims.width / dims.height;
      const isGrid = ratio > 1.4; // any reasonably wide image counts as grid
      if (!isGrid) {
        this.log(`[CINEMATIC] Grid dimension check FAILED: ${dims.width}x${dims.height} ratio=${ratio.toFixed(2)} (expected >1.4 for 16:9 grid)`, 'warn');
      }
      return isGrid;
    } catch (e) {
      this.log(`[CINEMATIC] Grid dimension check skipped: ${e.message}`, 'warn');
      return true; // don't block on read errors
    }
  }

  /**
   * Extract width + height from an image file's header bytes.
   * Supports PNG (most common Nano Banana output) and JPEG.
   */
  _extractImageDimensions(buf, bytesRead, filePath) {
    // PNG: signature \x89PNG\r\n\x1a\n then IHDR chunk at offset 16-24
    // width is 4 big-endian bytes at offset 16, height at offset 20.
    if (bytesRead >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    // JPEG: scan for SOF0/SOF2 markers (FFC0 / FFC2) — height/width follow
    if (bytesRead >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let i = 2;
      while (i < bytesRead - 8) {
        if (buf[i] === 0xFF && (buf[i + 1] === 0xC0 || buf[i + 1] === 0xC2)) {
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          if (width > 0 && height > 0) return { width, height };
        }
        // skip past the segment length
        if (buf[i] === 0xFF && buf[i + 1] >= 0xD0 && buf[i + 1] <= 0xD9) {
          i += 2;
        } else if (buf[i] === 0xFF) {
          const segLen = buf.readUInt16BE(i + 2);
          i += 2 + segLen;
        } else {
          i++;
        }
      }
    }
    return null;
  }

  /**
   * Generate the 4-column character reference grid for a character using
   * Nano Banana Pro with the portrait as a reference image. Uses the grid
   * template prompt from IMPROVEMENT-CINEMATIC-WORKFLOW.md.
   *
   * Returns the generated grid's file path.
   */
  async _generateCharacterGrid(character, portraitPath, outputPath, portraitCdnUrl = '') {
    const prompt = `Create a professional character reference sheet for the attached portrait. Match the current appearance. Plain background. Arrange into four vertical columns, each representing one viewing angle. Each column contains a full-body view on top and a matching close-up portrait directly beneath it. Columns (left → right): Column 1: front view (full body character, front portrait below). Column 2: left profile (full body character facing left, with portrait facing left below). Column 3: right profile (full body character facing right, with portrait facing right below). Column 4: back view (full body character, back of head portrait below). Maintain even spacing and framing around the character portraits. Clean silhouette, consistent alignment, and clean panel separation. Photorealistic, DSLR, muted tones. No text. Single thin borders.`;
    return await this._withSessionRetry(
      () => this.automation.generateImage({
        prompt,
        outputPath,
        references: [portraitPath],
        aspectRatio: '16:9',
        referenceCdnUrl: portraitCdnUrl,
      }),
      `grid ${character.id}`
    );
  }

  /**
   * Create (or restore) the Higgsfield Cinema Studio project.
   *
   * Called BEFORE portrait approval so a valid project ID exists before any
   * element or scene work begins. Idempotent: if a project ID already exists
   * on state or in DB for this pipeline run, it's reused — no duplicate.
   *
   * On fresh runs:  creates a new project via the + button, persists the ID.
   * On resume:      loads the ID from DB settings, navigates to confirm it.
   */
  async _ensureCinematicProject(projectId) {
    const { CinemaStudioAutomation } = require('../automation/cinema-studio-automation');

    // ── ONE-TIME DATA FIX: swap stale project ID → blank project ──
    // Remove this block after the current run completes successfully.
    const STALE_PROJECT_ID = '4406ba87-4089-41ac-b699-61cbb20de2da';
    const BLANK_PROJECT_ID = 'c5217bbd-f436-4b54-a3ae-61a7d28d3aa9';
    if (this.state.higgsfield_project_id === STALE_PROJECT_ID) {
      this.log(`[CINEMATIC] DATA FIX: replacing stale project ${STALE_PROJECT_ID} → blank project ${BLANK_PROJECT_ID}`);
      this.state.higgsfield_project_id = BLANK_PROJECT_ID;
      this.state.cinematicElementNames = null; // elements must be re-created in new project
      try {
        const proj = db.getProject(projectId);
        const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
        settings.higgsfield_cinema_project_id = BLANK_PROJECT_ID;
        db.updateProject(projectId, { settings });
        this.log(`[CINEMATIC] DATA FIX: DB updated — project ID now ${BLANK_PROJECT_ID}`);
      } catch (_) {}
    }

    // ── RESTORE from DB if not on state (app restart) ──
    if (!this.state.higgsfield_project_id) {
      try {
        const proj = db.getProject(projectId);
        const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
        if (settings.higgsfield_cinema_project_id) {
          // Check if the restored ID is the stale one
          if (settings.higgsfield_cinema_project_id === STALE_PROJECT_ID) {
            this.log(`[CINEMATIC] DATA FIX: DB had stale project — replacing with ${BLANK_PROJECT_ID}`);
            settings.higgsfield_cinema_project_id = BLANK_PROJECT_ID;
            db.updateProject(projectId, { settings });
          }
          this.state.higgsfield_project_id = settings.higgsfield_cinema_project_id;
          this.log(`[CINEMATIC] Restored Higgsfield project ID from DB: ${settings.higgsfield_cinema_project_id}`);
        }
      } catch (_) {}
    }

    // Already have a project — nothing to do
    if (this.state.higgsfield_project_id) {
      this.log(`[CINEMATIC] Higgsfield project already exists: ${this.state.higgsfield_project_id}`);
      return;
    }

    // ── CREATE NEW PROJECT ──
    this.log('[CINEMATIC] Creating Higgsfield Cinema Studio project (pre-approval)...');
    const titleInitials = this._titleInitials(this.state.selectedTitle || this.state.script?.title);

    try {
      await this.automation.ensureBrowser();
    } catch (e) {
      this.log(`[CINEMATIC] ensureBrowser failed: ${e.message} — project creation deferred to element stage`, 'warn');
      return;
    }

    const cinemaStudio = new CinemaStudioAutomation({
      automation: this.automation,
      logger: (m) => this.log(`[CINEMATIC] ${m}`),
      projectId: null,  // force new project creation
    });

    try {
      await cinemaStudio.ensureProject(titleInitials.toUpperCase());
      await cinemaStudio._ensureCinemaStudioActive();
      await cinemaStudio._setupToolbarSequence('16:9');
    } catch (e) {
      this.log(`[CINEMATIC] Project creation failed: ${e.message.split('\n')[0]} — will retry in element stage`, 'warn');
      return;
    }

    // Persist to state + DB
    if (cinemaStudio._projectId) {
      this.state.higgsfield_project_id = cinemaStudio._projectId;
      this.log(`[CINEMATIC] Higgsfield project ID: ${cinemaStudio._projectId}`);

      try {
        const proj = db.getProject(projectId);
        const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
        settings.higgsfield_cinema_project_id = cinemaStudio._projectId;
        db.updateProject(projectId, { settings });
        this.log(`[CINEMATIC] Higgsfield project ID saved to DB: ${cinemaStudio._projectId}`);
      } catch (e) {
        this.log(`[CINEMATIC] WARN: Could not persist project ID to DB: ${e.message}`, 'warn');
      }
    }
  }

  /**
   * Cinematic element setup stage (Phase 2).
   *
   * Generates character grids for each character in the bible, then creates
   * Higgsfield Character elements via the HiggsfieldElements automation
   * module. On automation failure, surfaces a manual checklist and pauses at
   * an approval gate so the user can finish element creation in Higgsfield's
   * UI and resume.
   *
   * Idempotent on resume: already-generated grids are skipped; already-
   * existing elements are skipped.
   */
  async _runCinematicElementSetup(projectId, projectDir) {
    const fs = require('fs');
    const path = require('path');
    const characters = this.state.script?.character_bible || [];
    if (characters.length === 0) {
      this.log('[CINEMATIC] No characters in bible — skipping element setup');
      return;
    }

    // ── ONE-TIME DATA FIX: swap stale project ID → blank project ──
    // Remove this block after the current run completes successfully.
    const STALE_PROJECT_ID = '4406ba87-4089-41ac-b699-61cbb20de2da';
    const BLANK_PROJECT_ID = 'c5217bbd-f436-4b54-a3ae-61a7d28d3aa9';
    let projectSwapped = false;
    try {
      const proj = db.getProject(projectId);
      const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
      if (settings.higgsfield_cinema_project_id === STALE_PROJECT_ID) {
        settings.higgsfield_cinema_project_id = BLANK_PROJECT_ID;
        db.updateProject(projectId, { settings });
        projectSwapped = true;
        this.log(`[CINEMATIC] DATA FIX: swapped stale project ${STALE_PROJECT_ID} → ${BLANK_PROJECT_ID} in DB`);
      }
    } catch (_) {}
    if (this.state.higgsfield_project_id === STALE_PROJECT_ID) {
      this.state.higgsfield_project_id = BLANK_PROJECT_ID;
      projectSwapped = true;
      this.log(`[CINEMATIC] DATA FIX: swapped stale project on state → ${BLANK_PROJECT_ID}`);
    }
    // CRITICAL: if project changed, elements must be re-created in the new project.
    // Clear cinematicElementNames so the idempotency gate doesn't skip element setup.
    if (projectSwapped) {
      this.state.cinematicElementNames = null;
      this.log('[CINEMATIC] DATA FIX: cleared cinematicElementNames — elements must be re-created in new project');
    }

    // ── RESTORE cinematicElementNames from DB on resume ──
    // cinematicElementNames only lives in memory. On app restart it's lost,
    // so rebuild from portrait assets before the idempotency gate fires.
    let restoredFromDb = false;
    let restoredSuffix = null; // suffix from existing DB entries for consistency
    if (!this.state.cinematicElementNames || Object.keys(this.state.cinematicElementNames).length === 0) {
      const portraitAssets = db.getAssets(projectId, { type: 'portrait' })
        .filter(a => a.element_name);
      if (portraitAssets.length > 0) {
        restoredFromDb = true;
        this.state.cinematicElementNames = {};
        for (const a of portraitAssets) {
          const name = a.element_name; // suffixed name e.g. "son_emeka_bpdr_0419"
          this.state.cinematicElementNames[name] = name;
          this.state.cinematicElementNames[`@${name}`] = name;
          // Derive base name by stripping the suffix pattern (_xxxx_MMDD)
          // This allows blocking @mentions (which use base names) to resolve
          const baseMatch = name.match(/^(.+)_[a-z]{2,5}_\d{4}$/);
          if (baseMatch) {
            this.state.cinematicElementNames[baseMatch[1]] = name;
            this.state.cinematicElementNames[`@${baseMatch[1]}`] = name;
            // Extract suffix for consistency — all elements in a project should
            // share the same suffix even if resumed on a different day
            if (!restoredSuffix) {
              restoredSuffix = name.slice(baseMatch[1].length + 1); // e.g. "bpdr_0419"
            }
          }
          const char = characters.find(c => c.element_name_hint === name ||
            (baseMatch && c.element_name_hint === baseMatch[1]) ||
            c.id === a.character_id);
          if (char) {
            this.state.cinematicElementNames[char.id] = name;
            // Also index by element_name_hint (base name from script)
            if (char.element_name_hint) {
              const hint = char.element_name_hint.toLowerCase().replace(/^@/, '');
              this.state.cinematicElementNames[hint] = name;
              this.state.cinematicElementNames[`@${hint}`] = name;
            }
            if (char.description_label) {
              const labelSlug = char.description_label
                .toLowerCase()
                .replace(/^(the|a|an)\s+/i, '')
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '');
              if (labelSlug) this.state.cinematicElementNames[labelSlug] = name;
            }
          }
        }
        this.log(`[CINEMATIC] Restored cinematicElementNames from DB on resume: ${portraitAssets.map(a => a.element_name).join(', ')}`);
        if (restoredSuffix) {
          this.log(`[CINEMATIC] Extracted suffix from DB entries: _${restoredSuffix} (will reuse for consistency)`);
        }

        // ── LAYER 1: COUNT CHECK ──
        // If fewer elements were stored in DB than characters in bible,
        // the element stage was incomplete. Clear and fall through to
        // re-create all elements (the @ button pre-check below will skip
        // any that still exist in Higgsfield).
        const restoredCount = portraitAssets.length;
        if (restoredCount < characters.length) {
          this.log(`[CINEMATIC] COUNT MISMATCH: DB has ${restoredCount} element names but bible has ${characters.length} characters — element stage was incomplete, re-running`);
          this.state.cinematicElementNames = null;
          // restoredSuffix is preserved so new elements use the same suffix
        }
      }
    }

    // ── PROJECT MATCH CHECK ──
    // Elements are project-specific in Higgsfield. If the project ID changed
    // (e.g. user provided a different project), elements must be re-created
    // even if cinematicElementNames is populated from a prior project.
    if (this.state.cinematicElementNames && Object.keys(this.state.cinematicElementNames).length > 0 &&
        this.state._elementsCreatedForProject && this.state.higgsfield_project_id &&
        this.state._elementsCreatedForProject !== this.state.higgsfield_project_id) {
      this.log(`[CINEMATIC] Project mismatch! Elements created for ${this.state._elementsCreatedForProject} but current project is ${this.state.higgsfield_project_id} — re-creating elements`);
      this.state.cinematicElementNames = null;
    }

    // ── VERIFIED IDEMPOTENCY GATE ──
    // If element names are on state (from DB restore or prior run), verify
    // they ACTUALLY EXIST in Higgsfield before skipping. Elements may have
    // been deleted manually from the Higgsfield UI.
    if (this.state.cinematicElementNames && Object.keys(this.state.cinematicElementNames).length > 0) {
      // Restore Higgsfield project ID from DB if not on state (app restart loses in-memory state)
      if (!this.state.higgsfield_project_id) {
        try {
          const proj = db.getProject(projectId);
          const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
          if (settings.higgsfield_cinema_project_id) {
            this.state.higgsfield_project_id = settings.higgsfield_cinema_project_id;
            this.log(`[CINEMATIC] Restored Higgsfield project ID from DB: ${settings.higgsfield_cinema_project_id}`);
          }
        } catch (_) {}
      }

      if (!this.state.higgsfield_project_id) {
        this.log(`[CINEMATIC] WARN: element names exist but no Higgsfield project ID found — cannot verify, re-running element setup`, 'warn');
        this.state.cinematicElementNames = null;
      } else {
        // ── LAYER 2: HIGGSFIELD VERIFICATION ──
        // Open browser, navigate to project, check @ button for actual elements.
        // Only runs on resume (restoredFromDb=true) to avoid slowing down first runs.
        if (restoredFromDb) {
          this.log(`[CINEMATIC] Verifying restored elements actually exist in Higgsfield...`);
          let verificationPassed = false;
          try {
            await this.automation.ensureBrowser();
            const { CinemaStudioAutomation } = require('../automation/cinema-studio-automation');
            const verifyCinema = new CinemaStudioAutomation({
              automation: this.automation,
              logger: (m) => this.log(`[CINEMATIC] ${m}`),
              projectId: this.state.higgsfield_project_id,
            });

            // Navigate to project and set up toolbar minimally for @ button
            const titleInitials = this._titleInitials(this.state.selectedTitle || this.state.script?.title);
            await verifyCinema.ensureProject(titleInitials.toUpperCase());
            await verifyCinema._ensureCinemaStudioActive();
            await verifyCinema._setupToolbarSequence('16:9');

            // Get the unique suffixed element names (not base names, not char IDs)
            const storedNames = [...new Set(Object.values(this.state.cinematicElementNames))];
            this.log(`[CINEMATIC] Checking @ button for ${storedNames.length} element(s): ${storedNames.map(n => '@' + n).join(', ')}`);

            const elementCheck = await verifyCinema._verifyElementsViaAtButton(storedNames);
            if (elementCheck.missing.length === 0) {
              this.log(`[CINEMATIC] ✓ All ${storedNames.length} elements verified in Higgsfield — skipping element setup`);
              verificationPassed = true;
            } else {
              this.log(`[CINEMATIC] MISSING from Higgsfield: ${elementCheck.missing.map(n => '@' + n).join(', ')} — re-running element setup`);
              this.state.cinematicElementNames = null;
              // restoredSuffix preserved for consistent naming
            }
          } catch (verifyErr) {
            this.log(`[CINEMATIC] Verification failed: ${verifyErr.message.split('\n')[0]} — re-running element setup to be safe`, 'warn');
            this.state.cinematicElementNames = null;
          }

          if (verificationPassed) {
            this.log(`[CINEMATIC] Using persisted Higgsfield project ID: ${this.state.higgsfield_project_id}`);
            return;
          }
        } else {
          // Not restored from DB (was already on state from current run) — trust it
          this.log(`[CINEMATIC] Element names already on state (${Object.keys(this.state.cinematicElementNames).length} keys) — skipping element setup`);
          this.log(`[CINEMATIC] Using persisted Higgsfield project ID: ${this.state.higgsfield_project_id}`);
          return;
        }
      }
    }

    const titleInitials = this._titleInitials(this.state.selectedTitle || this.state.script?.title);
    this.log(`[CINEMATIC] Project initials: ${titleInitials} (used for project name, not element names)`);

    // ── Phase 2A: generate character grids ──
    const gridDir = path.join(projectDir, 'assets', 'grids');
    fs.mkdirSync(gridDir, { recursive: true });

    // Check the DB for existing grid assets (survive crashes / resume)
    const existingGrids = db.getAssets(projectId, { type: 'character_grid' });
    const gridMap = {};
    for (const g of existingGrids) {
      if (g.status === 'done' && g.file_path && fs.existsSync(g.file_path)) {
        gridMap[g.character_id] = g.file_path;
      }
    }

    // SETTLE GATE: Higgsfield's gallery URL listing can lag the actual asset
    // creation by 5-15 seconds. The portrait stage marks "done" as soon as
    // each portrait downloads, but the LAST portrait's CDN URL may still be
    // propagating into the gallery view when we reach this point. If we click
    // Generate on the first grid before that propagation finishes, the new-URL
    // detection in waitForGeneration() will see the late-arriving portrait
    // URL as a "new" generation and mis-attribute it to grid 1.
    //
    // The fix that bit us in the wild on Session 8: poll the gallery for ~10s
    // BEFORE starting grid 1. If the gallery URL count keeps rising during the
    // poll window, more late-arriving URLs are still propagating. Stop polling
    // when the count is stable for 2 consecutive checks.
    if (Object.keys(gridMap).length < characters.length) {
      this.log('[CINEMATIC] Pre-grid settle: waiting for portrait stage CDN URLs to fully propagate to gallery...');
      try {
        await this._settleHiggsfieldGallery({ stableSamples: 2, maxWaitMs: 15000 });
      } catch (e) {
        this.log(`[CINEMATIC] Settle warn: ${e.message} — continuing anyway`, 'warn');
      }
    }

    for (let i = 0; i < characters.length; i++) {
      const char = characters[i];
      this.emit({ type: 'progress', stage: 'elements-grids', current: i + 1, total: characters.length });
      if (gridMap[char.id]) {
        this.log(`[CINEMATIC] Grid for ${char.id} already exists — skipping`);
        continue;
      }
      // Find portrait file on disk
      const portraitAsset = db.getAssets(projectId, { type: 'portrait' })
        .find(p => p.character_id === char.id && p.status === 'done' && p.file_path);
      if (!portraitAsset) {
        this.log(`[CINEMATIC] WARN: no portrait for ${char.id} — can't generate grid`, 'warn');
        continue;
      }
      const gridPath = path.join(gridDir, `${char.id}_grid.png`);
      // Insert asset row if not present, then mark generating
      let gridAsset = existingGrids.find(g => g.character_id === char.id);
      if (!gridAsset) {
        db.insertExpectedAssets(projectId, [{ type: 'character_grid', character_id: char.id }]);
        gridAsset = db.getAssets(projectId, { type: 'character_grid' }).find(g => g.character_id === char.id);
      }
      if (!gridAsset) {
        this.log(`[CINEMATIC] Couldn't create grid asset row for ${char.id} — skipping`, 'warn');
        continue;
      }
      // Retry up to 2 attempts per grid — strict gate below will halt if still failed
      const MAX_GRID_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_GRID_ATTEMPTS; attempt++) {
        try {
          db.markAssetGenerating(gridAsset.id, 'character-grid-generation');
          this.log(`[CINEMATIC] Generating grid for ${char.id} (${char.description_label || '?'})${attempt > 1 ? ` [retry ${attempt}/${MAX_GRID_ATTEMPTS}]` : ''}`);
          const genMeta = await this._generateCharacterGrid(char, portraitAsset.file_path, gridPath, portraitAsset.cdn_url || '');

          const dimsOk = await this._verifyGridDimensions(gridPath);
          if (!dimsOk) {
            this.log(`[CINEMATIC] Grid for ${char.id} downloaded with WRONG dimensions. ${attempt < MAX_GRID_ATTEMPTS ? 'Retrying...' : 'All attempts exhausted.'}`, 'warn');
            db.markAssetFailed(gridAsset.id, 'wrong-dimensions: aspect ratio doesn\'t match expected 16:9 grid');
            if (attempt < MAX_GRID_ATTEMPTS) continue; // retry
            break; // exhausted
          }

          db.markAssetDone(gridAsset.id, gridPath, genMeta);
          gridMap[char.id] = gridPath;
          break; // success
        } catch (e) {
          this.log(`[CINEMATIC] Grid gen failed for ${char.id} (attempt ${attempt}/${MAX_GRID_ATTEMPTS}): ${e.message}`, 'warn');
          db.markAssetFailed(gridAsset.id, e.message);
          if (attempt < MAX_GRID_ATTEMPTS) {
            this.log(`[CINEMATIC] Waiting 5s before retry...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
    }

    // ── STRICT GATE: all grids must be complete before proceeding ──
    const failedGrids = db.getAssets(projectId, { type: 'character_grid' })
      .filter(a => a.status !== 'done');
    if (failedGrids.length > 0) {
      const names = failedGrids.map(g => g.character_id || g.id).join(', ');
      throw new Error(`[STAGE GATE] Cannot proceed — ${failedGrids.length} character grid(s) incomplete: ${names}. Fix the issue and restart the pipeline.`);
    }
    this.log(`[CINEMATIC] ✓ All ${characters.length} character grid(s) verified — proceeding to element creation`);

    // ── Phase 2B: create character elements ──
    // ⚠️ DESIGN INTENT: element creation MUST be automated. The manual
    // checklist that fires when this loop fails is a FALLBACK for diagnosis
    // — not the default path. Session 8 first run had all 3 elements fall
    // through to manual; that's a regression to investigate, not the
    // intended behavior. If you see manual checklists firing routinely,
    // priority work is in HiggsfieldElements._createElement (selectors,
    // filechooser interception, click reliability) — see backlog in
    // CLAUDE.md and IMPROVEMENT-CINEMATIC-WORKFLOW.md.
    const { HiggsfieldElements } = require('../automation/higgsfield-elements');
    const { CinemaStudioAutomation } = require('../automation/cinema-studio-automation');
    // Reuse the project created by _ensureCinematicProject (called before
    // portrait approval). If it wasn't created yet (e.g. browser failed
    // during early creation), fall back to creating here.
    const cinemaStudio = new CinemaStudioAutomation({
      automation: this.automation,
      logger: (m) => this.log(`[CINEMATIC] ${m}`),
      projectId: this.state.higgsfield_project_id || null,
    });
    const elements = new HiggsfieldElements({
      automation: this.automation,
      logger: (m) => this.log(`[CINEMATIC] ${m}`),
      cinemaStudio,
    });
    // Pass project name so Elements panel navigation can ensure a project is selected
    elements.setProjectName(titleInitials.toUpperCase());

    // CRITICAL: open Playwright browser BEFORE any element operation.
    try {
      await this.automation.ensureBrowser();
      this.log('[CINEMATIC] Browser ready for element automation');
    } catch (e) {
      this.log(`[CINEMATIC] ensureBrowser failed: ${e.message} — element creation will fall back to manual`, 'warn');
    }

    // ── CORRECT ORDER: project → Image → Cinematic Cameras → @ button check ──
    // The project should already exist (created by _ensureCinematicProject before
    // portrait approval). ensureProject() navigates to it if a projectId was
    // passed, or creates a new one as fallback if the early creation failed.
    this.log('[CINEMATIC] Setting up Cinema Studio: project → Image → Cinematic Cameras...');
    try {
      await cinemaStudio.ensureProject(titleInitials.toUpperCase());
      // Capture project ID if it was just created (fallback path)
      if (!this.state.higgsfield_project_id && cinemaStudio._projectId) {
        this.state.higgsfield_project_id = cinemaStudio._projectId;
        this.log(`[CINEMATIC] Project created in element stage (fallback): ${cinemaStudio._projectId}`);
        try {
          const proj = db.getProject(projectId);
          const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
          settings.higgsfield_cinema_project_id = cinemaStudio._projectId;
          db.updateProject(projectId, { settings });
        } catch (_) {}
      }
      await cinemaStudio._ensureCinemaStudioActive();
      const setupOk = await cinemaStudio._setupToolbarSequence('16:9');
      if (!setupOk) {
        this.log('[CINEMATIC] WARN: Toolbar setup failed — will attempt element creation without pre-check', 'warn');
      }
    } catch (setupErr) {
      this.log(`[CINEMATIC] WARN: Cinema Studio setup failed: ${setupErr.message.split('\n')[0]} — continuing`, 'warn');
    }

    // ══════════════════════════════════════════════════════════
    // ONE NAME TO RULE THEM ALL
    // ══════════════════════════════════════════════════════════
    // The element_name_hint from the character bible IS the single authoritative
    // name used everywhere: Higgsfield element creation, blocking prompts,
    // kling_clips, scene gen @references, characters_present arrays.
    //
    // Priority for deriving the element name:
    //   1. char.element_name_hint  (explicit, from script prompt schema)
    //   2. Slug of char.description_label (fallback for older scripts)
    //   3. char.id (last resort, e.g. "character_1")
    //
    // The name must match exactly what appears as @mentions in blocking text,
    // characters_present, and kling_clips. No translation layer.

    const script = this.state.script;
    const pending = [];

    // Generate unique suffix to avoid Higgsfield element name collisions
    // across projects. Format: {acronym}_{MMDD} e.g. "bpdr_0419".
    // Priority: 1) state.elementSuffix (persisted in DB settings at creation)
    //           2) DB settings.element_name_suffix (belt-and-suspenders re-read)
    //           3) restoredSuffix (extracted from existing DB portrait entries)
    //           4) fresh from _elementSuffix() (only on first ever run)
    // This prevents date rollover bugs when pipeline resumes after midnight.

    // Belt-and-suspenders: if state.elementSuffix wasn't set during resume,
    // re-read directly from DB here as a last resort before falling through
    // to a fresh (date-based) suffix. This catches cases where the resume
    // restore path didn't execute (e.g. first launch after code update).
    if (!this.state.elementSuffix) {
      try {
        const rawS = db.getProject(projectId)?.settings;
        const parsedS = rawS ? (typeof rawS === 'string' ? JSON.parse(rawS) : rawS) : {};
        if (parsedS.element_name_suffix) {
          this.state.elementSuffix = parsedS.element_name_suffix;
          this.log(`[CINEMATIC] Restored element suffix from DB (direct read): _${parsedS.element_name_suffix}`);
        }
      } catch (_) {}
    }

    const elementSuffix = this.state.elementSuffix || restoredSuffix || this._elementSuffix(this.state.selectedTitle || this.state.script?.title);
    const suffixSource = this.state.elementSuffix ? 'from DB settings' : (restoredSuffix ? 'from DB portrait entries' : 'fresh');
    this.log(`[CINEMATIC] Element name suffix: _${elementSuffix} (${suffixSource})`);

    // Persist suffix to DB settings so it survives restarts and date rollovers
    if (!this.state.elementSuffix) {
      this.state.elementSuffix = elementSuffix;
      try {
        const rawSettings = db.getProject(projectId)?.settings;
        const settings = rawSettings ? (typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings) : {};
        settings.element_name_suffix = elementSuffix;
        db.updateProject(projectId, { settings: JSON.stringify(settings) });
        this.log(`[CINEMATIC] Element suffix persisted to DB: _${elementSuffix}`);
      } catch (e) {
        this.log(`[CINEMATIC] Failed to persist element suffix: ${e.message}`, 'warn');
      }
    }

    for (const char of characters) {
      // Derive the base element name
      let baseName = null;

      // Priority 1: explicit element_name_hint from script
      if (char.element_name_hint) {
        baseName = char.element_name_hint.toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
      }

      // Priority 2: slug from description_label
      if (!baseName) {
        const label = (char.description_label || '').toLowerCase()
          .replace(/^(the|a|an)\s+/i, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (label && label !== 'unknown') baseName = label;
      }

      // Priority 3: char.id as last resort
      if (!baseName) {
        baseName = (char.id || '').toLowerCase().replace(/^@/, '');
      }

      if (!baseName) {
        this.log(`[CINEMATIC] WARN: could not derive element name for ${char.id} — skipping`, 'warn');
        continue;
      }

      // Append project suffix to avoid cross-project name collisions
      // e.g. "son_emeka" → "son_emeka_bpdr_0419"
      const elementName = `${baseName}_${elementSuffix}`;

      const portraitPath = (db.getAssets(projectId, { type: 'portrait' })
        .find(p => p.character_id === char.id))?.file_path;
      if (!portraitPath) {
        this.log(`[CINEMATIC] WARN: no portrait for ${char.id} (${char.description_label}) — skipping element`, 'warn');
        continue;
      }

      this.log(`[CINEMATIC] @${elementName} (base: ${baseName}) → ${char.description_label} (${char.id})`);
      pending.push({
        char,
        name: elementName,
        baseName,
        portraitPath,
        gridPath: gridMap[char.id] || null,
        description: char.full_prompt_description || char.description_label,
      });
    }

    // Verify: cross-check that blocking text @mentions match derived element names
    const elementNames = new Set(pending.map(p => p.name));
    const blockingMentions = new Set();
    for (const ch of script.chapters || []) {
      for (const sc of ch.scenes || []) {
        const b = sc.blocking || {};
        for (const text of [b.frame_left, b.frame_center, b.frame_right, b.notes]) {
          if (typeof text !== 'string') continue;
          const matches = text.match(/@([a-z0-9_]+)/gi) || [];
          matches.forEach(m => blockingMentions.add(m.slice(1).toLowerCase()));
        }
      }
    }
    const unmatchedMentions = [...blockingMentions].filter(m => !elementNames.has(m));
    if (unmatchedMentions.length > 0) {
      this.log(`[CINEMATIC] WARN: blocking text has @mentions not matching any element: ${unmatchedMentions.map(m => '@' + m).join(', ')}. Available elements: ${[...elementNames].map(n => '@' + n).join(', ')}`, 'warn');
    } else {
      this.log(`[CINEMATIC] ✓ All blocking @mentions match element names: ${[...elementNames].map(n => '@' + n).join(', ')}`);
    }

    // ── @ BUTTON PRE-CHECK: which elements already exist? ──
    // The toolbar is already in Image + Cinematic Cameras mode (set up above).
    // Click the @ button to see all available elements. Skip creating any
    // that are already in the dropdown — saves time and avoids duplicates.
    let existingElements = new Set();
    try {
      const allNames = pending.map(p => p.name);
      this.log(`[CINEMATIC] Checking @ button for existing elements: ${allNames.map(n => '@' + n).join(', ')}`);
      const elementCheck = await cinemaStudio._verifyElementsViaAtButton(allNames);
      for (const name of elementCheck.available) {
        existingElements.add(name.toLowerCase().trim());
      }
      this.log(`[CINEMATIC] @ button found ${elementCheck.available.length} existing, ${elementCheck.missing.length} missing`);
    } catch (checkErr) {
      this.log(`[CINEMATIC] @ button pre-check failed: ${checkErr.message.split('\n')[0]} — will try creating all`, 'warn');
    }

    // Filter: only create elements that are NOT in the @ dropdown
    const actuallyPending = [];
    let preSkipped = 0;
    for (const p of pending) {
      if (existingElements.has(p.name.toLowerCase().trim())) {
        this.log(`[CINEMATIC] @${p.name} already exists (@ button confirmed) — skipping creation`);
        preSkipped++;
      } else {
        actuallyPending.push(p);
      }
    }
    if (preSkipped > 0) {
      this.log(`[CINEMATIC] ${preSkipped} element(s) already exist, ${actuallyPending.length} to create`);
    }

    let automationFailure = null;
    let createdCount = 0;
    let skippedCount = preSkipped;

    try {
      for (let idx = 0; idx < actuallyPending.length; idx++) {
        const p = actuallyPending[idx];
        this.emit({ type: 'progress', stage: 'elements-create', current: idx + 1, total: actuallyPending.length });

        // ── Inter-element wait ──
        // Give the UI time to settle between element creations.
        // First element starts immediately; subsequent ones wait 5s.
        if (idx > 0) {
          this.log(`[CINEMATIC] Waiting 5s before creating next element (@${p.name})...`);
          await new Promise(r => setTimeout(r, 5000));
        }

        try {
          const result = await elements.createCharacterElement({
            name: p.name,
            portraitPath: p.portraitPath,
            gridPath: p.gridPath,
            description: p.description,
          });
          if (result.created) {
            createdCount++;
            // ── Post-creation confirmation via @ button ──
            // Wait and verify the element actually exists using the authoritative
            // @ button check (types @name in prompt, checks autocomplete dropdown)
            this.log(`[CINEMATIC] Element @${p.name} created — waiting 3s then confirming via @ button...`);
            await new Promise(r => setTimeout(r, 3000));
            try {
              const atCheck = await cinemaStudio._verifyElementsViaAtButton([p.name]);
              if (atCheck.available.length > 0) {
                this.log(`[CINEMATIC] ✓ Element @${p.name} confirmed via @ button`);
              } else {
                this.log(`[CINEMATIC] Warn: @${p.name} not confirmed via @ button — trusting Save success`);
              }
            } catch (verifyErr) {
              this.log(`[CINEMATIC] @ button verification skipped for @${p.name}: ${verifyErr.message}`);
            }
          } else {
            skippedCount++;
          }
        } catch (e) {
          // Per-element failure — but the element may have been created despite
          // the automation error (e.g. setInputFiles didn't trigger React, but
          // the element was saved anyway via a prior attempt or manual action).
          this.log(`[CINEMATIC] Element creation failed for @${p.name}: ${e.message}`, 'warn');

          // Wait before checking — give Higgsfield time to process
          await new Promise(r => setTimeout(r, 3000));

          // ── Authoritative @ button verification ──
          // The Elements panel scraper is unreliable (shows elements from other
          // projects, grid/list mismatch). The @ button check types the full
          // @name in the Cinema Studio prompt box and checks the autocomplete
          // dropdown — this is the ground truth the user trusts.
          let existsAnyway = false;
          try {
            this.log(`[CINEMATIC] Running @ button verification for @${p.name} after creation failure...`);
            const atCheck = await cinemaStudio._verifyElementsViaAtButton([p.name]);
            existsAnyway = atCheck.available.length > 0;
            if (existsAnyway) {
              this.log(`[CINEMATIC] ✓ @ button confirms @${p.name} EXISTS despite creation error — counting as skipped`);
            } else {
              this.log(`[CINEMATIC] ✗ @ button confirms @${p.name} does NOT exist — creation truly failed`);
            }
          } catch (verifyErr) {
            this.log(`[CINEMATIC] @ button verification failed for @${p.name}: ${verifyErr.message}`, 'warn');
            // Fall back to panel scraper as last resort
            try {
              elements.invalidateCache();
              existsAnyway = await elements.elementExists(p.name);
              if (existsAnyway) {
                this.log(`[CINEMATIC] Panel scraper fallback: @${p.name} found — counting as skipped`);
              }
            } catch (_) {}
          }

          if (existsAnyway) {
            skippedCount++;
          } else {
            if (!automationFailure) automationFailure = e;
          }
        }
      }
    } catch (e) {
      // Catastrophic automation failure (e.g. panel didn't open at all)
      automationFailure = e;
    }

    this.log(`[CINEMATIC] Element setup: ${createdCount} created, ${skippedCount} already existed, ${pending.length - createdCount - skippedCount} failed (of ${pending.length} total)`);

    // Determine if we should proceed or gate.
    // Primary signal: creation results (created + skipped = all handled).
    // The scraper-based verification is unreliable (grid view vs list view
    // mismatch) so we trust the per-element Save success as the source of truth.
    const failedCount = pending.length - createdCount - skippedCount;

    if (failedCount > 0 && automationFailure) {
      // Some elements truly failed (Save threw, form stayed open, etc.)
      const failedElements = actuallyPending.filter(p => !existingElements.has(p.name.toLowerCase().trim()));
      const checklist = HiggsfieldElements.buildManualChecklist(failedElements);
      this.log(checklist, 'warn');
      this.emit({ type: 'cinematic-manual-element-checklist', pending: failedElements.map(p => ({ name: p.name, description: p.description })) });

      this.state.status = 'waiting_approval';
      this.emit({ type: 'waiting', gate: 'elements-ready' });
      this.log(`[CINEMATIC] ${failedCount} element(s) failed — waiting for manual creation or "Elements Ready" click`);

      await this.waitForApproval('elements-ready');

      // ── Post-approval @ button re-verification ──
      // User clicked "Elements Ready" — verify ALL elements actually exist
      // before spending credits on locations/scenes.
      this.log('[CINEMATIC] ✓ Element gate resolved — running @ button re-verification on ALL elements...');
      const allNames = pending.map(p => p.name);
      try {
        const recheck = await cinemaStudio._verifyElementsViaAtButton(allNames);
        if (recheck.missing.length > 0) {
          this.log(`[CINEMATIC] ⚠ Post-approval check: ${recheck.missing.length} element(s) STILL missing: ${recheck.missing.map(n => '@' + n).join(', ')}`, 'warn');
          this.emit({ type: 'cinematic-manual-element-checklist', pending: recheck.missing.map(n => ({ name: n, description: '' })) });

          // Re-gate — don't proceed with missing elements
          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'elements-ready' });
          this.log(`[CINEMATIC] ${recheck.missing.length} element(s) still missing — waiting again for "Elements Ready" click`);
          await this.waitForApproval('elements-ready');

          // Second check — if still missing, log warning but proceed (user explicitly confirmed twice)
          const recheck2 = await cinemaStudio._verifyElementsViaAtButton(allNames);
          if (recheck2.missing.length > 0) {
            this.log(`[CINEMATIC] ⚠ Still ${recheck2.missing.length} missing after 2nd approval — proceeding on user authority: ${recheck2.missing.map(n => '@' + n).join(', ')}`, 'warn');
          } else {
            this.log(`[CINEMATIC] ✓ All ${allNames.length} elements confirmed via @ button after 2nd approval`);
          }
        } else {
          this.log(`[CINEMATIC] ✓ All ${allNames.length} elements confirmed via @ button — proceeding`);
        }
      } catch (recheckErr) {
        this.log(`[CINEMATIC] @ button re-verification failed: ${recheckErr.message} — proceeding on user authority`, 'warn');
      }
    } else {
      // All elements created/skipped successfully — still run @ button verification
      // as a sanity check before proceeding to locations/scenes.
      this.log('[CINEMATIC] ✓ All character elements handled — running final @ button verification...');
      const allNames = pending.map(p => p.name);
      try {
        const finalCheck = await cinemaStudio._verifyElementsViaAtButton(allNames);
        if (finalCheck.missing.length > 0) {
          this.log(`[CINEMATIC] ⚠ Final check found ${finalCheck.missing.length} element(s) missing: ${finalCheck.missing.map(n => '@' + n).join(', ')}`, 'warn');
          // Gate — don't auto-proceed with missing elements
          this.emit({ type: 'cinematic-manual-element-checklist', pending: finalCheck.missing.map(n => ({ name: n, description: '' })) });
          this.state.status = 'waiting_approval';
          this.emit({ type: 'waiting', gate: 'elements-ready' });
          this.log(`[CINEMATIC] ${finalCheck.missing.length} element(s) missing despite creation success — waiting for "Elements Ready" click`);
          await this.waitForApproval('elements-ready');
          this.log('[CINEMATIC] ✓ Element gate resolved after final check — continuing');
        } else {
          this.log(`[CINEMATIC] ✓ All ${allNames.length} elements confirmed via @ button — proceeding to scene image generation`);
        }
      } catch (finalErr) {
        this.log(`[CINEMATIC] @ button final verification failed: ${finalErr.message} — proceeding`, 'warn');
      }
    }

    // ── CRITICAL: Switch from Elements panel to Generations view ──
    // After element setup, the UI is stuck on the Elements panel (shows element
    // list with "Add to Project", "Delete", "Save" buttons). The scene generation
    // code expects the Generations view (prompt textbox + GENERATE button).
    // The ONLY way out of the Elements panel is clicking the "Generations" tab.
    // Going home does NOT dismiss it — the panel persists across navigation.
    try {
      const resetPage = this.automation.page;
      if (resetPage && !resetPage.isClosed()) {
        this.log('[CINEMATIC] Clicking Generations tab to exit Elements panel...');
        for (let attempt = 0; attempt < 5; attempt++) {
          const clicked = await resetPage.evaluate(() => {
            const btns = document.querySelectorAll('button');
            for (const b of btns) {
              const text = b.textContent?.trim();
              const r = b.getBoundingClientRect();
              if (text === 'Generations' && r.width > 0 && r.height > 0 && r.y < window.innerHeight * 0.25) {
                b.click();
                return true;
              }
            }
            return false;
          }).catch(() => false);

          if (clicked) {
            this.log('[CINEMATIC] Generations tab clicked');
            await resetPage.waitForTimeout(3000);

            // Verify we're out of Elements panel
            const hasGenerate = await resetPage.evaluate(() => {
              return [...document.querySelectorAll('button')].some(b =>
                /^GENERATE|^Generate/.test(b.textContent?.trim() || '') && /\d/.test(b.textContent));
            }).catch(() => false);

            if (hasGenerate) {
              this.log('[CINEMATIC] ✓ Switched to Generations view — GENERATE button visible');
              break;
            }
            this.log(`[CINEMATIC] Generations clicked but GENERATE not visible yet (attempt ${attempt + 1}/5)`);
          } else {
            this.log(`[CINEMATIC] Generations tab not found (attempt ${attempt + 1}/5) — waiting...`);
          }
          await resetPage.waitForTimeout(2000);
        }
      }
    } catch (e) {
      this.log(`[CINEMATIC] Warn: Generations switch failed (non-fatal): ${e.message}`);
    }

    // Persist element names on the character's portrait asset row for
    // cross-run resolution. We use updateProjectAsset which accepts the
    // element_name + higgsfield_element_id columns added in migration 010.
    for (const p of pending) {
      const portraitAsset = db.getAssets(projectId, { type: 'portrait' })
        .find(a => a.character_id === p.char.id);
      if (portraitAsset) {
        try {
          // Direct UPDATE since updateProjectAsset doesn't allow these columns
          // (allowlist in updateProject only covers projects table fields).
          // For now we use a minimal raw update via the same connection.
          db.setAssetElementName(portraitAsset.id, p.name);
        } catch (_) {}
      }
    }

    // Stash the character-element-name mapping on state so Phase 3+ stages
    // can resolve character IDs → @element_names when composing prompts.
    //
    // The blocking text uses @charactername (e.g. "@courtney", "@mama_courage")
    // while char.id may be "@courtney", "character_1", or "courtney".
    // We index by EVERY plausible key so the lookup in _runCinematicSceneGen
    // always resolves:
    //   - char.id as-is (e.g. "@courtney" or "character_1")
    //   - char.id stripped of leading @ (e.g. "courtney")
    //   - description_label slugified (e.g. "the_mother" → "mother")
    // The map is dead simple now: the element name IS the @mention.
    // We still index by char.id and the name itself for cross-referencing,
    // but no complex slug/suffix/partial matching is needed.
    this.state.cinematicElementNames = pending.reduce((acc, p) => {
      // The element name includes the project suffix (e.g. "son_emeka_bpdr_0419")
      // but blocking text uses the base name (e.g. "@son_emeka").
      // Index by EVERY plausible key so lookups always resolve:
      acc[p.name] = p.name;                          // "son_emeka_bpdr_0419" → itself
      acc[p.char.id] = p.name;                       // "character_1" → "son_emeka_bpdr_0419"
      acc[`@${p.name}`] = p.name;                    // "@son_emeka_bpdr_0419" → itself
      // Base name (without suffix) — this is what blocking @mentions use
      if (p.baseName) {
        acc[p.baseName] = p.name;                    // "son_emeka" → "son_emeka_bpdr_0419"
        acc[`@${p.baseName}`] = p.name;              // "@son_emeka" → "son_emeka_bpdr_0419"
      }
      // description_label slug for any other lookups
      if (p.char.description_label) {
        const labelSlug = p.char.description_label
          .toLowerCase()
          .replace(/^(the|a|an)\s+/i, '')
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');
        if (labelSlug) acc[labelSlug] = p.name;
      }
      return acc;
    }, {});

    // Track which Higgsfield project these elements were created for.
    // If the project changes, the idempotency gate will invalidate and re-create.
    this.state._elementsCreatedForProject = this.state.higgsfield_project_id || cinemaStudio._projectId;

    // Persist the Higgsfield project ID so the scene-gen stage (which creates
    // a new CinemaStudioAutomation instance) can reuse the same project
    // instead of creating a duplicate or failing to find one.
    // Also save to DB so it survives app restarts.
    if (cinemaStudio._projectId) {
      this.state.higgsfield_project_id = cinemaStudio._projectId;
      this.log(`[CINEMATIC] Higgsfield project ID stashed on state: ${cinemaStudio._projectId}`);

      // Persist to DB settings JSON so we find the same project after restart
      const pid = this.state.project?.id;
      if (pid) {
        try {
          const proj = db.getProject(pid);
          const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
          settings.higgsfield_cinema_project_id = cinemaStudio._projectId;
          db.updateProject(pid, { settings });
          this.log(`[CINEMATIC] Higgsfield project ID saved to DB: ${cinemaStudio._projectId}`);
        } catch (e) {
          this.log(`[CINEMATIC] WARN: Could not persist project ID to DB: ${e.message}`);
        }
      }
    }
  }

  /**
   * Phase 3 stage: location image generation + location element creation.
   * Walks the script, collects unique location_element_hint values, generates
   * an empty location image per hint via Nano Banana Pro (no characters in
   * the image — characters are composited in by Cinema Studio 3.5 in the
   * scene-image stage), then creates a Higgsfield Location element from each.
   *
   * Idempotent on resume — checks DB for existing location_image assets and
   * Higgsfield for existing element names before regenerating/recreating.
   */
  async _runCinematicLocationSetup(projectId, projectDir) {
    const fs = require('fs');
    const path = require('path');

    const titleInitials = this._titleInitials(this.state.selectedTitle || this.state.script?.title);

    // Walk script scenes, collect unique location hints + their first scene's
    // location text/details (to build the empty-location prompt)
    const script = this.state.script;
    if (!script?.chapters?.length) {
      this.log('[CINEMATIC] No script chapters available — skipping location setup');
      return;
    }

    const locationMap = new Map(); // hint → { hint, name, prompt, description }
    for (const ch of script.chapters) {
      for (const sc of (ch.scenes || [])) {
        const hint = (sc.location_element_hint || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (!hint) continue;
        if (locationMap.has(hint)) continue;
        const elementName = `${hint}_${titleInitials}`;
        locationMap.set(hint, {
          hint,
          name: elementName,
          prompt: this._buildLocationPrompt(sc.location, sc.location_details),
          description: `${sc.location || hint}. ${sc.location_details || ''}`.slice(0, 400),
        });
      }
    }

    if (locationMap.size === 0) {
      this.log('[CINEMATIC] No location_element_hint fields in script — Phase 3 location stage skipped (script may be from before Phase 1)');
      return;
    }
    const projectAspectRatio = this.state.aspectRatio || '16:9';
    this.log(`[CINEMATIC] Phase 3: ${locationMap.size} unique location(s) to generate + register [aspect: ${projectAspectRatio}]`);

    // ── Phase 3A: generate empty location images ──
    const locDir = path.join(projectDir, 'assets', 'locations');
    fs.mkdirSync(locDir, { recursive: true });

    // Existing location_image assets from prior runs
    const existingLocAssets = db.getAssets(projectId, { type: 'location_image' });
    const locImagePaths = {}; // hint → file_path

    let idx = 0;
    for (const [hint, loc] of locationMap.entries()) {
      idx++;
      this.emit({ type: 'progress', stage: 'cinematic-locations', current: idx, total: locationMap.size });

      // Reuse existing if file present + on disk
      // Check by element_name first, then fall back to file path on disk
      let existing = existingLocAssets.find(a => a.element_name === loc.name);
      if (existing && existing.status === 'done' && existing.file_path && fs.existsSync(existing.file_path)) {
        this.log(`[CINEMATIC] Location image for @${loc.name} already exists (DB match) — skipping`);
        locImagePaths[hint] = existing.file_path;
        // Check orientation on existing images too
        try {
          const rotated = await this._fixLocationOrientation(existing.file_path, this.state.aspectRatio || '16:9');
          if (rotated) this.log(`[CINEMATIC] ↻ Existing location @${loc.name} auto-rotated`);
        } catch (_) {}
        continue;
      }
      // Fallback: check if file exists on disk even if DB element_name was cleared
      const expectedLocPath = path.join(locDir, `${hint}.png`);
      if (fs.existsSync(expectedLocPath)) {
        this.log(`[CINEMATIC] Location image for @${loc.name} found on disk — skipping generation`);
        locImagePaths[hint] = expectedLocPath;
        // Check orientation on disk-recovered images too
        try {
          const rotated = await this._fixLocationOrientation(expectedLocPath, this.state.aspectRatio || '16:9');
          if (rotated) this.log(`[CINEMATIC] ↻ Disk-recovered location @${loc.name} auto-rotated`);
        } catch (_) {}
        // Fix up DB if asset exists but element_name was cleared
        if (existing) {
          try { db.setAssetElementName(existing.id, loc.name); } catch (_) {}
          if (existing.status !== 'done') db.markAssetDone(existing.id, expectedLocPath, { recovered: true });
        }
        continue;
      }

      const outputPath = path.join(locDir, `${hint}.png`);

      // Insert asset row
      let locAsset = existing;
      if (!locAsset) {
        db.insertExpectedAssets(projectId, [{ type: 'location_image' }]);
        locAsset = db.getAssets(projectId, { type: 'location_image' })
          .filter(a => !a.element_name).slice(-1)[0]; // most recent untagged row
        if (locAsset) {
          // Tag with element_name so resume can find it
          try { db.setAssetElementName(locAsset.id, loc.name); } catch (_) {}
        }
      }

      // ── Prompt refinement for regen'd locations ──
      // If the user flagged this location for regeneration, the original prompt
      // produced a bad image (e.g. sideways composition). Append anti-pattern
      // instructions and clear the regen hint after generation.
      let locPrompt = loc.prompt;
      const regenHints = (() => {
        try {
          const rawS = db.getProject(projectId)?.settings;
          const s = rawS ? (typeof rawS === 'string' ? JSON.parse(rawS) : rawS) : {};
          if (typeof s === 'string') { try { return JSON.parse(s).location_regen_hints || []; } catch (_) { return []; } }
          return s.location_regen_hints || [];
        } catch (_) { return []; }
      })();
      if (regenHints.includes(hint)) {
        // HARD RULE: Do NOT add orientation/composition/camera directives to prompt.
        // The Higgsfield aspectRatio selector is the sole authority.
        // Just log the regen so we know it's a retry — the clean prompt is enough.
        this.log(`[CINEMATIC] [REGEN] Regenerating @${loc.name} — using clean prompt (no orientation directives)`);
      }

      // Retry up to 2 attempts — strict gate below halts if still failed
      const MAX_LOC_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_LOC_ATTEMPTS; attempt++) {
        try {
          if (locAsset) db.markAssetGenerating(locAsset.id, locPrompt);
          this.log(`[CINEMATIC] Generating empty location image for @${loc.name}: ${loc.description.slice(0, 60)}…${attempt > 1 ? ` [retry ${attempt}/${MAX_LOC_ATTEMPTS}]` : ''}`);
          const genMeta = await this._withSessionRetry(
            () => this.automation.generateImage({
              prompt: this.sanitizeAspectRatio(locPrompt),
              outputPath,
              references: [],
              aspectRatio: this.state.aspectRatio || '16:9',
            }),
            `location ${loc.name}`
          );
          if (locAsset) db.markAssetDone(locAsset.id, outputPath, genMeta);
          locImagePaths[hint] = outputPath;

          // ── Orientation check + auto-rotate ──
          // Read PNG dimensions from header and fix if orientation doesn't
          // match the expected aspect ratio.
          try {
            const expectedAspect = this.state.aspectRatio || '16:9';
            const rotated = await this._fixLocationOrientation(outputPath, expectedAspect);
            if (rotated) {
              this.log(`[CINEMATIC] ↻ Location @${loc.name} auto-rotated to match ${expectedAspect} aspect`);
            }
          } catch (orientErr) {
            this.log(`[CINEMATIC] Orientation check failed for @${loc.name}: ${orientErr.message}`, 'warn');
          }

          // Clear regen hint on success so it doesn't persist
          if (regenHints.includes(hint)) {
            try {
              const rawS2 = db.getProject(projectId)?.settings;
              const s2 = rawS2 ? (typeof rawS2 === 'string' ? JSON.parse(rawS2) : rawS2) : {};
              const parsed2 = typeof s2 === 'string' ? JSON.parse(s2) : s2;
              parsed2.location_regen_hints = (parsed2.location_regen_hints || []).filter(h => h !== hint);
              if (parsed2.location_regen_hints.length === 0) delete parsed2.location_regen_hints;
              db.updateProject(projectId, { settings: JSON.stringify(parsed2) });
              this.log(`[CINEMATIC] [REGEN] Cleared regen hint for @${loc.name}`);
            } catch (_) {}
          }

          break; // success
        } catch (e) {
          this.log(`[CINEMATIC] Location image gen failed for @${loc.name} (attempt ${attempt}/${MAX_LOC_ATTEMPTS}): ${e.message}`, 'warn');
          if (locAsset) db.markAssetFailed(locAsset.id, e.message);
          if (attempt < MAX_LOC_ATTEMPTS) {
            this.log(`[CINEMATIC] Waiting 5s before retry...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }
    }

    // NOTE: Locations are NOT created as Higgsfield elements. Cinema Studio 3.5
    // attaches the empty-location image as a REFERENCE IMAGE (via the + button →
    // "Image Generations" tab in the picker). The blocking prompt then describes
    // the location naturally ("WIDE SHOT inside the kitchen from the reference
    // image") while @character elements lock the people. This was confirmed in
    // Session 8 Phase 0 — the first end-to-end test used exactly this flow.
    //
    // Earlier Phase 3 design erroneously included a Phase 3B that created
    // Higgsfield Location elements via HiggsfieldElements.createLocationElement().
    // That step is now removed: locations need only the generated image, not an
    // element row. The createLocationElement() helper is still in HiggsfieldElements
    // for any future use case but is no longer called from the orchestrator.

    // Stash hint → image path mapping on state so the scene-image stage can
    // attach the correct empty-location image as a reference per scene.
    this.state.cinematicLocations = {};
    for (const [hint, loc] of locationMap.entries()) {
      this.state.cinematicLocations[hint] = {
        // elementName retained on the object for backwards-compat with any
        // logging / display code that reads it, but it's NOT a Higgsfield
        // element name — it's just a stable identifier derived from the hint.
        elementName: loc.name,
        imagePath: locImagePaths[hint] || null,
      };
    }

    const generated = Object.values(locImagePaths).length;
    this.log(`[CINEMATIC] Location setup: ${generated}/${locationMap.size} empty-location image(s) ready as Cinema Studio references`);

    // Emit location data for the renderer's Locations approval gate UI.
    // This MUST happen BEFORE any strict gate so the Locations tab renders
    // and the user can see which locations are OK / failed / wrong orientation.
    const locationSummary = [];
    for (const [hint, loc] of locationMap.entries()) {
      const imgPath = locImagePaths[hint] || null;
      let width = 0, height = 0;
      if (imgPath && fs.existsSync(imgPath)) {
        try {
          const fd = fs.openSync(imgPath, 'r');
          const buf = Buffer.alloc(24);
          fs.readSync(fd, buf, 0, 24, 0);
          fs.closeSync(fd);
          if (buf[0] === 0x89 && buf[1] === 0x50) { // PNG
            width = buf.readUInt32BE(16);
            height = buf.readUInt32BE(20); // IHDR: width@16, height@20
          }
        } catch (_) {}
      }
      locationSummary.push({
        hint,
        name: loc.name,
        description: loc.description,
        imagePath: imgPath,
        width,
        height,
        status: imgPath && fs.existsSync(imgPath) ? 'done' : 'missing',
      });
    }
    this.emit({ type: 'cinematic-locations-ready', locations: locationSummary, expectedAspect: projectAspectRatio });

    // ── STRICT GATE: all CURRENT location images must be complete ──
    // Checked AFTER emitting location data so the Locations tab renders and
    // the user can see exactly which locations are missing or failed.
    // Only check locations from the current script's locationMap — ignore
    // orphaned DB assets from earlier runs that have stale pending status.
    const currentHints = new Set(locationMap.keys());
    const allLocAssets = db.getAssets(projectId, { type: 'location_image' });
    const failedLocations = allLocAssets
      .filter(a => {
        // Match by element_name containing the hint (e.g. "church_hall_towwf"
        // matches hint "church_hall") or by character_id
        const name = (a.element_name || '').toLowerCase();
        const charId = (a.character_id || '').toLowerCase();
        const belongsToCurrent = [...currentHints].some(h =>
          name.includes(h) || charId.includes(h) || h === name || h === charId
        );
        return belongsToCurrent && a.status !== 'done';
      });
    // Also clean up orphaned assets that don't belong to any current location
    const orphanedAssets = allLocAssets.filter(a => {
      const name = (a.element_name || '').toLowerCase();
      const charId = (a.character_id || '').toLowerCase();
      return a.status !== 'done' && ![...currentHints].some(h =>
        name.includes(h) || charId.includes(h) || h === name || h === charId
      );
    });
    if (orphanedAssets.length > 0) {
      this.log(`[CINEMATIC] Ignoring ${orphanedAssets.length} orphaned location asset(s) from earlier runs: ${orphanedAssets.map(a => `asset#${a.id} [${a.status}]`).join(', ')}`);
    }
    if (failedLocations.length > 0) {
      const names = failedLocations.map(l => {
        const label = l.element_name || l.character_id || `asset#${l.id}`;
        const file = l.file_path ? ` (${path.basename(l.file_path)})` : '';
        const status = l.status ? ` [${l.status}]` : '';
        return `${label}${file}${status}`;
      }).join(', ');
      this.log(`[CINEMATIC] ⚠ ${failedLocations.length} location image(s) incomplete: ${names}`, 'warn');
      throw new Error(`[STAGE GATE] Cannot proceed — ${failedLocations.length} location image(s) incomplete: ${names}. Check the Locations tab, fix the issue, and restart the pipeline.`);
    }
    this.log(`[CINEMATIC] ✓ All ${locationMap.size} location image(s) verified — proceeding`);
  }

  /**
   * Build the empty-location prompt for Nano Banana Pro. Constraints:
   *   - No characters / no people in the image
   *   - Captures location-defining details from the script's location_details
   *   - Cinematic photorealistic style for consistency with Cinema Studio output
   *   - Aspect-ratio text mirrors the project's aspect dropdown so the prompt
   *     doesn't fight the UI setting. Nano Banana Pro honors BOTH the dropdown
   *     AND text hints — earlier runs that hardcoded "16:9 aspect" produced
   *     mixed results (9:16 twice, 16:9 once) when the project was set to 9:16.
   *     The framing descriptor is aspect-aware so vertical projects say
   *     "vertical composition" rather than "wide cinematic".
   */
  _buildLocationPrompt(location, locationDetails) {
    // HARD RULE: No aspect ratio, orientation, or composition directives in
    // prompt text. The Higgsfield UI selector (aspectRatio param) is the sole
    // authority. Putting "9:16" or "vertical composition" in the prompt confuses
    // the model into composing landscape content rotated into a portrait canvas.
    const loc = location || 'a setting';
    const details = locationDetails || '';
    return `${loc}. ${details}. Empty — no people, no characters, no figures, no human silhouettes anywhere in frame. Photorealistic cinematic still, natural lighting, shallow depth of field, warm color grade, film grain.`.replace(/\s+/g, ' ').trim();
  }

  /**
   * Check and fix orientation of a location image.
   *
   * Reads PNG dimensions from the file header (zero dependencies — just reads
   * bytes 16-23 of the PNG spec). If the orientation doesn't match the expected
   * aspect ratio (e.g. landscape image for a 9:16 project, or portrait image
   * for a 16:9 project), auto-rotates 90° CW using ffmpeg.
   *
   * @param {string} imagePath - path to the PNG file
   * @param {string} expectedAspect - '16:9', '9:16', or '1:1'
   * @returns {boolean} true if the image was rotated, false if orientation was fine
   */
  async _fixLocationOrientation(imagePath, expectedAspect = '16:9') {
    // Read PNG dimensions from the IHDR chunk (bytes 16-23)
    const fd = fs.openSync(imagePath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);

    // PNG signature check
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) {
      // Not a PNG — could be JPEG or WebP; skip orientation check
      this.log(`[ORIENTATION] ${path.basename(imagePath)} is not a PNG — skipping orientation check`);
      return false;
    }

    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20); // IHDR: width@16, height@20 (4 bytes each)
    this.log(`[ORIENTATION] ${path.basename(imagePath)}: ${width}x${height} (expected ${expectedAspect})`);

    const isLandscape = width > height;
    const isPortrait = height > width;
    const expectLandscape = expectedAspect === '16:9';
    const expectPortrait = expectedAspect === '9:16';

    // Check if orientation matches
    if (expectLandscape && isLandscape) return false; // correct
    if (expectPortrait && isPortrait) return false;   // correct
    if (expectedAspect === '1:1') return false;       // square — any orientation ok

    // Mismatch detected — auto-rotate 90° CW using ffmpeg
    this.log(`[ORIENTATION] ⚠ Orientation mismatch: image is ${isLandscape ? 'landscape' : 'portrait'} but expected ${expectedAspect} — rotating 90° CW`);

    const tmpPath = imagePath + '.rotated.png';
    const { execSync } = require('child_process');

    try {
      // ffmpeg transpose=1 = 90° clockwise
      execSync(`ffmpeg -y -i "${imagePath}" -vf "transpose=1" "${tmpPath}" 2>/dev/null`, {
        timeout: 15000,
      });

      // Verify the rotated file exists and has content
      if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
        fs.copyFileSync(tmpPath, imagePath);
        fs.unlinkSync(tmpPath);
        return true; // rotated
      } else {
        this.log('[ORIENTATION] Rotation output missing or empty — keeping original', 'warn');
        return false;
      }
    } catch (rotErr) {
      this.log(`[ORIENTATION] ffmpeg rotation failed: ${rotErr.message}`, 'warn');
      // Clean up tmp file if it exists
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
      return false;
    }
  }

  /**
   * Inject vision-refined blocking into a Kling multi_shot_prompt.
   *
   * The original multi_shot_prompt uses script-time blocking (frame-left/center/right
   * style), but the start frame image was generated using vision-refined blocking
   * that references actual spatial objects. This method rewrites the prompt so the
   * animation direction matches the image the viewer sees.
   *
   * Strategy:
   * 1. For each character, find their first mention in the prompt (typically the
   *    establishing shot) and replace the surrounding blocking text with the
   *    vision-refined version.
   * 2. Prepend a blocking context line that tells Kling where each character is
   *    positioned, so all subsequent shots inherit the spatial relationship.
   *
   * @param {string} prompt - The original multi_shot_prompt from the script
   * @param {Array} visionChars - Array of { name, position } from vision refinement
   * @returns {string} The rewritten prompt with vision-refined blocking
   */
  _injectVisionBlocking(prompt, visionChars) {
    if (!prompt || !visionChars || visionChars.length === 0) return prompt;

    const KLING_CHAR_LIMIT = 2500;
    const PREAMBLE_BUDGET_RATIO = 0.35; // preamble gets at most 35% of total budget

    // Ensure all character names in position text have @ prefix (belt-and-suspenders).
    // Must match BOTH suffixed names AND base names since Vision API returns base names.
    // Derive baseName on the fly for legacy data that was serialized without it.
    const charsWithBase = visionChars.map(c => {
      if (c.baseName) return c;
      const m = c.name.match(/^(.+)_[a-z]{2,5}_\d{4}$/);
      return { ...c, baseName: m ? m[1] : c.name };
    });
    const cleanPosition = (pos) => {
      let cleaned = pos || '';
      for (const c of charsWithBase) {
        const suffixedEsc = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Replace @baseName → @suffixedName (e.g. "@adanna" → "@adanna_mseb_0419")
        if (c.baseName && c.baseName !== c.name) {
          const baseEsc = c.baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleaned = cleaned.replace(new RegExp(`@${baseEsc}\\b`, 'gi'), `@${c.name}`);
          cleaned = cleaned.replace(new RegExp(`(?<!@)\\b${baseEsc}\\b`, 'gi'), `@${c.name}`);
        }
        // Also match bare suffixed name (safety net)
        cleaned = cleaned.replace(new RegExp(`(?<!@)\\b${suffixedEsc}\\b`, 'gi'), `@${c.name}`);
      }
      return cleaned;
    };

    // Deduplicate characters by name (keep first occurrence)
    const seen = new Set();
    const uniqueChars = charsWithBase.filter(c => {
      const key = c.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Replace generic frame-position descriptions in establishing shots.
    // Do this BEFORE building preamble so we know the prompt body length.
    let rewritten = prompt;
    for (const vc of uniqueChars) {
      const nameEscaped = vc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const framePositionPattern = new RegExp(
        `@${nameEscaped}\\s+(?:stands?|is|sits?|leans?|waits?)?\\s*(?:at\\s+)?frame-(?:left|center|right|centre)\\b[^.\\n]*`,
        'gi'
      );
      const beforeReplace = rewritten;
      rewritten = rewritten.replace(framePositionPattern, `@${vc.name} ${cleanPosition(vc.position)}`);
      if (rewritten !== beforeReplace) {
        this.log(`[VISION-BLOCKING] Replaced frame-position for @${vc.name}`);
      } else {
        this.log(`[VISION-BLOCKING] No frame-position for @${vc.name} — trying broader pattern`);
        // Broader fallback: match @name followed by any posture verb + description until period/newline
        // This catches cases where "frame-left/center/right" was already removed by a prior fix
        const broadPattern = new RegExp(
          `@${nameEscaped}\\s+(?:stands?|sits?|seated|leans?|is\\s+(?:standing|sitting|seated|leaning))\\b[^.\\n]*`,
          'gi'
        );
        rewritten = rewritten.replace(broadPattern, `@${vc.name} ${cleanPosition(vc.position)}`);
        if (rewritten !== beforeReplace) {
          this.log(`[VISION-BLOCKING] Replaced via broad pattern for @${vc.name}`);
        } else {
          // Expected for cinematic prompts where character positions are in a
          // separate CHARACTER POSITIONS block (stripped below), not inline in
          // shot directions. The preamble injection still works correctly.
          this.log(`[VISION-BLOCKING] No inline position to replace for @${vc.name} (preamble will override)`);
        }
      }
    }

    // ── POSTURE VERB CORRECTION ──
    // Even after the replacement above, ensure Shot 1 posture verbs match the
    // vision-refined positions. Extract posture from each character's position
    // text and correct any remaining mismatches in Shot 1.
    const shot1Match = rewritten.match(/(Shot\s*1\s*\([^)]*\)\s*:\s*)(.*?)(?=Shot\s*2\s*\(|$)/is);
    if (shot1Match) {
      let shot1Body = shot1Match[2];
      for (const vc of uniqueChars) {
        const posLower = (vc.position || '').toLowerCase();
        let targetPosture = null;
        if (/\bseat(?:ed|s)\b|\bsitting\b|\bsits?\b/.test(posLower)) targetPosture = 'seated';
        else if (/\bstand(?:s|ing)\b/.test(posLower)) targetPosture = 'standing';
        else if (/\blean(?:s|ing)\b/.test(posLower)) targetPosture = 'leaning';
        if (!targetPosture) continue;

        const nameEscaped = vc.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const postureRe = new RegExp(
          `(@${nameEscaped})\\s+(stands?|stand|standing|sits?|sitting|seated|leans?|leaning)\\b`,
          'gi'
        );
        shot1Body = shot1Body.replace(postureRe, (match, nameRef, currentVerb) => {
          const isCorrect =
            (targetPosture === 'seated' && /^(sits?|sitting|seated)$/i.test(currentVerb)) ||
            (targetPosture === 'standing' && /^(stands?|standing)$/i.test(currentVerb)) ||
            (targetPosture === 'leaning' && /^(leans?|leaning)$/i.test(currentVerb));
          if (isCorrect) return match;
          const verbMap = { seated: 'sits', standing: 'stands', leaning: 'leans' };
          const correctVerb = verbMap[targetPosture] || currentVerb;
          this.log(`[VISION-BLOCKING] Posture fix: ${nameRef} "${currentVerb}" → "${correctVerb}" (vision says ${targetPosture})`);
          return `${nameRef} ${correctVerb}`;
        });
      }
      rewritten = rewritten.replace(shot1Match[2], shot1Body);
    }

    // Build preamble with budget-aware truncation.
    // Each blocking line is trimmed to fit within the character budget.
    const preambleMaxChars = Math.floor(KLING_CHAR_LIMIT * PREAMBLE_BUDGET_RATIO);
    const preamblePrefix = 'CHARACTER POSITIONS (matching start frame): ';
    const preambleSuffix = '.\n\n';
    const overhead = preamblePrefix.length + preambleSuffix.length;
    const charCount = uniqueChars.length;
    // Budget per character = (preamble budget - overhead - separators) / char count
    const separatorCost = (charCount - 1) * 2; // '; ' between entries
    const perCharBudget = charCount > 0
      ? Math.floor((preambleMaxChars - overhead - separatorCost) / charCount)
      : 200;

    const blockingLines = uniqueChars.map(c => {
      const prefix = `@${c.name} — `;
      const maxPosLen = Math.max(40, perCharBudget - prefix.length);
      let pos = cleanPosition(c.position);
      // Truncate at sentence boundary if too long
      if (pos.length > maxPosLen) {
        // Try to cut at last period/comma within budget
        const truncated = pos.slice(0, maxPosLen);
        const lastStop = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf(','));
        pos = lastStop > maxPosLen * 0.5
          ? truncated.slice(0, lastStop + 1)
          : truncated.trimEnd();
      }
      return `${prefix}${pos}`;
    });

    let preamble = `${preamblePrefix}${blockingLines.join('; ')}${preambleSuffix}`;

    // Final budget check: if preamble + prompt > limit, trim preamble further
    const totalLen = preamble.length + rewritten.length;
    if (totalLen > KLING_CHAR_LIMIT) {
      const excess = totalLen - KLING_CHAR_LIMIT;
      this.log(`[VISION-BLOCKING] Prompt ${totalLen} chars exceeds ${KLING_CHAR_LIMIT} — trimming preamble by ${excess} chars`);
      // Rebuild with tighter per-char budget
      const tighterTotal = preambleMaxChars - excess;
      const tighterPerChar = charCount > 0
        ? Math.floor((tighterTotal - overhead - separatorCost) / charCount)
        : 80;
      const tighterLines = uniqueChars.map(c => {
        const prefix = `@${c.name} — `;
        const maxLen = Math.max(30, tighterPerChar - prefix.length);
        let pos = cleanPosition(c.position);
        if (pos.length > maxLen) {
          const truncated = pos.slice(0, maxLen);
          const lastStop = Math.max(truncated.lastIndexOf('.'), truncated.lastIndexOf(','));
          pos = lastStop > maxLen * 0.4
            ? truncated.slice(0, lastStop + 1)
            : truncated.trimEnd();
        }
        return `${prefix}${pos}`;
      });
      preamble = `${preamblePrefix}${tighterLines.join('; ')}${preambleSuffix}`;
    }

    // Strip the original "CHARACTER POSITIONS:" line from the prompt body.
    // The vision-refined preamble (built above) is the ground truth — it's
    // based on what Claude Vision actually saw in the location image, which
    // is the same image used as the Kling start frame. The original blocking
    // from the script stage used generic "frame-left/center/right" positions
    // written before the location image existed and may contradict the start
    // frame. Keeping both gives Kling conflicting instructions.
    //
    // SAFE: this method is only called from _runCinematicVideoStage (video
    // gen), never during scene image generation. The scene pipeline is
    // unaffected.
    const beforeStrip = rewritten;
    rewritten = rewritten.replace(
      /CHARACTER POSITIONS\s*:[^\n]*(?:\n(?!Shot\s*\d|\n|\s*$)[^\n]*)*/gi,
      ''
    ).replace(/\n{3,}/g, '\n\n');
    if (rewritten !== beforeStrip) {
      this.log('[VISION-BLOCKING] Stripped original CHARACTER POSITIONS (vision preamble overrides)');
    }

    return preamble + rewritten;
  }

  /**
   * Use Claude Vision to refine blocking for a single scene based on the actual
   * location image. Instead of generic frame-left/center/right positions, this
   * produces blocking grounded in the spatial layout of the real location.
   *
   * @param {string} locationImagePath - Absolute path to the location PNG
   * @param {Object} scene - The scene object from the script (has blocking, characters_present, etc.)
   * @param {Array} characters - Array of { name, position } for each character in the scene
   * @param {string} aspectRatio - '16:9' or '9:16'
   * @param {string|null} previousSceneImagePath - Path to the previous scene's output image at the SAME location (for continuity). null if first scene at this location.
   * @returns {Array} Refined characters array with spatially-grounded positions, or original on failure
   */
  async _refineBlockingWithVision(locationImagePath, scene, characters, aspectRatio = '16:9', previousSceneImagePath = null) {
    const fs = require('fs');

    try {
      const apiKey = this.store.get('claudeApiKey');
      if (!apiKey) {
        this.log('[VISION-BLOCKING] No Claude API key — falling back to script blocking');
        return characters;
      }

      if (!fs.existsSync(locationImagePath)) {
        this.log(`[VISION-BLOCKING] Location image not found: ${locationImagePath} — falling back`);
        return characters;
      }

      // ── Resize image if too large for Claude Vision API (5MB base64 limit) ──
      // Location images from Higgsfield can be 10-14MB PNGs. We scale down to
      // max 1200px on the longest side and convert to JPEG for much smaller payloads.
      // Claude only needs to see spatial layout, not pixel-perfect detail.
      let imageData;
      let mimeType = 'image/jpeg';
      const rawSize = fs.statSync(locationImagePath).size;

      if (rawSize > 3 * 1024 * 1024) { // > 3MB — resize to be safe under 5MB base64
        const path = require('path');
        const { execSync } = require('child_process');
        // Inline FFmpeg lookup (same logic as assembler.js findFFmpeg)
        let ffmpegPath = null;
        for (const cmd of ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) {
          try { execSync(`"${cmd}" -version`, { stdio: 'ignore' }); ffmpegPath = cmd; break; } catch (_) {}
        }

        if (ffmpegPath) {
          const tmpJpeg = path.join(path.dirname(locationImagePath), `_vision_tmp_${Date.now()}.jpg`);
          try {
            // Scale to max 1200px on longest side, JPEG quality 85
            execSync(`"${ffmpegPath}" -i "${locationImagePath}" -vf "scale='if(gt(iw,ih),1200,-2)':'if(gt(iw,ih),-2,1200)'" -q:v 2 -y "${tmpJpeg}"`, { timeout: 15000, stdio: 'pipe' });
            imageData = fs.readFileSync(tmpJpeg);
            this.log(`[VISION-BLOCKING] Resized image: ${(rawSize / 1024 / 1024).toFixed(1)}MB → ${(imageData.length / 1024).toFixed(0)}KB JPEG`);
            try { fs.unlinkSync(tmpJpeg); } catch (_) {}
          } catch (resizeErr) {
            this.log(`[VISION-BLOCKING] FFmpeg resize failed: ${resizeErr.message} — trying raw`);
            imageData = fs.readFileSync(locationImagePath);
            mimeType = locationImagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
          }
        } else {
          this.log('[VISION-BLOCKING] FFmpeg not found — sending raw image (may exceed 5MB limit)');
          imageData = fs.readFileSync(locationImagePath);
          mimeType = locationImagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        }
      } else {
        imageData = fs.readFileSync(locationImagePath);
        mimeType = locationImagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
      }

      const base64Image = imageData.toString('base64');

      // Final size check — if still over 5MB base64, skip vision
      if (base64Image.length > 5 * 1024 * 1024) {
        this.log(`[VISION-BLOCKING] Image still too large after resize (${(base64Image.length / 1024 / 1024).toFixed(1)}MB base64) — falling back`);
        return characters;
      }

      // Use base names in Vision prompt — the LLM naturally shortens suffixed
      // names (e.g. "adanna_mseb_0419" → "adanna"), so we give it base names
      // upfront and map the output back to suffixed names afterward.
      const charList = characters.map(c => `@${c.baseName || c.name}`).join(', ');
      const charCount = characters.length;
      const sceneContext = scene.blocking?.notes || '';
      const orientation = aspectRatio === '9:16' ? 'vertical/portrait (9:16 — tall frame, characters stacked in depth)' : 'horizontal/landscape (16:9 — wide frame, characters spread laterally)';

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });

      // ── Build content array: location image + optional previous scene image + prompt ──
      const contentParts = [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64Image },
        },
      ];

      // ── CONTINUITY: include previous scene image if same location ──
      let continuityClause = '';
      if (previousSceneImagePath && fs.existsSync(previousSceneImagePath)) {
        try {
          let prevData = fs.readFileSync(previousSceneImagePath);
          let prevMime = previousSceneImagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
          // Resize if too large (same logic as location image)
          if (prevData.length > 4 * 1024 * 1024) {
            const { execSync } = require('child_process');
            const path = require('path');
            const tmpPrev = path.join(path.dirname(previousSceneImagePath), `_prev_tmp_${Date.now()}.jpg`);
            try {
              let ffmpegPath = null;
              for (const cmd of ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) {
                try { execSync(`"${cmd}" -version`, { stdio: 'ignore' }); ffmpegPath = cmd; break; } catch (_) {}
              }
              if (ffmpegPath) {
                execSync(`"${ffmpegPath}" -i "${previousSceneImagePath}" -vf "scale='if(gt(iw,ih),1200,-2)':'if(gt(iw,ih),-2,1200)'" -q:v 2 -y "${tmpPrev}"`, { timeout: 15000, stdio: 'pipe' });
                prevData = fs.readFileSync(tmpPrev);
                prevMime = 'image/jpeg';
                try { fs.unlinkSync(tmpPrev); } catch (_) {}
              }
            } catch (_) {}
          }
          const prevBase64 = prevData.toString('base64');
          if (prevBase64.length <= 5 * 1024 * 1024) {
            contentParts.push({
              type: 'image',
              source: { type: 'base64', media_type: prevMime, data: prevBase64 },
            });
            continuityClause = `
CONTINUITY REFERENCE: The second image is the PREVIOUS SCENE at this same location. Characters who appear in both scenes MUST maintain the same spatial positions (same side of desk, same chair, same standing spot) UNLESS the script specifically calls for movement. Do NOT swap character positions between scenes.`;
            this.log(`[VISION-BLOCKING] Including previous scene for continuity: ${previousSceneImagePath}`);
          }
        } catch (e) {
          this.log(`[VISION-BLOCKING] Could not load previous scene image: ${e.message} — proceeding without continuity ref`);
        }
      }

      contentParts.push({
        type: 'text',
        text: `You are a cinematic scene compositor for an AI-generated Nollywood drama.

LOCATION IMAGE: This is the reference location where the scene takes place.
FRAME ORIENTATION: ${orientation}
CHARACTERS IN SCENE: ${charList} (${charCount} character${charCount > 1 ? 's' : ''})
SCENE MOOD: ${sceneContext || 'dramatic confrontation'}${continuityClause}

YOUR TASK:
1. Study the location image. Identify spatial anchors: furniture, doorways, counters, stalls, signage, props, depth planes, natural framing elements.
2. Propose blocking for each character that references SPECIFIC objects/areas visible in the image.
3. Consider the frame orientation — ${aspectRatio === '9:16' ? 'vertical frames work best with foreground/background depth separation, characters at different distances from camera' : 'wide frames work best with lateral separation, characters occupying different horizontal zones'}.${previousSceneImagePath ? '\n4. Study the previous scene image and maintain character positions for continuity.' : ''}

SPATIAL CONTEXT: This is a Nigerian production. All vehicles are LEFT-HAND DRIVE (steering wheel on the LEFT side). If the location is a vehicle interior, the driver sits on the LEFT behind the steering wheel, the passenger on the RIGHT.

RULES:
- NEVER use "frame-left", "frame-center", "frame-right" — these produce flat, lineup compositions.
- ALWAYS reference objects/areas visible in the image (e.g., "behind the grill", "leaning on the counter", "standing in the doorway", "approaching from the street").
- In vehicle scenes, use the steering wheel position to determine driver vs passenger seating.
- For ${charCount > 1 ? 'multi-character scenes: create spatial RELATIONSHIPS between characters — one closer to camera, one further; one seated, one standing; one inside, one entering' : 'single-character scenes: place the character in a way that uses the environment to frame them naturally'}.
- Characters must NEVER look at or acknowledge the camera. They are in a candid, natural moment — interacting with each other, looking at objects, working, reacting. Describe their gaze direction explicitly (e.g., "eyes on the grill", "glancing sideways at X", "looking down at her hands").
- Keep each character's blocking to ONE concise sentence.
- The blocking will be used as text in an AI image generation prompt, so be descriptive but compact.
- VISUAL CONSISTENCY: All scenes share the same location. Maintain consistent camera distance (medium-wide), consistent naturalistic lighting, and consistent documentary tone across scenes. Avoid dramatic close-ups or posed compositions.
- LOCATION FIDELITY: The generated image must match the reference location EXACTLY. Do NOT introduce props, furniture, objects, or architectural details that are not visible in the reference image. Only reference things you can actually see in the photo.${previousSceneImagePath ? '\n- SPATIAL CONTINUITY: Characters who appeared in the previous scene at this location MUST stay on the same side / in the same position unless the scene describes them moving. If a character was seated behind the desk on the right, they must remain there.' : ''}

OUTPUT FORMAT (JSON array, one object per character, same order as input):
[
  { "name": "character_name", "blocking": "spatial description referencing location objects" }
]

Output ONLY the JSON array, no explanation.`,
      });

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: contentParts,
        }],
      });

      const text = response.content?.[0]?.text || '';
      this.log(`[VISION-BLOCKING] Raw response: ${text.slice(0, 300)}`);

      // Parse JSON from response (may be wrapped in markdown code blocks)
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.log('[VISION-BLOCKING] Could not parse JSON from response — falling back');
        return characters;
      }

      const refined = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(refined) || refined.length === 0) {
        this.log('[VISION-BLOCKING] Parsed result is empty — falling back');
        return characters;
      }

      // Map refined blocking back to characters array
      const refinedChars = [];
      for (const origChar of characters) {
        const origBase = (origChar.baseName || origChar.name).toLowerCase();
        const match = refined.find(r => {
          if (!r.name) return false;
          const rName = r.name.toLowerCase().replace(/^@/, '');
          // Match on suffixed name, base name, or Vision's returned name
          return rName === origChar.name.toLowerCase() || rName === origBase;
        });
        if (match && match.blocking) {
          // Post-process: replace bare base names AND @base names with @suffixedName
          // Vision returns base names (e.g. "toward adanna") — we need to convert
          // these to @suffixed_name (e.g. "toward @adanna_mseb_0419") so Higgsfield
          // creates the correct element pill.
          let cleanedBlocking = match.blocking;
          for (const c of characters) {
            const cBase = (c.baseName || c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Replace @baseName with @suffixedName (e.g. "@adanna" → "@adanna_mseb_0419")
            const atBaseRegex = new RegExp(`@${cBase}\\b`, 'gi');
            cleanedBlocking = cleanedBlocking.replace(atBaseRegex, `@${c.name}`);
            // Replace bare baseName (not already @-prefixed) with @suffixedName
            const bareBaseRegex = new RegExp(`(?<!@)\\b${cBase}\\b`, 'gi');
            cleanedBlocking = cleanedBlocking.replace(bareBaseRegex, `@${c.name}`);
          }
          if (cleanedBlocking !== match.blocking) {
            this.log(`[VISION-BLOCKING] Fixed character names in blocking: "${match.blocking}" → "${cleanedBlocking}"`);
          }
          refinedChars.push({ name: origChar.name, baseName: origChar.baseName, position: cleanedBlocking });
          this.log(`[VISION-BLOCKING] @${origChar.name}: "${cleanedBlocking}"`);
        } else {
          refinedChars.push(origChar); // Keep original if no match
          this.log(`[VISION-BLOCKING] @${origChar.name}: no match in response — keeping original`);
        }
      }

      this.log(`[VISION-BLOCKING] ✓ Refined blocking for ${refinedChars.length} character(s)`);
      return refinedChars;

    } catch (e) {
      this.log(`[VISION-BLOCKING] API call failed: ${e.message} — falling back to script blocking`);
      return characters;
    }
  }

  /**
   * Verify and correct vision-refined blocking by examining the ACTUAL scene
   * image (start frame). The original _refineBlockingWithVision() proposes
   * blocking based on the empty location image BEFORE the scene is rendered.
   * Cinema Studio may place characters differently than proposed. This method
   * reads the rendered scene image and describes where characters ACTUALLY are,
   * correcting any mismatches.
   *
   * Called once per scene at video gen time, before clips are generated.
   *
   * @param {string} sceneImagePath - Path to the rendered scene image (start frame)
   * @param {Array} characters - Array of { name, baseName, position } from stashed blocking
   * @param {Array} [characterDescs] - Optional array of { name, description } for visual identification
   * @returns {Array} Corrected characters array with positions matching the scene image
   */
  async _verifyBlockingWithSceneImage(sceneImagePath, characters, characterDescs = []) {
    const fs = require('fs');

    if (!characters || characters.length === 0) return characters;

    try {
      const apiKey = this.store.get('claudeApiKey');
      if (!apiKey) {
        this.log('[VISION-VERIFY] No Claude API key — using stashed blocking as-is');
        return characters;
      }

      if (!fs.existsSync(sceneImagePath)) {
        this.log(`[VISION-VERIFY] Scene image not found: ${sceneImagePath} — using stashed blocking`);
        return characters;
      }

      // ── Detect ACTUAL mime type from file magic bytes (not extension!) ──
      // Cinema Studio saves scene images with .png extension but webp content.
      const _detectMimeFromBytes = (buf) => {
        if (buf.length >= 4) {
          // PNG: 89 50 4E 47
          if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
          // JPEG: FF D8 FF
          if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
          // WEBP: RIFF....WEBP
          if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
              && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
          // GIF: GIF8
          if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
        }
        // Fallback to extension
        const ext = (sceneImagePath || '').split('.').pop().toLowerCase();
        if (ext === 'png') return 'image/png';
        if (ext === 'webp') return 'image/webp';
        return 'image/jpeg';
      };

      // ── Read image and convert webp → jpeg if needed ──
      let imageData = fs.readFileSync(sceneImagePath);
      let mimeType = _detectMimeFromBytes(imageData);
      const rawSize = imageData.length;
      const needsConversion = mimeType === 'image/webp';

      this.log(`[VISION-VERIFY] Image: ${(rawSize / 1024).toFixed(0)}KB, detected format: ${mimeType}${needsConversion ? ' (will convert to JPEG)' : ''}`);

      if (rawSize > 3 * 1024 * 1024 || needsConversion) {
        const path = require('path');
        const { execSync } = require('child_process');
        let ffmpegPath = null;
        for (const cmd of ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) {
          try { execSync(`"${cmd}" -version`, { stdio: 'ignore' }); ffmpegPath = cmd; break; } catch (_) {}
        }
        if (ffmpegPath) {
          const tmpJpeg = path.join(path.dirname(sceneImagePath), `_verify_tmp_${Date.now()}.jpg`);
          try {
            execSync(`"${ffmpegPath}" -i "${sceneImagePath}" -vf "scale='if(gt(iw,ih),1200,-2)':'if(gt(iw,ih),-2,1200)'" -q:v 2 -y "${tmpJpeg}"`, { timeout: 15000, stdio: 'pipe' });
            imageData = fs.readFileSync(tmpJpeg);
            mimeType = 'image/jpeg';
            this.log(`[VISION-VERIFY] Converted → JPEG (${(imageData.length / 1024).toFixed(0)}KB)`);
            try { fs.unlinkSync(tmpJpeg); } catch (_) {}
          } catch (resizeErr) {
            this.log(`[VISION-VERIFY] FFmpeg conversion failed: ${resizeErr.message}`);
            // If webp and ffmpeg failed, we can't send it — Claude won't accept webp
            if (needsConversion) {
              this.log('[VISION-VERIFY] Cannot convert webp without ffmpeg — using stashed blocking');
              return characters;
            }
          }
        } else {
          this.log('[VISION-VERIFY] FFmpeg not found');
          if (needsConversion) {
            this.log('[VISION-VERIFY] Cannot convert webp without ffmpeg — using stashed blocking');
            return characters;
          }
        }
      }

      const base64Image = imageData.toString('base64');
      if (base64Image.length > 5 * 1024 * 1024) {
        this.log('[VISION-VERIFY] Image too large — using stashed blocking');
        return characters;
      }

      // Build character identification list with visual descriptions
      // so Vision can actually tell WHO is who in the scene image
      const charIdentLines = characters.map(c => {
        const baseName = c.baseName || c.name;
        const desc = characterDescs.find(d =>
          d.name.toLowerCase() === baseName.toLowerCase() ||
          d.name.toLowerCase() === c.name.toLowerCase()
        );
        if (desc && desc.description) {
          return `- @${baseName}: ${desc.description}`;
        }
        return `- @${baseName}`;
      }).join('\n');

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64Image },
            },
            {
              type: 'text',
              text: `You are verifying character positions in a scene image for an AI video generation pipeline.

CHARACTERS IN THIS SCENE (use visual descriptions to identify each person):
${charIdentLines}

TASK: Look at this scene image, IDENTIFY each character by their visual description (clothing, hair, body type, gender), and describe WHERE they are ACTUALLY positioned. Focus on:
- Distance from camera (closest, middle, furthest)
- Left/right/center placement in the frame
- Physical relationship to visible objects (cars, trees, furniture, doorways, etc.)
- Body orientation and gaze direction

SPATIAL CONTEXT: This is a Nigerian production. All vehicles are LEFT-HAND DRIVE (steering wheel on the LEFT side of the vehicle). The person sitting behind the steering wheel is the DRIVER. The person on the right side of the vehicle interior is the PASSENGER. Use the steering wheel position to anchor your identification — do NOT assume who is driving based on character names.

RULES:
- FIRST identify which person in the image matches each character description. This is critical — do not guess.
- In vehicle scenes, ALWAYS locate the steering wheel first to determine driver vs passenger.
- Describe what you SEE, not what you think should be there.
- Be spatially precise — "closest to camera", "further back", "on the left side of frame near the silver car".
- Reference actual objects visible in the image.
- One concise sentence per character.
- Characters must NEVER be described as looking at the camera.

OUTPUT FORMAT (JSON array, same order as input character list):
[
  { "name": "character_name", "blocking": "spatial description of actual position in the image" }
]

Output ONLY the JSON array.`,
            },
          ],
        }],
      });

      const text = response.content?.[0]?.text || '';
      this.log(`[VISION-VERIFY] Raw response: ${text.slice(0, 300)}`);

      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.log('[VISION-VERIFY] Could not parse JSON — using stashed blocking');
        return characters;
      }

      const verified = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(verified) || verified.length === 0) {
        this.log('[VISION-VERIFY] Empty result — using stashed blocking');
        return characters;
      }

      // Map verified positions back to characters
      const correctedChars = [];
      let corrections = 0;
      for (const origChar of characters) {
        const origBase = (origChar.baseName || origChar.name).toLowerCase();
        const match = verified.find(r => {
          if (!r.name) return false;
          const rName = r.name.toLowerCase().replace(/^@/, '');
          return rName === origChar.name.toLowerCase() || rName === origBase;
        });
        if (match && match.blocking) {
          // Post-process: replace bare names with @suffixed names
          let cleanedBlocking = match.blocking;
          for (const c of characters) {
            const cBase = (c.baseName || c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            cleanedBlocking = cleanedBlocking.replace(new RegExp(`@${cBase}\\b`, 'gi'), `@${c.name}`);
            cleanedBlocking = cleanedBlocking.replace(new RegExp(`(?<!@)\\b${cBase}\\b`, 'gi'), `@${c.name}`);
          }
          // Check if position changed meaningfully
          if (cleanedBlocking !== origChar.position) {
            corrections++;
            this.log(`[VISION-VERIFY] @${origChar.name}: CORRECTED "${origChar.position?.slice(0, 60)}..." → "${cleanedBlocking.slice(0, 60)}..."`);
          }
          correctedChars.push({ name: origChar.name, baseName: origChar.baseName, position: cleanedBlocking });
        } else {
          correctedChars.push(origChar);
          this.log(`[VISION-VERIFY] @${origChar.name}: no match — keeping stashed blocking`);
        }
      }

      if (corrections > 0) {
        this.log(`[VISION-VERIFY] ✓ Corrected ${corrections}/${characters.length} character position(s) to match scene image`);
      } else {
        this.log(`[VISION-VERIFY] ✓ All ${characters.length} positions verified — no corrections needed`);
      }

      return correctedChars;

    } catch (e) {
      this.log(`[VISION-VERIFY] Verification failed: ${e.message} — using stashed blocking`);
      return characters;
    }
  }

  /**
   * 3rd Vision Pass — Reconcile shot directions with verified blocking.
   *
   * After _verifyBlockingWithSceneImage corrects CHARACTER POSITIONS and
   * _injectVisionBlocking rewrites the preamble, shot body actions may still
   * reference physically impossible actions (e.g. "turns toward the ignition"
   * when the character isn't in the driver's seat) or visual-state contradictions
   * (e.g. "jacket off, sleeves rolled" when the character is wearing a jacket
   * in the scene image, or referencing props not visible in the start frame).
   *
   * This method sends the scene image + verified positions + full prompt to
   * Claude Vision and asks it to fix physically impossible actions AND strip
   * visual-state contradictions (wardrobe, props, appearance).
   *
   * GUARDRAILS (action density vs lip sync trade-off):
   * - Word count ceiling: replacement ≤ original per shot
   * - Dialogue shots: minimal action (prefer removal over substitution)
   * - Action verb cap: 1 per dialogue shot, 2 per non-dialogue shot
   * - Post-validation: reject if any shot grew >20% or verb count increased
   *
   * @param {string} sceneImagePath - Path to the rendered scene image
   * @param {Array} verifiedPositions - Corrected characters from 2nd Vision pass
   * @param {string} prompt - The multi_shot_prompt AFTER _injectVisionBlocking
   * @param {Buffer|null} imageData - Pre-read image data (avoids re-reading/re-converting)
   * @param {string|null} mimeType - Detected mime type of imageData
   * @returns {string} Reconciled prompt, or original prompt on failure
   */
  async _reconcileShotDirectionsWithImage(sceneImagePath, verifiedPositions, prompt, imageData = null, mimeType = null) {
    const fs = require('fs');

    if (!prompt || !verifiedPositions || verifiedPositions.length === 0) return prompt;

    try {
      const apiKey = this.store.get('claudeApiKey');
      if (!apiKey) {
        this.log('[SHOT-RECONCILE] No Claude API key — using prompt as-is');
        return prompt;
      }

      // ── Prepare image data (reuse from caller if available) ──
      if (!imageData || !mimeType) {
        if (!fs.existsSync(sceneImagePath)) {
          this.log(`[SHOT-RECONCILE] Scene image not found: ${sceneImagePath} — using prompt as-is`);
          return prompt;
        }

        const _detectMimeFromBytes = (buf) => {
          if (buf.length >= 4) {
            if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
            if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
            if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
                && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
          }
          const ext = (sceneImagePath || '').split('.').pop().toLowerCase();
          if (ext === 'png') return 'image/png';
          if (ext === 'webp') return 'image/webp';
          return 'image/jpeg';
        };

        imageData = fs.readFileSync(sceneImagePath);
        mimeType = _detectMimeFromBytes(imageData);

        // Convert WebP → JPEG if needed
        if (mimeType === 'image/webp') {
          const path = require('path');
          const { execSync } = require('child_process');
          let ffmpegPath = null;
          for (const cmd of ['ffmpeg', 'C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe']) {
            try { execSync(`"${cmd}" -version`, { stdio: 'ignore' }); ffmpegPath = cmd; break; } catch (_) {}
          }
          if (ffmpegPath) {
            const tmpJpeg = path.join(path.dirname(sceneImagePath), `_reconcile_tmp_${Date.now()}.jpg`);
            try {
              execSync(`"${ffmpegPath}" -i "${sceneImagePath}" -vf "scale='if(gt(iw,ih),1200,-2)':'if(gt(iw,ih),-2,1200)'" -q:v 2 -y "${tmpJpeg}"`, { timeout: 15000, stdio: 'pipe' });
              imageData = fs.readFileSync(tmpJpeg);
              mimeType = 'image/jpeg';
              try { fs.unlinkSync(tmpJpeg); } catch (_) {}
            } catch (convErr) {
              this.log(`[SHOT-RECONCILE] WebP conversion failed: ${convErr.message} — using prompt as-is`);
              return prompt;
            }
          } else {
            this.log('[SHOT-RECONCILE] Cannot convert webp without ffmpeg — using prompt as-is');
            return prompt;
          }
        }
      }

      const base64Image = imageData.toString('base64');

      // ── Pre-analysis: extract shot directions and word counts ──
      const shotPattern = /(Shot\s*(\d+)\s*\([^)]*\)\s*:\s*)([\s\S]*?)(?=Shot\s*\d+\s*\(|$)/gi;
      const originalShots = [];
      let shotMatch;
      while ((shotMatch = shotPattern.exec(prompt)) !== null) {
        const shotNum = parseInt(shotMatch[2]);
        const shotBody = shotMatch[3].trim();
        const hasDialogue = /\[@[^\]]+,\s*speaking[^\]]*\]\s*:\s*"/.test(shotBody);
        const wordCount = shotBody.split(/\s+/).filter(w => w.length > 0).length;
        // Count action verbs (common body action verbs in shot directions)
        const actionVerbPattern = /\b(turns?|walks?|steps?|reaches?|grabs?|leans?|stands?|sits?|rises?|moves?|shifts?|crosses?|gestures?|points?|pushes?|pulls?|opens?|closes?|lifts?|drops?|places?|sets?|picks?|exits?|enters?|approaches?|retreats?|spins?|pivots?|bends?|stretches?|climbs?)\b/gi;
        const actionVerbs = (shotBody.match(actionVerbPattern) || []).length;
        originalShots.push({ shotNum, shotBody, hasDialogue, wordCount, actionVerbs });
      }

      if (originalShots.length === 0) {
        this.log('[SHOT-RECONCILE] No shot directions found in prompt — skipping');
        return prompt;
      }

      // Build verified positions summary for the prompt
      const positionsSummary = verifiedPositions.map(c =>
        `@${c.name}: ${c.position || 'unknown position'}`
      ).join('\n');

      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });

      // Build character visual descriptions for independent identification
      const bible = this.state.script?.character_bible || [];
      const charIdentBlock = verifiedPositions.map(c => {
        const baseName = (c.baseName || c.name).toLowerCase();
        const charEntry = bible.find(be => {
          const hint = (be.element_name_hint || '').toLowerCase().replace(/^@/, '');
          const charId = (be.id || '').toLowerCase();
          return hint === baseName || charId === baseName ||
            hint === c.name.toLowerCase() || charId === c.name.toLowerCase();
        });
        const desc = charEntry?.full_prompt_description
          ? (charEntry.full_prompt_description.length > 150
            ? charEntry.full_prompt_description.slice(0, 150) + '...'
            : charEntry.full_prompt_description)
          : (charEntry?.description_label || baseName);
        return `- @${c.name}: ${desc}`;
      }).join('\n');

      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mimeType, data: base64Image },
            },
            {
              type: 'text',
              text: `You are reconciling shot directions with character positions for an AI video generation pipeline (Kling).

CHARACTERS IN THIS SCENE (identify by visual description):
${charIdentBlock}

SPATIAL CONTEXT: This is a Nigerian production. All vehicles are LEFT-HAND DRIVE (steering wheel on the LEFT side of the vehicle). The person behind the steering wheel is the DRIVER. In vehicle scenes, ALWAYS locate the steering wheel FIRST to determine who is the driver and who is the passenger.

STEP 1 — INDEPENDENTLY IDENTIFY CHARACTER POSITIONS:
Look at the scene image. Using ONLY the visual descriptions above (clothing, hair, body type) and spatial anchors (steering wheel position for vehicles), determine WHERE each character actually is. Do NOT read ahead to the claimed positions below — form your own assessment first.

After forming your assessment, compare with these CLAIMED POSITIONS:
${positionsSummary}

If your independent assessment CONTRADICTS the claimed positions (e.g., you see the woman in sage green behind the steering wheel but the claim says she's in the passenger seat), return ONLY:
BLOCKING_MISMATCH: <describe what's wrong — who is actually where vs what was claimed>
Do NOT attempt to fix shot directions if the positions are wrong.

STEP 2 — IF POSITIONS ARE CORRECT, check each shot's directions against the scene image:

${prompt}

Check for TWO types of problems:

A) PHYSICALLY IMPOSSIBLE ACTIONS — body actions that can't happen given where the character is (e.g., "turns toward the ignition" but the character isn't in the driver's seat).

B) VISUAL-STATE CONTRADICTIONS — shot directions that describe a wardrobe, prop, spatial position, or appearance state that CONTRADICTS what's visible in the scene image. The scene image is the start frame — Kling cannot change what's already rendered. Check ALL of these categories:

   WARDROBE: Does the shot describe clothing that doesn't match the image?
   - "jacket off, sleeves rolled" but the character is wearing a jacket in the image

   PROPS IN HAND: Does the shot reference a prop the character isn't holding/near in the image?
   - "hand tightens on her handbag strap" but the character is holding a mug in the image
   - "holding a briefcase" but no briefcase is visible anywhere in the image

   SPATIAL POSITION: Does the shot place a character somewhere they aren't in the image?
   - "standing near the door" but the character is seated on the sofa in the image
   - "has risen from the chair, standing now" but the character is clearly seated
   - "standing" but the character is clearly seated in the image

   FACING DIRECTION: Does the shot require a face angle that's impossible given how the character faces in the image?
   - EXTREME CLOSE-UP on character's face but the character's back is partially to the camera in the image
   - "looks directly into camera" but the character is in profile view

   APPEARANCE: Does the shot describe a look that doesn't match?
   - "hair down" but the character's hair is pinned up in the image

CRITICAL GUARDRAILS — you MUST follow these:
1. ONLY fix physically impossible actions (A) or visual-state contradictions (B). Leave everything else EXACTLY as-is.
2. For VISUAL-STATE CONTRADICTIONS: STRIP the contradicting detail entirely — do NOT invent a replacement. If "jacket off, sleeves rolled" contradicts the image, just remove that phrase. The character will appear as they do in the start frame, which is correct.
3. For shots WITH dialogue (containing [@character, speaking...]: "..."):
   - PREFER removing the impossible action entirely over replacing it
   - If you must replace, use a SUBTLE gesture only: "nods", "glances down", "shifts slightly", "sits still"
   - MAX 1 action verb in the entire shot direction when dialogue is present
4. For shots WITHOUT dialogue:
   - Replace with a SIMPLER action that works from the character's actual position
   - MAX 2 action verbs
5. NEVER make a shot direction LONGER than the original. Aim shorter.
6. NEVER add new actions, new object interactions, or elaborate choreography.
7. Keep ALL dialogue, camera directions, tone markers, and @ character references EXACTLY as-is.
8. If ALL shot directions are valid (no impossible actions AND no visual contradictions), return "NO_CHANGES_NEEDED" (nothing else).

OUTPUT FORMAT: Return the COMPLETE modified prompt (all shots, not just changed ones). Preserve exact formatting, line breaks, and structure. Change ONLY the specific phrases that are impossible or contradictory.`,
            },
          ],
        }],
      });

      let resultText = (response.content?.[0]?.text || '').trim();
      this.log(`[SHOT-RECONCILE] Raw response (first 300 chars): ${resultText.slice(0, 300)}`);

      // Strip markdown code block wrapping if present
      // Claude often wraps output in ```...``` or ```text...```
      const mdBlock = resultText.match(/^```(?:\w+)?\s*\n([\s\S]*?)\n```\s*$/);
      if (mdBlock) {
        resultText = mdBlock[1].trim();
        this.log('[SHOT-RECONCILE] Stripped markdown code block wrapping');
      }

      // ── Strip reasoning from Vision response ──
      // Vision echoes STEP 1/STEP 2 analysis mixed into its response.
      // Strategy: extract the CHARACTER POSITIONS line + scene setting + shot directions,
      // discard everything else (reasoning, audit notes, markdown headers, dividers).
      //
      // The clean prompt structure is always:
      //   CHARACTER POSITIONS (matching start frame): ...
      //   <blank line>
      //   <scene setting line>
      //   <blank line>
      //   Shot 1 (...): ...
      //   Shot 2 (...): ...
      //   Shot 3 (...): ...
      {
        // Step A: Extract or recover CHARACTER POSITIONS line
        const charPosLineMatch = resultText.match(/^(CHARACTER POSITIONS \(matching start frame\):[^\n]+)/m);
        let charPosLine = null;
        if (charPosLineMatch) {
          charPosLine = charPosLineMatch[1];
        } else {
          // Vision omitted it — recover from original prompt
          const origMatch = prompt.match(/^(CHARACTER POSITIONS[^\n]+)/m);
          if (origMatch) {
            charPosLine = origMatch[1];
            this.log('[SHOT-RECONCILE] Vision omitted CHARACTER POSITIONS — recovering from original prompt');
          }
        }

        // Step B: Find everything from the scene setting line through end of shots
        // Scene setting line is the non-shot, non-blocking line before Shot 1
        // (e.g. "Inside the living room from the reference image. Soft afternoon light.")
        const shotIdx = resultText.search(/^Shot\s*1\s*\(/m);
        if (shotIdx > 0) {
          // Look backwards from Shot 1 for the scene setting line
          const beforeShots = resultText.slice(0, shotIdx);
          // Find the last non-empty, non-reasoning line before Shot 1
          // Reasoning lines contain: **, ---, STEP, CONFIRMED, ✅, →, Physically
          const lines = beforeShots.split('\n');
          let sceneSettingStart = -1;
          for (let li = lines.length - 1; li >= 0; li--) {
            const line = lines[li].trim();
            if (!line) continue;
            // Skip reasoning/formatting lines
            if (/^(\*\*|---|STEP|CONFIRMED|BLOCKING|✅|→|Physically|Shot\s|The\s+(woman|man|person)\s+in\s+the\s+image|Claimed|Shots?\s+\d.*(:?\s+✅|\s+—)|CHARACTER POSITIONS)/i.test(line)) continue;
            // This should be the scene setting line
            sceneSettingStart = beforeShots.lastIndexOf(line);
            break;
          }

          let promptBody;
          if (sceneSettingStart >= 0) {
            promptBody = resultText.slice(sceneSettingStart).trim();
          } else {
            // Couldn't find scene setting — just take from Shot 1
            promptBody = resultText.slice(shotIdx).trim();
          }

          // Reassemble: CHARACTER POSITIONS + scene setting + shots
          if (charPosLine) {
            const cleaned = charPosLine + '\n\n' + promptBody;
            if (cleaned.length !== resultText.length) {
              this.log(`[SHOT-RECONCILE] Stripped reasoning: ${resultText.length} → ${cleaned.length} chars`);
            }
            resultText = cleaned;
          } else {
            resultText = promptBody;
          }
        }
      }

      // ── Check for BLOCKING_MISMATCH — 2nd Vision pass got it wrong ──
      if (resultText.startsWith('BLOCKING_MISMATCH') || resultText.includes('BLOCKING_MISMATCH:')) {
        this.log(`[SHOT-RECONCILE] ⚠ BLOCKING MISMATCH DETECTED: ${resultText.slice(0, 200)}`);
        this.log('[SHOT-RECONCILE] 2nd Vision pass misidentified characters — signalling re-verification needed');
        // Return special marker so the caller can trigger re-verification
        return '__BLOCKING_MISMATCH__';
      }

      // ── Check for no-changes response ──
      if (resultText === 'NO_CHANGES_NEEDED' || resultText.includes('NO_CHANGES_NEEDED')) {
        this.log('[SHOT-RECONCILE] All shot directions are physically valid — no changes needed');
        return prompt;
      }

      // ── Post-validation: enforce guardrails in code ──
      const reconciledShots = [];
      const reconciledPattern = /(Shot\s*(\d+)\s*\([^)]*\)\s*:\s*)([\s\S]*?)(?=Shot\s*\d+\s*\(|$)/gi;
      let reconMatch;
      while ((reconMatch = reconciledPattern.exec(resultText)) !== null) {
        const shotNum = parseInt(reconMatch[2]);
        const shotBody = reconMatch[3].trim();
        const wordCount = shotBody.split(/\s+/).filter(w => w.length > 0).length;
        const actionVerbPattern = /\b(turns?|walks?|steps?|reaches?|grabs?|leans?|stands?|sits?|rises?|moves?|shifts?|crosses?|gestures?|points?|pushes?|pulls?|opens?|closes?|lifts?|drops?|places?|sets?|picks?|exits?|enters?|approaches?|retreats?|spins?|pivots?|bends?|stretches?|climbs?)\b/gi;
        const actionVerbs = (shotBody.match(actionVerbPattern) || []).length;
        reconciledShots.push({ shotNum, shotBody, wordCount, actionVerbs });
      }

      // Validate each shot against original — per-shot granular guardrails.
      // Shots that got shorter/simpler are accepted (visual-state stripping).
      // Shots that grew or gained verbs are rejected (Vision adding choreography)
      // and fall back to the ORIGINAL shot direction for that shot only.
      let anyViolation = false;
      for (const recon of reconciledShots) {
        const orig = originalShots.find(o => o.shotNum === recon.shotNum);
        if (!orig) continue;

        let shotViolated = false;

        // Check word count ceiling (20% tolerance)
        if (recon.wordCount > orig.wordCount * 1.2) {
          this.log(`[SHOT-RECONCILE] GUARDRAIL: Shot ${recon.shotNum} grew from ${orig.wordCount} → ${recon.wordCount} words — reverting this shot to original`);
          shotViolated = true;
        }

        // Check action verb count didn't increase
        if (!shotViolated && recon.actionVerbs > orig.actionVerbs) {
          this.log(`[SHOT-RECONCILE] GUARDRAIL: Shot ${recon.shotNum} action verbs increased from ${orig.actionVerbs} → ${recon.actionVerbs} — reverting this shot to original`);
          shotViolated = true;
        }

        if (shotViolated) {
          anyViolation = true;
          // Replace just this shot's body with the original in resultText
          // Find the reconciled shot in resultText and swap its body back
          const shotHeaderPattern = new RegExp(
            `(Shot\\s*${recon.shotNum}\\s*\\([^)]*\\)\\s*:\\s*)([\\s\\S]*?)(?=Shot\\s*\\d+\\s*\\(|$)`,
            'i'
          );
          const origBody = orig.shotBody;
          resultText = resultText.replace(shotHeaderPattern, (match, header) => {
            return header + origBody + '\n\n';
          });
          this.log(`[SHOT-RECONCILE] Shot ${recon.shotNum}: reverted to original direction (kept other shots' fixes)`);
        }
      }

      if (anyViolation) {
        this.log('[SHOT-RECONCILE] Per-shot guardrail applied — accepted valid fixes, reverted violating shots to originals');
      }

      // Validate shot count matches
      if (reconciledShots.length !== originalShots.length) {
        this.log(`[SHOT-RECONCILE] Shot count mismatch: original=${originalShots.length}, reconciled=${reconciledShots.length} — using original prompt`);
        return prompt;
      }

      // ── Log changes ──
      let changes = 0;
      for (const recon of reconciledShots) {
        const orig = originalShots.find(o => o.shotNum === recon.shotNum);
        if (orig && recon.shotBody !== orig.shotBody) {
          changes++;
          this.log(`[SHOT-RECONCILE] Shot ${recon.shotNum}: "${orig.shotBody.slice(0, 60)}..." → "${recon.shotBody.slice(0, 60)}..."`);
          if (orig.wordCount !== recon.wordCount) {
            this.log(`[SHOT-RECONCILE]   Words: ${orig.wordCount} → ${recon.wordCount} (${recon.wordCount <= orig.wordCount ? '✓ within budget' : '⚠ grew'})`);
          }
          if (orig.actionVerbs !== recon.actionVerbs) {
            this.log(`[SHOT-RECONCILE]   Action verbs: ${orig.actionVerbs} → ${recon.actionVerbs} (${recon.actionVerbs <= orig.actionVerbs ? '✓ simplified' : '⚠ added'})`);
          }
        }
      }

      if (changes === 0) {
        this.log('[SHOT-RECONCILE] Vision returned prompt but no shot directions actually changed');
        return prompt;
      }

      this.log(`[SHOT-RECONCILE] ✓ Reconciled ${changes}/${originalShots.length} shot direction(s) with verified blocking`);

      // ── Final character budget check ──
      const KLING_CHAR_LIMIT = 2500;
      if (resultText.length > KLING_CHAR_LIMIT) {
        this.log(`[SHOT-RECONCILE] Reconciled prompt ${resultText.length} chars exceeds ${KLING_CHAR_LIMIT} limit — using original prompt`);
        return prompt;
      }

      return resultText;

    } catch (e) {
      this.log(`[SHOT-RECONCILE] Reconciliation failed: ${e.message} — using prompt as-is`);
      return prompt;
    }
  }

  /**
   * Generate ALL scene images for a cinematic-mode project via Cinema Studio 3.5.
   * Replaces the standard scene-image generation when generator_mode = 'cinematic'.
   *
   * For each scene:
   *   - Resolve @location_name from scene.location_element_hint
   *   - Resolve @character_name(s) from scene.characters_present (via state.cinematicElementNames)
   *   - Compose blocking prompt from scene.blocking
   *   - Call CinemaStudioAutomation.generateSceneImage()
   *   - Save as scene_image_cinematic asset type
   *
   * Idempotent on resume — skip scenes whose scene_image_cinematic asset already exists.
   */
  async _runCinematicSceneImageStage(projectId, projectDir) {
    const fs = require('fs');
    const path = require('path');
    const { CinemaStudioAutomation } = require('../automation/cinema-studio-automation');

    // ── HARD GATE: project must exist before scenes can run ──
    // The project is created during _runCinematicElementSetup (element stage).
    // If we don't have a project ID here, the element stage didn't complete
    // properly — halt rather than creating a duplicate or orphaned project.
    if (!this.state.higgsfield_project_id) {
      // Last resort: check DB settings in case state wasn't hydrated
      try {
        const proj = db.getProject(projectId);
        const settings = proj?.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
        if (settings.higgsfield_cinema_project_id) {
          this.state.higgsfield_project_id = settings.higgsfield_cinema_project_id;
          this.log(`[CINEMATIC] Recovered Higgsfield project ID from DB: ${settings.higgsfield_cinema_project_id}`);
        }
      } catch (_) {}
    }
    if (!this.state.higgsfield_project_id) {
      throw new Error('[STAGE GATE] Cannot start scene generation — no Higgsfield project ID. The element-setup stage must create a project first. Fix the element stage and restart the pipeline.');
    }
    this.log(`[CINEMATIC] Using Higgsfield project ID: ${this.state.higgsfield_project_id}`);

    const cinema = new CinemaStudioAutomation({
      automation: this.automation,
      logger: (m) => this.log(`[CINEMATIC] ${m}`),
      projectId: this.state.higgsfield_project_id,
    });
    // Pass element name map so scene prompt can translate @character_N → @element_name
    cinema._elemMap = this.state.cinematicElementNames || {};

    const sceneDir = path.join(projectDir, 'assets', 'scenes');
    fs.mkdirSync(sceneDir, { recursive: true });



    const script = this.state.script;
    const allScenes = [];
    for (const ch of (script.chapters || [])) {
      for (const sc of (ch.scenes || [])) {
        allScenes.push({ chapter: ch.chapter_number, scene: sc });
      }
    }

    const existingScenes = db.getAssets(projectId, { type: 'scene_image_cinematic' });
    const existingByKey = {};
    for (const a of existingScenes) {
      if (a.status === 'done' && a.file_path && fs.existsSync(a.file_path)) {
        existingByKey[`${a.chapter}_${a.scene}`] = a.file_path;
      }
    }

    // ── STALE ASSET CLEANUP ──
    // Remove scene_image_cinematic assets that don't match any scene in the
    // current script. These accumulate from previous runs with different scripts
    // or from duplicate insertExpectedAssets calls on restart. Without cleanup,
    // verifyStageComplete() sees them as pending and blocks the pipeline.
    const validKeys = new Set(allScenes.map(s => `${s.chapter}_${s.scene.scene_number}`));
    const staleAssets = existingScenes.filter(a => a.status !== 'archived' && !validKeys.has(`${a.chapter}_${a.scene}`));
    if (staleAssets.length > 0) {
      this.log(`[CINEMATIC] Cleaning up ${staleAssets.length} stale scene_image_cinematic assets (not in current script)`);
      for (const a of staleAssets) {
        db.deleteAsset(a.id);
      }
    }

    // ── DEDUP: remove duplicate pending assets for the same chapter_scene ──
    // Each restart of the scene loop calls insertExpectedAssets for pending scenes,
    // creating duplicate rows. Keep only one asset per chapter+scene (prefer done > generating > pending).
    const freshAssets = db.getAssets(projectId, { type: 'scene_image_cinematic' })
      .filter(a => a.status !== 'archived'); // archived rows are not duplicates — they're history
    const seenKeys = {};
    const dupeIds = [];
    // Sort so 'done' comes first, then 'generating', then 'pending'
    const statusOrder = { done: 0, generating: 1, pending: 2 };
    const sorted = [...freshAssets].sort((a, b) => (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9));
    for (const a of sorted) {
      const key = `${a.chapter}_${a.scene}`;
      if (seenKeys[key]) {
        dupeIds.push(a.id);
      } else {
        seenKeys[key] = a.id;
      }
    }
    if (dupeIds.length > 0) {
      this.log(`[CINEMATIC] Removing ${dupeIds.length} duplicate scene_image_cinematic assets`);
      for (const id of dupeIds) {
        db.deleteAsset(id);
      }
    }

    // ── DIAGNOSTIC: dump location map before scene loop ──
    const _locMap = this.state.cinematicLocations || {};
    this.log(`[CINEMATIC] Location map (${Object.keys(_locMap).length} entries):`);
    for (const [k, v] of Object.entries(_locMap)) {
      this.log(`[CINEMATIC]   "${k}" → ${v.imagePath || '(no path)'}`);
    }
    // Also dump each scene's location_element_hint for cross-reference
    for (const { chapter: ch, scene: sc } of allScenes) {
      this.log(`[CINEMATIC]   Scene Ch${ch} Sc${sc.scene_number}: location_element_hint="${sc.location_element_hint}"`);
    }

    let idx = 0;
    let browserDead = false; // Cascade protection: stop retrying if browser died

    // ── CONTINUITY TRACKING: remember the last generated/existing scene image per location ──
    // When consecutive scenes share the same location, the previous scene's output
    // image is passed to _refineBlockingWithVision so Vision can maintain character positions.
    const lastSceneImageByLocation = {}; // location_hint → file path

    for (const { chapter, scene } of allScenes) {
      idx++;
      const key = `${chapter}_${scene.scene_number}`;
      const sceneLocHint = (scene.location_element_hint || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      this.emit({ type: 'progress', stage: 'cinematic-scenes', current: idx, total: allScenes.length });

      if (existingByKey[key]) {
        this.log(`[CINEMATIC] Scene Ch${chapter} Sc${scene.scene_number} already generated — skipping`);
        // Track this existing scene for continuity even though we're skipping generation
        if (sceneLocHint) lastSceneImageByLocation[sceneLocHint] = existingByKey[key];
        continue;
      }

      // ── CASCADE PROTECTION: if the browser died (user closed, crash), skip remaining scenes ──
      if (browserDead || this.automation._userClosedBrowser) {
        this.log(`[CINEMATIC] Scene Ch${chapter} Sc${scene.scene_number}: skipped (browser closed — cascade protection)`);
        continue;
      }

      // Resolve location — source of truth is the LOCAL image file
      // MUST apply same key cleaning as _runCinematicLocationSetup (lowercase + strip non-alnum)
      // to avoid key mismatch when the script's location_element_hint has different casing.
      const locHintClean = (scene.location_element_hint || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const locInfo = _locMap[locHintClean] || _locMap[scene.location_element_hint] || null;
      if (!locInfo || !locInfo.imagePath) {
        this.log(`[CINEMATIC] Ch${chapter} Sc${scene.scene_number}: no location image for hint "${scene.location_element_hint}" (clean: "${locHintClean}") — skipping`, 'warn');
        this.log(`[CINEMATIC]   Available locations: ${Object.keys(_locMap).join(', ') || '(none)'}`, 'warn');
        continue;
      }
      this.log(`[CINEMATIC] Ch${chapter} Sc${scene.scene_number}: location="${scene.location_element_hint}" (clean: "${locHintClean}") → ${locInfo.imagePath}`);

      // Resolve characters from blocking.
      // ONE NAME TO RULE THEM ALL: the blocking @mention IS the element name.
      // @mama_agbado in blocking text = element "mama_agbado" in Higgsfield.
      // Direct lookup, no translation needed.
      const characters = [];
      const blocking = scene.blocking || {};
      const elemMap = this.state.cinematicElementNames || {};
      for (const [pos, hint] of [['frame-left', blocking.frame_left], ['frame-center', blocking.frame_center], ['frame-right', blocking.frame_right]]) {
        if (!hint) continue;
        const matches = (typeof hint === 'string' ? hint : '').match(/@([a-z0-9_]+)/gi) || [];
        for (const m of matches) {
          const charId = m.slice(1).toLowerCase();
          // Element name = blocking @mention (one name to rule them all).
          // Direct lookup — no translation needed.
          const elementName = elemMap[charId] || elemMap[`@${charId}`] || null;

          if (!elementName) {
            this.log(`[CINEMATIC] WARN: blocking ref "${m}" not in element map. Available: ${Object.keys(elemMap).join(', ')}`, 'warn');
          }
          // Derive baseName by stripping the suffix from the element name
          // e.g. "adanna_mseb_0419" → "adanna", "son_emeka_bpdr_0419" → "son_emeka"
          const resolvedName = elementName || charId;
          const baseMatch = resolvedName.match(/^(.+)_[a-z]{2,5}_\d{4}$/);
          const baseName = baseMatch ? baseMatch[1] : resolvedName;
          characters.push({ name: resolvedName, baseName, position: `${pos}: ${hint.replace(/@[a-z0-9_]+/gi, '').trim()}` });
        }
      }

      // Deduplicate characters by name — a character mentioned in multiple
      // frame positions (e.g. frame_center AND frame_right) gets pushed twice.
      // Keep the first occurrence (earliest frame position = most prominent).
      const seenChars = new Set();
      const dedupedCharacters = characters.filter(c => {
        const key = c.name.toLowerCase();
        if (seenChars.has(key)) {
          this.log(`[CINEMATIC] Ch${chapter} Sc${scene.scene_number}: dropping duplicate character "${c.name}" (already added)`);
          return false;
        }
        seenChars.add(key);
        return true;
      });

      if (dedupedCharacters.length === 0) {
        this.log(`[CINEMATIC] Ch${chapter} Sc${scene.scene_number}: no characters resolved from blocking — skipping`, 'warn');
        continue;
      }
      if (dedupedCharacters.length !== characters.length) {
        this.log(`[CINEMATIC] Ch${chapter} Sc${scene.scene_number}: deduped ${characters.length} → ${dedupedCharacters.length} character(s)`);
      }

      const outputPath = path.join(sceneDir, `ch${String(chapter).padStart(2, '0')}_sc${String(scene.scene_number).padStart(2, '0')}_cinematic.png`);

      // Insert asset row (with dedup — only if no row exists for this chapter+scene)
      const existingAsset = db.getAssets(projectId, { type: 'scene_image_cinematic' })
        .find(a => a.chapter === chapter && a.scene === scene.scene_number);
      if (!existingAsset) {
        db.insertExpectedAssets(projectId, [{ type: 'scene_image_cinematic', chapter, scene: scene.scene_number }]);
      }
      const sceneAsset = existingAsset || db.getAssets(projectId, { type: 'scene_image_cinematic' })
        .find(a => a.chapter === chapter && a.scene === scene.scene_number);

      // ── HARVEST-FIRST: Check if this scene already exists on the project page ──
      // Before spending credits on a new generation, scan the Higgsfield project's
      // Generations tab for an already-completed image matching this scene's prompt.
      // This handles: (1) previous generation that timed out but actually completed,
      // (2) resumed pipeline where images exist server-side but not locally.
      // ── HARVEST-FIRST REMOVED ──
      // Partial prompt matching is unreliable — raw script blocking never matches
      // vision-refined text, and character-only matching can't distinguish scenes.
      // Instead: let generation run with 240s timeout. If it times out,
      // _waitAndDownload does harvest-after-timeout with the EXACT submitted prompt.

      // ── VISION-BASED BLOCKING REFINEMENT ──
      // Send the location image to Claude Vision to get spatially-grounded blocking
      // that references actual objects in the scene (grill, counter, doorway, etc.)
      // instead of generic frame-left/center/right positions.
      // Falls back to original script blocking on any failure.
      // Lookup previous scene image at the same location for continuity
      const prevSceneImage = sceneLocHint ? (lastSceneImageByLocation[sceneLocHint] || null) : null;
      if (prevSceneImage) {
        this.log(`[CINEMATIC] Ch${chapter} Sc${scene.scene_number}: continuity ref from previous scene at "${sceneLocHint}": ${prevSceneImage}`);
      }
      this.log(`[CINEMATIC] Ch${chapter} Sc${scene.scene_number}: refining blocking via Claude Vision...`);
      const refinedCharacters = await this._refineBlockingWithVision(
        locInfo.imagePath,
        scene,
        dedupedCharacters,
        this.state.aspectRatio || '16:9',
        prevSceneImage
      );

      // ── STASH VISION-REFINED BLOCKING ──
      // Serialize the vision-refined character positions so they can be read back
      // at video gen time and injected into the Kling multi_shot_prompt.
      // This ensures the animation prompt matches the start frame image exactly.
      const visionBlockingJson = JSON.stringify({
        blocking,
        location_hint: scene.location_element_hint,
        vision_refined_characters: refinedCharacters,
      });

      // ── RETRY LOOP for scene image generation ──
      // Up to 3 attempts per scene. On failure: reset browser context and retry.
      // This catches transient failures like "page not ready", toolbar setup issues,
      // reference attachment flakes, etc. Same pattern as the video stage retry loop.
      const MAX_SCENE_RETRIES = 3;
      let sceneSuccess = false;
      for (let attempt = 1; attempt <= MAX_SCENE_RETRIES; attempt++) {
        try {
          if (sceneAsset) db.markAssetGenerating(sceneAsset.id, visionBlockingJson);
          const result = await cinema.generateSceneImage({
            locationImagePath: locInfo.imagePath,
            locationElementName: locInfo.elementName,
            characters: refinedCharacters,
            lighting: blocking.notes || '',
            outputPath,
            aspectRatio: this.state.aspectRatio || '16:9',
            projectName: this._titleInitials(this.state.selectedTitle || this.state.script?.title).toUpperCase(),
            onGenClicked: (creditCost) => {
              if (sceneAsset) db.markAssetGenClicked(sceneAsset.id, creditCost);
            },
          });
          if (sceneAsset) db.markAssetDone(sceneAsset.id, result.path, { model: result.model, sourceGenId: result.sourceGenId });
          sceneSuccess = true;
          break; // Success — exit retry loop
        } catch (e) {
          this.log(`[CINEMATIC] Scene image ATTEMPT ${attempt}/${MAX_SCENE_RETRIES} failed Ch${chapter} Sc${scene.scene_number}: ${e.message}`, 'warn');

          // ── CASCADE DETECTION: if the error indicates browser death or user abort, stop retrying ──
          const errMsg = e.message.toLowerCase();
          const isBrowserDead = (errMsg.includes('page') && (errMsg.includes('closed') || errMsg.includes('crashed'))) ||
                                (errMsg.includes('browser') && (errMsg.includes('closed') || errMsg.includes('disconnected')));
          const isUserAbort = errMsg.includes('aborted') || errMsg.includes('user closed');
          if (isBrowserDead || isUserAbort) {
            if (sceneAsset) db.markAssetFailed(sceneAsset.id, e.message);
            browserDead = true;
            cinema.abort();
            this.log(`[CINEMATIC] ${isUserAbort ? 'User abort' : 'Browser dead'} — stopping scene retries`, 'warn');
            break;
          }

          // ── PRE-RETRY HARVEST: if this was a timeout (credits likely burned),
          // attempt to recover the image from Higgsfield before re-generating.
          // The image may have completed server-side after our poll window closed.
          const isTimeout = errMsg.includes('timeout');
          const isPreGen = errMsg.includes('[pre-gen]');
          if (isTimeout && !isPreGen && attempt < MAX_SCENE_RETRIES) {
            this.log(`[CINEMATIC] Timeout on attempt ${attempt} — waiting 30s then attempting harvest recovery before retry...`);
            await new Promise(r => setTimeout(r, 30000)); // let Higgsfield finish
            try {
              // Build a recovery prompt from the blocking fields — these form the
              // core of what gets typed into Higgsfield's prompt textbox.
              // The prompt includes location, frame positions, and lighting notes.
              const blockingParts = [
                blocking.notes || '',
                blocking.frame_left || '',
                blocking.frame_center || '',
                blocking.frame_right || '',
              ].filter(Boolean).join(' ');
              const recoveryPrompt = blockingParts.length > 30 ? blockingParts : visionBlockingJson;
              const harvested = await cinema.attemptHarvestRecovery(recoveryPrompt, outputPath);
              if (harvested) {
                this.log(`[CINEMATIC] ✓ HARVEST RECOVERY succeeded for Ch${chapter} Sc${scene.scene_number} — no re-generation needed`);
                if (sceneAsset) db.markAssetDone(sceneAsset.id, outputPath, { model: 'cinematic-cameras', sourceGenId: harvested.sourceGenId });
                sceneSuccess = true;
                break; // exit retry loop — recovered successfully
              }
              this.log(`[CINEMATIC] Harvest recovery returned null — will retry generation`);
            } catch (harvestErr) {
              this.log(`[CINEMATIC] Harvest recovery failed: ${harvestErr.message} — will retry generation`, 'warn');
            }
          }

          if (attempt < MAX_SCENE_RETRIES) {
            // Reset browser context before retry — clears dirty state
            this.log(`[CINEMATIC] Resetting browser context before retry ${attempt + 1}...`);
            await new Promise(r => setTimeout(r, 3000));
            try {
              await cinema.resetFormForNextGeneration();
            } catch (resetErr) {
              this.log(`[CINEMATIC] WARN: Pre-retry reset failed: ${resetErr.message}`, 'warn');
            }
            await new Promise(r => setTimeout(r, 2000));
          } else {
            // Final attempt failed — mark as failed
            this.log(`[CINEMATIC] Scene Ch${chapter} Sc${scene.scene_number} FAILED after ${MAX_SCENE_RETRIES} attempts`, 'error');
            if (sceneAsset) db.markAssetFailed(sceneAsset.id, e.message);
          }
        }
      } // end retry loop

      // ── CONTINUITY: track the output image for same-location continuity ──
      if (sceneSuccess && sceneLocHint) {
        lastSceneImageByLocation[sceneLocHint] = outputPath;
      }

      if (browserDead) {
        this.log(`[CINEMATIC] Browser dead — skipping remaining ${allScenes.length - 1 - idx} scene(s)`, 'warn');
        break;
      }

      // ── INTER-GENERATION RESET (runs after EVERY scene — success or fail) ──
      // Nuke the browser context between scenes. Without this, the previous
      // prompt/reference/UI state persists and causes failures on the next scene
      // (+ button not found, stale text, leftover reference images, etc.)
      // Must run even after failures — a timed-out generation still leaves dirty state.
      if (idx < allScenes.length && !browserDead) {
        this.log(`[CINEMATIC] Resetting form before next scene (${5}s cooldown)...`);
        await new Promise(r => setTimeout(r, 5000)); // 5s cooldown for Higgsfield to settle
        try {
          await cinema.resetFormForNextGeneration();
        } catch (resetErr) {
          this.log(`[CINEMATIC] WARN: Form reset failed: ${resetErr.message} — continuing anyway`, 'warn');
        }
      }
    }

    // ── Fallback gate: if any scenes still missing, surface manual checklist ──
    // ⚠️ DESIGN INTENT: scene image generation MUST be automated. The manual
    // checklist that fires when this loop fails is a FALLBACK for diagnosis
    // — not the default path. If you see this firing routinely, priority work
    // is in CinemaStudioAutomation (selectors, picker tile detection, model
    // toggle, blocking prompt typing reliability) — see backlog in CLAUDE.md.
    const finalSceneAssets = db.getAssets(projectId, { type: 'scene_image_cinematic' });
    const missingScenes = [];
    for (const { chapter, scene } of allScenes) {
      const asset = finalSceneAssets.find(a => a.chapter === chapter && a.scene === scene.scene_number);
      if (!asset || asset.status !== 'done' || !asset.file_path || !fs.existsSync(asset.file_path)) {
        const _fbHintClean = (scene.location_element_hint || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
        const locInfo = _locMap[_fbHintClean] || _locMap[scene.location_element_hint] || null;
        const expectedPath = path.join(sceneDir, `ch${String(chapter).padStart(2, '0')}_sc${String(scene.scene_number).padStart(2, '0')}_cinematic.png`);
        missingScenes.push({
          chapter,
          scene: scene.scene_number,
          location: scene.location || scene.location_element_hint,
          locationImagePath: locInfo?.imagePath || null,
          characters_present: scene.characters_present || [],
          blocking: scene.blocking || null,
          expectedPath,
        });
      }
    }

    this.log(`[CINEMATIC] Scene image stage: ${allScenes.length - missingScenes.length}/${allScenes.length} done${missingScenes.length ? `, ${missingScenes.length} missing — pausing for manual completion` : ''}`);

    if (missingScenes.length > 0) {
      // Build a clear checklist + emit to UI
      const checklistLines = [
        '',
        '═══════════════════════════════════════════════════════════════',
        '  CINEMA STUDIO AUTOMATION INCOMPLETE — MANUAL SCENE IMAGES NEEDED',
        '═══════════════════════════════════════════════════════════════',
        '',
        `${missingScenes.length} scene image(s) couldn't be generated automatically (selector/UI fragility).`,
        'Generate each one manually in Cinema Studio 3.5 and save to the listed path:',
        '',
      ];
      // Translate @character_N refs → actual @element_names for manual use
      const elemMap = this.state.cinematicElementNames || {};
      const _xlat = (text) => {
        if (!text) return text;
        return text.replace(/@([a-z0-9_]+)/gi, (match, name) => {
          const resolved = elemMap[name.toLowerCase()] || elemMap[`@${name.toLowerCase()}`];
          return resolved ? `@${resolved}` : match;
        });
      };

      for (const m of missingScenes) {
        checklistLines.push(`  Ch${m.chapter} Sc${m.scene}: ${m.location || '(unknown location)'}`);
        if (m.locationImagePath) checklistLines.push(`    Location ref: ${m.locationImagePath}`);
        if (m.blocking) {
          if (m.blocking.frame_left)   checklistLines.push(`    Frame-left:   ${_xlat(m.blocking.frame_left)}`);
          if (m.blocking.frame_center) checklistLines.push(`    Frame-center: ${_xlat(m.blocking.frame_center)}`);
          if (m.blocking.frame_right)  checklistLines.push(`    Frame-right:  ${_xlat(m.blocking.frame_right)}`);
          if (m.blocking.notes)        checklistLines.push(`    Lighting:     ${_xlat(m.blocking.notes)}`);
        }
        checklistLines.push(`    Save to:      ${m.expectedPath}`);
        checklistLines.push('');
      }
      checklistLines.push('Steps for each scene:');
      checklistLines.push('  1. Open Higgsfield → Cinema Studio 3.5 (top nav)');
      checklistLines.push('  2. Select your project in the left sidebar (hover icons to find it)');
      checklistLines.push('  3. Click "Image" tab → ensure "Cinematic Cameras" is active in bottom toolbar');
      checklistLines.push('  4. Click + (left of prompt) → "Image Generations" tab → pick the location ref image listed above');
      checklistLines.push('  5. Type a blocking prompt using @character refs + the position descriptions above');
      checklistLines.push('  6. Set aspect ratio + 2K → Generate');
      checklistLines.push('  7. Right-click the result → Download → save to the "Save to" path above');
      checklistLines.push('');
      checklistLines.push('When all scene images exist on disk, click "Scene Images Ready — Continue" to proceed.');
      checklistLines.push('═══════════════════════════════════════════════════════════════');
      this.log(checklistLines.join('\n'), 'warn');

      // Translate blocking @refs in the emitted data so the UI shows real element names
      const translatedScenes = missingScenes.map(m => ({
        ...m,
        blocking: m.blocking ? {
          frame_left: _xlat(m.blocking.frame_left),
          frame_center: _xlat(m.blocking.frame_center),
          frame_right: _xlat(m.blocking.frame_right),
          notes: _xlat(m.blocking.notes),
        } : null,
      }));
      this.emit({ type: 'cinematic-manual-scene-images', pending: translatedScenes });
      this.state.status = 'waiting_approval';
      this.emit({ type: 'waiting', gate: 'scene-images-ready' });
      this.log('[CINEMATIC] Pipeline paused — finish scene image generation manually, then click "Scene Images Ready — Continue"');
      await this.waitForApproval('scene-images-ready');

      // After user clicks Continue: rescan the disk and mark any newly-present
      // scene images as done. Then re-check; if still missing, allow proceeding
      // anyway (with warning) so the user doesn't get permanently stuck.
      let manualRecovered = 0;
      for (const m of missingScenes) {
        if (fs.existsSync(m.expectedPath)) {
          const assets = db.getAssets(projectId, { type: 'scene_image_cinematic' })
            .filter(a => a.chapter === m.chapter && a.scene === m.scene);
          for (const a of assets) {
            db.markAssetDone(a.id, m.expectedPath, { model: 'cinematic-cameras-manual', sourceGenId: null });
          }
          manualRecovered++;
        }
      }
      this.log(`[CINEMATIC] Manual recovery: ${manualRecovered}/${missingScenes.length} scene images now present on disk`);
    }

    this.log(`[CINEMATIC] Scene image stage complete — ${allScenes.length} scenes processed`);
  }

  /**
   * Phase 4 stage: Kling 3.0 multi-shot video generation.
   *
   * Iterates the script's scene.kling_clips arrays. Each clip is one Kling
   * generation containing 2-4 dialogue lines packed into a single 10-12s
   * multi-shot output with native lip-synced audio.
   *
   * Start frame for each clip = the scene's scene_image_cinematic asset
   * (generated in Phase 3 via Cinema Studio 3.5).
   *
   * Idempotent on resume — clips with a kling_clip_id already marked done
   * are skipped. History recovery (Session 8 inline auto-recovery) doesn't
   * yet apply to cinematic clips — that's a future Phase 5+ improvement.
   */
  async _runCinematicVideoStage(projectId, projectDir) {
    const fs = require('fs');
    const path = require('path');
    const { KlingAutomation } = require('../automation/kling-automation');

    const kling = new KlingAutomation({
      automation: this.automation,
      logger: (m) => this.log(`[CINEMATIC] ${m}`),
    });

    const clipsDir = path.join(projectDir, 'assets', 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });

    // Walk scenes, collect kling_clips with their scene image references
    const allKlingClips = [];
    for (const ch of (this.state.script?.chapters || [])) {
      for (const sc of (ch.scenes || [])) {
        const klingClips = sc.kling_clips || [];
        if (klingClips.length === 0) continue;
        // Find the scene's cinematic image (start frame source)
        const sceneImageAsset = db.getAssets(projectId, { type: 'scene_image_cinematic' })
          .find(a => a.chapter === ch.chapter_number && a.scene === sc.scene_number && a.status === 'done');
        if (!sceneImageAsset || !sceneImageAsset.file_path || !fs.existsSync(sceneImageAsset.file_path)) {
          this.log(`[CINEMATIC] Ch${ch.chapter_number} Sc${sc.scene_number}: no scene image found, skipping ${klingClips.length} kling clips`, 'warn');
          continue;
        }
        // ── RETRIEVE STASHED VISION-REFINED BLOCKING ──
        // The scene image's prompt_used contains the vision-refined character
        // positions that were used to generate the start frame. We inject these
        // into the Kling multi_shot_prompt so the animation matches the image.
        let visionRefinedChars = null;
        let visionBlockingVerified = false;
        try {
          const stashed = sceneImageAsset.prompt_used;
          if (stashed) {
            const parsed = typeof stashed === 'string' ? JSON.parse(stashed) : stashed;
            if (parsed.vision_refined_characters && Array.isArray(parsed.vision_refined_characters)) {
              visionRefinedChars = parsed.vision_refined_characters;
              // Check if this blocking was already verified against the scene image
              visionBlockingVerified = parsed.vision_blocking_verified === true;
              const verifiedTag = visionBlockingVerified ? ' (already verified)' : '';
              this.log(`[CINEMATIC] Ch${ch.chapter_number} Sc${sc.scene_number}: loaded ${visionRefinedChars.length} vision-refined blocking(s)${verifiedTag}`);
            }
          }
        } catch (parseErr) {
          this.log(`[CINEMATIC] Ch${ch.chapter_number} Sc${sc.scene_number}: could not parse stashed blocking — using original multi_shot_prompt`, 'warn');
        }

        // NOTE: Blocking verification against the rendered scene image is done
        // LAZILY in the clip generation loop below — only when the first pending
        // clip for a scene is encountered. This avoids 64 Vision API calls at
        // startup for scenes whose clips are all already done.

        for (const clipDef of klingClips) {
          allKlingClips.push({
            chapter: ch.chapter_number,
            scene: sc.scene_number,
            clipDef,
            startFramePath: sceneImageAsset.file_path,
            startFrameGenId: sceneImageAsset.source_gen_id,
            sceneAssetId: sceneImageAsset.id,
            visionRefinedChars,
            visionBlockingVerified,
          });
        }
      }
    }

    if (allKlingClips.length === 0) {
      this.log('[CINEMATIC] No kling_clips entries in script — Phase 4 video stage has nothing to generate', 'warn');
      return;
    }

    this.log(`[CINEMATIC] Phase 4: ${allKlingClips.length} Kling clip(s) to generate`);

    // Resume-aware: identify clips already done or skipped by clip_id
    const existingClips = db.getAssets(projectId, { type: 'video_clip_cinematic' });
    const doneByClipId = {};
    const skippedByClipId = {};
    for (const a of existingClips) {
      if (a.status === 'done' && a.kling_clip_id && a.file_path && fs.existsSync(a.file_path)) {
        doneByClipId[a.kling_clip_id] = a.file_path;
      }
      if (a.status === 'skipped' && a.kling_clip_id) {
        skippedByClipId[a.kling_clip_id] = true;
      }
    }

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    let dialogueSkipped = 0;

    // ── LAZY VISION VERIFICATION CACHE ──
    // Blocking verification against the rendered scene image is expensive (~1 Sonnet
    // call per scene). We only run it when the first PENDING clip for a scene is
    // encountered, then cache the result for subsequent clips in the same scene.
    // Scenes whose clips are all done never trigger verification.
    const verifiedBlockingCache = {}; // "ch{N}_sc{M}" → { chars: corrected visionRefinedChars, hadCorrections: bool }
    const shotReconcileCache = {};   // clipId → true (reconciled shot directions for this clip)

    for (let i = 0; i < allKlingClips.length; i++) {
      const item = allKlingClips[i];
      let { chapter, scene, clipDef, startFramePath, startFrameGenId, sceneAssetId, visionRefinedChars, visionBlockingVerified } = item;
      const clipId = clipDef.clip_id || `ch${chapter}_sc${scene}_c${i + 1}`;
      const label = `${clipId} (Ch${chapter} Sc${scene}, ${clipDef.duration_seconds || 10}s, ${(clipDef.line_refs || []).length} line(s))`;

      this.emit({ type: 'progress', stage: 'cinematic-video', current: i + 1, total: allKlingClips.length });

      // Skip clips marked as 'skipped' during dialogue triage
      if (skippedByClipId[clipId]) {
        this.log(`[CINEMATIC] ${clipId} marked as skipped (no dialogue) — skipping video gen`);
        dialogueSkipped++;
        continue;
      }

      if (doneByClipId[clipId]) {
        this.log(`[CINEMATIC] ${clipId} already generated — skipping`);
        skipped++;
        continue;
      }

      // ── RESUME: Check if the clip file already exists on disk ──
      // Covers the gap where the file was downloaded but the DB wasn't updated
      // (crash between file write and markAssetDone).
      const expectedOutputPath = path.join(clipsDir, `${clipId}_cinematic.mp4`);
      if (fs.existsSync(expectedOutputPath)) {
        const stat = fs.statSync(expectedOutputPath);
        if (stat.size > 50000) { // sanity: >50KB means it's a real video, not a partial write
          this.log(`[CINEMATIC] ${clipId}: found existing file on disk (${(stat.size / 1024 / 1024).toFixed(2)} MB) — marking done`);
          const clipAssetForDisk = existingClips.find(a => a.kling_clip_id === clipId);
          if (clipAssetForDisk) {
            db.markAssetDone(clipAssetForDisk.id, expectedOutputPath, { model: 'kling-3.0' });
          }
          generated++;
          skipped++;
          this.state.videoClips = this.state.videoClips || [];
          this.state.videoClips.push({
            chapter, scene, clipId, path: expectedOutputPath, status: 'complete',
          });
          continue;
        }
      }

      // ── LAZY VISION BLOCKING VERIFICATION ──
      // Only runs once per scene, when the first pending clip is encountered.
      // Sends the rendered scene image to Claude Vision to verify/correct
      // character positions so Kling prompts match the actual start frame.
      // Once verified, the corrected blocking is persisted to DB so subsequent
      // runs skip the Vision call entirely.
      if (visionRefinedChars && visionRefinedChars.length > 0) {
        const sceneKey = `ch${chapter}_sc${scene}`;

        if (visionBlockingVerified && verifiedBlockingCache[sceneKey]) {
          // Already verified AND cached by a previous clip in THIS run — use cache
          // (cache may contain re-verified positions from a BLOCKING_MISMATCH fix)
          visionRefinedChars = verifiedBlockingCache[sceneKey].chars;
          item.visionRefinedChars = visionRefinedChars;
        } else if (visionBlockingVerified) {
          // Already verified in a previous run (persisted in DB) — skip Vision call
          // Load hadCorrections flag and manuallySwapped flag from DB.
          // DEFAULT hadCorrections TO TRUE when flag is missing — scenes verified
          // before Session 25 don't have this flag, and we'd rather run a cheap
          // 3rd pass check than silently propagate wrong blocking.
          let hadCorr = true; // safe default: assume corrections happened
          let manualSwap = false;
          if (sceneAssetId) {
            try {
              const sceneAssetCheck = db.getAssets(projectId, { type: 'scene_image_cinematic' })
                .find(a => a.id === sceneAssetId);
              if (sceneAssetCheck) {
                const pu = typeof sceneAssetCheck.prompt_used === 'string'
                  ? JSON.parse(sceneAssetCheck.prompt_used) : (sceneAssetCheck.prompt_used || {});
                // Only use false if the flag was EXPLICITLY set to false
                if (pu.blocking_had_corrections === false) hadCorr = false;
                else if (pu.blocking_had_corrections === true) hadCorr = true;
                // undefined → stays true (safe default)
                manualSwap = pu.manually_swapped === true;
              }
            } catch (_) {}
          }
          if (manualSwap) {
            this.log(`[VISION-VERIFY] ${sceneKey}: manually swapped — locked, skipping all Vision re-checks`);
            hadCorr = false; // prevent 3rd pass from running (and undoing the manual fix)
          }
          verifiedBlockingCache[sceneKey] = { chars: visionRefinedChars, hadCorrections: hadCorr, manuallySwapped: manualSwap };
        } else if (verifiedBlockingCache[sceneKey]) {
          // Already verified for this scene in THIS run — use cached result
          visionRefinedChars = verifiedBlockingCache[sceneKey].chars;
          item.visionRefinedChars = visionRefinedChars;
        } else {
          // First pending clip for this scene — verify now
          this.log(`[VISION-VERIFY] ${sceneKey}: verifying blocking against rendered scene image...`);

          // Build character visual descriptions from character_bible
          // so Vision can identify WHO is who in the scene image
          const characterDescs = [];
          const bible = this.state.script?.character_bible || [];
          for (const vc of visionRefinedChars) {
            const baseName = (vc.baseName || vc.name).toLowerCase();
            const char = bible.find(c => {
              const hint = (c.element_name_hint || '').toLowerCase().replace(/^@/, '');
              const charId = (c.id || '').toLowerCase();
              return hint === baseName || charId === baseName ||
                hint === vc.name.toLowerCase() || charId === vc.name.toLowerCase();
            });
            if (char) {
              // Use description_label (short) + key visual details from full_prompt_description
              const shortDesc = char.description_label || char.name || baseName;
              const fullDesc = char.full_prompt_description || '';
              // Extract just the visual identifiers (clothing, hair, body type)
              // from full_prompt_description — first 150 chars is usually enough
              const visualSnippet = fullDesc.length > 150 ? fullDesc.slice(0, 150) + '...' : fullDesc;
              characterDescs.push({
                name: baseName,
                description: visualSnippet || shortDesc,
              });
              this.log(`[VISION-VERIFY] ${baseName}: "${(visualSnippet || shortDesc).slice(0, 60)}..."`);
            } else {
              characterDescs.push({ name: baseName, description: baseName });
            }
          }

          const corrected = await this._verifyBlockingWithSceneImage(
            startFramePath,
            visionRefinedChars,
            characterDescs
          );

          // Detect whether corrections were made (compare positions)
          let hadCorrections = false;
          for (let ci = 0; ci < visionRefinedChars.length; ci++) {
            const orig = visionRefinedChars[ci];
            const corr = corrected[ci];
            if (corr && orig.position !== corr.position) {
              hadCorrections = true;
              break;
            }
          }
          if (hadCorrections) {
            this.log(`[VISION-VERIFY] ${sceneKey}: blocking had corrections — shot direction reconciliation will be triggered`);
          }

          visionRefinedChars = corrected;
          verifiedBlockingCache[sceneKey] = { chars: visionRefinedChars, hadCorrections };
          item.visionRefinedChars = visionRefinedChars;

          // Persist corrected blocking + verified flag + corrections flag to DB
          // so subsequent runs skip the Vision call entirely
          if (sceneAssetId) {
            try {
              const sceneAsset = db.getAssets(projectId, { type: 'scene_image_cinematic' })
                .find(a => a.id === sceneAssetId);
              if (sceneAsset) {
                const existing = typeof sceneAsset.prompt_used === 'string'
                  ? JSON.parse(sceneAsset.prompt_used)
                  : (sceneAsset.prompt_used || {});
                existing.vision_refined_characters = corrected;
                existing.vision_blocking_verified = true;
                existing.blocking_had_corrections = hadCorrections;
                db.updateAssetPromptUsed(sceneAssetId, existing);
                this.log(`[VISION-VERIFY] ${sceneKey}: persisted corrected blocking to DB ✓`);
              }
            } catch (dbErr) {
              this.log(`[VISION-VERIFY] ${sceneKey}: failed to persist to DB: ${dbErr.message}`, 'warn');
            }
          }
        }
      }

      // ── RESUME: Generate was clicked but download never completed ──
      // Credits were already burned — go straight to Asset library recovery
      // instead of re-generating. The gen_clicked_at timestamp survives
      // resetStuckAssets() on app restart.
      //
      // Signals that credits were burned:
      //   1. gen_clicked_at is set (explicit timestamp from onGenClicked callback)
      //   2. prompt_used is set AND error is NOT a [PRE-GEN] error
      //      (markAssetGenerating sets prompt_used before generateClip, but
      //       [PRE-GEN] errors mean Generate was never clicked — no credits burned)
      const existingAsset = existingClips.find(a => a.kling_clip_id === clipId);
      const isPreGenError = existingAsset?.error_message?.includes('[PRE-GEN]');
      const genWasClicked = existingAsset && existingAsset.status !== 'done' && (
        existingAsset.gen_clicked_at ||
        (existingAsset.prompt_used && !isPreGenError)
      );
      if (genWasClicked) {
        const signal = existingAsset.gen_clicked_at
          ? `gen_clicked_at=${existingAsset.gen_clicked_at}`
          : `error="${(existingAsset.error_message || '').slice(0, 60)}"`;
        this.log(`[CINEMATIC] ${clipId}: Generate was already clicked (${signal}) — attempting recovery instead of re-generating`);

        // Sanitize prompt for recovery matching (same as the normal flow)
        let recoveryPrompt = clipDef.multi_shot_prompt || '';
        const elemMap2 = this.state.cinematicElementNames || {};
        const validNames2 = new Set(Object.values(elemMap2).map(n => n.toLowerCase()));
        recoveryPrompt = recoveryPrompt.replace(/@([a-z0-9_]+)/gi, (match, name) => {
          if (validNames2.has(name.toLowerCase())) return match;
          return name;
        });

        const recoveryOutputPath = path.join(clipsDir, `${clipId}_cinematic.mp4`);
        try {
          const recovered = await kling.recoverTimedOutClip(recoveryPrompt, recoveryOutputPath, {
            minSimilarity: 75,  // lower threshold — prompt may have been modified by Kling
            maxTilesToCheck: 8,
            timeoutMs: 90000,
          });

          if (recovered) {
            this.log(`[CINEMATIC] ✓ ${clipId} RECOVERED from Asset library (similarity=${recovered.similarity}%, uuid=${recovered.assetUuid || 'unknown'})`);
            const clipAssetForRecovery = existingClips.find(a => a.kling_clip_id === clipId);
            if (clipAssetForRecovery) {
              db.markAssetDone(clipAssetForRecovery.id, recovered.path, {
                model: 'kling-3.0',
                sourceGenId: recovered.sourceGenId,
                cdnUrl: recovered.cdnUrl,
              });
            }
            generated++;
            this.state.videoClips = this.state.videoClips || [];
            this.state.videoClips.push({
              chapter, scene, clipId, path: recovered.path, status: 'complete',
            });
            this.emit({ type: 'clip-complete', index: i, path: recovered.path });

            // Approval gate after recovery
            if (i < allKlingClips.length - 1) {
              this.log(`[CINEMATIC] Waiting for clip approval (recovered): ${clipId}`);
              this.emit({
                type: 'waiting',
                gate: 'clip-review',
                clipId,
                clipPath: recovered.path,
                clipIndex: i,
                clipTotal: allKlingClips.length,
                clipLabel: label,
              });
              const decision = await this.waitForApproval('clip-review');
              if (decision === 'stop') {
                this.log(`[CINEMATIC] User stopped after ${clipId} — skipping remaining clips`);
                break;
              }
            }
            continue;
          } else {
            this.log(`[CINEMATIC] ${clipId}: recovery found no match — will re-generate (credits may be wasted)`);
            // Fall through to normal generation flow
          }
        } catch (recoveryErr) {
          this.log(`[CINEMATIC] ${clipId}: recovery error — ${recoveryErr.message} — will re-generate`, 'warn');
          // Fall through to normal generation flow
        }
      }

      // ── INJECT VISION-REFINED BLOCKING INTO MULTI_SHOT_PROMPT ──
      // The original multi_shot_prompt uses script blocking (e.g., "stands frame-left
      // near the wooden table"). The start frame image was generated with vision-refined
      // blocking that references actual objects in the location photo. We rewrite the
      // prompt's blocking to match the start frame so the animation is consistent.
      let finalMultiShotPrompt = clipDef.multi_shot_prompt || '';
      if (visionRefinedChars && visionRefinedChars.length > 0) {
        finalMultiShotPrompt = this._injectVisionBlocking(finalMultiShotPrompt, visionRefinedChars);
        this.log(`[CINEMATIC] ${clipId}: injected vision-refined blocking into multi_shot_prompt`);
      }

      // ── 3rd Vision Pass: reconcile shot directions with scene image ──
      // Runs for EVERY clip (not gated on sceneHadCorrections) because visual-state
      // contradictions (wardrobe, props in hand, position, facing direction) exist
      // regardless of whether the 2nd pass corrected blocking positions.
      // DB cache prevents re-running on previously reconciled clips.
      if (visionRefinedChars && visionRefinedChars.length > 0 && !shotReconcileCache[clipId]) {
        const sceneKey = `ch${chapter}_sc${scene}`;

        {
          // Check if this clip was already reconciled in a previous run (persisted in DB)
          const clipAsset = existingClips.find(a => a.kling_clip_id === clipId);
          let alreadyReconciled = false;
          if (clipAsset?.prompt_used) {
            try {
              const pu = typeof clipAsset.prompt_used === 'string'
                ? JSON.parse(clipAsset.prompt_used) : clipAsset.prompt_used;
              alreadyReconciled = pu?.shot_directions_reconciled === true;
            } catch (_) {}
          }

          if (alreadyReconciled) {
            this.log(`[SHOT-RECONCILE] ${clipId}: already reconciled (persisted in DB) — skipping`);
            shotReconcileCache[clipId] = true;
          } else {
            this.log(`[SHOT-RECONCILE] ${clipId}: reconciling shot directions with scene image...`);
            let reconcileResult = await this._reconcileShotDirectionsWithImage(
              startFramePath,
              visionRefinedChars,
              finalMultiShotPrompt
            );

            // ── BLOCKING MISMATCH: 2nd Vision pass misidentified characters ──
            // The 3rd pass detected that the "verified" positions don't match the
            // scene image (e.g. characters are swapped). Re-run 2nd Vision pass
            // with a fresh call, then re-inject and re-reconcile.
            if (reconcileResult === '__BLOCKING_MISMATCH__') {
              this.log(`[SHOT-RECONCILE] ${clipId}: triggering re-verification of 2nd Vision pass for ${sceneKey}...`);

              // Build character descriptions for re-verification
              const characterDescs = [];
              const bible = this.state.script?.character_bible || [];
              for (const vc of visionRefinedChars) {
                const baseName = (vc.baseName || vc.name).toLowerCase();
                const charEntry = bible.find(c => {
                  const hint = (c.element_name_hint || '').toLowerCase().replace(/^@/, '');
                  const charId = (c.id || '').toLowerCase();
                  return hint === baseName || charId === baseName ||
                    hint === vc.name.toLowerCase() || charId === vc.name.toLowerCase();
                });
                if (charEntry) {
                  const fullDesc = charEntry.full_prompt_description || '';
                  const visualSnippet = fullDesc.length > 200 ? fullDesc.slice(0, 200) + '...' : fullDesc;
                  characterDescs.push({ name: baseName, description: visualSnippet || charEntry.description_label || baseName });
                } else {
                  characterDescs.push({ name: baseName, description: baseName });
                }
              }

              // Re-run 2nd Vision pass (this time it should get positions right)
              const reCorrected = await this._verifyBlockingWithSceneImage(
                startFramePath,
                visionRefinedChars,
                characterDescs
              );

              // Check if re-verification actually changed anything
              let reVerifyChanged = false;
              for (let ci = 0; ci < visionRefinedChars.length; ci++) {
                if (reCorrected[ci] && visionRefinedChars[ci].position !== reCorrected[ci].position) {
                  reVerifyChanged = true;
                  break;
                }
              }

              if (reVerifyChanged) {
                this.log(`[SHOT-RECONCILE] ${sceneKey}: re-verification corrected positions — updating cache and DB`);
                visionRefinedChars = reCorrected;
                item.visionRefinedChars = visionRefinedChars;
                verifiedBlockingCache[sceneKey] = { chars: reCorrected, hadCorrections: true };

                // Persist corrected blocking to DB
                if (sceneAssetId) {
                  try {
                    const sceneAsset = db.getAssets(projectId, { type: 'scene_image_cinematic' })
                      .find(a => a.id === sceneAssetId);
                    if (sceneAsset) {
                      const existing = typeof sceneAsset.prompt_used === 'string'
                        ? JSON.parse(sceneAsset.prompt_used) : (sceneAsset.prompt_used || {});
                      existing.vision_refined_characters = reCorrected;
                      existing.vision_blocking_verified = true;
                      existing.blocking_had_corrections = true;
                      db.updateAssetPromptUsed(sceneAssetId, existing);
                      this.log(`[SHOT-RECONCILE] ${sceneKey}: persisted re-verified blocking to DB ✓`);
                    }
                  } catch (dbErr) {
                    this.log(`[SHOT-RECONCILE] ${sceneKey}: failed to persist: ${dbErr.message}`, 'warn');
                  }
                }

                // Re-inject corrected blocking into prompt
                finalMultiShotPrompt = clipDef.multi_shot_prompt || '';
                finalMultiShotPrompt = this._injectVisionBlocking(finalMultiShotPrompt, visionRefinedChars);
                this.log(`[SHOT-RECONCILE] ${clipId}: re-injected corrected blocking into prompt`);

                // Re-run 3rd pass with corrected positions
                reconcileResult = await this._reconcileShotDirectionsWithImage(
                  startFramePath,
                  visionRefinedChars,
                  finalMultiShotPrompt
                );

                if (reconcileResult === '__BLOCKING_MISMATCH__') {
                  // Still mismatched after re-verification — give up, use re-injected prompt as-is
                  this.log(`[SHOT-RECONCILE] ${clipId}: still mismatched after re-verification — using re-injected prompt as-is`);
                } else {
                  finalMultiShotPrompt = reconcileResult;
                }
              } else {
                this.log(`[SHOT-RECONCILE] ${sceneKey}: re-verification returned same positions — using prompt as-is`);
              }
            } else {
              finalMultiShotPrompt = reconcileResult;
            }

            shotReconcileCache[clipId] = true;
          }
        }
      }

      // ── SANITIZE @-REFERENCES ──
      // Only character names are valid Higgsfield elements. Location @-references
      // (e.g. @mama_agbado_corn_stall) don't resolve — strip the @ prefix so they
      // become plain descriptive text. This fixes prompts where Claude mistakenly
      // used @ on location names despite the rubric forbidding it.
      const elemMap = this.state.cinematicElementNames || {};
      const validElementNames = new Set(
        Object.values(elemMap).map(n => n.toLowerCase())
      );
      finalMultiShotPrompt = finalMultiShotPrompt.replace(/@([a-z0-9_]+)/gi, (match, name) => {
        if (validElementNames.has(name.toLowerCase())) {
          return match; // keep @character_name — it's a valid element
        }
        this.log(`[CINEMATIC] ${clipId}: stripped invalid @-ref "${match}" → "${name}"`);
        return name; // strip the @ — it's a location or typo
      });

      // ── REPLACE character_N with actual element names ──
      // The LLM sometimes uses "character_1", "character_3" etc. in shot
      // descriptions instead of the actual @element_name. Replace them
      // using the cinematicElementNames map (which indexes character_1 → real name).
      finalMultiShotPrompt = finalMultiShotPrompt.replace(/\bcharacter_(\d+)\b/gi, (match) => {
        const key = match.toLowerCase();
        const resolved = elemMap[key];
        if (resolved) {
          this.log(`[CINEMATIC] ${clipId}: replaced "${match}" → "@${resolved}"`);
          return `@${resolved}`;
        }
        return match; // no mapping found — leave as-is
      });

      // ── AUTO-FIX BARE CHARACTER NAMES → @element references ──
      // The LLM shot descriptions often use bare names like "mama_chisom" or
      // "adanna" without the @ prefix. Kling needs @element_name to identify
      // characters. Build a lookup from elemMap (which maps base names and
      // suffixed names to canonical suffixed names), sort longest-first to
      // avoid partial matches, then replace bare occurrences with @suffixed_name.
      {
        // Collect all name variants → canonical suffixed element name
        const bareFixMap = {};
        for (const [key, canonical] of Object.entries(elemMap)) {
          // Skip keys that start with @ (those are @-prefixed duplicates in elemMap)
          if (key.startsWith('@')) continue;
          // Skip keys like "character_1" — already handled above
          if (/^character_\d+$/i.test(key)) continue;
          bareFixMap[key.toLowerCase()] = canonical;
        }
        // Sort longest-first to avoid partial matches (e.g. "chi" inside "chisom")
        const sortedBareNames = Object.keys(bareFixMap).sort((a, b) => b.length - a.length);

        let bareFixCount = 0;
        for (const bareName of sortedBareNames) {
          const escaped = bareName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const canonical = bareFixMap[bareName];
          // Match bare name NOT already preceded by @ (word boundary)
          const bareRe = new RegExp(`(?<!@)\\b${escaped}\\b`, 'gi');
          const before = finalMultiShotPrompt;
          finalMultiShotPrompt = finalMultiShotPrompt.replace(bareRe, `@${canonical}`);
          if (finalMultiShotPrompt !== before) {
            bareFixCount++;
          }
        }
        if (bareFixCount > 0) {
          this.log(`[CINEMATIC] ${clipId}: auto-fixed ${bareFixCount} bare character name(s) → @element references`);
        }
      }

      // ── NORMALIZE CURLY/SMART QUOTES → ASCII ──
      // Vision (3rd pass) sometimes returns dialogue with curly quotes (\u201C \u201D \u2018 \u2019)
      // which breaks downstream regex patterns that expect ASCII quotes.
      {
        const beforeQuoteFix = finalMultiShotPrompt;
        finalMultiShotPrompt = finalMultiShotPrompt
          .replace(/[\u201C\u201D]/g, '"')   // " " → "
          .replace(/[\u2018\u2019]/g, "'");  // ' ' → '
        if (finalMultiShotPrompt !== beforeQuoteFix) {
          this.log(`[CINEMATIC] ${clipId}: normalized curly quotes → ASCII`);
        }
      }

      // ── STRIP @element NAMES FROM DIALOGUE QUOTES ──
      // Characters should speak human names ("I am Okafor"), not element tags
      // ("I am @okafor_otpto_0420"). The @ inside quotes would trigger an
      // autocomplete attempt instead of being spoken as text.
      // Runs AFTER bare-name fixer (which may add @-refs into dialogue).
      // Matches dialogue blocks (]: "..."), then replaces ALL @element_name
      // patterns inside each dialogue string. Handles multiple @-refs per line.
      {
        const beforeDialogueFix = finalMultiShotPrompt;
        finalMultiShotPrompt = finalMultiShotPrompt.replace(
          /(\]:\s*")([^"]*?)(")/gi,
          (match, prefix, dialogueText, suffix) => {
            const cleaned = dialogueText.replace(/@([a-z0-9_]+)/gi, (atMatch, name) => {
              const baseName = name.replace(/_[a-z]{2,6}_\d{4}$/i, '');
              const humanName = baseName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
              this.log(`[CINEMATIC] ${clipId}: dialogue fix: @${name} → ${humanName}`);
              return humanName;
            });
            return prefix + cleaned + suffix;
          }
        );
        if (finalMultiShotPrompt !== beforeDialogueFix) {
          this.log(`[CINEMATIC] ${clipId}: stripped @element references from dialogue → human names`);
        }
      }

      // ── 3-SHOT WARNING ──
      // Kling 3.0 renders 4+ shots unreliably (skips shots, misattributes dialogue).
      // The script rubric enforces exactly 3 shots per clip. If more are needed,
      // the scene should be split into multiple clips — NOT trimmed. Log a warning
      // so the operator sees it in the prompt preview gate.
      {
        const shotMatches = finalMultiShotPrompt.match(/Shot \d+/gi) || [];
        if (shotMatches.length > 3) {
          this.log(`[CINEMATIC] ⚠ ${clipId}: prompt has ${shotMatches.length} shots — Kling renders 4+ unreliably. Scene should have been split into multiple clips. Proceeding but expect degraded output.`, 'warn');
        }
      }

      // ── SMART DURATION — ensure dialogue fits ──
      // Count dialogue words from the prompt and calculate minimum needed time.
      // Formula: (words / 2.5) + (shotTransitions * 0.5) + 1.0s buffer
      // If the calculated duration exceeds the script's requested duration,
      // bump up. Kling supports 3-15s; cap at 15.
      const effectiveDuration = (() => {
        const scriptDur = clipDef.duration_seconds || 10;
        // Extract dialogue words: text inside quotes after speaker tags []: "..."
        const dialogueMatches = finalMultiShotPrompt.match(/\]:\s*"([^"]*)"/g) || [];
        const allDialogueText = dialogueMatches.map(m => {
          const q = m.match(/"([^"]*)"/);
          return q ? q[1] : '';
        }).join(' ');
        const wordCount = allDialogueText.split(/\s+/).filter(w => w.length > 0).length;
        // Count shot transitions (number of shots - 1)
        const shotCount = (finalMultiShotPrompt.match(/Shot \d+/gi) || []).length;
        const transitions = Math.max(0, shotCount - 1);
        // Observed speaking rate: ~2.5 words/sec for Kling's accented delivery
        // (was 2.0 — too conservative, caused 3-4s dead air where Kling fills with phantom animations)
        const minDuration = Math.ceil((wordCount / 2.5) + (transitions * 0.5) + 1.0);
        const effective = Math.min(15, Math.max(5, Math.max(scriptDur, minDuration)));
        if (effective > scriptDur) {
          this.log(`[DURATION] ${clipId}: script says ${scriptDur}s but dialogue needs ~${minDuration}s (${wordCount} words, ${shotCount} shots) → bumped to ${effective}s`);
        }
        return effective;
      })();

      const outputPath = path.join(clipsDir, `${clipId}_cinematic.mp4`);

      // Insert/locate asset row — keyed by kling_clip_id for resume idempotency
      let clipAsset = existingClips.find(a => a.kling_clip_id === clipId);
      if (!clipAsset) {
        // Insert a video_clip_cinematic row. We use chapter + scene to match
        // schema constraints; the clip-specific identity is on kling_clip_id
        // (set immediately after insertion).
        db.insertExpectedAssets(projectId, [{
          type: 'video_clip_cinematic',
          chapter,
          scene,
          line: (clipDef.line_refs && clipDef.line_refs[0]) || null,
        }]);
        clipAsset = db.getAssets(projectId, { type: 'video_clip_cinematic' })
          .filter(a => a.chapter === chapter && a.scene === scene && !a.kling_clip_id)
          .slice(-1)[0];
        if (clipAsset) {
          // Tag with clip_id + line_refs JSON so resume can find it
          try {
            const lineRefsJson = JSON.stringify(clipDef.line_refs || []);
            // Reuse setAssetElementName-style direct UPDATE for the
            // clip-specific columns added in migration 012.
            const sql = `UPDATE project_assets SET kling_clip_id = ?, line_refs = ? WHERE id = ?`;
            // db.runSql is internal; use the exposed setAssetElementName as a model.
            // We extend with a dedicated helper inline for now.
            db._setKlingClipMeta && db._setKlingClipMeta(clipAsset.id, clipId, lineRefsJson);
            // Fallback: if the helper isn't available, use a generic column update
            if (!db._setKlingClipMeta) {
              // Last-resort: use updateProjectAsset to store on a JSON-style
              // settings field. For now, log a warning.
              this.log(`[CINEMATIC] Warn: kling_clip_id metadata not persisted for ${clipId}`, 'warn');
            }
          } catch (_) {}
        }
      }

      // ── FINAL POSTURE CORRECTION (last-chance fix) ──
      // Parse the CHARACTER POSITIONS preamble (which we KNOW is correct) and
      // fix any posture verb mismatches in Shot 1. This catches cases where
      // _injectVisionBlocking's regex replacement fails for unknown reasons.
      {
        const preambleMatch = finalMultiShotPrompt.match(/CHARACTER POSITIONS[^:]*:\s*(.*?)(?:\.\s*\n)/s);
        const s1Match = finalMultiShotPrompt.match(/(Shot\s*1\s*\([^)]*\)\s*:\s*)([\s\S]*?)(?=\nShot\s*2\s*\(|\n\[|$)/);
        if (preambleMatch && s1Match) {
          // Parse each character's posture from preamble
          const charBlocks = preambleMatch[1].split(/;\s*/);
          const postureMap = {}; // suffixed_name → target verb
          for (const block of charBlocks) {
            const nameMatch = block.match(/@([a-z0-9_]+)/i);
            if (!nameMatch) continue;
            const name = nameMatch[1].toLowerCase();
            const lower = block.toLowerCase();
            if (/\bseat(?:ed|s)\b|\bsitting\b|\bsits?\b/.test(lower)) postureMap[name] = 'sits';
            else if (/\bstand(?:s|ing)\b/.test(lower)) postureMap[name] = 'stands';
            else if (/\blean(?:s|ing)\b/.test(lower)) postureMap[name] = 'leans';
          }
          this.log(`[POSTURE-FIX] Parsed preamble postures: ${JSON.stringify(postureMap)}`);

          let shot1Text = s1Match[2];
          let postureFixCount = 0;
          for (const [charName, targetVerb] of Object.entries(postureMap)) {
            const nameEsc = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Match @charName followed by posture verb — with optional "is" prefix
            // Handles: "@name stands", "@name sits", "@name is seated", "@name is standing"
            const re = new RegExp(`(@${nameEsc})(\\s+(?:is\\s+)?)(stands?|stand|standing|sits?|sitting|seated|leans?|leaning)\\b`, 'gi');
            shot1Text = shot1Text.replace(re, (match, nameRef, space, verb) => {
              if (verb.toLowerCase() === targetVerb ||
                  (targetVerb === 'sits' && /^(sits?|sitting|seated)$/i.test(verb)) ||
                  (targetVerb === 'stands' && /^(stands?|standing)$/i.test(verb)) ||
                  (targetVerb === 'leans' && /^(leans?|leaning)$/i.test(verb))) {
                return match; // already correct
              }
              postureFixCount++;
              this.log(`[POSTURE-FIX] ${nameRef} "${space.trim()} ${verb}" → "${targetVerb}"`);
              return `${nameRef} ${targetVerb}`;
            });
          }
          if (postureFixCount > 0) {
            finalMultiShotPrompt = finalMultiShotPrompt.replace(s1Match[2], shot1Text);
            this.log(`[POSTURE-FIX] Fixed ${postureFixCount} posture verb(s) in Shot 1`);
          } else {
            this.log(`[POSTURE-FIX] No posture mismatches in Shot 1`);
          }
        } else {
          this.log(`[POSTURE-FIX] Could not parse preamble (${!!preambleMatch}) or Shot 1 (${!!s1Match}) — skipping`);
        }
      }

      // ── PRE-GEN PROMPT PREVIEW GATE (TEMPORARY — remove when full production starts) ──
      // Show the final multi_shot_prompt to the user before Playwright submits it
      // to Kling. If the prompt looks wrong (bad blocking, weird phrasing), user
      // can stop here without burning ~18 credits on a bad clip.
      this.log(`[CINEMATIC] Prompt preview gate for ${clipId}`);
      this.emit({
        type: 'waiting',
        gate: 'prompt-preview',
        clipId,
        clipIndex: i,
        clipTotal: allKlingClips.length,
        clipLabel: label,
        prompt: finalMultiShotPrompt,
        startFramePath,
        durationSeconds: effectiveDuration,
      });
      const preGenDecision = await this.waitForApproval('prompt-preview');
      if (preGenDecision === 'stop') {
        this.log(`[CINEMATIC] User stopped before generating ${clipId} — skipping remaining clips`);
        break;
      }
      this.log(`[CINEMATIC] Prompt approved for ${clipId} — proceeding to Kling generation`);

      try {
        if (clipAsset) {
          // Store prompt as JSON with reconciliation flag for restart persistence
          const promptPayload = {
            prompt: finalMultiShotPrompt,
            shot_directions_reconciled: shotReconcileCache[clipId] === true,
          };
          db.markAssetGenerating(clipAsset.id, JSON.stringify(promptPayload));
        }

        // ── CLEAN CONTEXT between clips ──
        // After a previous generation (or recovery), the browser context may
        // have stale state (leftover overlays, forms, etc.). Recreate the
        // context for a clean Kling page. Skip for the very first clip if
        // we haven't done any generation yet.
        if (i > 0 || generated > 0) {
          this.log(`[CINEMATIC] Recreating browser context before ${clipId}...`);
          try {
            await this.automation.recreateContext();
          } catch (ctxErr) {
            this.log(`[CINEMATIC] Context recreate failed: ${ctxErr.message.split('\n')[0]} — proceeding anyway`, 'warn');
          }
        }

        this.log(`[CINEMATIC] Generating ${label}`);

        // validElementNames is built above (before the sanitize step).
        // Pass it to generateClip so _typeMultiShotPrompt only triggers
        // @-autocomplete for real character elements.
        const result = await kling.generateClip({
          startFramePath,
          startFrameGenId,
          multiShotPrompt: finalMultiShotPrompt,
          durationSeconds: effectiveDuration,
          outputPath,
          validElements: validElementNames,
          onGenClicked: (creditCost) => {
            // Persist that Generate was clicked — survives app restart.
            // On resume, the pipeline will go straight to Asset recovery
            // instead of re-generating (burning credits again).
            if (clipAsset) db.markAssetGenClicked(clipAsset.id, creditCost);
          },
        });

        if (clipAsset) {
          db.markAssetDone(clipAsset.id, result.path, {
            model: result.model,
            sourceGenId: result.sourceGenId,
            cdnUrl: result.cdnUrl,
          });
        }
        generated++;
        this.state.videoClips = this.state.videoClips || [];
        this.state.videoClips.push({
          chapter, scene, clipId, path: result.path, status: 'complete',
        });
        this.emit({ type: 'clip-complete', index: i, path: result.path });

        // ── PER-CLIP APPROVAL GATE (credit-saving measure) ──
        // Pause after each clip so the user can watch it and verify the
        // prompt structure before burning credits on the next one.
        // The gate auto-skips if this is the last clip (nothing to gate).
        if (i < allKlingClips.length - 1) {
          this.log(`[CINEMATIC] Waiting for clip approval: ${clipId} (${generated}/${allKlingClips.length - skipped})`);
          this.emit({
            type: 'waiting',
            gate: 'clip-review',
            clipId,
            clipPath: result.path,
            clipIndex: i,
            clipTotal: allKlingClips.length,
            clipLabel: label,
          });
          const decision = await this.waitForApproval('clip-review');
          if (decision === 'stop') {
            this.log(`[CINEMATIC] User stopped after ${clipId} — skipping remaining clips`);
            break;
          }
          this.log(`[CINEMATIC] Clip ${clipId} approved — continuing to next`);
        }
      } catch (e) {
        this.log(`[CINEMATIC] ${clipId} failed: ${e.message}`, 'warn');

        // ── SESSION EXPIRED: pause pipeline, relaunch browser, wait for login ──
        // Must be checked BEFORE any retry logic — no point retrying without auth.
        if (e.message && e.message.includes('SESSION_EXPIRED')) {
          this.log('[CINEMATIC] Session expired — pausing for re-authentication...', 'warn');
          this.paused = true;
          this.state.status = 'session_expired';
          this.emit({ type: 'session-expired', message: e.message });

          // Relaunch browser so user can log in
          if (this.automation) {
            try {
              await this.automation.close();
            } catch (_) {}
            await this.automation.ensureBrowser();
            await this.automation.page.goto('https://higgsfield.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            this.log('Fresh browser opened — please log into Higgsfield, then click Resume.');
          }

          // Wait for user to log in and click Resume
          await new Promise((resolve) => { this._pauseResolver = resolve; });
          if (this.cancelled) return;

          this.paused = false;
          this.state.status = 'running';
          this.log('[CINEMATIC] Resumed after re-authentication — retrying clip...');
          // Retry this clip (don't increment i)
          i--;
          continue;
        }

        let shouldRetry = false;

        // ── KLING RECOVERY: attempt to recover from Asset library ──
        // generateClip() tags setup errors with [PRE-GEN]. Only errors from
        // _generateAndDownload (after clicking Generate) should trigger recovery,
        // because those are the only ones that burn credits.
        const isPreGen = e.message.includes('[PRE-GEN]');
        const isTimeout = e.message.includes('Timeout') || e.message.includes('timeout');
        const isBrowserDead = e.message.includes('closed') || e.message.includes('crashed') ||
                              e.message.includes('disconnected') || e.message.includes('Target');

        if (!isPreGen && isTimeout && !isBrowserDead && finalMultiShotPrompt) {
          this.log(`[CINEMATIC] ${clipId}: timeout detected — waiting 120s for Kling to finish generating before recovery...`);
          await new Promise(r => setTimeout(r, 120000));
          this.log(`[CINEMATIC] ${clipId}: wait complete — attempting Asset library recovery...`);
          try {
            const recovered = await kling.recoverTimedOutClip(finalMultiShotPrompt, outputPath, {
              minSimilarity: 85,
              maxTilesToCheck: 6,
              timeoutMs: 60000,
            });

            if (recovered) {
              this.log(`[CINEMATIC] ✓ ${clipId} RECOVERED from Asset library (similarity=${recovered.similarity}%, uuid=${recovered.assetUuid || 'unknown'})`);
              if (clipAsset) {
                db.markAssetDone(clipAsset.id, recovered.path, {
                  model: 'kling-3.0',
                  sourceGenId: recovered.sourceGenId,
                  cdnUrl: recovered.cdnUrl,
                });
              }
              generated++;
              this.state.videoClips = this.state.videoClips || [];
              this.state.videoClips.push({
                chapter, scene, clipId, path: recovered.path, status: 'complete',
              });
              this.emit({ type: 'clip-complete', index: i, path: recovered.path });

              // ── PER-CLIP APPROVAL GATE after recovery too ──
              // TEMPORARY — remove when full production starts.
              if (i < allKlingClips.length - 1) {
                this.log(`[CINEMATIC] Waiting for clip approval (recovered): ${clipId}`);
                this.emit({
                  type: 'waiting',
                  gate: 'clip-review',
                  clipId,
                  clipPath: recovered.path,
                  clipIndex: i,
                  clipTotal: allKlingClips.length,
                  clipLabel: label,
                });
                const decision = await this.waitForApproval('clip-review');
                if (decision === 'stop') {
                  this.log(`[CINEMATIC] User stopped after ${clipId} — skipping remaining clips`);
                  break;
                }
              }
              continue; // skip the failure path — clip is done
            } else {
              this.log(`[CINEMATIC] ${clipId}: recovery found no match — will re-generate`);
              // Not in local folder, not in Higgsfield → re-generate
              shouldRetry = true;
            }
          } catch (recoveryErr) {
            this.log(`[CINEMATIC] ${clipId}: recovery error — ${recoveryErr.message} — will re-generate`, 'warn');
            shouldRetry = true;
          }
        } else if (isPreGen || isBrowserDead) {
          // Credit cost inflation = resolution is wrong. Pausing the pipeline
          // is the only safe move — retrying will hit the same 4K setting.
          // User must fix resolution in Kling's UI, then resume.
          const isCostInflation = e.message.includes('Credit cost inflated');
          if (isCostInflation) {
            this.log(`[CINEMATIC] ${clipId}: CREDIT COST INFLATED — pausing pipeline. Fix resolution in Kling UI, then resume.`, 'error');
            if (clipAsset) db.markAssetFailed(clipAsset.id, e.message);
            // Reset to pending so resume picks it up
            if (clipAsset) {
              db.resetAsset(clipAsset.id);
            }
            this.emit({
              type: 'cost-inflation-pause',
              clipId,
              message: e.message,
            });
            // Pause — user resumes after fixing resolution
            this.paused = true;
            this.state.status = 'paused';
            this.emit({ type: 'paused', reason: 'cost-inflation' });
            this.log('[CINEMATIC] Pipeline paused — waiting for resume...');
            await this.checkPause();
            if (this.cancelled) return;
            // After resume, retry this clip (don't increment i)
            i--;
            continue;
          }
          // Other setup failures or dead browser — safe to retry (no credits burned)
          shouldRetry = true;
          this.log(`[CINEMATIC] ${clipId}: ${isPreGen ? 'pre-gen failure' : 'browser dead'} — will re-generate`);
        }

        if (shouldRetry && !this.cancelled) {
          this.log(`[CINEMATIC] ${clipId}: retrying generation (attempt 2/2)...`);
          try {
            // Reset asset status for retry
            if (clipAsset) {
              const retryPayload = {
                prompt: finalMultiShotPrompt,
                shot_directions_reconciled: shotReconcileCache[clipId] === true,
              };
              db.markAssetGenerating(clipAsset.id, JSON.stringify(retryPayload));
            }

            // Fresh browser context for clean slate
            this.log(`[CINEMATIC] Recreating browser context for ${clipId} retry...`);
            try { await this.automation.recreateContext(); } catch (_) {}

            const retryResult = await kling.generateClip({
              startFramePath,
              startFrameGenId,
              multiShotPrompt: finalMultiShotPrompt,
              durationSeconds: effectiveDuration,
              outputPath,
              validElements: validElementNames,
              onGenClicked: (creditCost) => {
                if (clipAsset) db.markAssetGenClicked(clipAsset.id, creditCost);
              },
            });

            if (clipAsset) {
              db.markAssetDone(clipAsset.id, retryResult.path, {
                model: retryResult.model,
                sourceGenId: retryResult.sourceGenId,
                cdnUrl: retryResult.cdnUrl,
              });
            }
            generated++;
            this.state.videoClips = this.state.videoClips || [];
            this.state.videoClips.push({
              chapter, scene, clipId, path: retryResult.path, status: 'complete',
            });
            this.emit({ type: 'clip-complete', index: i, path: retryResult.path });
            this.log(`[CINEMATIC] ✓ ${clipId} succeeded on retry`);

            // Approval gate after retry
            if (i < allKlingClips.length - 1) {
              this.log(`[CINEMATIC] Waiting for clip approval (retried): ${clipId}`);
              this.emit({
                type: 'waiting',
                gate: 'clip-review',
                clipId,
                clipPath: retryResult.path,
                clipIndex: i,
                clipTotal: allKlingClips.length,
                clipLabel: label,
              });
              const decision = await this.waitForApproval('clip-review');
              if (decision === 'stop') {
                this.log(`[CINEMATIC] User stopped after ${clipId} — skipping remaining clips`);
                break;
              }
            }
            continue; // retry succeeded — skip failure path
          } catch (retryErr) {
            this.log(`[CINEMATIC] ${clipId}: retry also failed — ${retryErr.message}`, 'warn');
          }
        }

        if (clipAsset) db.markAssetFailed(clipAsset.id, e.message);
        failed++;
      }
    }

    this.log(`[CINEMATIC] Video stage complete — ${generated} generated, ${skipped} resumed, ${dialogueSkipped} dialogue-skipped, ${failed} failed`);

    // ── BACKFILL PASS: retry any clips that failed during the main loop ──
    // Failures from transient issues (agreement modals, browser crashes, ad
    // interception) leave clips marked as 'failed' in the DB. Rather than
    // requiring a full restart, sweep through and retry each failed clip once.
    if (failed > 0 && !this.cancelled) {
      const failedAssets = db.getAssets(projectId, { type: 'video_clip_cinematic' })
        .filter(a => a.status === 'failed' && a.kling_clip_id);

      if (failedAssets.length > 0) {
        this.log(`[CINEMATIC] ── BACKFILL PASS: ${failedAssets.length} failed clip(s) to retry ──`);
        let backfillSuccess = 0;
        let backfillFail = 0;

        for (const failedAsset of failedAssets) {
          if (this.cancelled) break;

          const failedClipId = failedAsset.kling_clip_id;
          // Find the matching clip definition from allKlingClips
          const matchIdx = allKlingClips.findIndex(item => {
            const cid = item.clipDef.clip_id || `ch${item.chapter}_sc${item.scene}_c${allKlingClips.indexOf(item) + 1}`;
            return cid === failedClipId;
          });

          if (matchIdx === -1) {
            this.log(`[CINEMATIC] [BACKFILL] ${failedClipId}: no matching clip definition found — skipping`);
            backfillFail++;
            continue;
          }

          // Check if file appeared on disk since the failure (manual intervention, etc.)
          const expectedPath = path.join(clipsDir, `${failedClipId}_cinematic.mp4`);
          if (fs.existsSync(expectedPath) && fs.statSync(expectedPath).size > 50000) {
            this.log(`[CINEMATIC] [BACKFILL] ${failedClipId}: file found on disk (${(fs.statSync(expectedPath).size / 1024 / 1024).toFixed(2)} MB) — marking done`);
            db.markAssetDone(failedAsset.id, expectedPath, { model: 'kling-3.0' });
            backfillSuccess++;
            continue;
          }

          const item = allKlingClips[matchIdx];
          const { chapter, scene, clipDef, startFramePath: sfPath, visionRefinedChars } = item;
          const label = `${failedClipId} (Ch${chapter} Sc${scene}, ${clipDef.duration_seconds || 10}s, ${(clipDef.line_refs || []).length} line(s))`;

          this.log(`[CINEMATIC] [BACKFILL] Retrying ${label}...`);

          // Reset asset status for retry
          db.resetAsset(failedAsset.id);

          try {
            // Fresh browser context for clean slate
            this.log(`[CINEMATIC] [BACKFILL] Recreating browser context for ${failedClipId}...`);
            await this.automation.recreateContext();

            const clipPath = path.join(clipsDir, `${failedClipId}_cinematic.mp4`);
            const result = await this.klingAutomation.generateClip({
              startFramePath: sfPath,
              startFrameGenId: item.startFrameGenId,
              multiShotPrompt: failedAsset.prompt ? JSON.parse(failedAsset.prompt).prompt || clipDef.multi_shot_prompt : clipDef.multi_shot_prompt,
              durationSeconds: clipDef.duration_seconds || 10,
              outputPath: clipPath,
              validElements: clipDef.valid_elements || [],
            });

            db.markAssetDone(failedAsset.id, result.path, {
              model: 'kling-3.0',
              sourceGenId: result.generationId,
              cdnUrl: result.cdnUrl,
            });
            backfillSuccess++;
            this.log(`[CINEMATIC] [BACKFILL] ${failedClipId}: SUCCESS — ${(fs.statSync(result.path).size / 1024 / 1024).toFixed(2)} MB`);

            // Show for approval
            this.log(`[CINEMATIC] [BACKFILL] Waiting for clip approval: ${failedClipId}`);
            this.emit({
              type: 'waiting',
              gate: 'clip-review',
              clipId: failedClipId,
              clipPath: result.path,
              clipIndex: matchIdx,
              clipTotal: allKlingClips.length,
              clipLabel: `[BACKFILL] ${label}`,
            });
            const decision = await this.waitForApproval('clip-review');
            if (decision === 'stop') {
              this.log(`[CINEMATIC] [BACKFILL] User stopped after ${failedClipId}`);
              break;
            }
          } catch (backfillErr) {
            this.log(`[CINEMATIC] [BACKFILL] ${failedClipId}: retry failed — ${backfillErr.message}`, 'warn');
            db.markAssetFailed(failedAsset.id, `backfill: ${backfillErr.message}`);
            backfillFail++;
          }
        }

        this.log(`[CINEMATIC] ── BACKFILL COMPLETE: ${backfillSuccess} recovered, ${backfillFail} still failed ──`);
        generated += backfillSuccess;
        failed = failed - backfillSuccess;
      }
    }

    this.log(`[CINEMATIC] Video stage final tally — ${generated} generated, ${skipped} resumed, ${dialogueSkipped} dialogue-skipped, ${failed} failed`);
  }

  /**
   * Decide whether a failed video clip is worth attempting history recovery for.
   *
   * Skips recovery when:
   *   - We already tried this asset in this run (prevents scrape loops)
   *   - Pipeline is cancelled
   *   - Error is SESSION_EXPIRED (user has to re-login — scraping won't help)
   *   - Error is a clean abort (browser closed / target destroyed)
   *   - Asset has no recorded prompt yet (matcher has nothing to compare)
   *
   * Everything else is a candidate — Generate may have fired server-side and
   * produced an asset we lost track of. Worst case, the scrape finds no match
   * and we fall through to the normal failure path (~5-15s added latency).
   */
  _shouldTryHistoryRecovery(asset, err) {
    if (!asset || !asset.id) return false;
    if (this._historyAttempted && this._historyAttempted.has(asset.id)) return false;
    if (this.cancelled) return false;
    if (!err || !err.message) return false;
    if (err.message.includes('SESSION_EXPIRED')) return false;
    if (err.message.includes('Target') && err.message.includes('closed')) return false;
    // If we already rescued the CDN URL, the normal restart-recovery path handles it
    if (err.detectedCdnUrl) return false;
    return true;
  }

  /**
   * Stage scene references for a single image generation.
   *
   * Two types of references, both applied when applicable:
   *
   * A) CHARACTER PORTRAITS — determined by `scene.characters_present` (the
   *    authoritative list from the script JSON). Every character in the list
   *    gets their portrait uploaded as a reference. Fingerprint matching
   *    against the prompt text is used ONLY for ordering — so ref[0] maps
   *    to the first character described in the prompt, ref[1] to the second, etc.
   *    If a character isn't found in the prompt text (LLM shorthand), they're
   *    appended at the end rather than dropped.
   *
   * B) CONTINUITY REFERENCE — if the prompt contains a tag like
   *    "(Continuity: Using Image Prompt [Line X] as reference)", the generated
   *    image from Line X is included. This locks environment, lighting, and
   *    character positioning from the referenced line.
   *
   * Final reference order (up to 14 slots on Nano Banana):
   *   [character portraits in prompt-position order] + [continuity scene image]
   *
   * @param {string} imagePrompt - The scene's image_prompt text
   * @param {Object} sceneImageMap - Map of "chapter_line" → file path for generated scene images
   * @param {number} chapterNum - Current chapter number (for continuity line lookup)
   * @param {string[]} charactersPresent - Character IDs from scene.characters_present (authoritative)
   * @returns {{ references: string[], matchedChars: Array, continuityLine: number|null }}
   */
  stageSceneReferences(imagePrompt, sceneImageMap, chapterNum, charactersPresent = []) {
    const fs = require('fs');
    const bible = this.state.script?.character_bible || [];
    const promptLower = imagePrompt.toLowerCase();

    // ── A) CHARACTER PORTRAITS — characters_present is the source of truth ──
    const matchedChars = [];    // Characters with prompt position (for ordering)
    const unpositioned = [];    // Characters in scene but not found in prompt text
    const missingPortraits = []; // Characters whose portrait file is missing

    // Build set of character IDs that should be in this scene
    const sceneCharIds = new Set(charactersPresent || []);

    // If characters_present is empty, fall back to scanning ALL bible characters
    // against the prompt (backward compat for scripts without characters_present).
    // characters_present may contain element_name_hint values (e.g. "mama_adaeze")
    // OR legacy char.id values (e.g. "character_1") — match against both.
    const charsToCheck = sceneCharIds.size > 0
      ? bible.filter(c => sceneCharIds.has(c.id) || sceneCharIds.has(c.element_name_hint))
      : bible;

    if (sceneCharIds.size > 0) {
      this.log(`[STAGE] Scene declares ${sceneCharIds.size} character(s): ${[...sceneCharIds].join(', ')}`);
    } else {
      this.log(`[STAGE] No characters_present — falling back to fingerprint scan of all ${bible.length} characters`);
    }

    for (const char of charsToCheck) {
      // Look up the portrait for this character
      const portrait = this.state.portraits.find(p => p.characterId === char.id);
      if (!portrait || !fs.existsSync(portrait.path)) {
        this.log(`[STAGE] Character ${char.description_label || char.id} (${char.id}) — portrait MISSING`, 'warn');
        missingPortraits.push(char.id);
        continue;
      }

      // Use fingerprint matching to find this character's position in the prompt
      // (for ordering only — not for deciding inclusion)
      const descriptors = this._extractCharacterFingerprints(char);
      let bestPosition = -1;
      let bestDescriptor = '';
      let matchCount = 0;

      for (const d of descriptors) {
        const pos = promptLower.indexOf(d.toLowerCase());
        if (pos !== -1) {
          matchCount++;
          if (bestPosition === -1 || pos < bestPosition) {
            bestPosition = pos;
            bestDescriptor = d;
          }
        }
      }

      const entry = {
        charId: char.id,
        label: char.description_label || char.id,
        position: bestPosition,
        portraitPath: portrait.path,
        matchCount,
        bestDescriptor: (bestDescriptor || '').slice(0, 50),
      };

      if (bestPosition !== -1) {
        matchedChars.push(entry);
      } else {
        // Character is in the scene but their description wasn't found in the prompt
        // Still include them — append after positioned characters
        entry.position = Infinity;
        unpositioned.push(entry);
        this.log(`[STAGE] Character ${char.description_label || char.id} in scene but not found in prompt text — appending`, 'warn');
      }
    }

    // Sort positioned characters by their appearance in the prompt
    matchedChars.sort((a, b) => a.position - b.position);

    // Combine: positioned first (in prompt order), then unpositioned (in scene order)
    const allChars = [...matchedChars, ...unpositioned];

    // ── B) CONTINUITY REFERENCE — parse the tag from the prompt ──
    let continuityLine = null;
    let continuityPath = null;

    // Match patterns like:
    //   (Continuity: Using Image Prompt [Line 1] as reference)
    //   (Continuity: Using generated Image from [Line 1] as reference image)
    //   (Continuity: Using Image Prompt [Previous #] as reference)
    const continuityMatch = imagePrompt.match(
      /\(Continuity:.*?(?:Line|Prompt\s*\[Line)\s*(\d+)/i
    );

    if (continuityMatch) {
      continuityLine = parseInt(continuityMatch[1], 10);
      const key = `${chapterNum}_${continuityLine}`;
      continuityPath = sceneImageMap[key] || null;

      if (continuityPath && fs.existsSync(continuityPath)) {
        this.log(`[STAGE] Continuity ref: Line ${continuityLine} → ${path.basename(continuityPath)}`);
      } else if (continuityPath) {
        this.log(`[STAGE] Continuity ref: Line ${continuityLine} file missing: ${continuityPath}`, 'warn');
        continuityPath = null;
      } else {
        this.log(`[STAGE] Continuity ref: Line ${continuityLine} not found in scene map (key: ${key})`, 'warn');
      }
    }

    // ── BUILD FINAL REFERENCE LIST ──
    // Character portraits first (face consistency), then continuity image (environment lock-in)
    const references = allChars.map(m => m.portraitPath);
    if (continuityPath) {
      references.push(continuityPath);
    }

    // ── LOGGING ──
    this.log(`[STAGE] ${allChars.length} character(s) staged (${matchedChars.length} positioned in prompt, ${unpositioned.length} appended):`);
    for (const m of allChars) {
      const posLabel = m.position === Infinity ? 'NOT IN PROMPT' : `pos ${m.position}`;
      this.log(`[STAGE]   ${m.label} (${m.charId}) @ ${posLabel} — ${m.matchCount} descriptors (best: "${m.bestDescriptor}")`);
    }
    if (missingPortraits.length > 0) {
      this.log(`[STAGE] MISSING PORTRAITS (not uploaded): ${missingPortraits.join(', ')}`, 'warn');
    }
    this.log(`[STAGE] Total refs: ${references.length} (${allChars.length} portraits${continuityPath ? ` + continuity Line ${continuityLine}` : ', no continuity ref'})`);

    return { references, matchedChars: allChars, continuityLine };
  }

  /**
   * Sanitize an image prompt's continuity tag.
   *
   * The LLM sometimes produces garbled continuity tags where the tag text
   * is interleaved with the scene description. For example:
   *   "(Continuity: Using Image Prompt [Line 1] as rs slightly parted..."
   *   "...cinematic still.eference) The same bustling..."
   *
   * This method:
   * 1. Detects a well-formed continuity tag → returns prompt unchanged
   * 2. Detects a malformed/partial tag → strips it, prepends a clean tag
   * 3. No tag found but line > 1 → prepends a clean tag for the previous line
   *
   * @param {string} imagePrompt - The raw image_prompt from the script
   * @param {number} lineNumber - Current line number in the chapter
   * @returns {string} Sanitized prompt
   */
  sanitizeContinuityTag(imagePrompt, lineNumber) {
    if (!imagePrompt || lineNumber <= 1) return imagePrompt;

    // Pattern for a CLEAN continuity tag
    const cleanTagPattern = /^\(Continuity: Using (?:Image Prompt|generated Image from) \[(?:Line|Previous) \d+\] as reference(?: image)?\)\s*/i;

    // Check if prompt already has a clean tag at the start
    if (cleanTagPattern.test(imagePrompt.trim())) {
      return imagePrompt; // Already well-formed
    }

    // Pattern for a GARBLED continuity tag — the tag text is scattered/interleaved
    // Look for fragments: "(Continuity:" somewhere, and possibly "eference)" or "as r" fragments
    const garbledPatterns = [
      /\(Continuity:.*?(?:as\s+r\w*\b|eference\)?)/gi,       // Partial "as reference" with garbled text between
      /\(Continuity:[^)]*$/gm,                                  // Unclosed "(Continuity:..."
      /eference\)\s*/gi,                                         // Orphaned "eference)" fragment (missing leading "r")
    ];

    let cleaned = imagePrompt;
    let wasGarbled = false;

    for (const pattern of garbledPatterns) {
      if (pattern.test(cleaned)) {
        wasGarbled = true;
        cleaned = cleaned.replace(pattern, '');
      }
      pattern.lastIndex = 0; // Reset global regex
    }

    // Also try to extract any line number from the garbled tag for the continuity reference
    let refLine = lineNumber - 1; // Default: reference previous line
    const lineNumMatch = imagePrompt.match(/\(Continuity:.*?\[(?:Line|Previous)\s*(\d+)/i);
    if (lineNumMatch) {
      refLine = parseInt(lineNumMatch[1], 10);
    }

    if (wasGarbled) {
      // Strip any remaining orphaned fragments and whitespace
      cleaned = cleaned.replace(/^\s+/, '').replace(/\s{2,}/g, ' ');
      this.log(`[PROMPT] Sanitized garbled continuity tag for Line ${lineNumber} (ref Line ${refLine})`);
    }

    // Prepend clean continuity tag
    const cleanTag = `(Continuity: Using Image Prompt [Line ${refLine}] as reference) `;
    return cleanTag + cleaned;
  }

  /**
   * Strip aspect ratio text from image prompts — the Higgsfield UI selector handles
   * the canvas dimensions. Having "9:16 aspect ratio" in the prompt text confuses the
   * model into composing landscape content rotated into a portrait canvas.
   *
   * For 9:16 projects, replaces stripped text with compositional cues that guide the
   * model toward naturally vertical framing (e.g., "tall vertical shot, floor to ceiling").
   *
   * @param {string} prompt - The image prompt text
   * @param {string} aspectRatio - Target aspect ratio ('9:16', '16:9', etc.)
   * @returns {string} Cleaned prompt
   */
  sanitizeAspectRatio(prompt) {
    if (!prompt) return prompt;

    // HARD RULE: Strip ALL aspect ratio, orientation, and composition directives
    // from prompt text. The Higgsfield UI selector (aspectRatio param) is the
    // sole authority. Any aspect/orientation text in the prompt confuses the
    // model into composing content with wrong orientation.
    let cleaned = prompt
      // Aspect ratio patterns
      .replace(/\b\d+:\d+\s*aspect\s*ratio\b[,.]?\s*/gi, '')
      .replace(/\b(?:9:16|16:9|1:1|4:3|3:4)\b[,.]?\s*/gi, '')
      // Orientation/format patterns
      .replace(/\b(?:vertical|horizontal)\s*(?:composition|shot|image|photo)\b[,.]?\s*/gi, '')
      .replace(/\bfull-?height\s*framing\b[,.]?\s*/gi, '')
      .replace(/\b(?:portrait|landscape)\s*(?:orientation|format|mode)\b[,.]?\s*/gi, '')
      .replace(/\b(?:vertical|tall)\s*(?:format|frame|canvas)\b[,.]?\s*/gi, '')
      .replace(/\b(?:wide|widescreen)\s*(?:format|frame|canvas)\b[,.]?\s*/gi, '')
      // Camera angle/perspective directives
      .replace(/\b(?:ground[- ]level|eye[- ]height|bird'?s?[- ]eye|top[- ]down|aerial)\s*(?:camera\s*)?(?:perspective|viewpoint|angle|view|shot)\b[,.]?\s*/gi, '')
      .replace(/\bhorizon\s+visible\b.*?(?:\.|$)/gi, '')
      .replace(/\b(?:do not|don'?t)\s+use\s+(?:aerial|top[- ]down|bird|tilted).*?(?:\.|$)/gi, '')
      .replace(/\b(?:upright\s+and\s+)?naturally\s+oriented\b[,.]?\s*/gi, '')
      .replace(/\btilted\s*camera\s*angles?\b[,.]?\s*/gi, '')
      // Cleanup
      .replace(/\s{2,}/g, ' ')
      .replace(/,\s*\./g, '.')
      .replace(/,\s*,/g, ',')
      .replace(/IMPORTANT:\s*[,.]?\s*/gi, '')
      .trim();

    // HARD RULE: Do NOT re-inject any orientation or composition cues.
    // The Higgsfield UI selector (aspectRatio param) is the sole authority.
    // Putting "vertical shot" or "tall composition" in prompt text confuses
    // the model into composing landscape content rotated into a portrait canvas.

    return cleaned;
  }

  /**
   * Extract distinctive fingerprint phrases from a character's bible entry.
   * These are short, unique fragments that are likely to appear verbatim
   * (or near-verbatim) in scene image prompts.
   *
   * Priority order (most distinctive first):
   * - Unique physical features (scars, birthmarks, vitiligo, tattoos)
   * - Age + ethnicity + gender combo ("45-year-old Nigerian woman")
   * - Skin tone description
   * - Hair description
   * - Build/height ("short and stocky at 5'2\"")
   * - Distinctive wardrobe items
   */
  _extractCharacterFingerprints(char) {
    const descriptors = [];
    const desc = char.full_prompt_description || '';
    const descLower = desc.toLowerCase();

    // 1. Age + nationality + gender (very distinctive: "45-year-old Nigerian woman")
    const ageMatch = desc.match(/\d{1,2}-year-old\s+\w+\s+(?:woman|man|girl|boy)/i);
    if (ageMatch) descriptors.push(ageMatch[0]);

    // 2. Unique physical marks (scars, vitiligo, birthmarks, tattoos, dimples)
    const markPatterns = [
      /vitiligo[^,.]*/i,
      /scar[^,.]*/i,
      /burn scar[^,.]*/i,
      /birthmark[^,.]*/i,
      /tattoo[^,.]*/i,
      /dimple[^,.]*/i,
      /mole[^,.]*/i,
    ];
    for (const pat of markPatterns) {
      const match = desc.match(pat);
      if (match) descriptors.push(match[0].trim());
    }

    // 3. Skin tone (e.g., "warm medium brown skin with golden undertones")
    const skinMatch = desc.match(/(?:deep|warm|rich|light|medium|dark|fair)\s+[\w\s]+skin[\w\s]*/i);
    if (skinMatch) descriptors.push(skinMatch[0].trim().slice(0, 60));

    // 4. Hair description (e.g., "long box braids with gold thread")
    const hairMatch = desc.match(/(?:short|long|medium|tightly)\s+[\w\s]+(?:hair|braids|afro|locs|TWA|gele|cornrows)[^,]*/i);
    if (hairMatch) descriptors.push(hairMatch[0].trim().slice(0, 60));

    // 5. Build + height (e.g., "short and stocky at 5'2\"")
    const buildMatch = desc.match(/(?:slender|stocky|muscular|lean|athletic|tall|short)[^,]*(?:\d'\d"|build)/i);
    if (buildMatch) descriptors.push(buildMatch[0].trim());

    // 6. Height alone if not caught above
    const heightMatch = desc.match(/\d'\d"/);
    if (heightMatch) descriptors.push(heightMatch[0]);

    // 7. Distinctive wardrobe items from the description
    if (char.wardrobe) {
      // Take first distinctive item (e.g., "yellow and green printed cotton wrapper")
      const wardrobeItems = char.wardrobe.split(',').map(s => s.trim()).filter(s => s.length > 10);
      if (wardrobeItems.length > 0) descriptors.push(wardrobeItems[0].slice(0, 50));
    }

    return descriptors;
  }

  /**
   * Build a Veo-safe video prompt that explicitly silences non-speaking characters.
   * Veo 3.1 tends to mis-assign lip-sync when multiple characters are visible —
   * this tells it exactly who speaks and who stays silent.
   */
  buildVideoPrompt(line, scene, accent) {
    const bible = this.state.script?.character_bible || [];
    const speakerId = (line.speaker_id || '').replace(/^@/, '');

    // Find character by id OR element_name_hint (speaker_id may be either)
    const _findChar = (id) => {
      const clean = (id || '').replace(/^@/, '');
      return bible.find(c => c.id === clean || c.element_name_hint === clean) || null;
    };

    // Get speaker's name/label
    const speaker = _findChar(speakerId);
    const speakerLabel = speaker?.description_label || speakerId;

    // Get non-speaking characters present in this scene
    const nonSpeakers = (scene.characters_present || [])
      .filter(id => (id || '').replace(/^@/, '') !== speakerId)
      .map(id => {
        const char = _findChar(id);
        return char?.description_label || id;
      });

    // Build the prompt with explicit lip-sync instructions
    let prompt = line.animation_prompt || '';

    // Speaker instruction
    prompt += `\n\n${speakerLabel} speaks: "${line.dialogue}" (${accent}). Tone: ${line.tone}.`;
    prompt += ` ${speakerLabel}'s mouth moves to match the dialogue with natural lip-sync.`;

    // Non-speaker silence instructions
    if (nonSpeakers.length > 0) {
      const silenceList = nonSpeakers.join(', ');
      prompt += `\n\nIMPORTANT: ${silenceList} — mouth CLOSED, absolutely no lip movement, no dialogue. `;
      prompt += nonSpeakers.length === 1
        ? `${nonSpeakers[0]} listens silently with a subtle reaction but does NOT speak or move their lips.`
        : `These characters listen silently with subtle reactions but do NOT speak or move their lips at any point.`;
    }

    return prompt;
  }

  /**
   * Interleave videos from two pools for balanced Gemini analysis.
   * Alternates: remake, AI, remake, AI... (remakes first — proven formulas are more valuable).
   * Deduplicates by videoId.
   */
  _interleaveVideos(aiOriginals = [], remakeCandidates = []) {
    const result = [];
    const seen = new Set();
    const maxPer = Math.max(aiOriginals.length, remakeCandidates.length);

    for (let i = 0; i < maxPer; i++) {
      // Remakes first — proven traditional hits are the richer ingredient source
      if (i < remakeCandidates.length) {
        const v = remakeCandidates[i];
        if (!seen.has(v.videoId)) { seen.add(v.videoId); result.push(v); }
      }
      if (i < aiOriginals.length) {
        const v = aiOriginals[i];
        if (!seen.has(v.videoId)) { seen.add(v.videoId); result.push(v); }
      }
    }
    return result;
  }

  async runStage(stageName, fn) {
    this.state.currentStage = stageName;
    this.state.status = 'running';
    this.emit({ type: 'stage', stage: stageName });
    this.log(`── Stage: ${stageName} ──`);
    const pid = this.state.project?.id;
    if (pid) db.logEvent(pid, 'stage_start', { stage: stageName });
    await fn();
    if (pid) db.logEvent(pid, 'stage_complete', { stage: stageName });
  }

  // ── Approval gates ──
  _approvalResolvers = {};

  /**
   * Re-emit gate-specific data on resume so the renderer can populate
   * the approval UI (e.g. location thumbnails, element checklists).
   * Called before re-entering a pending gate after app restart.
   */
  /**
   * Build and emit scene verification data grouped by location.
   * Fired before the 'scenes' approval gate so the Scene Verification tab
   * can render a location-grouped grid for continuity review.
   */
  _emitSceneVerificationData(projectId, projectDir) {
    const fs = require('fs');
    const path = require('path');

    const sceneAssets = db.getAssets(projectId, { type: 'scene_image_cinematic' })
      .filter(a => a.status === 'done' || a.status === 'pending' || a.status === 'failed');

    // Build scene list from the script to get location_element_hint for each scene
    const script = this.state.script;
    const sceneMetaMap = {}; // key: "chapter_sceneNumber" → scene metadata
    for (const ch of (script?.chapters || [])) {
      for (const sc of (ch.scenes || [])) {
        sceneMetaMap[`${ch.chapter_number}_${sc.scene_number}`] = {
          location_hint: (sc.location_element_hint || '').toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          location_label: sc.location || sc.location_element_hint || 'unknown',
          characters_present: sc.characters_present || [],
          blocking_notes: sc.blocking?.notes || '',
        };
      }
    }

    // Build location image lookup from DB assets (survives resume — unlike in-memory cinematicLocations)
    const locImageMap = {}; // key: location_hint → file_path
    const locAssets = db.getAssets(projectId, { type: 'location_image', status: 'done' });
    for (const la of locAssets) {
      // element_name stores the location hint for location_image assets (set via setAssetElementName)
      const hint = (la.element_name || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
      if (hint && la.file_path && fs.existsSync(la.file_path)) {
        locImageMap[hint] = la.file_path;
      }
    }
    // Also try in-memory map as fallback
    const locMap = this.state.cinematicLocations || {};

    // Build location → scenes map
    const locationGroups = {}; // key: location_hint → { locationLabel, locationImagePath, scenes[] }

    for (const asset of sceneAssets) {
      const key = `${asset.chapter}_${asset.scene}`;
      const meta = sceneMetaMap[key] || {};
      const locHint = meta.location_hint || 'unknown';

      if (!locationGroups[locHint]) {
        const locInfo = locMap[locHint] || {};
        locationGroups[locHint] = {
          locationHint: locHint,
          locationLabel: meta.location_label || locHint,
          locationImagePath: locImageMap[locHint] || locInfo.imagePath || null,
          scenes: [],
        };
      }

      const fileBase = asset.file_path ? path.basename(asset.file_path, path.extname(asset.file_path)) : `ch${String(asset.chapter).padStart(2, '0')}_sc${String(asset.scene).padStart(2, '0')}_cinematic`;

      locationGroups[locHint].scenes.push({
        chapter: asset.chapter,
        scene: asset.scene,
        hint: fileBase,
        imagePath: asset.file_path && fs.existsSync(asset.file_path) ? asset.file_path : null,
        status: asset.status,
        characters: meta.characters_present || [],
        blockingNotes: meta.blocking_notes || '',
        promptUsed: asset.prompt_used || null,
      });
    }

    // Sort scenes within each group by chapter then scene number
    for (const group of Object.values(locationGroups)) {
      group.scenes.sort((a, b) => a.chapter !== b.chapter ? a.chapter - b.chapter : a.scene - b.scene);
    }

    // Sort location groups by total scene count descending (most-used locations first)
    const sortedGroups = Object.values(locationGroups).sort((a, b) => b.scenes.length - a.scenes.length);

    this.emit({
      type: 'cinematic-scene-verification-data',
      locationGroups: sortedGroups,
      totalScenes: sceneAssets.length,
      doneScenes: sceneAssets.filter(a => a.status === 'done').length,
    });
    this.log(`[SCENE-VERIFY] Emitted verification data: ${sortedGroups.length} location(s), ${sceneAssets.length} scene(s)`);
  }

  /**
   * Emit dialogue triage data — categorises every kling_clip as having dialogue
   * or being silent. Called before the dialogue-triage approval gate so the UI
   * can show the triage panel. Also auto-marks silent clips as 'skipped' in DB
   * (user can un-skip individual clips as b-roll from the UI).
   */
  _emitDialogueTriageData(projectId) {
    const script = this.state.script;
    if (!script?.chapters) return;

    // Build line lookup: chapter → scene → lineNumber → line object
    const lineLookup = {};
    for (const ch of script.chapters) {
      for (const sc of ch.scenes) {
        for (const ln of (sc.lines || [])) {
          lineLookup[`${ch.chapter_number}_${sc.scene_number}_${ln.line_number}`] = ln;
        }
      }
    }

    // Get existing clip assets from DB to check current status
    const clipAssets = db.getAssets(projectId, { type: 'video_clip_cinematic' });
    const clipAssetByClipId = {};
    for (const a of clipAssets) {
      if (a.kling_clip_id) clipAssetByClipId[a.kling_clip_id] = a;
    }

    const triageItems = [];
    let autoSkipped = 0;

    for (const ch of script.chapters) {
      for (const sc of ch.scenes) {
        for (const clipDef of (sc.kling_clips || [])) {
          const clipId = clipDef.clip_id;
          const lineRefs = clipDef.line_refs || [];

          // Check each line_ref for dialogue
          const linesWithDialogue = [];
          const linesWithoutDialogue = [];
          for (const lineNum of lineRefs) {
            const line = lineLookup[`${ch.chapter_number}_${sc.scene_number}_${lineNum}`];
            const dialogue = line ? (line.dialogue || '').trim() : '';
            if (dialogue) {
              linesWithDialogue.push({
                lineNumber: lineNum,
                speaker: line.speaker_id || '',
                dialogue,
                tone: line.tone || '',
              });
            } else {
              linesWithoutDialogue.push({
                lineNumber: lineNum,
                speaker: line?.speaker_id || '',
                action: line?.animation_prompt || line?.image_prompt || '',
              });
            }
          }

          const hasDialogue = linesWithDialogue.length > 0;
          const clipAsset = clipAssetByClipId[clipId];

          // Auto-skip silent clips that are still pending (don't override manual decisions)
          if (!hasDialogue && clipAsset && clipAsset.status === 'pending') {
            db.markAssetSkipped(clipAsset.id, 'no-dialogue');
            autoSkipped++;
          }

          triageItems.push({
            clipId,
            chapter: ch.chapter_number,
            scene: sc.scene_number,
            hasDialogue,
            lineRefs,
            linesWithDialogue,
            linesWithoutDialogue,
            durationSeconds: clipDef.duration_seconds || 10,
            promptSnippet: (clipDef.multi_shot_prompt || '').substring(0, 200),
            assetId: clipAsset?.id || null,
            currentStatus: clipAsset ? (hasDialogue ? clipAsset.status : (clipAsset.status === 'pending' ? 'skipped' : clipAsset.status)) : 'unknown',
          });
        }
      }
    }

    const withDialogue = triageItems.filter(t => t.hasDialogue);
    const silent = triageItems.filter(t => !t.hasDialogue);

    this.emit({
      type: 'dialogue-triage-data',
      triageItems,
      totalClips: triageItems.length,
      withDialogue: withDialogue.length,
      silent: silent.length,
    });

    if (autoSkipped > 0) {
      this.log(`[DIALOGUE-TRIAGE] Auto-skipped ${autoSkipped} silent clip(s) — user can approve as b-roll from UI`);
    }
    this.log(`[DIALOGUE-TRIAGE] Emitted triage data: ${withDialogue.length} with dialogue, ${silent.length} silent, ${triageItems.length} total`);
  }

  /**
   * Apply dialogue triage decisions from the UI.
   * @param {{ skipClipIds: string[], approveClipIds: string[] }} decisions
   */
  applyDialogueTriage(decisions) {
    const project = this.getActiveProject();
    if (!project) return { success: false, reason: 'no active project' };

    const clipAssets = db.getAssets(project.id, { type: 'video_clip_cinematic' });
    const byClipId = {};
    for (const a of clipAssets) {
      if (a.kling_clip_id) byClipId[a.kling_clip_id] = a;
    }

    let skippedCount = 0;
    let approvedCount = 0;

    // Mark clips to skip
    for (const clipId of (decisions.skipClipIds || [])) {
      const asset = byClipId[clipId];
      if (asset && asset.status !== 'skipped') {
        db.markAssetSkipped(asset.id, 'no-dialogue');
        skippedCount++;
      }
    }

    // Un-skip clips approved as b-roll
    for (const clipId of (decisions.approveClipIds || [])) {
      const asset = byClipId[clipId];
      if (asset && asset.status === 'skipped') {
        db.markAssetUnskipped(asset.id);
        approvedCount++;
      }
    }

    this.log(`[DIALOGUE-TRIAGE] Applied: ${skippedCount} skipped, ${approvedCount} approved as b-roll`);
    return { success: true, skipped: skippedCount, approved: approvedCount };
  }

  async _reEmitGateData(gate, projectId, projectDir) {
    const fs = require('fs');
    const path = require('path');

    if (gate === 'locations-ready') {
      // Rebuild location summary from DB assets for the thumbnail grid
      const locAssets = db.getAssets(projectId, { type: 'location_image' });
      const locationSummary = [];
      for (const asset of locAssets) {
        let width = 0, height = 0;
        if (asset.file_path && fs.existsSync(asset.file_path)) {
          try {
            const fd = fs.openSync(asset.file_path, 'r');
            const buf = Buffer.alloc(24);
            fs.readSync(fd, buf, 0, 24, 0);
            fs.closeSync(fd);
            if (buf[0] === 0x89 && buf[1] === 0x50) {
              width = buf.readUInt32BE(16);
              height = buf.readUInt32BE(20); // IHDR: width@16, height@20
            }
          } catch (_) {}
        }
        // Derive a meaningful hint from element_name or file path basename
        // (file paths like .../locations/rooftop_party.png → "rooftop_party")
        const locHint = asset.element_name
          || (asset.file_path ? path.basename(asset.file_path, path.extname(asset.file_path)) : null)
          || String(asset.id);
        locationSummary.push({
          hint: locHint,
          name: asset.element_name || locHint,
          description: asset.prompt_used || '',
          imagePath: asset.file_path || null,
          width,
          height,
          status: asset.file_path && fs.existsSync(asset.file_path) ? 'done' : 'missing',
        });
      }
      if (locationSummary.length > 0) {
        this.emit({ type: 'cinematic-locations-ready', locations: locationSummary, expectedAspect: this.state.aspectRatio || '16:9' });
        this.log(`[RESUME] Re-emitted location data for ${locationSummary.length} location(s)`);
      }
    }

    if (gate === 'elements-ready') {
      // Rebuild element checklist from script characters
      const script = this.state.script;
      if (script?.characters) {
        const suffix = this.state.elementSuffix || '';
        const pending = script.characters.map(c => {
          const hint = c.element_name_hint || c.description_label?.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || c.id;
          const name = suffix ? `${hint}_${suffix}` : hint;
          return { name, description: c.full_prompt_description || c.description_label || '' };
        });
        this.emit({ type: 'cinematic-manual-element-checklist', pending });
        this.log(`[RESUME] Re-emitted element checklist for ${pending.length} element(s)`);
      }
    }

    if (gate === 'scenes') {
      // Rebuild scene verification data for the Scene Verification tab
      this._emitSceneVerificationData(projectId, projectDir);
    }

    if (gate === 'dialogue-triage') {
      // Rebuild dialogue triage data for the Dialogue Triage tab
      this._emitDialogueTriageData(projectId);
    }

    // Other gates (portraits, clips, etc.) don't need extra data —
    // the 'waiting' event alone is enough for the renderer to show the right UI.
  }

  waitForApproval(gate) {
    // Persist the pending gate to DB so it survives app restarts.
    // On resume, the pipeline checks for a pending gate and re-enters
    // the wait before continuing the stage.
    const projectId = this.state.project?.id;
    if (projectId) {
      try {
        const rawSettings = db.getProject(projectId)?.settings;
        const settings = rawSettings ? (typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings) : {};
        settings.pending_approval_gate = gate;
        db.updateProject(projectId, { settings: JSON.stringify(settings) });
      } catch (e) {
        console.warn('[GATE] Failed to persist pending gate:', e.message);
      }
    }

    return new Promise((resolve) => {
      this._approvalResolvers[gate] = (value) => {
        // Clear the pending gate from DB on approval
        if (projectId) {
          try {
            const rawSettings = db.getProject(projectId)?.settings;
            const settings = rawSettings ? (typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings) : {};
            delete settings.pending_approval_gate;
            db.updateProject(projectId, { settings: JSON.stringify(settings) });
          } catch (e) {
            console.warn('[GATE] Failed to clear pending gate:', e.message);
          }
        }
        resolve(value);
      };
    });
  }

  approveResearch(selections = {}) {
    // Merge user's theme selections into the brief
    // Nationality/accent are baked in (always Nigerian), tone/setting are research-derived
    if (this.state.project?.brief && selections.selectedThemes?.length) {
      this.state.project.brief.concept = `Story inspired by these proven themes: ${selections.selectedThemes.join(', ')}`;
    }

    if (this._approvalResolvers['research']) {
      this._approvalResolvers['research']();
      delete this._approvalResolvers['research'];
    }
    this.log('Research approved — proceeding to script generation');
  }

  approveTitle(title) {
    this.state.selectedTitle = title;
    if (this._approvalResolvers['title']) {
      this._approvalResolvers['title']();
      delete this._approvalResolvers['title'];
    }
    this.log(`Title approved: "${title}"`);
  }

  /**
   * Approve the generated script and proceed to video generation.
   * @param {Object} [options]
   * @param {boolean} [options.override] - Pass true to bypass the structural
   *   review hard-block. Only set when the user explicitly confirms via the
   *   "Override and approve anyway" secondary dialog in the UI.
   * @returns {{ accepted: boolean, reason?: string, review?: Object }}
   */
  approveScript({ override = false } = {}) {
    const review = this.state.scriptReview;
    // Hard-block: reject approval if review failed and user didn't explicitly override.
    // Protects 1000-3000 credits per long-form run from being wasted on a weak script.
    if (review && !review.pass && !override) {
      this.log(`[REVIEW] Approval blocked: score=${review.score}/${review.threshold} — regenerate or override`, 'warn');
      return { accepted: false, reason: 'structural-review-failed', review };
    }
    if (this._approvalResolvers['script']) {
      this._approvalResolvers['script']();
      delete this._approvalResolvers['script'];
    }
    if (review && !review.pass && override) {
      this.log(`[REVIEW] Script approved via OVERRIDE (score=${review.score}/${review.threshold}) — user accepts the structural risk`, 'warn');
    } else {
      this.log('Script approved');
    }
    return { accepted: true, review };
  }

  /**
   * Regenerate the script (discards the current one + its review, generates
   * fresh). Called from the UI when the review hard-blocks and the user opts
   * to retry instead of override.
   *
   * Implemented as: resolve the current approval promise with a REGENERATE
   * sentinel, then the orchestrator's script stage catches it and loops back
   * into generation. The stage loop around the waitForApproval handles this.
   */
  requestScriptRegenerate() {
    if (this._approvalResolvers['script']) {
      this._approvalResolvers['script']({ regenerate: true });
      delete this._approvalResolvers['script'];
      this.log('[REVIEW] Script regeneration requested by user');
    }
  }

  approvePortraits() {
    if (this._approvalResolvers['portraits']) {
      this._approvalResolvers['portraits']();
      delete this._approvalResolvers['portraits'];
    }
    this.log('Portraits approved');
  }

  rerenderPortraits() {
    if (this._approvalResolvers['portraits']) {
      this._approvalResolvers['portraits']({ rerender: true });
      delete this._approvalResolvers['portraits'];
    }
    this.log('Portrait re-render requested');
  }

  /**
   * Roll the active project's stage back to 'script-done' so the portrait
   * generation loop re-runs on next start. Use when a portrait file was
   * deleted or is missing and the pipeline has already advanced past
   * the portraits stage.
   */
  resetToPortraits() {
    const project = this.getActiveProject();
    if (!project) {
      this.log('[RESET] No active project', 'error');
      return { success: false, reason: 'no active project' };
    }
    db.updateProjectStage(project.id, 'script-done');
    this.log(`[RESET] Project "${project.title}" stage rolled back to script-done — portraits will re-run on next start`);
    return { success: true, stage: 'script-done' };
  }

  /**
   * Roll the active project's stage back to 'scenes-done' so the Scene
   * Verification tab shows on next resume. Safe to call at any stage
   * after scenes-done — video clips are NOT deleted, just the stage
   * pointer is rewound. On resume, the scenes gate fires (showing the
   * verification tab) ONLY if no video clips have started yet. If clips
   * have started, we also clear them so the gate fires cleanly.
   *
   * @param {boolean} clearClips - If true, reset all video_clip_cinematic
   *   assets to pending so the scenes gate re-fires even if clips had started.
   *   If false (default), only resets stage — clips that already started will
   *   cause the pipeline to skip the scenes gate and go straight to video gen.
   */
  resetToSceneVerify(clearClips = true) {
    const project = this.getActiveProject();
    if (!project) {
      this.log('[RESET] No active project', 'error');
      return { success: false, reason: 'no active project' };
    }

    // Check BOTH video clip types — settings.generator_mode may be wrong,
    // so detect from actual assets (same approach as reset-to-scene-verify.js)
    const clipTypes = ['video_clip_cinematic', 'video_clip'];
    let totalCleared = 0;

    for (const clipType of clipTypes) {
      const allClips = db.getAssets(project.id, { type: clipType });
      if (allClips.length === 0) continue;

      const doneClips = allClips.filter(a => a.status === 'done');

      if (clearClips) {
        // Delete all video clip asset rows — they haven't been assembled yet,
        // and the video stage will recreate them from scratch after scene approval.
        // The actual clip files on disk are kept (pipeline will regenerate only
        // clips whose asset rows are missing or pending).
        this.log(`[RESET] Clearing ${allClips.length} ${clipType} asset row(s) (${doneClips.length} done) so scene gate re-fires`);
        for (const clip of allClips) {
          db.deleteAsset(clip.id);
        }
        totalCleared += allClips.length;
      } else {
        this.log(`[RESET] WARNING: ${doneClips.length}/${allClips.length} ${clipType} clips already exist — scene gate may be skipped on resume. Use clearClips=true to force.`, 'warn');
      }
    }

    // Clear any pending approval gate
    try {
      const rawSettings = db.getProject(project.id)?.settings;
      const settings = rawSettings ? (typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings) : {};
      if (settings.pending_approval_gate) {
        this.log(`[RESET] Clearing pending_approval_gate: "${settings.pending_approval_gate}"`);
        delete settings.pending_approval_gate;
        db.updateProject(project.id, { settings: JSON.stringify(settings) });
      }
    } catch (_) {}

    db.updateProjectStage(project.id, 'scenes-done');
    this.log(`[RESET] Project "${project.title}" stage rolled back to scenes-done — Scene Verification tab will show on next start`);
    return { success: true, stage: 'scenes-done', clipsCleared: totalCleared };
  }

  /**
   * Poll the Higgsfield Elements panel every 10s to check if all required
   * elements exist. Resolves (returns) as soon as they're all found.
   * Called in a Promise.race against the manual "Elements Ready" button.
   */
  async _pollForElements(elements, pending) {
    this._elementPollAborted = false;
    const POLL_INTERVAL = 10000; // 10 seconds
    const MAX_POLLS = 60;       // give up after 10 minutes

    for (let i = 0; i < MAX_POLLS; i++) {
      if (this._elementPollAborted) return;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      if (this._elementPollAborted) return;

      try {
        elements.invalidateCache();
        const current = await elements.listExistingElements();
        const missing = pending.filter(p => !current.some(e =>
          e.name && e.name.toLowerCase().replace(/^@+/, '') === p.name.toLowerCase()
        ));

        if (missing.length === 0) {
          this.log(`[CINEMATIC] Auto-poll: all ${pending.length} elements now exist — auto-continuing`);
          return; // resolves the Promise.race
        }
        this.log(`[CINEMATIC] Auto-poll ${i + 1}: ${missing.length} element(s) still missing`);
      } catch (e) {
        // Browser might be closed or Elements panel inaccessible — keep waiting
        this.log(`[CINEMATIC] Auto-poll ${i + 1}: check failed (${e.message.split('\n')[0]}) — retrying`);
      }
    }
    this.log('[CINEMATIC] Auto-poll: timed out after 10 minutes — waiting for manual "Elements Ready" click');
  }

  /**
   * Cinematic mode only: resolve the "Elements Ready — Continue" gate after
   * the user has finished manual element creation in the Higgsfield UI.
   * Called from the renderer when they click the Elements Ready button on
   * the manual checklist panel.
   */
  approveElementsReady() {
    if (this._approvalResolvers['elements-ready']) {
      this._approvalResolvers['elements-ready']();
      delete this._approvalResolvers['elements-ready'];
    }
    this.log('[CINEMATIC] Elements confirmed ready by user');
  }

  approveLocationsReady() {
    if (this._approvalResolvers['locations-ready']) {
      this._approvalResolvers['locations-ready']();
      delete this._approvalResolvers['locations-ready'];
    }
    this.log('[CINEMATIC] Locations confirmed ready by user');
  }

  /**
   * Regenerate selected location images. Called from the Locations tab when the
   * user clicks "Regenerate Selected". Cleans up the DB asset + local file so
   * the pipeline re-generates on next run.
   * @param {string[]} hints - Location hint names (e.g. ['rooftop_party', 'church_hall'])
   */
  regenerateLocations(hints = []) {
    if (!hints || hints.length === 0) return;
    const fs = require('fs');
    const projectId = this.state.project?.id;
    if (!projectId) {
      this.log('[REGEN-LOC] No active project — cannot regenerate', 'warn');
      return;
    }

    this.log(`[REGEN-LOC] Starting regen for projectId=${projectId}, hints=${JSON.stringify(hints)}`);

    const allLocAssets = db.getAssets(projectId, { type: 'location_image' });
    this.log(`[REGEN-LOC] Found ${allLocAssets.length} location_image asset(s) in DB for project ${projectId}`);
    if (allLocAssets.length > 0) {
      const pathMod = require('path');
      this.log(`[REGEN-LOC] Assets: ${allLocAssets.map(a => {
        const name = a.element_name || '<null>';
        const file = a.file_path ? pathMod.basename(a.file_path) : '<no file>';
        return `#${a.id}(name=${name}, file=${file})`;
      }).join(', ')}`);
    }

    let cleaned = 0;

    for (const hint of hints) {
      const hintLower = hint.toLowerCase();
      // STRICT match: exact file_path basename only (e.g. hint "rooftop_party" matches "rooftop_party.png")
      // Never use includes() — it caused mass-deletion when element_name was null
      const matching = allLocAssets.filter(a => {
        if (!a.file_path) return false;
        const fileBase = require('path').basename(a.file_path, require('path').extname(a.file_path)).toLowerCase();
        return fileBase === hintLower;
      });

      this.log(`[REGEN-LOC] Hint "${hint}" matched ${matching.length} asset(s)${matching.length > 0 ? ': ' + matching.map(a => `#${a.id}(${a.element_name || require('path').basename(a.file_path || '')})`).join(', ') : ''}`);

      // SAFETY: each hint should match at most 1 asset. If more matched, something is wrong — abort.
      if (matching.length > 1) {
        this.log(`[REGEN-LOC] ABORT: hint "${hint}" matched ${matching.length} assets (expected 0-1). Skipping to prevent mass deletion.`, 'error');
        continue;
      }

      for (const asset of matching) {
        // Delete local file
        if (asset.file_path) {
          try {
            if (fs.existsSync(asset.file_path)) {
              fs.unlinkSync(asset.file_path);
              this.log(`[REGEN-LOC] Deleted file: ${asset.file_path}`);
            }
          } catch (e) {
            this.log(`[REGEN-LOC] Could not delete file: ${e.message}`, 'warn');
          }
        }

        // Delete DB asset entirely — pipeline will create a fresh one on re-run
        try {
          db.deleteAsset(asset.id);
          this.log(`[REGEN-LOC] Deleted DB asset #${asset.id} (${asset.element_name})`);
          cleaned++;
        } catch (e) {
          this.log(`[REGEN-LOC] Failed to delete asset: ${e.message}`, 'warn');
        }
      }

      // Also clear from state.cinematicLocations if present
      if (this.state.cinematicLocations && this.state.cinematicLocations[hint]) {
        delete this.state.cinematicLocations[hint];
      }
    }

    // Persist the regen hints AND clear pending_approval_gate so the pipeline
    // doesn't re-enter the locations-ready wait on restart.
    try {
      const rawSettings = db.getProject(projectId)?.settings;
      const settings = rawSettings ? (typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings) : {};

      // Save regen hints for prompt refinement on next run
      const existing = settings.location_regen_hints || [];
      settings.location_regen_hints = [...new Set([...existing, ...hints])];

      // Clear pending approval gate — critical: without this, the pipeline
      // re-enters the locations-ready wait BEFORE any stages run on restart
      if (settings.pending_approval_gate) {
        this.log(`[REGEN-LOC] Clearing pending_approval_gate: "${settings.pending_approval_gate}"`);
        delete settings.pending_approval_gate;
      }

      db.updateProject(projectId, { settings: JSON.stringify(settings) });
      this.log(`[REGEN-LOC] Saved regen hints + cleared pending gate in DB settings`);
    } catch (e) {
      this.log(`[REGEN-LOC] Failed to update DB settings: ${e.message}`, 'warn');
    }

    // Reset project stage to portraits-done so the elements-setup stage
    // (which includes location generation) re-runs on next pipeline start.
    db.updateProjectStage(projectId, 'portraits-done');
    this.log(`[REGEN-LOC] Stage reset to portraits-done — elements-setup will re-run on restart`);

    this.log(`[REGEN-LOC] Cleaned ${cleaned} asset(s) for ${hints.length} location(s) — restart pipeline to re-generate`);
  }

  /**
   * Regenerate selected scene images. Called from the Scene Verification tab
   * when the user clicks "Regenerate Selected". Uses SOFT DELETE: renames
   * the old file into .archive/, marks the DB row as 'archived' (preserving
   * all metadata), and inserts a fresh 'pending' row so the pipeline
   * re-generates only those scenes on next run.
   *
   * @param {string[]} hints - Scene file basenames, e.g. ['ch05_sc03_cinematic', 'ch05_sc04_cinematic']
   */
  regenerateScenes(hints = []) {
    if (!hints || hints.length === 0) return;
    const fs = require('fs');
    const path = require('path');
    const projectId = this.state.project?.id;
    if (!projectId) {
      this.log('[REGEN-SCENE] No active project — cannot regenerate', 'warn');
      return;
    }

    this.log(`[REGEN-SCENE] Starting regen for projectId=${projectId}, hints=${JSON.stringify(hints)}`);

    const allSceneAssets = db.getAssets(projectId, { type: 'scene_image_cinematic' })
      .filter(a => a.status !== 'archived'); // ignore already-archived rows
    this.log(`[REGEN-SCENE] Found ${allSceneAssets.length} active scene_image_cinematic asset(s)`);
    if (allSceneAssets.length > 0) {
      this.log(`[REGEN-SCENE] Assets: ${allSceneAssets.map(a => {
        const file = a.file_path ? path.basename(a.file_path) : '<no file>';
        return `#${a.id}(ch${a.chapter}_sc${a.scene}, status=${a.status}, file=${file})`;
      }).join(', ')}`);
    }

    let archived = 0;

    for (const hint of hints) {
      const hintLower = hint.toLowerCase();
      // STRICT match: exact file_path basename only (no includes!)
      const matching = allSceneAssets.filter(a => {
        if (!a.file_path) return false;
        const fileBase = path.basename(a.file_path, path.extname(a.file_path)).toLowerCase();
        return fileBase === hintLower;
      });

      this.log(`[REGEN-SCENE] Hint "${hint}" matched ${matching.length} asset(s)${matching.length > 0 ? ': ' + matching.map(a => `#${a.id}(ch${a.chapter}_sc${a.scene})`).join(', ') : ''}`);

      // SAFETY: each hint should match at most 1 asset. If more matched, abort.
      if (matching.length > 1) {
        this.log(`[REGEN-SCENE] ABORT: hint "${hint}" matched ${matching.length} assets (expected 0-1). Skipping to prevent mass archival.`, 'error');
        continue;
      }

      for (const asset of matching) {
        // ── SOFT DELETE: rename file into .archive/ subdirectory ──
        if (asset.file_path && fs.existsSync(asset.file_path)) {
          try {
            const dir = path.dirname(asset.file_path);
            const archiveDir = path.join(dir, '.archive');
            fs.mkdirSync(archiveDir, { recursive: true });

            const ext = path.extname(asset.file_path);
            const base = path.basename(asset.file_path, ext);

            // Determine version number (v1, v2, ...) by counting existing archives
            let version = 1;
            try {
              const existing = fs.readdirSync(archiveDir).filter(f => f.startsWith(base + '_v'));
              version = existing.length + 1;
            } catch (_) {}

            const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const archiveName = `${base}_v${version}_${dateStamp}${ext}`;
            const archivePath = path.join(archiveDir, archiveName);

            fs.renameSync(asset.file_path, archivePath);
            this.log(`[REGEN-SCENE] Archived file: ${asset.file_path} → ${archivePath}`);

            // ── SOFT DELETE: archive DB row (preserves all metadata) ──
            db.markAssetArchived(asset.id, archivePath, `v${version}`);
            this.log(`[REGEN-SCENE] Archived DB asset #${asset.id} (ch${asset.chapter}_sc${asset.scene}) as v${version}`);
          } catch (e) {
            this.log(`[REGEN-SCENE] Failed to archive file: ${e.message}`, 'warn');
            // Still archive the DB row even if file rename failed
            db.markAssetArchived(asset.id, asset.file_path, 'v?');
          }
        } else {
          // No file on disk — just archive the DB row
          db.markAssetArchived(asset.id, asset.file_path || '', 'v0');
          this.log(`[REGEN-SCENE] Archived DB asset #${asset.id} (no file on disk)`);
        }

        // ── INSERT fresh pending row for the same chapter+scene ──
        db.insertExpectedAssets(projectId, [{
          type: 'scene_image_cinematic',
          chapter: asset.chapter,
          scene: asset.scene,
        }]);
        this.log(`[REGEN-SCENE] Inserted fresh pending asset for ch${asset.chapter}_sc${asset.scene}`);
        archived++;
      }
    }

    // Persist regen hints + clear pending_approval_gate
    try {
      const rawSettings = db.getProject(projectId)?.settings;
      const settings = rawSettings ? (typeof rawSettings === 'string' ? JSON.parse(rawSettings) : rawSettings) : {};

      const existing = settings.scene_regen_hints || [];
      settings.scene_regen_hints = [...new Set([...existing, ...hints])];

      // Clear pending approval gate so pipeline re-runs scene generation
      if (settings.pending_approval_gate) {
        this.log(`[REGEN-SCENE] Clearing pending_approval_gate: "${settings.pending_approval_gate}"`);
        delete settings.pending_approval_gate;
      }

      db.updateProject(projectId, { settings: JSON.stringify(settings) });
      this.log(`[REGEN-SCENE] Saved regen hints + cleared pending gate in DB settings`);
    } catch (e) {
      this.log(`[REGEN-SCENE] Failed to update DB settings: ${e.message}`, 'warn');
    }

    // Reset project stage to portraits-done so the scene image stage re-runs.
    // The scene loop skips all 'done' scenes and only generates 'pending' ones.
    db.updateProjectStage(projectId, 'portraits-done');
    this.log(`[REGEN-SCENE] Stage reset to portraits-done — scene image stage will re-run on restart`);

    this.log(`[REGEN-SCENE] Archived ${archived} scene(s) for ${hints.length} hint(s) — restart pipeline to re-generate`);
  }

  /**
   * Cinematic mode only: resolve the "Scene Images Ready — Continue" gate
   * after the user has finished manual scene image generation in Cinema
   * Studio. Pipeline rescans disk for the expected paths and proceeds.
   */
  approveSceneImagesReady() {
    if (this._approvalResolvers['scene-images-ready']) {
      this._approvalResolvers['scene-images-ready']();
      delete this._approvalResolvers['scene-images-ready'];
    }
    this.log('[CINEMATIC] Scene images confirmed ready by user');
  }

  approveScenes() {
    if (this._approvalResolvers['scenes']) {
      this._approvalResolvers['scenes']();
      delete this._approvalResolvers['scenes'];
    }
    this.log('Scene images approved');
  }

  approveDialogueTriage() {
    if (this._approvalResolvers['dialogue-triage']) {
      this._approvalResolvers['dialogue-triage']();
      delete this._approvalResolvers['dialogue-triage'];
    }
    this.log('Dialogue triage approved — proceeding to video generation');
    return { success: true };
  }

  approveClips() {
    if (this._approvalResolvers['clips']) {
      this._approvalResolvers['clips']();
      delete this._approvalResolvers['clips'];
    }
    this.log('Video clips approved');
  }

  /**
   * TEMPORARY — remove when full production starts.
   * Pre-generation prompt preview gate. User reads the final multi_shot_prompt
   * and approves or stops before Kling burns credits.
   * @param {'continue'|'stop'} decision
   */
  approvePromptPreview(decision = 'continue') {
    if (this._approvalResolvers['prompt-preview']) {
      this._approvalResolvers['prompt-preview'](decision);
      delete this._approvalResolvers['prompt-preview'];
    }
    this.log(`Prompt preview decision: ${decision}`);
  }

  /**
   * TEMPORARY — remove when full production starts.
   * Per-clip approval gate. User watches the generated clip and approves or
   * stops before the next clip burns credits.
   * @param {'continue'|'stop'} decision - 'continue' proceeds to next clip,
   *   'stop' breaks out of the clip loop (remaining clips skipped).
   */
  approveClipReview(decision = 'continue') {
    if (this._approvalResolvers['clip-review']) {
      this._approvalResolvers['clip-review'](decision);
      delete this._approvalResolvers['clip-review'];
    }
    this.log(`Clip review decision: ${decision}`);
  }

  /**
   * Approve the Verify stage. Called after the user has reviewed flagged clips
   * in the Verify tab (accepted ones they want to keep, rejected ones get
   * reset to pending via db.setVerifyHumanDecision). Returning from here lets
   * the pipeline either jump back to video gen (if any clips were rejected)
   * or proceed to assembly.
   */
  approveVerify() {
    if (this._approvalResolvers['verify']) {
      this._approvalResolvers['verify']();
      delete this._approvalResolvers['verify'];
    }
    this.log('Verify stage approved');
  }

  updateScriptLine(chapterIdx, sceneIdx, lineIdx, updates) {
    const line = this.state.script.chapters[chapterIdx]?.scenes[sceneIdx]?.lines[lineIdx];
    if (line) {
      Object.assign(line, updates);
      // Persist script change to DB
      if (this.state.project?.id) {
        db.updateProject(this.state.project.id, { script_json: this.state.script });
      }
      this.emit({ type: 'script-updated' });
    }
  }

  flagAsset(type, index) {
    if (!this.state.flaggedAssets[type]) this.state.flaggedAssets[type] = [];
    const arr = this.state.flaggedAssets[type];
    const pos = arr.indexOf(index);
    if (pos >= 0) {
      arr.splice(pos, 1);
      this.emit({ type: 'asset-unflagged', assetType: type, index });
      this.log(`Unflagged ${type} asset at index ${index}`);
    } else {
      arr.push(index);
      this.emit({ type: 'asset-flagged', assetType: type, index });
      this.log(`Flagged ${type} asset at index ${index}`);
    }
  }

  /**
   * Wrap a Higgsfield automation call with SESSION_EXPIRED recovery.
   * If the session expires mid-generation, pauses the pipeline, emits a
   * Verify all assets for a given type are complete before allowing stage transition.
   * Checks both the DB status AND file existence on disk.
   *
   * @param {string} type - Asset type ('portrait', 'scene_image', 'video_clip')
   * @param {string} stageName - Human-readable stage name for logging
   * @throws {Error} If any assets are incomplete or files are missing
   */
  verifyStageComplete(type, stageName) {
    const projectId = this.state.project.id;
    const fs = require('fs');

    // Check DB for any non-done assets
    const incomplete = db.getIncompleteAssets(projectId, type);
    if (incomplete.length > 0) {
      const statuses = incomplete.map(a => `id=${a.id}:${a.status}`).join(', ');
      db.logEvent(projectId, 'verification_fail', { stage: stageName, detail: `${incomplete.length} assets not done: ${statuses}` });
      throw new Error(`${stageName} incomplete: ${incomplete.length} assets not done [${statuses}]`);
    }

    // Check that every 'done' asset has a valid file on disk
    const allAssets = db.getAssets(projectId, { type, status: 'done' });
    const missingFiles = [];
    for (const asset of allAssets) {
      if (!asset.file_path || !fs.existsSync(asset.file_path)) {
        missingFiles.push({ id: asset.id, path: asset.file_path || '(null)' });
      }
    }

    if (missingFiles.length > 0) {
      const details = missingFiles.map(m => `id=${m.id}: ${m.path}`).join(', ');
      this.log(`${stageName}: ${missingFiles.length} assets marked done but files missing — resetting to pending`, 'warn');
      db.logEvent(projectId, 'verification_fail', { stage: stageName, detail: `${missingFiles.length} files missing on disk: ${details}` });
      // Reset these back to pending so they get re-generated on retry
      for (const m of missingFiles) {
        db.resetAsset(m.id);
      }
      throw new Error(`${stageName} has ${missingFiles.length} missing files — reset to pending for retry [${details}]`);
    }

    const counts = db.getAssetCounts(projectId, type);
    this.log(`[VERIFY] ${stageName} complete: ${counts.done}/${counts.total} assets done, all files verified on disk`);
  }

  // ── Publish Stage Methods ──

  /**
   * Get all projects eligible for publish — checks BOTH the DB and disk.
   * A project is publishable if it has a project_dir that contains scene
   * images on disk (assets/scenes/*.{png,jpg,jpeg,webp}).
   * This catches projects where the pipeline crashed after generating
   * images but before marking DB assets as 'done'.
   */
  getPublishableProjects() {
    const candidates = db.getPublishableProjects(); // all non-abandoned with project_dir
    const publishable = [];
    for (const p of candidates) {
      const sceneCount = this._countSceneImagesOnDisk(p.project_dir);
      if (sceneCount > 0) {
        p.sceneCount = sceneCount;
        publishable.push(p);
      }
    }
    return publishable;
  }

  /**
   * Count scene image files in a project's assets/scenes directory.
   */
  _countSceneImagesOnDisk(projectDir) {
    if (!projectDir) return 0;
    const scenesDir = path.join(projectDir, 'assets', 'scenes');
    try {
      if (!fs.existsSync(scenesDir)) return 0;
      const files = fs.readdirSync(scenesDir);
      return files.filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Get scene image file paths from disk for a project.
   * Falls back to disk scan if DB has no 'done' scene_image assets.
   */
  _getSceneImagePaths(projectId, projectDir) {
    // Try DB first — query BOTH scene_image and scene_image_cinematic types
    const dbAssets = [
      ...db.getAssets(projectId, { type: 'scene_image', status: 'done' }),
      ...db.getAssets(projectId, { type: 'scene_image_cinematic', status: 'done' }),
    ];
    const dbPaths = dbAssets.map(a => a.file_path).filter(p => p && fs.existsSync(p));
    if (dbPaths.length > 0) return dbPaths;

    // Fallback: scan disk — only match actual scene images, NOT portraits or grids.
    // Scene images follow naming patterns:
    //   ch01_line001.png          (standard mode)
    //   ch01_sc01_cinematic.png   (cinematic mode)
    const scenesDir = path.join(projectDir, 'assets', 'scenes');
    try {
      if (!fs.existsSync(scenesDir)) return [];
      return fs.readdirSync(scenesDir)
        .filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f) && /^ch\d+_(line\d+|sc\d+)/i.test(f))
        .map(f => path.join(scenesDir, f))
        .sort();
    } catch (_) {
      return [];
    }
  }

  /**
   * Load a project for publish operations. Works for both standalone
   * (any project by ID) and pipeline mode (active project).
   * Returns a normalized object with both snake_case (DB) and camelCase
   * property access for compatibility with downstream consumers.
   */
  _getProjectForPublish(projectId) {
    const row = projectId ? db.getProject(projectId) : db.getActiveProject();
    if (!row) return null;
    // Add camelCase aliases used by SEOGenerator / ThumbnailGenerator
    row.scriptJson = row.script_json || null;
    row.projectDir = row.project_dir || null;
    return row;
  }

  /**
   * Get publish state for active pipeline project.
   */
  getPublishState() {
    const row = this._getProjectForPublish();
    if (!row) return null;
    return this._buildPublishState(row);
  }

  /**
   * Get publish state for any project by ID (standalone mode).
   */
  getPublishStateForProject(projectId) {
    const row = this._getProjectForPublish(projectId);
    if (!row) return null;
    return this._buildPublishState(row);
  }

  /**
   * Load a project into the standalone publish context.
   * Sets _standalonePublishProjectId so subsequent publish calls
   * (thumbnail, SEO, etc.) operate on this project.
   */
  loadPublishProject(projectId) {
    const row = db.getProject(projectId);
    if (!row) return { success: false, reason: 'Project not found' };
    // Check scene images: DB first, then disk fallback
    const scenePaths = this._getSceneImagePaths(projectId, row.project_dir);
    if (scenePaths.length === 0) return { success: false, reason: 'No scene images found on disk' };
    this._standalonePublishProjectId = projectId;
    this.log(`[PUBLISH] Loaded project "${row.title}" (${projectId}) — ${scenePaths.length} scene images`);
    return { success: true, project: this._buildPublishState(row), sceneCount: scenePaths.length };
  }

  /**
   * Build a publish state object from a raw DB row.
   */
  _buildPublishState(row) {
    // Merge any in-memory publish state if this is the active pipeline project
    const activeProject = db.getActiveProject();
    const isActive = activeProject && activeProject.id === row.id;
    return {
      projectId: row.id,
      title: row.title,
      projectDir: row.project_dir,
      thumbnailPath: row.thumbnail_path || null,
      keyArtPath: row.thumbnail_key_art_path || null,
      titleCardPath: row.thumbnail_title_card_path || null,
      thumbnailSceneId: row.thumbnail_scene_id || null,
      youtubeMetadata: row.youtube_metadata ? JSON.parse(row.youtube_metadata) : null,
      facebookMetadata: row.facebook_metadata ? JSON.parse(row.facebook_metadata) : null,
      publishedAt: row.published_at || null,
      ...(isActive ? (this.state.publishState || {}) : {}),
    };
  }

  async scoreSceneThumbnails() {
    const project = this._getProjectForPublish(this._standalonePublishProjectId);
    if (!project) return [];
    // Use hybrid DB+disk lookup for scene images
    const paths = this._getSceneImagePaths(project.id, project.project_dir);
    if (paths.length === 0) return [];

    const { ThumbnailGenerator } = require('../publish/thumbnailGenerator');
    const geminiKey = this.store.get('geminiApiKey', '');
    const thumbGen = new ThumbnailGenerator(this.automation, { geminiApiKey: geminiKey });
    const candidates = await thumbGen.scoreSceneCandidates(paths);
    if (this.state.publishState) this.state.publishState.sceneCandidates = candidates;
    return candidates;
  }

  /**
   * Select a scene for thumbnail generation.
   * @param {string|number} sceneRef - DB asset ID (number) or file path (string)
   */
  setThumbnailScene(sceneRef) {
    const project = this._getProjectForPublish(this._standalonePublishProjectId);
    if (!project) return;

    let scenePath = null;

    // If it's a file path (string containing / or \), use directly
    if (typeof sceneRef === 'string' && (sceneRef.includes('/') || sceneRef.includes('\\'))) {
      scenePath = sceneRef;
    } else {
      // Try as DB asset ID (check both scene_image and scene_image_cinematic)
      const assets = [
        ...db.getAssets(project.id, { type: 'scene_image' }),
        ...db.getAssets(project.id, { type: 'scene_image_cinematic' }),
      ];
      const asset = assets.find(a => a.id === sceneRef || a.id === Number(sceneRef));
      if (asset) {
        scenePath = asset.file_path;
        db.updateProject(project.id, { thumbnail_scene_id: sceneRef });
      }
    }

    if (scenePath) {
      // Validate the path is a real scene image, not a portrait/grid
      const basename = path.basename(scenePath).toLowerCase();
      if (!/^ch\d+_(sc\d+|line\d+)/.test(basename)) {
        this.log(`[PUBLISH] GUARDRAIL: Rejected "${basename}" — not a scene image`, 'warn');
        return;
      }
      // Store the selected path for generateThumbnail
      if (!this._publishState) this._publishState = {};
      this._publishState.selectedScenePath = scenePath;
      if (this.state.publishState) {
        this.state.publishState.selectedScenePath = scenePath;
      }
      this.log(`[PUBLISH] Selected scene for thumbnail: ${path.basename(scenePath)}`);
    }
  }

  async generateThumbnail(options = {}) {
    const project = this._getProjectForPublish(this._standalonePublishProjectId);
    if (!project) return null;

    const projectDir = project.project_dir;
    const outputDir = path.join(projectDir, 'output');
    fs.mkdirSync(outputDir, { recursive: true });

    // ── On-demand Playwright for standalone mode ──
    // If no automation instance exists (standalone publish, not a pipeline run),
    // spin up a temporary HiggsFieldAutomation, run the flow, then close it.
    let automation = this.automation;
    let standaloneAutomation = false;

    if (!automation) {
      this.log('[PUBLISH] No active browser — launching Playwright for thumbnail generation...');
      this.emit({ type: 'publish-status', message: 'Launching browser...' });
      automation = new HiggsFieldAutomation(null, projectDir);
      standaloneAutomation = true;

      try {
        await automation.ensureBrowser();
        // Navigate to Higgsfield to confirm session is valid
        await automation.page.goto('https://higgsfield.ai/studio', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        }).catch(() => {});

        // Check login
        const loggedIn = await automation.isLoggedIn();
        if (!loggedIn) {
          this.log('[PUBLISH] Not logged in — please log in to the browser window, then retry.');
          this.emit({ type: 'publish-status', message: 'Please log in to Higgsfield in the browser window, then click Generate again.' });
          // Don't close the browser — leave it open for the user to log in
          this._standaloneAutomation = automation;
          return { error: 'login-required', message: 'Please log in to Higgsfield in the browser window.' };
        }
      } catch (e) {
        this.log(`[PUBLISH] Browser launch failed: ${e.message}`);
        try { await automation.close(); } catch (_) {}
        throw e;
      }
    } else if (this._standaloneAutomation) {
      // Reuse previously-launched standalone browser (user may have logged in)
      automation = this._standaloneAutomation;
      const loggedIn = await automation.isLoggedIn();
      if (!loggedIn) {
        this.emit({ type: 'publish-status', message: 'Still not logged in — please log in to the browser window.' });
        return { error: 'login-required', message: 'Please log in to Higgsfield in the browser window.' };
      }
    }

    const { ThumbnailGenerator } = require('../publish/thumbnailGenerator');
    const geminiKey = this.store.get('geminiApiKey', '');
    const thumbGen = new ThumbnailGenerator(automation, { geminiApiKey: geminiKey });

    const script = project.script_json ? JSON.parse(project.script_json) : {};
    const characters = (script.character_bible || []).map(c => c.name);
    const genre = script.genre || options.genre || 'drama';
    const setting = script.setting || options.setting || '';
    const mood = script.mood || options.mood || 'dramatic';

    // Resolve scene image: standalone state > pipeline state > explicit option > DB-persisted selection
    let sceneImagePath = this._publishState?.selectedScenePath
      || this.state.publishState?.selectedScenePath
      || options.sceneImagePath || null;
    if (!sceneImagePath && project.thumbnail_scene_id) {
      const sceneAsset = [
        ...db.getAssets(project.id, { type: 'scene_image' }),
        ...db.getAssets(project.id, { type: 'scene_image_cinematic' }),
      ].find(a => a.id === project.thumbnail_scene_id);
      if (sceneAsset) sceneImagePath = sceneAsset.file_path;
    }

    // ── GUARDRAIL: validate selected image is a real scene, not a portrait/grid ──
    // Prevents wasting credits generating thumbnails from wrong reference images.
    if (sceneImagePath) {
      const basename = path.basename(sceneImagePath).toLowerCase();
      const isScene = /^ch\d+_(sc\d+|line\d+)/.test(basename);
      if (!isScene) {
        const msg = `Selected image "${basename}" is not a scene image (expected ch*_sc* or ch*_line*). Aborting to avoid wasting credits.`;
        this.log(`[PUBLISH] GUARDRAIL: ${msg}`, 'warn');
        throw new Error(msg);
      }
    }

    this.log(`[PUBLISH] Generating thumbnail (genre: ${genre}, placement: ${options.placement || 'lower-third'})...`);
    this.emit({ type: 'publish-status', message: 'Generating thumbnail...' });

    try {
      const result = await thumbGen.generateThumbnail({
        title: project.title,
        tagline: options.tagline || '',
        genre,
        characterNames: characters,
        setting,
        mood,
        outputDir,
        placement: options.placement || 'lower-third',
        sceneImagePath,
      });

      // Persist paths
      db.updateProject(project.id, {
        thumbnail_path: result.thumbnailPath,
        thumbnail_key_art_path: result.keyArtPath,
        thumbnail_title_card_path: result.titleCardPath,
      });

      if (this.state.publishState) {
        this.state.publishState.thumbnailGenerated = true;
        this.state.publishState.thumbnailPath = result.thumbnailPath;
      }

      this.log(`[PUBLISH] Thumbnail generated: ${result.thumbnailPath}`);
      this.emit({ type: 'thumbnail-generated', ...result });

      // Auto-resolve publish gate: final video + thumbnail now both exist
      if (this._publishResolver) {
        this.log('[PUBLISH] Final video + thumbnail both exist — auto-closing project');
        db.updateProject(project.id, { published_at: new Date().toISOString() });
        this._publishResolver();
        this._publishResolver = null;
        this.state.status = 'running';
        this.state.currentApprovalGate = null;
      }

      return result;
    } finally {
      // Close standalone browser after generation completes
      if (standaloneAutomation) {
        this.log('[PUBLISH] Closing standalone browser session');
        try { await automation.close(); } catch (_) {}
        this._standaloneAutomation = null;
      }
    }
  }

  async generateSEOMetadata() {
    const project = this._getProjectForPublish(this._standalonePublishProjectId);
    if (!project) return null;

    const { SEOGenerator } = require('../publish/seoGenerator');
    const apiKey = this.store.get('claudeApiKey', '');
    const seoGen = new SEOGenerator(apiKey);

    const channelName = this.store.get('channelName', '');
    const subscribeUrl = this.store.get('subscribeUrl', '');

    this.log(`[PUBLISH] Generating YouTube metadata...`);
    const ytMeta = await seoGen.generateYouTubeMetadata(project, { channelName, subscribeUrl });

    this.log(`[PUBLISH] Generating Facebook caption...`);
    const fbMeta = await seoGen.generateFacebookCaption(project, ytMeta);

    // Persist
    db.updateProject(project.id, {
      youtube_metadata: JSON.stringify(ytMeta),
      facebook_metadata: JSON.stringify(fbMeta),
    });

    // Write output files
    const outputDir = path.join(project.project_dir, 'output');
    seoGen.writeOutputFiles(outputDir, ytMeta, fbMeta);

    if (this.state.publishState) {
      this.state.publishState.seoGenerated = true;
      this.state.publishState.youtubeMetadata = ytMeta;
      this.state.publishState.facebookMetadata = fbMeta;
    }

    this.log(`[PUBLISH] SEO metadata generated — YouTube title: "${ytMeta.title}"`);
    this.emit({ type: 'seo-generated', youtube: ytMeta, facebook: fbMeta });
    return { youtube: ytMeta, facebook: fbMeta };
  }

  /**
   * Early SEO generation — runs in background after script approval.
   * Non-blocking: portrait generation proceeds in parallel. If this fails
   * the publish stage can still call generateSEOMetadata() on demand.
   */
  async _generateEarlySEO(projectId, projectDir) {
    const { SEOGenerator } = require('../publish/seoGenerator');
    const apiKey = this.store.get('claudeApiKey', '');
    if (!apiKey) {
      this.log('[SEO] No Claude API key — skipping early SEO generation', 'warn');
      return;
    }

    const project = db.getProject(projectId);
    if (!project) return;
    // Add camelCase aliases expected by SEOGenerator
    project.scriptJson = project.script_json || null;
    project.projectDir = project.project_dir || null;

    const seoGen = new SEOGenerator(apiKey);
    const channelName = this.store.get('channelName', '');
    const subscribeUrl = this.store.get('subscribeUrl', '');

    this.log('[SEO] Generating YouTube metadata (background)...');
    const ytMeta = await seoGen.generateYouTubeMetadata(project, { channelName, subscribeUrl });

    this.log('[SEO] Generating Facebook caption (background)...');
    const fbMeta = await seoGen.generateFacebookCaption(project, ytMeta);

    // Persist to DB
    db.updateProject(projectId, {
      youtube_metadata: JSON.stringify(ytMeta),
      facebook_metadata: JSON.stringify(fbMeta),
    });

    // Write output files if project dir exists
    if (projectDir) {
      const fs = require('fs');
      const outputDir = path.join(projectDir, 'output');
      fs.mkdirSync(outputDir, { recursive: true });
      seoGen.writeOutputFiles(outputDir, ytMeta, fbMeta);
    }

    this.log(`[SEO] Early SEO complete — YouTube title: "${ytMeta.title}"`);
    this.emit({ type: 'seo-generated', youtube: ytMeta, facebook: fbMeta });
  }

  updatePlatformMetadata(platform, fields) {
    const project = this._getProjectForPublish(this._standalonePublishProjectId);
    if (!project) return;

    const column = platform === 'youtube' ? 'youtube_metadata' : 'facebook_metadata';
    const existing = project[column] ? JSON.parse(project[column]) : {};
    const updated = { ...existing, ...fields };
    db.updateProject(project.id, { [column]: JSON.stringify(updated) });

    if (this.state.publishState) {
      if (platform === 'youtube') this.state.publishState.youtubeMetadata = updated;
      else this.state.publishState.facebookMetadata = updated;
    }

    this.log(`[PUBLISH] Updated ${platform} metadata`);
  }

  approvePublish() {
    // Pipeline mode: resolve the approval gate
    if (this._publishResolver) {
      this._publishResolver();
      this._publishResolver = null;
      this.state.status = 'running';
      this.state.currentApprovalGate = null;

      const project = this.getActiveProject();
      if (project) {
        db.updateProject(project.id, { published_at: new Date().toISOString() });
      }

      this.log('[PUBLISH] User approved — finalizing output package');
      return { success: true, mode: 'pipeline' };
    }

    // Standalone mode: just mark as published
    const projectId = this._standalonePublishProjectId;
    if (projectId) {
      db.updateProject(projectId, { published_at: new Date().toISOString() });
      this.log(`[PUBLISH] Standalone publish approved for project ${projectId}`);
      return { success: true, mode: 'standalone', projectId };
    }

    return { success: false, reason: 'No active publish context' };
  }

  /**
   * 'session-expired' event so the UI can prompt the user to log in,
   * then retries the same operation once after resume.
   *
   * @param {Function} fn - Async function that calls automation (e.g. generateImage/generateVideo)
   * @param {string} label - Human-readable label for logging (e.g. "portrait 1/5")
   * @returns {Promise<*>} Result of fn()
   */
  async _withSessionRetry(fn, label) {
    try {
      return await fn();
    } catch (err) {
      if (err.message && err.message.includes('SESSION_EXPIRED')) {
        this.log(`Session expired during ${label}. Relaunching browser for re-authentication...`, 'warn');
        this.paused = true;
        this.state.status = 'session_expired';
        this.emit({ type: 'session-expired', message: err.message });

        // Close the old Playwright browser and relaunch fresh so the user
        // can log in directly in the Playwright window (no more BrowserView).
        if (this.automation) {
          try {
            await this.automation.close();
            this.log('Closed old browser session');
          } catch (_) { /* browser may already be dead */ }
          // ensureBrowser() on next fn() call will relaunch a fresh browser
          // where the user can log in. Navigate to Higgsfield login page.
          await this.automation.ensureBrowser();
          await this.automation.page.goto('https://higgsfield.ai', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          this.log('Fresh browser opened — please log into Higgsfield, then click Resume.');
        }

        // Wait for user to log in and click Resume
        await new Promise((resolve) => { this._pauseResolver = resolve; });

        // If we were woken by cancel/shutdown, don't retry — just bail
        if (this.cancelled) {
          throw new Error('Pipeline cancelled during session recovery');
        }

        // Save the fresh session cookies from the Playwright browser
        if (this.automation) {
          try { await this.automation.saveSession(); } catch (_) { /* ignore */ }
        }

        // Retry once after re-auth
        this.state.status = 'running';
        this.emit({ type: 'resumed' });
        this.log(`Retrying ${label} after re-authentication...`);
        return await fn();
      }
      throw err; // Non-session error — bubble up normally
    }
  }

  /**
   * Rewrite a character's full_prompt_description to avoid NSFW/restricted content
   * rejection on Higgsfield. Called when Higgsfield flags a portrait as "Restricted
   * content detected" — typically because the description resembles a real person.
   *
   * Uses Claude to rephrase the description with more fictional/stylized traits
   * while preserving the character's role and visual identity for the story.
   *
   * @param {Object} char - Character object from character_bible (mutated in place by caller)
   * @returns {string|null} New description, or null if rewrite failed
   */
  async _rewriteCharacterDescription(char) {
    const apiKey = this.store.get('claudeApiKey');
    if (!apiKey) {
      this.log('[NSFW] No Claude API key — cannot rewrite description', 'error');
      return null;
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `An AI image generator rejected this character description as "restricted content" (it likely resembles a real person too closely). Rewrite the physical description to be more fictional and stylized while keeping the character believable for a Nollywood drama.

RULES:
- Change distinctive facial features enough that they don't match any real person
- Keep the same ethnicity, approximate age, gender, and body type
- Keep the same wardrobe/clothing description (this is important for visual continuity)
- Make features more distinctive/unique/fictional (e.g., unusual eye color, specific scar patterns, distinctive hairstyle)
- Do NOT use any celebrity names or references to real people
- Output ONLY the rewritten description text, nothing else — no explanation, no preamble
- Match the same format: "A [age]-year-old [nationality] [gender] with [skin], [hair], [eyes], [features], [build] at [height], wearing [wardrobe]"

ORIGINAL DESCRIPTION:
${char.full_prompt_description}

CHARACTER NAME: ${char.name || char.description_label}

REWRITTEN DESCRIPTION:`,
      }],
    });

    const newDesc = (response.content[0]?.text || '').trim();
    if (!newDesc || newDesc.length < 50) {
      this.log(`[NSFW] Claude returned unusable description (${newDesc.length} chars)`, 'warn');
      return null;
    }

    return newDesc;
  }

  /**
   * Persist the current script state (including character_bible changes) to disk.
   * Called after modifying character descriptions (e.g., NSFW rewrite).
   */
  _saveScriptState(projectId) {
    try {
      const projectDir = this.state?.project?.dir;
      if (!projectDir || !this.state.script) return;
      const scriptPath = path.join(projectDir, 'script.json');
      fs.writeFileSync(scriptPath, JSON.stringify(this.state.script, null, 2));
      this.log(`[SCRIPT] Saved updated script to ${scriptPath}`);

      // Also update in DB if the method exists
      if (db.updateProjectScript) {
        db.updateProjectScript(projectId, this.state.script);
      }
    } catch (e) {
      this.log(`[SCRIPT] Failed to save script state: ${e.message}`, 'warn');
    }
  }

  // ── Pause/Resume/Cancel ──
  pause() {
    this.paused = true;
    this.state.status = 'paused';
    const pid = this.state.project?.id;
    if (pid) db.logEvent(pid, 'pause', { stage: this.state.currentStage, detail: `Paused during ${this.state.currentStage}` });
    this.emit({ type: 'paused' });
    this.log('Pipeline paused');
  }

  resume() {
    this.paused = false;
    this.state.status = 'running';
    const pid = this.state.project?.id;
    if (pid) db.logEvent(pid, 'resume', { stage: this.state.currentStage, detail: `Resumed in ${this.state.currentStage}` });
    if (this._pauseResolver) {
      this._pauseResolver();
      this._pauseResolver = null;
    }
    this.emit({ type: 'resumed' });
    this.log('Pipeline resumed');
  }

  cancel() {
    this.cancelled = true;
    this.paused = false;
    this.state.status = 'idle';
    const pid = this.state.project?.id;
    if (pid) db.logEvent(pid, 'cancel', { stage: this.state.currentStage, detail: `Cancelled during ${this.state.currentStage}` });
    if (this._pauseResolver) {
      this._pauseResolver();
      this._pauseResolver = null;
    }
    // Resolve any waiting approval gates
    for (const key of Object.keys(this._approvalResolvers)) {
      this._approvalResolvers[key]();
      delete this._approvalResolvers[key];
    }
    if (this.automation) this.automation.cancel();
    this.emit({ type: 'cancelled' });
    this.log('Pipeline cancelled');
  }

  _pauseResolver = null;
  checkPause() {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => { this._pauseResolver = resolve; });
  }
}

module.exports = { PipelineOrchestrator };
