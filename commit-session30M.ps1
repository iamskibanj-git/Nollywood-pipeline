Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }
if (Test-Path ".git\index2.lock") { Remove-Item ".git\index2.lock" -Force }
if (Test-Path ".git\HEAD.lock") { Remove-Item ".git\HEAD.lock" -Force }

$msg = @"
Session 30M: Pipeline progress stats with ETA across all major stages

Cinematic video (Kling clips):
- Rich progress: elapsed, eta, generated, skipped, failed, clipId, clipLabel
- clipGenStartTime tracks total wall clock; ETA from per-clip average
- Final summary event emitted after loop completes (done: true)

Staged video clips (Veo):
- videoStartTime + videoGenCount for ETA computation
- videoGenCount incremented on all completion paths (CDN recovery, disk
  recovery, normal generation, in-catch CDN harvest)

Portraits:
- portraitStartTime + portraitGenCount for ETA
- Progress includes character description_label
- Counter incremented at end of each iteration (success or thrown)

Scene images (staged):
- sceneStartTime + sceneGenCount for ETA
- Counter incremented on both CDN-recovery and normal-gen success paths

Cinematic locations:
- locStartTime + locGenCount for ETA
- Counter incremented on skip (existing), disk recovery, and generation paths
- Progress includes location element name

Cinematic scenes:
- cSceneStartTime + cSceneGenCount for ETA
- Counter incremented after each scene (success or fail) and on skip

Final assembly (FFmpeg):
- assemblyStartTime tracks total assembly wall clock
- Processing step: per-clip ETA from average normalization time
- Concatenating/upscaling/complete steps show elapsed time

Renderer:
- updateGenProgress() accepts extra object with elapsed/eta/generated/
  skipped/failed/label/clipLabel fields
- formatETA() and formatElapsed() helpers for human-readable time
- Progress text changed from <p> to <pre> for multi-line clip labels
- Assembly progress shows descriptive text per step with elapsed/ETA

Facebook uploader — login wait + timing + flow fixes:
- _waitForLogin(): navigates to facebook.com on launch, polls for
  logged-in indicators (profile, notifications, messenger icons)
- If not logged in, waits up to 3 min for user to complete login + 2FA
- Polls every 3s with elapsed/remaining time in console logs
- Auto-proceeds once logged-in indicators detected
- CLICK_TIMEOUT raised 15s -> 20s for slow FB DOM
- POST_CLICK_SETTLE raised 3s -> 4s
- POST_NAV_SETTLE raised 4s -> 6s
- POST_SCHEDULE_CONFIRM raised 10s -> 15s

Facebook uploader — selectors + flow rewrite (from live screenshots):
- SELECTORS rewritten to match May 2026 Professional Dashboard UI
- scheduledTab: role="tab" -> plain text links (span/a)
- descriptionField: targets contenteditable with "Describe" placeholder
- Added schedulingOptionsRow, scheduleForLaterButton selectors
- scheduleButton: exact-match "Schedule" excluding "for later"/"Scheduling"
- scheduleReel() rewritten as 12-step flow via Content Library direct URL
- _clickSchedulingOptions(): multi-strategy click on "Scheduling options" row
- _clickFinalSchedule(): exact-match "Schedule" button via getByRole/text-is
- _dismissPopups(): auto-dismisses FB overlays before every click action
  - Handles: keyboard shortcuts dialog, cookie consent, notification
    prompts, "videos are now reels" banner, app install prompts
  - Fixed: uses page.locator()/getByText() instead of page.$() which
    silently fails on Playwright text selectors (>> syntax)
  - Recursive: dismissing one popup re-checks for another
  - Escape fallback for unknown dialogs (skips our wizard dialogs)
  - Removed generic dialog close button handler (was closing Create Reel wizard)
  - Called after navigations and before _clickWithFallback/_waitAndClick
- _setScheduleDate(): rewrote with 3-tier strategy — aria-label inputs,
  value-scan all inputs for date pattern, label text click
- _setScheduleTime(): rewrote with 3-tier strategy — aria-label inputs,
  value-scan all inputs for time pattern, label text click
- Debug screenshot after opening scheduling panel for diagnosis
- fs import moved to top (was at bottom, used before require)

Database auto-backup system:
- backup(tag): creates timestamped backup in AppData/backups/ folder
  Tags: startup, shutdown, auto, pre-upload, pre-assembly, pre-fix, manual
- startAutoBackup(): periodic backup every 30 minutes during runtime
- stopAutoBackup(): cleans up timer on close
- listBackups(): returns all backups sorted newest-first
- restoreBackup(filename): restores from backup (creates safety backup first)
- Rolling pruning: auto backups keep last 5, manual/tagged keep last 10
- Hooked into: init (startup), close (shutdown), assembleShorts (pre-assembly),
  uploadAll (pre-upload), runStage (pre-<stageName> for all pipeline stages)
- Pipeline coverage: research, portraits, scene_images, locations,
  cinematic_scenes, video_clips, assembly — all via runStage()
- fix-shorts-status.js: creates pre-fix backup before any status changes

Shorts upload order + status fix:
- getNextPendingUpload: ORDER BY short_number ASC (was scheduled_date)
- New status: 'upload_failed' replaces generic 'failed' for upload errors
- getNextPendingUpload picks up both 'seo_done' and 'upload_failed' for retry
- Upload All button enabled when seo_done OR upload_failed shorts exist
- Plan Calendar disabled once any shorts are assembled (prevents orphaning)
- fix-failed-to-upload-failed.js: one-time data migration script

Facebook uploader — dynamic readiness wait + retry:
- _waitForPageReady(): polls for Content Library UI indicators (adapted from
  Kling DYNAMIC READINESS WAIT pattern — threshold check + 10% buffer)
- _retryStep(name, fn, maxRetries, baseDelay): retry wrapper with linear
  backoff (3s, 6s, 9s...) and popup dismissal between attempts
- Steps 2, 3, 8, 11 wrapped with _retryStep for resilience

waitForGeneration — 3-layer detection rewrite:
- Pre-gen snapshot: History tab URLs/count captured BEFORE Layer 1 runs.
  Previously Layer 2 took its snapshot after Layer 1 failed (45s in),
  so the completed image was in the "initial" baseline — invisible to
  the diff. Now Layer 2 uses the pre-gen baseline.
- Layer 2 History tab refresh: re-clicks History tab every 30s to force
  Higgsfield's SPA to update the DOM (was static/cached).
- Layer 2 stall detection: if no changes (no new URLs, no count change,
  no status transition) for 60s, bails to Layer 3 instead of waiting
  for the full 7-minute timeout.
- Layer 3 (new): _recoverCdnUrlFromAssets() — lightweight Asset library
  scan. Navigates to /asset/image, checks first 4 tiles by prompt match
  (60% similarity threshold), extracts CDN URL from detail page.
  No context recreate, no download — just returns the URL for the
  existing downloadLatestResult flow. Falls back cleanly on failure.

Higgsfield API polling — consecutive 404 bail-out:
- _pollJobCompletion: tracks consecutive 404 responses from job polling
- After 15 consecutive 404s (~45s), bails Layer 1 (API) → Layer 2 (CDN diff)
- Prevents wasting 7 minutes polling a dead endpoint when the image may
  already be in the History tab after 30-60s
- Error type: API_ENDPOINT_DEAD with apiEndpointDead flag (non-fatal,
  falls through to Layer 2 in waitForGeneration catch block)
- Resets counter on non-404 errors and successful polls

Thumbnail composite aspect ratio fix:
- compositeThumbnail() had hard-coded '16:9' in both generateImage() calls
- Added aspectRatio parameter to method signature (default '16:9')
- Both callers (generateThumbnail, generateCustomThumbnail) now pass
  the project's aspect ratio through to the composite stage

Thumbnail composite — new placement options:
- Added left-side, right-side, bottom-bar, split-diagonal placements
  to compositeThumbnail() prompt logic (keeps text off faces)
- Each placement has specific prompt instructions for where to anchor
  text and which areas to keep clear
- All placements include "Do NOT cover or obscure character faces" guard
- Dropdown updated: 7 options (lower/upper third, left/right side,
  bottom bar, diagonal corner, auto negative space)

Publish aspect ratio override:
- New dropdown in Publish tab: "Project Default" | "16:9 Landscape" | "9:16 Portrait"
- Overrides the global project aspect_ratio for thumbnail gen only
- Passed as aspectRatioOverride through renderer → IPC → orchestrator
- orchestrator.generateThumbnail() and generateCustomThumbnail() use
  options.aspectRatioOverride || project.aspect_ratio || '16:9'
- Preview box aspect ratio updates dynamically when dropdown changes
- Log output shows [override] tag when override is active

Credit stats on Pipeline Complete screen:
- IPC handler: get-project-credit-usage → db.getProjectCreditUsage(projectId)
- Preload: getProjectCreditUsage(projectId) exposed
- Renderer: loadCreditStats() called on pipeline-complete event
- Widget shows per-type breakdown (portraits, scenes, video, thumbnails)
  with credit counts, generation counts, and total
- Friendly labels for all asset types, color-coded (green=free, yellow=paid)

Thumbnail credit tracking:
- ThumbnailGenerator: added onCreditUsed(creditCost, stage) callback option
- New _genImage() wrapper method — passes onGenClicked to automation.generateImage
  and fires onCreditUsed with stage label (key-art, title-card, composite, custom-closeup)
- All 7 generateImage calls in thumbnailGenerator.js routed through _genImage
- Orchestrator: generateThumbnail() and generateCustomThumbnail() pass onCreditUsed
  that inserts lightweight 'thumbnail' asset rows into project_assets with credit_cost

CLAUDE.md: Full session 30M documentation — backup system, progress stats,
  FB uploader login/popup/selectors/flow, upload ordering, retry/readiness,
  asset recovery, API 404 bail-out, composite aspect ratio fix,
  placement options, publish aspect ratio override, credit stats widget,
  thumbnail credit tracking
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
