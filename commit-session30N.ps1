Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }
if (Test-Path ".git\index2.lock") { Remove-Item ".git\index2.lock" -Force }
if (Test-Path ".git\HEAD.lock") { Remove-Item ".git\HEAD.lock" -Force }

$msg = @"
Session 30N: Script engine review — 6 fixes across JSON parsing, grading, prompt sanitization

Fixes (script-engine.js):
1. _closeUnclosedBrackets: rewrote to use ordered nesting stack instead of
   separate brace/bracket counters — old approach closed ] before } regardless
   of actual nesting order, corrupting recovery of truncated JSON like [{ ...
2. _fixUnescapedQuotes: added \n \r to string boundary detection — newlines
   after a quote indicate a string boundary, not an inner quote to escape
3. reviewScriptStructure: grader parse failures now return pass:false instead
   of silently auto-passing with score 65 — prevents structurally weak scripts
   from slipping through when the grader response is malformed or truncated
4. _sanitizeKlingClipPrompts fix 3 (bare name @-prefixing): now skips matches
   inside dialogue quotes — bare character names in dialogue should stay as
   human names, not get @-prefixed then immediately stripped by fix 4
5. _sanitizeKlingClipPrompts fix 6 (dual-speaker strip): collect replacements
   first then apply — modifying the prompt string mid-iteration with a stateful
   regex (g flag + exec loop) corrupted lastIndex, skipping matches
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
