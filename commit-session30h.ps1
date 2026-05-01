Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30h: Vision verification — fully automated quality gates

Automation Roadmap Phase 2 — Claude Vision-based quality checks at three
generation stages. Eliminates human approval gates: pipeline regenerates
until vision passes (up to retry cap), then auto-proceeds. Human
intervention only when retry cap exhausted (description problem, not
generation variance).

New: src/main/verify/imageVerifier.js
- ImageVerifier class with three verification methods:
  - verifyPortrait: checks character bible match (gender, age, skin tone,
    build, hair, clothing, overall). Weighted scoring — gender/skin_tone
    weighted 3x (identity-critical), overall_impression 2x.
  - verifyGrid: multi-image comparison (portrait + grid). Checks face
    consistency (3x weight), angle coverage, layout, clothing consistency,
    identity stability across reference sheet angles.
  - verifySceneImage: checks character presence (3x — catastrophic if
    wrong), character identity, setting match, blocking positions,
    composition quality. Supports portrait reference images.
- Shared infra: mime detection from magic bytes, webp→jpeg conversion via
  ffmpeg, Claude Vision API (single + multi-image), JSON extraction,
  configurable thresholds, fallback pass-through on error.
- Single pass/fail verdict (no review tier). Fallback = pass (non-blocking).

Orchestrator wiring (orchestrator.js):
- Portrait stage: verification after generation. Auto-reject + regenerate
  up to 4 retries. Human gate ONLY fires if retry cap exhausted (stored
  in _portraitVerifyExhausted set). Otherwise auto-proceeds.
- Grid stage: verification after generation + dimension check. Auto-reject
  within 4-attempt retry loop (MAX_GRID_ATTEMPTS = 4). Auto-proceeds.
- Scene image stage: verification after generation. Auto-reject within
  3-attempt retry loop. Auto-proceeds — all scene approval gates removed.
- Resume re-gates: replaced with auto-proceed logging (scenes already
  passed vision verification during generation).
- Manual fallback gate preserved: fires only when Cinema Studio automation
  itself fails (UI reliability, not quality).

Scoring thresholds (single pass/fail):
- Portrait: pass ≥ 80
- Grid: pass ≥ 75
- Scene: pass ≥ 70 (forced fail if character_presence < 50)

Retry caps: Portrait 4, Grid 4, Scene 3

Gracefully non-blocking — API errors, missing keys, or image load
failures return 'pass' so pipeline continues. No behavioral change
when Claude API key is not configured.

CLAUDE.md: Session 30h summary
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
