# Session 30R: Batch Prompt-Preview Mode (M4)
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
feat(cinematic): batch prompt-preview mode — review all clips before generation (Session 30R)

M4 from the stop-point mitigation strategy. Completes all 4 mitigations.
Replaces per-clip prompt-preview gate with single batch review.

Batch prompt-preview (two-phase clip processing):
- Phase 1: runs all prompt transforms (vision blocking, posture correction,
  rules engine, grounding prefix) and collects final prompts into
  batchPreviewData[] + cachedFinalPrompts{} + cachedClipGenData{}
- Single 'prompt-preview-batch' gate emits all clip data for batch review
- Phase 2: generates only approved clips using cached prompts
- Rejected clips tracked via batchRejected counter
- Phase 2 includes session-expired recovery + single retry

UI:
- New batch-preview-panel (purple #8b5cf6 theme) with:
  - Paginated card grid (20/page) showing start frame, label, prompt
  - Per-card toggle selection (click to approve/reject)
  - Select All / Deselect All buttons
  - Approve Selected (count) / Stop buttons
  - Click prompt text to expand/collapse full prompt

IPC:
- approvePromptPreviewBatch(decision) — 'stop' | 'approve' | {approved:[]}
- New IPC handle + preload binding

Design:
- Two-phase avoids duplicating 750 lines of transform code
- cachedClipGenData stores all per-clip refs for Phase 2
- All clips selected by default — operator deselects bad ones

Files changed:
- src/main/pipeline/orchestrator.js (batch collection, gate, gen loop, method)
- src/renderer/index.html (batch panel HTML, JS functions, gate handler)
- src/main/main.js (IPC handle)
- src/preload/preload.js (preload binding)
- CLAUDE.md (Session 30R documentation)
"@

git add src/main/pipeline/orchestrator.js
git add src/renderer/index.html
git add src/main/main.js
git add src/preload/preload.js
git add CLAUDE.md
git add commit-session30R-batch-preview.ps1

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30R committed. Batch prompt-preview mode in place. All 4 mitigations complete."
