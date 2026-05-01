Set-Location $PSScriptRoot

# Remove stale lock if present
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30: Assembly gate, redo recovery widened, prompt grounding, check-rejections utility

Assembly Integrity Gate (orchestrator.js):
- Hard gate before FFmpeg: all clips must be status=done AND file present on disk
- Throws with clip names if any pending or missing-file clips detected
- Prevents partial/broken assemblies from ever producing output

Redo Recovery Widened (orchestrator.js, db.js):
- Pre-stage recovery now catches scenes-done in addition to verified/assembled
- Fixes edge case: previous restart set stage to scenes-done but crashed before clearing gen_clicked_at
- db.runSqlDirect (did not exist) replaced with new db.clearAssetGenerationMeta()
- New exported function clearAssetGenerationMeta() in db.js clears gen_clicked_at, prompt_used, cdn_url

Production Grounding (orchestrator.js):
- Prefix on all Kling prompts: Nigerian drama identity, SFX directive, dramatic score directive
- Suffix on all Kling prompts: NO SUBTITLES
- Injected after rules engine, before prompt preview gate. Idempotent (no duplication on re-runs)

check-rejections.js utility:
- Read-only DB inspector: shows rejected/pending clips with status, file, gen_clicked_at
- Run with: node check-rejections.js
"@

git add -A
git commit -m $msg

Write-Host "`nDone. You can delete this file now." -ForegroundColor Green
