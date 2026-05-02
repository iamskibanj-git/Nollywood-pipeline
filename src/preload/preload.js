const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings
  getApiKey: () => ipcRenderer.invoke('get-api-key'),
  setApiKey: (key) => ipcRenderer.invoke('set-api-key', key),
  getGeminiKey: () => ipcRenderer.invoke('get-gemini-key'),
  setGeminiKey: (key) => ipcRenderer.invoke('set-gemini-key', key),
  getProjectsDir: () => ipcRenderer.invoke('get-projects-dir'),
  setProjectsDir: () => ipcRenderer.invoke('set-projects-dir'),

  // Pipeline controls
  startPipeline: (brief) => ipcRenderer.invoke('start-pipeline', brief),
  pausePipeline: () => ipcRenderer.invoke('pause-pipeline'),
  resumePipeline: () => ipcRenderer.invoke('resume-pipeline'),
  cancelPipeline: () => ipcRenderer.invoke('cancel-pipeline'),
  getPipelineState: () => ipcRenderer.invoke('get-pipeline-state'),

  // Research
  approveResearch: (selections) => ipcRenderer.invoke('approve-research', selections),
  getProducedStories: () => ipcRenderer.invoke('get-produced-stories'),
  getResearchCacheStatus: () => ipcRenderer.invoke('get-research-cache-status'),
  clearResearchCache: () => ipcRenderer.invoke('clear-research-cache'),
  listResearchPools: () => ipcRenderer.invoke('list-research-pools'),
  deleteResearchPool: (poolId) => ipcRenderer.invoke('delete-research-pool', poolId),

  // Active project (resume)
  getActiveProjectStatus: () => ipcRenderer.invoke('get-active-project-status'),
  abandonActiveProject: () => ipcRenderer.invoke('abandon-active-project'),
  updateProjectSettings: (settings) => ipcRenderer.invoke('update-project-settings', settings),

  // Script
  approveTitle: (title) => ipcRenderer.invoke('approve-title', title),
  approveScript: (options) => ipcRenderer.invoke('approve-script', options || {}),
  regenerateScript: () => ipcRenderer.invoke('regenerate-script'),
  updateScriptLine: (ch, sc, ln, updates) => ipcRenderer.invoke('update-script-line', ch, sc, ln, updates),

  // Review gates
  approvePortraits: () => ipcRenderer.invoke('approve-portraits'),
  rerenderPortraits: () => ipcRenderer.invoke('rerender-portraits'),
  resetToPortraits: () => ipcRenderer.invoke('reset-to-portraits'),
  resetToSceneVerify: () => ipcRenderer.invoke('reset-to-scene-verify'),
  approveElementsReady: () => ipcRenderer.invoke('approve-elements-ready'),
  approveLocationsReady: () => ipcRenderer.invoke('approve-locations-ready'),
  regenerateLocations: (hints) => ipcRenderer.invoke('regenerate-locations', hints),
  regenerateScenes: (hints) => ipcRenderer.invoke('regenerate-scenes', hints),
  approveSceneImagesReady: () => ipcRenderer.invoke('approve-scene-images-ready'),
  approveScenes: () => ipcRenderer.invoke('approve-scenes'),
  approveDialogueTriage: (decisions) => ipcRenderer.invoke('approve-dialogue-triage', decisions),
  approveClips: () => ipcRenderer.invoke('approve-clips'),
  approveClipReview: (decision) => ipcRenderer.invoke('approve-clip-review', decision),
  approvePromptPreview: (decision) => ipcRenderer.invoke('approve-prompt-preview', decision),
  flagAsset: (type, index) => ipcRenderer.invoke('flag-asset', type, index),

  // Clip verification (post-MVP verify stage)
  getClipVerifications: () => ipcRenderer.invoke('get-clip-verifications'),
  setVerifyDecision: (assetId, decision) => ipcRenderer.invoke('set-verify-decision', assetId, decision),
  approveVerify: () => ipcRenderer.invoke('approve-verify'),

  // Project logs
  getProjectLogs: (projectId, options) => ipcRenderer.invoke('get-project-logs', projectId, options),
  getProjectLogCount: (projectId) => ipcRenderer.invoke('get-project-log-count', projectId),

  // Publish stage
  getPublishState: () => ipcRenderer.invoke('get-publish-state'),
  getPublishableProjects: () => ipcRenderer.invoke('get-publishable-projects'),
  getPublishStateForProject: (id) => ipcRenderer.invoke('get-publish-state-for-project', id),
  loadPublishProject: (id) => ipcRenderer.invoke('load-publish-project', id),
  scoreSceneThumbnails: () => ipcRenderer.invoke('score-scene-thumbnails'),
  setThumbnailScene: (id) => ipcRenderer.invoke('set-thumbnail-scene', id),
  generateThumbnail: (options) => ipcRenderer.invoke('generate-thumbnail', options),
  generateCustomThumbnail: (options) => ipcRenderer.invoke('generate-custom-thumbnail', options),
  getPublishCharacters: () => ipcRenderer.invoke('get-publish-characters'),
  generateSEOMetadata: () => ipcRenderer.invoke('generate-seo-metadata'),
  updatePlatformMetadata: (platform, fields) => ipcRenderer.invoke('update-platform-metadata', platform, fields),
  approvePublish: () => ipcRenderer.invoke('approve-publish'),

  // Shorts tab
  getShortsProjects: () => ipcRenderer.invoke('shorts:getProjects'),
  getShortsStatus: (projectId) => ipcRenderer.invoke('shorts:getStatus', projectId),
  planShortsCalendar: (projectId, options) => ipcRenderer.invoke('shorts:planCalendar', projectId, options),
  assembleShorts: (projectId) => ipcRenderer.invoke('shorts:assemble', projectId),
  uploadAllShorts: (projectId) => ipcRenderer.invoke('shorts:uploadAll', projectId),

  // API connectivity test
  testApiKeys: () => ipcRenderer.invoke('test-api-keys'),

  // Selectors
  getSelectors: () => ipcRenderer.invoke('get-selectors'),
  saveSelectors: (sel) => ipcRenderer.invoke('save-selectors', sel),

  // Events from main process
  onPipelineEvent: (callback) => {
    ipcRenderer.on('pipeline-event', (_, event) => callback(event));
  },
  onLogMessage: (callback) => {
    ipcRenderer.on('log-message', (_, msg) => callback(msg));
  },
  onShortsProgress: (callback) => {
    ipcRenderer.on('shorts-progress', (_, data) => callback(data));
  },
});
