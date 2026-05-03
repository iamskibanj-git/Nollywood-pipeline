# Session 30U: Outfit Key Normalization
# Run from the nollywood-ai-pipeline root directory

$commitMessage = @"
fix(cinematic): normalize character_outfits keys for multi-outfit resolution (Session 30U)

LLM-generated character_outfits keys arrive in mismatched formats
(character_N, @Prefix, mixed case) that silently fail outfit lookup.
Character renders in default outfit instead of scene-specific one.

Script-engine normalization (primary fix):
- Added key normalization in _sanitizeKlingClipPrompts at scene level
- Lowercases keys, strips @ prefix, resolves character_N to
  element_name_hint via charIndexMap
- Runs before clip-level loop so all downstream code sees clean keys

Orchestrator safety net (defense-in-depth):
- Scene image gen (~line 6795): if sceneOutfits[charId] misses,
  resolves both sides through elemMap to catch residual mismatches
- Kling prompt transform (~line 7882): identical safety-net pattern
  for sceneOutfits[nameLower] in @ref replacement
- Both are no-ops when script-engine normalization succeeds
- Logs when safety-net fires for diagnostics

Files changed:
- src/main/pipeline/script-engine.js (key normalization)
- src/main/pipeline/orchestrator.js (two safety-net blocks)
- CLAUDE.md (Session 30U documentation)
"@

git add src/main/pipeline/script-engine.js
git add src/main/pipeline/orchestrator.js
git add CLAUDE.md
git add commit-session30U-outfit-key-normalization.ps1

git commit -m $commitMessage

Write-Host ""
Write-Host "Session 30U committed. Outfit key normalization + orchestrator safety net."
