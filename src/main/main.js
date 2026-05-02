const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const { PipelineOrchestrator } = require('./pipeline/orchestrator');
const db = require('./database/db');

// Ensure global fetch is available (Electron 28+ / Node 18+ has it natively,
// but older versions may not — this guard keeps things working everywhere)
if (typeof globalThis.fetch === 'undefined') {
  try {
    const nodeFetch = require('node-fetch');
    globalThis.fetch = nodeFetch;
    globalThis.Headers = nodeFetch.Headers;
    globalThis.Request = nodeFetch.Request;
    globalThis.Response = nodeFetch.Response;
    console.log('[INIT] Polyfilled global fetch via node-fetch');
  } catch {
    console.warn('[INIT] No global fetch and node-fetch not installed. Gemini API calls may fail.');
  }
}

const store = new Store();
let mainWindow = null;
let pipeline = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 900,
    minWidth: 800,
    minHeight: 700,
    title: 'Nollywood AI Pipeline',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load dashboard UI
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Initialize SQLite database (async — sql.js loads WASM)
  const dbPath = path.join(app.getPath('userData'), 'nollywood-pipeline.sqlite');
  db.init(dbPath).then(() => {
    console.log(`[INIT] Database initialized at ${dbPath}`);

    // Migrate old electron-store data to SQLite on first run
    db.migrateFromStore(store);

    // Initialize pipeline orchestrator (needs DB ready)
    pipeline = new PipelineOrchestrator(store, mainWindow);
    console.log('[INIT] Pipeline orchestrator ready');
  }).catch(err => {
    console.error('[INIT] Database init failed:', err);
  });

  mainWindow.on('close', (e) => {
    // If pipeline is actively running, confirm before closing
    if (pipeline && pipeline.state && pipeline.state.status === 'running') {
      const { dialog: d } = require('electron');
      const choice = d.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['Cancel', 'Close Anyway'],
        defaultId: 0,
        title: 'Pipeline Running',
        message: 'The pipeline is still running. Closing will save progress — you can resume next time.',
        detail: 'Assets already generated are safe. Any asset mid-generation will be retried on next launch.',
      });
      if (choice === 0) {
        e.preventDefault();
        return;
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ── Graceful Shutdown ──
// Covers: X button, Alt+F4, app.quit(), taskbar close

let isShuttingDown = false;

function gracefulShutdown(source) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[SHUTDOWN] Graceful shutdown initiated (${source})`);

  // 1. Cancel pipeline if running (halts generation loops)
  if (pipeline) {
    try {
      pipeline.cancel();
      console.log('[SHUTDOWN] Pipeline cancelled');
    } catch (e) {
      console.warn('[SHUTDOWN] Pipeline cancel error:', e.message);
    }

    // Close Playwright browser if open (saves Higgsfield session cookies)
    if (pipeline.automation) {
      try {
        // close() is async but we can't await in a signal handler —
        // fire and forget, the process will wait briefly
        pipeline.automation.close().catch(() => {});
        console.log('[SHUTDOWN] Playwright browser close initiated');
      } catch (e) {
        console.warn('[SHUTDOWN] Browser close error:', e.message);
      }
    }
  }

  // 2. Reset any stuck 'generating' assets back to 'pending' for next launch
  try {
    db.resetStuckAssets();
    console.log('[SHUTDOWN] Stuck generating assets reset to pending');
  } catch (e) {
    console.warn('[SHUTDOWN] Asset reset error:', e.message);
  }

  // 3. Final DB save + close
  try {
    db.close();
    console.log('[SHUTDOWN] Database closed cleanly');
  } catch (e) {
    console.warn('[SHUTDOWN] DB close error:', e.message);
  }
}

app.on('before-quit', () => gracefulShutdown('before-quit'));

// ── Terminal kill signals (Ctrl+C, kill, etc.) ──
// These bypass Electron's event loop — must handle at process level

process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] SIGINT received (Ctrl+C)');
  gracefulShutdown('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received');
  gracefulShutdown('SIGTERM');
  process.exit(0);
});

// Uncaught exceptions — save DB state before crashing
process.on('uncaughtException', (err) => {
  console.error('[CRASH] Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[CRASH] Unhandled rejection:', reason);
  // Don't exit — just log. The pipeline has its own error handling.
  // But do a defensive DB save in case something is mid-write.
  try { db.save(); } catch (e) { /* ignore */ }
});

// ── IPC Handlers ──

// Settings
ipcMain.handle('get-api-key', () => store.get('claudeApiKey', ''));
ipcMain.handle('set-api-key', (_, key) => { store.set('claudeApiKey', key); return true; });
ipcMain.handle('get-gemini-key', () => store.get('geminiApiKey', ''));
ipcMain.handle('set-gemini-key', (_, key) => { store.set('geminiApiKey', key); return true; });
ipcMain.handle('get-projects-dir', () => store.get('projectsDir', path.join(app.getPath('documents'), 'NollywoodAI', 'projects')));
ipcMain.handle('set-projects-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths[0]) {
    store.set('projectsDir', result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
});

// Pipeline controls (pipeline may be null during async DB init — guard all calls)
ipcMain.handle('start-pipeline', (_, options) => pipeline ? pipeline.start(options || {}) : { success: false, reason: 'Pipeline not ready — DB still initializing' });
ipcMain.handle('pause-pipeline', () => pipeline?.pause());
ipcMain.handle('resume-pipeline', () => pipeline?.resume());
ipcMain.handle('cancel-pipeline', () => pipeline?.cancel());
ipcMain.handle('get-pipeline-state', () => pipeline?.getState() || { status: 'idle' });

// Research review (with selections from UI)
ipcMain.handle('approve-research', (_, selections) => pipeline.approveResearch(selections));

// Dedup
ipcMain.handle('get-produced-stories', () => pipeline.getProducedStories());

// Research cache management (back-compat — returns most-recent pool)
ipcMain.handle('get-research-cache-status', () => pipeline ? pipeline.getResearchCacheStatus() : { hasCache: false });
ipcMain.handle('clear-research-cache', () => { if (pipeline) pipeline.clearResearchCache(); return true; });

// Multi-pool support (Session 8)
ipcMain.handle('list-research-pools', () => pipeline ? pipeline.listResearchPools() : []);
ipcMain.handle('delete-research-pool', (_, poolId) => { if (pipeline) pipeline.deleteResearchPool(poolId); return true; });

// Active project status (for resume UI)
ipcMain.handle('get-active-project-status', () => pipeline ? pipeline.getActiveProjectStatus() : { hasActiveProject: false });
ipcMain.handle('abandon-active-project', () => pipeline ? pipeline.abandonActiveProject() : { success: false, reason: 'Pipeline not ready' });
ipcMain.handle('update-project-settings', (_, settings) => pipeline ? pipeline.updateProjectSettings(settings) : { success: false, reason: 'Pipeline not ready' });

// Script editing
ipcMain.handle('approve-title', (_, title) => pipeline.approveTitle(title));
ipcMain.handle('approve-script', (_, options) => pipeline.approveScript(options || {}));
ipcMain.handle('regenerate-script', () => { if (pipeline) pipeline.requestScriptRegenerate(); return true; });
ipcMain.handle('update-script-line', (_, chapterIdx, sceneIdx, lineIdx, updates) => {
  pipeline.updateScriptLine(chapterIdx, sceneIdx, lineIdx, updates);
});

// Portraits and scene review
ipcMain.handle('approve-portraits', () => pipeline.approvePortraits());
ipcMain.handle('rerender-portraits', () => pipeline.rerenderPortraits());
ipcMain.handle('reset-to-portraits', () => pipeline.resetToPortraits());
ipcMain.handle('reset-to-scene-verify', () => pipeline.resetToSceneVerify());
ipcMain.handle('approve-elements-ready', () => pipeline.approveElementsReady());
ipcMain.handle('approve-locations-ready', () => pipeline.approveLocationsReady());
ipcMain.handle('regenerate-locations', (_, hints) => pipeline.regenerateLocations(hints));
ipcMain.handle('regenerate-scenes', (_, hints) => pipeline.regenerateScenes(hints));
ipcMain.handle('approve-scene-images-ready', () => pipeline.approveSceneImagesReady());
ipcMain.handle('approve-dialogue-triage', (_, decisions) => {
  if (!pipeline) return { success: false, reason: 'Pipeline not ready' };
  if (decisions) pipeline.applyDialogueTriage(decisions);
  return pipeline.approveDialogueTriage();
});
ipcMain.handle('approve-scenes', () => pipeline.approveScenes());
ipcMain.handle('approve-clips', () => pipeline.approveClips());
ipcMain.handle('approve-clip-review', (_, decision) => pipeline.approveClipReview(decision));
ipcMain.handle('approve-prompt-preview', (_, decision) => pipeline.approvePromptPreview(decision));
ipcMain.handle('flag-asset', (_, type, index) => pipeline.flagAsset(type, index));

// Clip verification (post-MVP verify stage)
ipcMain.handle('get-clip-verifications', () => {
  if (!pipeline) return [];
  const proj = pipeline.getActiveProject();
  if (!proj) return [];
  return db.getClipVerifications(proj.id);
});
ipcMain.handle('set-verify-decision', (_, assetId, decision) => {
  // decision: 'accepted' (keep clip as-is) | 'rejected' (redo — resets asset to pending)
  db.setVerifyHumanDecision(assetId, decision);
  return true;
});
ipcMain.handle('approve-verify', () => pipeline.approveVerify && pipeline.approveVerify());

// Project logs
ipcMain.handle('get-project-logs', (_, projectId, options) => db.getProjectLogs(projectId, options || {}));
ipcMain.handle('get-project-log-count', (_, projectId) => db.getProjectLogCount(projectId));

// Publish stage
ipcMain.handle('get-publish-state', () => pipeline ? pipeline.getPublishState() : null);
ipcMain.handle('get-publishable-projects', () => pipeline ? pipeline.getPublishableProjects() : []);
ipcMain.handle('get-publish-state-for-project', (_, projectId) => pipeline ? pipeline.getPublishStateForProject(projectId) : null);
ipcMain.handle('load-publish-project', (_, projectId) => pipeline ? pipeline.loadPublishProject(projectId) : null);
ipcMain.handle('score-scene-thumbnails', () => pipeline ? pipeline.scoreSceneThumbnails() : []);
ipcMain.handle('set-thumbnail-scene', (_, sceneAssetId) => pipeline ? pipeline.setThumbnailScene(sceneAssetId) : null);
ipcMain.handle('generate-thumbnail', (_, options) => pipeline ? pipeline.generateThumbnail(options) : null);
ipcMain.handle('generate-custom-thumbnail', (_, options) => pipeline ? pipeline.generateCustomThumbnail(options) : null);
ipcMain.handle('get-publish-characters', () => pipeline ? pipeline.getPublishCharacters() : { characters: [], suggestedExpression: 'intense determined' });
ipcMain.handle('generate-seo-metadata', () => pipeline ? pipeline.generateSEOMetadata() : null);
ipcMain.handle('update-platform-metadata', (_, platform, fields) => pipeline ? pipeline.updatePlatformMetadata(platform, fields) : null);
ipcMain.handle('approve-publish', () => pipeline ? pipeline.approvePublish() : null);

// Shorts tab
const { ShortsController } = require('./shorts');
let shortsController = null;
function getShortsController() {
  if (!shortsController) {
    shortsController = new ShortsController(db, {
      apiKey: store.get('claudeApiKey', ''),
      userDataDir: store.get('chromeUserDataDir', null),
      log: (...args) => console.log('[SHORTS]', ...args),
      onProgress: (data) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shorts-progress', data);
        }
      },
    });
  }
  return shortsController;
}
ipcMain.handle('shorts:getProjects', () => getShortsController().getProjects());
ipcMain.handle('shorts:getStatus', (_, projectId) => getShortsController().getStatus(projectId));
ipcMain.handle('shorts:planCalendar', (_, projectId, options) => getShortsController().planCalendar(projectId, options));
ipcMain.handle('shorts:assemble', (_, projectId) => getShortsController().assembleShorts(projectId));
ipcMain.handle('shorts:uploadAll', (_, projectId) => getShortsController().uploadAll(projectId));

// API connectivity test — validates keys work before starting a pipeline run
ipcMain.handle('test-api-keys', async () => {
  const results = { claude: null, gemini: null };

  // Test Claude API
  const claudeKey = store.get('claudeApiKey', '');
  if (!claudeKey) {
    results.claude = { ok: false, error: 'No API key set' };
  } else {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: claudeKey });
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with just the word OK' }],
      });
      const text = response.content?.[0]?.text || '';
      results.claude = { ok: true, response: text.substring(0, 50) };
    } catch (e) {
      results.claude = { ok: false, error: e.message?.substring(0, 200) || 'Unknown error' };
    }
  }

  // Test Gemini API
  const geminiKey = store.get('geminiApiKey', '');
  if (!geminiKey) {
    results.gemini = { ok: false, error: 'No API key set (optional — browser fallback available)' };
  } else {
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: 'Reply with just the word OK' }] }],
            generationConfig: { maxOutputTokens: 10 },
          }),
        }
      );
      if (!resp.ok) {
        const errBody = await resp.text().catch(() => '');
        results.gemini = { ok: false, error: `HTTP ${resp.status}: ${errBody.substring(0, 150)}` };
      } else {
        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        results.gemini = { ok: true, response: text.substring(0, 50) };
      }
    } catch (e) {
      results.gemini = { ok: false, error: e.message?.substring(0, 200) || 'Network error' };
    }
  }

  return results;
});

// Higgsfield selectors config
ipcMain.handle('get-selectors', () => {
  const selectorsPath = path.join(__dirname, '..', '..', 'config', 'higgsfield-selectors.json');
  try {
    return require(selectorsPath);
  } catch {
    return null;
  }
});
ipcMain.handle('save-selectors', (_, selectors) => {
  const fs = require('fs');
  const selectorsPath = path.join(__dirname, '..', '..', 'config', 'higgsfield-selectors.json');
  fs.writeFileSync(selectorsPath, JSON.stringify(selectors, null, 2));
  return true;
});
