# Session 30Q: Element Gate Auto-Verification (M3)
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
feat(cinematic): element gate auto-verification — skip manual gate when all present (Session 30Q)

M3 from the stop-point mitigation strategy. Removes the primary barrier
to fully unattended cinematic prestige runs.

Element auto-verification:
- Before 'elements-ready' gate, scrapes Higgsfield Elements tab via
  listExistingElements() and compares against expected cinematicElementNames
- Case-insensitive matching, deduplicates many-to-one name map values
- All present: auto-approves, skips manual gate entirely
- Any missing: shows gate with specific missing-element checklist
- Verification failure: falls through to manual gate (non-blocking)
- Scope: existence only, not quality (quality verification is separate)

UI:
- elements-ready gate handler passes event.missing to the existing
  renderCinematicElementChecklist() for operator-visible missing list

Design:
- invalidateCache() before listing ensures fresh scrape
- Temporary HiggsfieldElements instance (same pattern as element setup)
- _lastMissingElements stored for gate event data

Files changed:
- src/main/pipeline/orchestrator.js (auto-verification block)
- src/renderer/index.html (missing elements in gate handler)
- CLAUDE.md (Session 30Q documentation)
"@

git add src/main/pipeline/orchestrator.js
git add src/renderer/index.html
git add CLAUDE.md
git add commit-session30Q-element-autoverify.ps1

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30Q committed. Element gate auto-verification in place."
