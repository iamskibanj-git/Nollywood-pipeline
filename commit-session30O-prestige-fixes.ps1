# Session 30O: Prestige Tier Validation Hardening — 8 fixes across two review rounds
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
fix(prestige): validation hardening — 8 fixes from post-implementation review (Session 30O)

Two rounds of prestige-tier bug fixes caught in code review.

Round 1 — UI/data fixes:

P1 — Outline coverage validation:
- After A2 batches, validate allChapterOutlines has exactly chapters 1..totalChapters
- Checks missing, duplicate, AND out-of-range chapter numbers + length === totalChapters
- Sort outlines by chapter_number after validation

P2 — Outfit IDs in compact bible:
- compactBible now includes outfits array with outfit_id + context per outfit
- Previously only passed outfit_count, leaving A2 unable to assign valid outfit IDs
- Enables correct character_outfits mappings in scene beats

P2 — Prestige tier labels in UI:
- Added prestige case to all three tierLabel ternaries in index.html
- Cinematic/staged summaries: 'prestige — 5-act + dual B-plots'
- Review panel: 'Prestige (45 min)'

P3 — Prestige in rubric TIER DEFINITIONS:
- Added prestige (45 min, 12-15 chapters) to structure-review-prompt.txt
- Five-act structure, dual B-plots, VERY HIGH structural bar

Round 2 — Validation hardening:

P1 — Phase B chapter number validation:
- Each call enforces exactly one chapter with chapter_number === chNum
- Corrects mismatches, warns on multi-chapter returns, takes first only
- Final 1..N coverage validation on allChapters before return

P2 — AUTO-SPLIT placeholder hard-fail:
- After oversized clip auto-split, scans for [AUTO-SPLIT prefix in multi_shot_prompt
- Throws with clip IDs instead of warning — prevents placeholders reaching Kling

P2 — 3-character scene limit enforcement:
- Promoted from console.warn to hard throw for cinematic mode
- Error lists offending scenes with chapter/scene/character count
- Kling platform constraint — warn-only was no check at prestige scale

P2 — Out-of-range chapter rejection:
- Added chapter_number < 1 or > totalChapters guard to outline validation
- Bonus chapters (e.g. ch16 in a 15-chapter outline) now caught

Files changed:
- src/main/pipeline/script-engine.js (outline validation, Phase B validation,
  auto-split guard, 3-char enforcement, outfit IDs in compact bible)
- src/renderer/index.html (three tierLabel ternaries)
- prompts/structure-review-prompt.txt (prestige tier definition)
- CLAUDE.md (Session 30O documentation)
"@

git add src/main/pipeline/script-engine.js
git add src/renderer/index.html
git add prompts/structure-review-prompt.txt
git add CLAUDE.md
git add commit-session30O-prestige-fixes.ps1

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30O committed. Prestige validation hardening complete (8 fixes)."
