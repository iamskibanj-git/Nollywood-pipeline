Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30j: Asset recovery — CDN capture + file integrity checks

Ensures no credits are wasted on crash by capturing CDN URLs for all
generated assets and adding file integrity validation to reconciliation.

CDN URL capture (re-download instead of re-generate on crash):
- character_grid: passes onGenClicked callback + captures genMeta.cdnUrl
  via db.markAssetCdnUrl() immediately after generation returns
- location_image: passes onGenClicked via generateImage options + captures
  genMeta.cdnUrl — same pattern as grid
- scene_image_cinematic: already had onGenClicked wired, added
  result.cdnUrl capture before markAssetDone

CDN capture on error/timeout paths (orchestrator.js):
- Grid outer catch: captures e.detectedCdnUrl before markAssetFailed
- Location outer catch: captures e.detectedCdnUrl before markAssetFailed
- Scene outer catch: captures e.detectedCdnUrl before markAssetFailed
- Matches existing portrait + video pattern — timeout-but-completed
  generations can now be re-downloaded on resume

File integrity check in reconcileWithFilesystem (db.js):
- MIN_FILE_SIZES map: images (portrait, grid, location, scene) > 1KB,
  videos (video_clip_cinematic) > 10KB
- Files below minimum → deleted from disk, status reset to pending
- Runs before normal recovery/invalidation logic in reconciliation loop
- Catches partial downloads from crash mid-write, prevents treating
  truncated files as complete

Terminology cleanup — locations are images, not elements:
- Removed misleading "location element creation" from comments/logs
- Renamed locInfo.elementName → locInfo.name in cinematicLocations state
- Removed unused locationElementName param from generateSceneImage()
- Added @deprecated to createLocationElement() in higgsfield-elements.js
- _restoreCinematicMaps: auto-migrates legacy elementName → name
- CLAUDE.md: explicit "locations are NOT elements" documentation

Asset locking — vision certification = permanent lock:
- New migration 018: locked_at column on project_assets
- db.lockAsset(assetId): sets locked_at = now (permanent)
- db.isAssetLocked(assetId): check lock status
- db.lockUpstream(assetId, projectId): lock self + all upstream deps
  - grid pass → lock grid + portrait (same character_id)
  - scene pass → lock scene + location + all grids + portraits
- reconcileWithFilesystem: skip locked assets entirely. If locked file
  is missing → log CRITICAL error (manual intervention, not auto-regen)
- Exception: video_clip_cinematic NEVER locked (always redo-eligible)
- Orchestrator wiring:
  - Portrait vision pass → db.lockAsset()
  - Grid vision pass → db.lockUpstream() (locks grid + portrait)
  - Location vision pass → db.lockAsset()
  - Scene vision pass → db.lockUpstream() (locks scene + location +
    all grids + portraits for the project)

Cinematography rules for vision blocking (_refineBlockingWithVision):
- 180-degree rule: explicit instruction that characters maintain screen
  direction (left/right) relative to each other across all scenes at the
  same location. Camera stays on one side of the action axis.
- Dialogue context: scene's kling_clips dialogue lines extracted and fed
  to Vision so blocking reflects who speaks to whom (speaker faces
  listener, eyelines cross naturally). Up to 4 clips of dialogue.
- Spatial continuity clause updated: explicitly references 180-degree
  rule enforcement across cuts.

180-degree rule at shot direction level (_injectVisionBlocking):
- Eyeline direction derivation: parses each character's horizontal
  position (left/center/right) from vision-refined blocking text
- Derives gaze direction toward scene partner(s) using center-of-mass
  calculation across all other characters' positions
- Injects EYELINES section into CHARACTER POSITIONS preamble:
  "EYELINES (180° rule — gaze direction for close-ups): @ama gazes
  RIGHT; @frank gazes LEFT."
- Lives in preamble header (not inside shot directions) so it doesn't
  conflict with one-@element-per-shot-direction rule
- Ensures close-up shots inherit correct gaze direction from spatial
  positions established in the start frame
- Budget-aware: eyeline section preserved in both normal and tight
  preamble rebuilds

Video gen duration + timing changes:
- Fixed duration: ALL Kling clips now generate at 15s (was variable
  10-12s). Duration alone doesn't degrade lip sync — gives model room.
- Removed smart duration calculator (effectiveDuration IIFE). Simple
  constant assignment: effectiveDuration = KLING_CLIP_DURATION (15).
- Timing brackets stripped: legacy prompts with "Shot 1 (0-3s):" have
  brackets removed at runtime before submission. Model decides pacing.
- Script engine rules updated: duration_seconds = 15, no timing in shot
  headers, every shot MUST have dialogue (no silent establishing shots).
- 3-shot structure preserved: exactly 3 shots per clip, hard rule.
- Example clip in script-engine updated: new format uses camera info
  only in parenthetical — "Shot 1 (WIDE ESTABLISHING, static):"

Shorts Scheduler — Facebook Reels repurposing (new module):
- src/main/shorts/shorts-scheduler.js: clip selection, FFmpeg assembly,
  SEO generation, calendar planning
- src/main/shorts/facebook-uploader.js: Playwright automation for FB
  Reel scheduling (Professional Dashboard flow)
- src/main/shorts/index.js: ShortsController — IPC-ready entry point
- Migration 019: shorts table + projects.repurposed_at column
- Standalone tab (not pipeline): dropdown selects completed project,
  processes clips into 30-day calendar of reels
- Clip curation: exclude REDO backups, rank for standalone impact
- FFmpeg: concat 2-6 clips + 9:16 watermark → 30-90s reels
- SEO: Claude-generated dialogue-driven hooks + hashtags + CTA
- Upload: one reel per navigation cycle, confirm → tag → persist

CLAUDE.md: Session 30j summary
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
