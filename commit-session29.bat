@echo off
cd /d "%~dp0"

:: Remove stale lock if present
if exist ".git\index.lock" del ".git\index.lock"

git add -A
git commit -m "Session 29: Rules engine, verify fixes, accent detection, clip packing guard" -m "Rules Engine (orchestrator.js):" -m "- New _validateAndFixPromptRules() method - 11-rule pre-generation validator" -m "- Rules 1-9,11: dual speaker detection, laughter->smile, push-in+emotion strip, ECU downgrade, head-lift->gaze-rises, prop-in-hand strip, word count ceiling, speaker-facing-away turn injection, accessory removal strip, dialogue-blocking flags" -m "- Hooked into _runCinematicVideoStage after vision passes, before prompt preview gate. Non-destructive passthrough when no rules fire." -m "" -m "Verify-Redo Flow Fixes (db.js, orchestrator.js):" -m "- Auto-accept Gemini accept tier clips so redo iterations only re-verify regenerated clips, not all 150" -m "- Soft-delete old clip file on reject - renames to _redo_backup so video stage cannot re-adopt old files" -m "- Full rejection reset: clear gen_clicked_at, prompt_used, cdn_url, file_path, status on reject" -m "- Resume-path redo: detect pending clips at verified/assembled stage, reset to scenes-done" -m "- Pre-stage redo recovery: clear stale gen_clicked_at via new db.clearAssetGenerationMeta()" -m "- const->let fix for resumeStage variable to allow redo reassignment" -m "" -m "Accent Detection (clipVerifier.js):" -m "- Removed neutral/unclear escape hatch from accent matching" -m "- Tightened Gemini prompt: must commit to specific accent. Lean toward American when in doubt." -m "" -m "Clip Packing Guard (script-engine.js):" -m "- EXACTLY 3 lines per clip enforced in prompt (was 1-3)" -m "- Post-script auto-split validator for 4+ line clips" -m "" -m "CLAUDE.md: Session 29 docs - rules engine table, REDO re-categorization (19 Tier 1), architecture notes."

echo.
echo Done. You can delete this file now.
pause
