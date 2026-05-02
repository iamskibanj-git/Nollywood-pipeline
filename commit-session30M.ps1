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

CLAUDE.md: Pipeline progress stats documentation
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
