# Session 30T: Status Consistency + Staged Verify Fix
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
fix(pipeline): skipped clips block assembly + staged verify doesn't throw (Session 30T)

Two bugs in terminal status handling found via code review.

P1 — Skipped cinematic clips block assembly:
- Assembly integrity gate used (status !== 'done'), catching 'skipped'
  clips from dialogue triage as blockers. But getIncompleteAssets() and
  verifyStageComplete() treat 'skipped' as terminal — verify passes,
  then assembly fails on the same clips.
- Fix: use TERMINAL_STATUSES Set('done','skipped','archived') for the
  pending check. Skipped clips logged and excluded from concatenation.

P2 — Staged video file verification only logs missing files:
- Staged path logged missing done-clip files but advanced to videos-done
  anyway. Cinematic path uses verifyStageComplete() which throws.
  Missing files caught at assembly instead of here (after Gemini verify
  already burned credits).
- Fix: collect missing files, throw before updateProjectStage. Matches
  cinematic path behavior.

Files changed:
- src/main/pipeline/orchestrator.js (both fixes)
- CLAUDE.md (Session 30T documentation)
"@

git add src/main/pipeline/orchestrator.js
git add CLAUDE.md
git add commit-session30T-status-consistency.ps1

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30T committed. Status consistency + staged verify fix."
