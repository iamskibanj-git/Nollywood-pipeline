Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30d: Fix P1/P2 bugs from code review

P1: Fix cinematic clip row duplication (orphaned pending rows):
- Add stale/orphan cleanup + dedup for video_clip_cinematic before
  generation loop (mirrors scene_image_cinematic pattern at Phase 3)
- Adopt-orphan logic: before inserting new DB row, find pre-inserted
  row from _insertExpectedAssets() by chapter+scene+line where
  kling_clip_id is null, tag it instead of creating duplicate
- Update in-memory array after tagging so loop iterations see the tag

P1: Fix settings update using staged structure for cinematic:
- calculateStoryStructure() in updateProjectSettings() now receives
  the effective generatorMode instead of defaulting to 'staged'

P2: Scope title dedup to current research pool:
- checkDuplicate() accepts optional poolId, passes to getProducedStories()
- Call site passes this.state.selectedPoolId

P2: Fix verify redo cap — throw instead of silently proceeding:
- When MAX_VERIFY_REDO_ITERATIONS reached, check for pending clips
- If any remain, throw explicit error (belt-and-suspenders with
  assembly integrity gate from Session 30)
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
