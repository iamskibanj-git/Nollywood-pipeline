Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30e: Story treatment layer — cinematic storytelling enrichment

Addresses the core creative gap: the engine was treating cinematic mode
as "dialogue plus blocking" rather than AI-safe visual melodrama. These
changes add emotional intention, power dynamics, visual storytelling,
cultural voice, and relationship tracking without adding any extra LLM
calls — they enrich the existing two-pass prompts.

Outline prompt (Pass 1) enrichments:
- character_bible: added speech_style (proverbial|sharp|spiritual|etc)
  and speech_notes for voice consistency enforcement
- relationship_arcs: top-level array tracking 3-5 key relationships,
  their type, arc trajectory, and tension source
- chapter_outlines: added power_holder_start/end, emotional_temperature
  (low-simmer|building|boiling|aftermath)
- scene_beats: added scene_purpose (reveal|confrontation|reversal|etc)
  and power_shift (who gains/loses status)
- Extended outline rules explaining WHY each field matters for drama

Chapter prompt (Pass 2) enrichments:
- Rule 8: emotional_state per scene (start/turn/end) for continuity
- Rule 9: visual_beat per kling_clip — one AI-safe physical action
  that carries story meaning (replaces talking-heads syndrome)
- Rule 10: scene_purpose enforcement from outline
- Rule 4 extended: speech_style voice consistency
- 9-word rule EXCEPTION: proverbial/spiritual characters get 12-word
  ceiling for proverb-length lines (preserves cultural cadence)
- Passes relationship_arcs + power/emotional fields to chapter context

Cinematic scaffolding additions (_buildCinematicScaffolding):
- AI-SAFE VISUAL STORYTELLING section: good vs bad visual beats,
  integration into shot directions, examples
- EMOTIONAL RHYTHM AND BREATHING ROOM: pressure/breathing alternation,
  scene purpose variety, Nollywood recognition moments (shame, pride,
  longing, spiritual fear)
- CULTURAL DIALOGUE CADENCE: proverbial rhythm, spiritual declarations,
  accusatory repetition, class markers in speech

Validation (_validateScriptCompleteness):
- Soft warnings for: scenes missing emotional_state, scenes missing
  scene_purpose, clips missing visual_beat, characters missing
  speech_style
- Monitoring only (no hard-fail) — lets us measure LLM compliance
  rate before tightening
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
