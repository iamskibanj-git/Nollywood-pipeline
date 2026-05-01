Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30f: Research → script storytelling pipeline enrichment

Closes the gap between research analysis and the new storytelling
fields added in 30e. Research now extracts relationship dynamics,
emotional pacing, power structures, and visual storytelling patterns
from top-performing videos — and these feed directly into the outline
and chapter generation prompts.

Per-video Gemini analysis (buildAnalysisPrompt) — new fields:
- relationship_dynamics: pair type, tension source, power balance,
  audience investment per key relationship in the video
- emotional_pacing: opening intensity, escalation style, breathing
  moments, climax type
- power_dynamics: initial/final power holder, inversion moment,
  social axes (class, gender, age, spiritual, financial)
- visual_storytelling_moments: non-dialogue beats that carry meaning
- dialogue_style.speech_patterns: proverbs, accusations, spiritual
  declarations, class markers

Cross-video pattern extraction (extractPatterns) — new output:
- relationship_patterns: type, frequency, why it works, tension formula
- emotional_arc_patterns: dominant pacing, breathing room, climax types,
  emotional hooks (shame, longing, spiritual fear, etc)
- power_shift_patterns: common inversions, social axes, timing
- effective_visual_beats: non-dialogue moments that work
- dialogue_voice_patterns: speech patterns that resonate

Local fallback (extractPatternsLocal) — extended:
- Counts relationship types from individual analyses
- Collects visual beats and speech patterns
- Includes in recommendations

buildScriptResearchContext wiring (script-engine.js):
- Passes relationship patterns with tension formulas
- Passes emotional arc patterns (pacing, breathing, hooks)
- Passes power shift patterns (inversions, axes)
- Passes effective visual beats
- Passes dialogue voice patterns
- All sanitized through sanitizePatternEntry to strip specifics

CLAUDE.md knowledge base:
- Multi-outfit character system: full design doc, element naming format
  (@baseName_oN_suffix), schema changes, portrait/grid/element flow,
  orchestrator @reference swap logic, 5-phase implementation plan
- Session 30d-f summary documenting all changes this session
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
