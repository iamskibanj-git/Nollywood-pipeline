Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30c: Script engine upstream improvements (A-D, F, G)

Scaffolding additions (_buildCinematicScaffolding):
- Kling rendering budget section: push-in word limits, prop/dialogue
  competition, laughter ban, emotional animation vs description taxonomy
- Cross-clip continuity: re-establish state per clip, movement progression
  guidance, static start frame constraints
- Shot direction length cap (15 words recommended)
- Speaker facing-away turn directive requirement
- NO SUBTITLES directive baked into prompt template

Sanitizer additions (_sanitizeKlingClipPrompts):
- #6 Dual-speaker strip: detect and remove extra [@speaker] in Shot 2/3
- #7 Shot direction length warning: log when body > 20 words
- #8 Difficult-word replacement via _replaceDifficultWords()

New static method _replaceDifficultWords():
- Dictionary of TTS problem words (urgently, EFCC, NDLEA, ATM, SUV, etc.)
- Only operates inside dialogue quotes - won't corrupt shot directions
- Extensible: add new entries as TTS failures are observed
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
