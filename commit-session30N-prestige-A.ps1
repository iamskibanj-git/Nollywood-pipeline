Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }
if (Test-Path ".git\index2.lock") { Remove-Item ".git\index2.lock" -Force }
if (Test-Path ".git\HEAD.lock") { Remove-Item ".git\HEAD.lock" -Force }

$msg = @"
Session 30N-A: Prestige tier (45min) — presets, scaffolding, grading, UI

Session A of prestige tier implementation (wiring + configuration).
Session B (pending) adds two-phase outline engine + voice anchors.

Changes:

orchestrator.js:
- Added 45min preset to DURATION_PRESETS (staged: 15ch x 3sc x 9ln = 405 lines)
- Added 45min preset to CINEMATIC_DURATION_PRESETS (245 target clips, 15 chapters)
- Added TIER_PRESTIGE constant + updated getDurationTier() for '45min' -> 'prestige'
- Exported tier constants and preset objects via module.exports
- Added SYNC WARNING comment on DURATION_PRESETS for renderer parity
- R4 fix: grader catch block now retries once (5s delay) before fallback;
  prestige tier hard-fails (pass:false) instead of auto-passing with score 65
  — too expensive (~3000 credits) to let bad scripts through on infra failure

script-engine.js:
- Added prestige tier to _buildStructuralScaffolding (five-act structure with
  act breaks, ensemble 6-10 chars, dual B-plots, 3+ setup/payoff pairs,
  thematic coherence, escalating hooks across five acts)
- Prestige branch inserted ABOVE long-form with strict === gating (R5/R10)
- Added prestige-specific block to _buildCinematicScaffolding (clip budget
  discipline, three-line-max enforcement, five-act pacing, voice consistency)
- Updated reviewScriptStructure: prestige threshold 80 (+5 cinematic = 85),
  grader max_tokens 16384 for prestige (vs 8192 for other tiers)
- R2 skeleton compression: prestige tier strips tone, location_details,
  truncates dialogue to 6 words per line in grader skeleton

prompts/structure-review-prompt.txt:
- Added prestige tier rubric: inciting (5), first reversal (6), midpoint
  crisis (8), dual B-plots (10), stakes (5), setup/payoff 3+ (6), exposition
  (4), thematic coherence (3), act structure compliance (3) = 50 pts
- Updated category list with first_reversal, dual_bplot, thematic_coherence,
  act_structure
- Updated severity guidance for prestige-specific critical/warning/minor

src/renderer/index.html:
- Added 45min option to all 3 duration dropdowns (pool, fresh, research-edit)
- Added 45min entries to PRESET_STRUCTURES and CINEMATIC_PRESET_STRUCTURES
- Updated durMap and durRevMap with '45min' <-> '45 min'

CLAUDE.md:
- Added prestige tier implementation plan section after Duration Presets
- Documented five-act structure, two-phase outline, voice anchors, credit math
- Documented all 16 risk mitigations (R1-R16) with severity ratings
- Documented two-session implementation split (A: wiring, B: engine)
- Updated Script JSON Recovery section with Session 30N fix details
- Updated pass threshold documentation to include prestige >= 80
"@

git add -A
git commit -m $msg
Write-Host "`nDone. Session A complete — Session B implements Tasks 13-14, 16-17." -ForegroundColor Green
