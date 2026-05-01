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

CLAUDE.md: Session 30j summary
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
