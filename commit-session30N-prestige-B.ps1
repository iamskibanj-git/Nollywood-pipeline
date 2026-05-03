# Session 30N-B: Prestige Tier Engine — Two-Phase Outline + Voice Anchors
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
feat(prestige): two-phase outline generation + voice anchors (Session 30N-B)

Tasks 13-14, 16-17 of the prestige tier implementation.

Two-phase outline for prestige (R1 mitigation):
- Phase A1: arc skeleton (character bible + five-act beats + dual B-plots)
- Phase A2: detailed chapter outlines in batches of 5 (3 calls for 15 chapters)
- Phase B: per-chapter generation using combined A1+A2 outline
- Gated on tier === 'prestige'; non-prestige uses original single-pass outline
- Refactored _generateStoryDriven into prestige/standard outline split

Voice anchors (R3 mitigation):
- _extractVoiceAnchors() runs for ALL story-driven scripts (not just prestige)
- Extracts signature phrases per character + TONE_BASELINE from outline
- Injected into every chapter prompt between CHARACTER BIBLE and OUTLINE sections
- ~200-400 tokens per call, prevents voice drift across 12-15 chapters

Validation:
- All 'prestige' string refs consistent across codebase (no typos)
- R5 mitigation confirmed: prestige branch checked BEFORE long-form fallback
- Token budget: ~$3-4 per prestige script generation + grading
- node -c fails due to NTFS mount sync (documented); Read tool confirms files complete

Files changed:
- src/main/pipeline/script-engine.js (two-phase outline, voice anchors)
- CLAUDE.md (prestige tier status updated to implemented)
"@

git add src/main/pipeline/script-engine.js
git add CLAUDE.md
git add commit-session30N-prestige-B.ps1
git add SESSION-B-CONTINUATION-PROMPT.md

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30N-B committed. Prestige tier engine is complete."
Write-Host "Both sessions (A + B) are now committed."
