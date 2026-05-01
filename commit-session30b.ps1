Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30b: CLAUDE.md - Script engine improvement roadmap (A-G)

Documents 7 categories of upstream script engine improvements
derived from 150-clip production observations:
A. Move 6 rules engine fixes upstream into scaffolding
B. Scene continuity across multiple clips (same scene)
C. Shot direction sentence length cap (15 words)
D. Dynamic scenes - movement progression across clips
E. Structured SFX/Score hints (future, not implementing now)
F. Subtitle suppression at script level
G. Difficult-word replacement dictionary
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
