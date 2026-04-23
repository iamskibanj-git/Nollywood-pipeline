@echo off
cd /d "%~dp0.."
if exist ".git\HEAD.lock" (
    del ".git\HEAD.lock"
    echo Deleted stale HEAD.lock
) else (
    echo No HEAD.lock found
)
git add src/main/pipeline/orchestrator.js
git commit -m "fix: strict location regen match + strip orientation from all prompts" -m "Location regen now uses exact file basename match (no includes), safety cap aborts if >1 match. Removed anti-pattern camera directives from regen prompt injection. Expanded sanitizeAspectRatio to strip bare ratios, camera angles, horizon/tilt directives from stored prompts." -m "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
echo.
echo Done!
pause
