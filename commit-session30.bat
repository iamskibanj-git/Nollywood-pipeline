@echo off
cd /d "%~dp0"

:: Remove stale lock if present
if exist ".git\index.lock" del ".git\index.lock"

git add -A
git commit -m "Session 30: Assembly gate, redo recovery widened, prompt grounding, check-rejections utility" -m "Assembly Integrity Gate (orchestrator.js):" -m "- Hard gate before FFmpeg: all clips must be status=done AND file present on disk" -m "- Throws with clip names if any pending or missing-file clips detected" -m "- Prevents partial/broken assemblies from ever producing output" -m "" -m "Redo Recovery Widened (orchestrator.js, db.js):" -m "- Pre-stage recovery now catches scenes-done in addition to verified/assembled" -m "- Fixes edge case: previous restart set stage to scenes-done but crashed before clearing gen_clicked_at" -m "- db.runSqlDirect (did not exist) replaced with new db.clearAssetGenerationMeta()" -m "- New exported function clearAssetGenerationMeta() in db.js clears gen_clicked_at, prompt_used, cdn_url" -m "" -m "Production Grounding (orchestrator.js):" -m "- Prefix on all Kling prompts: Nigerian drama identity, SFX directive, dramatic score directive" -m "- Suffix on all Kling prompts: NO SUBTITLES" -m "- Injected after rules engine, before prompt preview gate. Idempotent (no duplication on re-runs)" -m "" -m "check-rejections.js utility:" -m "- Read-only DB inspector: shows rejected/pending clips with status, file, gen_clicked_at" -m "- Run with: node check-rejections.js"

echo.
echo Done. You can delete this file now.
pause
