# Session 30P: Pipeline Stop-Point Mitigations — Credit Pause + Preflight Check
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
feat(pipeline): credit-exhaustion pause + Higgsfield preflight check (Session 30P)

Two mitigations from the stop-point analysis, targeting the highest-risk
operational gaps in cinematic prestige runs.

M1 — Credit-exhaustion pause gate:
- getAvailableCredits() in higgsfield.js: reads Generate button text to
  detect credit cost pre-generation. Cached 30s. Returns available/cost/throttled.
- _withSessionRetry() in orchestrator.js: pre-checks credits before every
  Higgsfield generation call. If exhausted, emits 'credits-exhausted' gate
  with detail (cost, reason). Operator adds credits + clicks Resume.
- Converts a crash-with-cryptic-error into a clean resumable pause.

M2 — Higgsfield preflight health check:
- preflightCheck() in higgsfield.js: ensureBrowser + isLoggedIn with 15s
  timeout. Returns { ok, reason }.
- Preflight gate in orchestrator.js: runs before Stage 3A (portraits) for
  cinematic mode. If failed, emits 'preflight-failed' gate. Re-checks on
  resume. 30 seconds of preflight saves 8-16 hours of wasted runs.

UI:
- index.html: gate handlers for preflight-failed and credits-exhausted.
  Shows clear operator messaging with fix instructions.

Both mitigations are non-breaking — degrade to pre-30P behavior on failure.

Files changed:
- src/main/automation/higgsfield.js (getAvailableCredits, preflightCheck)
- src/main/pipeline/orchestrator.js (preflight gate, credit pre-check)
- src/renderer/index.html (two gate UI handlers)
- CLAUDE.md (Session 30P documentation)
"@

git add src/main/automation/higgsfield.js
git add src/main/pipeline/orchestrator.js
git add src/renderer/index.html
git add CLAUDE.md
git add commit-session30P-mitigations.ps1

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30P committed. Credit pause + preflight check mitigations in place."
