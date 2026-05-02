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

Facebook uploader — login wait + timing fixes:
- _waitForLogin(): navigates to facebook.com on launch, polls for
  logged-in indicators (profile, notifications, messenger icons)
- If not logged in, waits up to 3 min for user to complete login + 2FA
- Polls every 3s with elapsed/remaining time in console logs
- Auto-proceeds once logged-in indicators detected
- CLICK_TIMEOUT raised 15s -> 20s for slow FB DOM
- POST_CLICK_SETTLE raised 3s -> 4s
- POST_NAV_SETTLE raised 4s -> 6s
- POST_SCHEDULE_CONFIRM raised 10s -> 15s

CLAUDE.md: Pipeline progress stats documentation
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
