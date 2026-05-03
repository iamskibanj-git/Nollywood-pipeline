# Session 30O: Prestige Tier Bug Fixes — Outline Validation, Outfit IDs, UI Labels, Rubric
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
fix(prestige): outline validation, outfit IDs, UI labels, rubric tier def (Session 30O)

Four prestige-tier bugs caught in post-implementation review.

P1 — Outline coverage validation:
- After A2 batches, validate allChapterOutlines has exactly chapters 1..totalChapters
- Fail with descriptive error on missing/duplicate chapters instead of burning a 45-min run
- Sort outlines by chapter_number after validation

P2 — Outfit IDs in compact bible:
- compactBible now includes outfits array with outfit_id + context per outfit
- Previously only passed outfit_count, leaving A2 unable to assign valid outfit IDs
- Enables correct character_outfits mappings in scene beats

P2 — Prestige tier labels in UI:
- Added prestige case to cinematic tierLabel ternary (line 1042)
- Added prestige case to staged tierLabel ternary (line 1076)
- Added prestige case to structural review panel tierLabel (line 1363)
- Previously all three fell through to 'standard — 3-act' for prestige

P3 — Prestige in rubric TIER DEFINITIONS:
- Added prestige (45 min, 12-15 chapters) to structure-review-prompt.txt
- Five-act structure, dual B-plots, VERY HIGH structural bar
- Previously only test/standard/long-form were defined

Files changed:
- src/main/pipeline/script-engine.js (outline validation, outfit IDs)
- src/renderer/index.html (three tierLabel ternaries)
- prompts/structure-review-prompt.txt (tier definition)
"@

git add src/main/pipeline/script-engine.js
git add src/renderer/index.html
git add prompts/structure-review-prompt.txt
git add commit-session30O-prestige-fixes.ps1

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30O committed. Prestige tier fixes applied."
