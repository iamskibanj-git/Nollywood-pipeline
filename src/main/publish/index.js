/**
 * Publish Tab Controller — Standalone entry point for the Publish tab.
 *
 * Accessible at any time for completed projects (scene images generated).
 * Two thumbnail modes:
 *   - Scene-based: pick existing scene image → title card → composite
 *   - Custom close-up: generate close-up of main character → title card → composite
 *
 * Also generates SEO metadata (YouTube + Facebook) via the existing SEOGenerator.
 *
 * IPC-ready methods for renderer:
 *   - getProjects()          → list eligible projects (scene images done)
 *   - getCharacters(projectId) → character list with dialogue counts
 *   - suggestExpression(projectId) → auto-suggest emotional expression
 *   - getSceneCandidates(projectId) → scored scene images for scene-based mode
 *   - generateSceneThumbnail(projectId, options) → scene-based thumbnail
 *   - generateCustomThumbnail(projectId, options) → custom close-up thumbnail
 *   - generateSEO(projectId, options) → YouTube + Facebook metadata
 *   - getStatus(projectId)   → current publish state
 */

const path = require('path');
const fs = require('fs');
const { ThumbnailGenerator } = require('./thumbnailGenerator');
const { SEOGenerator } = require('./seoGenerator');

class PublishController {
  /**
   * @param {object} db - Database module (queryAll, queryOne, runSql, getProject, etc.)
   * @param {object} automation - HiggsFieldAutomation instance
   * @param {object} options - { anthropicApiKey, geminiApiKey }
   */
  constructor(db, automation, options = {}) {
    this.db = db;
    this.automation = automation;
    this.anthropicApiKey = options.anthropicApiKey || null;
    this.geminiApiKey = options.geminiApiKey || null;
    this.thumbGen = new ThumbnailGenerator(automation, {
      geminiApiKey: this.geminiApiKey,
    });
    this.seoGen = this.anthropicApiKey
      ? new SEOGenerator(this.anthropicApiKey)
      : null;
    this.log = options.log || console.log;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROJECT LISTING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get projects eligible for publish tab.
   * Eligible = has scene images generated (not necessarily fully completed).
   */
  getProjects() {
    return this.db.queryAll(`
      SELECT p.id, p.title, p.stage, p.completed_at, p.project_dir,
        p.repurposed_at,
        (SELECT COUNT(*) FROM project_assets pa
         WHERE pa.project_id = p.id
         AND pa.type IN ('scene_image', 'scene_image_cinematic')
         AND pa.status = 'done') as scene_count,
        (SELECT COUNT(*) FROM project_assets pa
         WHERE pa.project_id = p.id
         AND pa.type = 'portrait'
         AND pa.status = 'done') as portrait_count
      FROM projects p
      WHERE (SELECT COUNT(*) FROM project_assets pa
             WHERE pa.project_id = p.id
             AND pa.type IN ('scene_image', 'scene_image_cinematic')
             AND pa.status = 'done') > 0
      ORDER BY p.created_at DESC
    `);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHARACTER DATA (for custom thumbnail dropdown)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get characters for a project (for custom thumbnail character picker).
   * Returns characters sorted by dialogue count (most lines = likely lead).
   *
   * @param {string} projectId
   * @returns {Array<{name, elementNameHint, elementName, dialogueCount}>}
   */
  getCharacters(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const script = this._parseScript(project);
    if (!script) return [];

    // Get element suffix from project settings
    const settings = this._parseSettings(project);
    const suffix = settings.element_name_suffix || null;

    return this.thumbGen.getCharactersForThumbnail(script, suffix);
  }

  /**
   * Auto-suggest emotional expression based on script tone analysis.
   *
   * @param {string} projectId
   * @returns {string} Suggested expression
   */
  suggestExpression(projectId) {
    const project = this.db.getProject(projectId);
    if (!project) return 'intense determined';

    const script = this._parseScript(project);
    return this.thumbGen.suggestExpression(script);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SCENE CANDIDATES (for scene-based thumbnail)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Score scene images for thumbnail-worthiness.
   *
   * @param {string} projectId
   * @returns {Array<{path, score, reason}>}
   */
  async getSceneCandidates(projectId) {
    const sceneAssets = [
      ...this.db.getAssets(projectId, { type: 'scene_image', status: 'done' }),
      ...this.db.getAssets(projectId, { type: 'scene_image_cinematic', status: 'done' }),
    ].filter(a => a.file_path && fs.existsSync(a.file_path));

    if (sceneAssets.length === 0) return [];

    const paths = sceneAssets.map(a => a.file_path);
    return this.thumbGen.scoreSceneCandidates(paths);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // THUMBNAIL GENERATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Generate scene-based thumbnail (existing flow).
   *
   * @param {string} projectId
   * @param {object} options - { sceneImagePath, placement }
   */
  async generateSceneThumbnail(projectId, options = {}) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const script = this._parseScript(project);
    const settings = this._parseSettings(project);
    const outputDir = path.join(project.project_dir || '.', 'output');

    const result = await this.thumbGen.generateThumbnail({
      title: project.title || 'Untitled',
      tagline: settings.tagline || '',
      genre: settings.genre || 'drama',
      characterNames: this._getCharacterElementNames(script, settings),
      setting: settings.setting || '',
      mood: settings.mood || '',
      outputDir,
      placement: options.placement || 'lower-third',
      sceneImagePath: options.sceneImagePath,
    });

    // Persist thumbnail path to project
    this.db.runSql(
      `UPDATE projects SET thumbnail_path = ?, updated_at = datetime('now') WHERE id = ?`,
      [result.thumbnailPath, projectId]
    );

    this.log(`[PUBLISH] Scene-based thumbnail saved: ${result.thumbnailPath}`);
    return result;
  }

  /**
   * Generate custom close-up thumbnail.
   *
   * @param {string} projectId
   * @param {object} options - { characterElementName, expression, placement }
   */
  async generateCustomThumbnail(projectId, options = {}) {
    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const settings = this._parseSettings(project);
    const outputDir = path.join(project.project_dir || '.', 'output');

    if (!options.characterElementName) {
      throw new Error('characterElementName is required for custom thumbnail');
    }

    const result = await this.thumbGen.generateCustomThumbnail({
      title: project.title || 'Untitled',
      tagline: settings.tagline || '',
      genre: settings.genre || 'drama',
      characterElementName: options.characterElementName,
      expression: options.expression || 'intense determined',
      outputDir,
      placement: options.placement || 'lower-third',
    });

    // Persist thumbnail path to project
    this.db.runSql(
      `UPDATE projects SET thumbnail_path = ?, updated_at = datetime('now') WHERE id = ?`,
      [result.thumbnailPath, projectId]
    );

    this.log(`[PUBLISH] Custom thumbnail saved: ${result.thumbnailPath}`);
    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SEO GENERATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Generate YouTube + Facebook SEO metadata.
   *
   * @param {string} projectId
   * @param {object} options - { channelName, subscribeUrl }
   */
  async generateSEO(projectId, options = {}) {
    if (!this.seoGen) throw new Error('Anthropic API key required for SEO generation');

    const project = this.db.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    const script = this._parseScript(project);
    const projectData = {
      title: project.title,
      script,
      settings: this._parseSettings(project),
    };

    const youtube = await this.seoGen.generateYouTubeMetadata(projectData, options);
    const facebook = await this.seoGen.generateFacebookMetadata(projectData, options);

    // Persist to project settings
    const settings = this._parseSettings(project);
    settings.seo = { youtube, facebook };
    this.db.runSql(
      `UPDATE projects SET settings = ?, updated_at = datetime('now') WHERE id = ?`,
      [JSON.stringify(settings), projectId]
    );

    this.log(`[PUBLISH] SEO metadata generated for "${project.title}"`);
    return { youtube, facebook };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  _parseScript(project) {
    try {
      return project.script_json ? JSON.parse(project.script_json) : null;
    } catch {
      return null;
    }
  }

  _parseSettings(project) {
    try {
      return project.settings ? JSON.parse(project.settings) : {};
    } catch {
      return {};
    }
  }

  _getCharacterElementNames(script, settings) {
    if (!script || !script.character_bible) return [];
    const suffix = settings.element_name_suffix || '';
    return script.character_bible.map(c => {
      const hint = (c.element_name_hint || '').replace(/^@/, '').toLowerCase();
      return suffix ? `${hint}_${suffix}` : hint;
    });
  }
}

module.exports = { PublishController };
