Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30g: Multi-outfit character system — full implementation

Characters can now wear different outfits across the story. Each outfit
becomes a SEPARATE Higgsfield Element with its own portrait, grid, and
@reference — enabling the visual pipeline to render the correct clothing
per scene without any manual element swapping.

Script engine (script-engine.js):
- Outline schema: physical_description (permanent features) + outfits[]
  array replaces full_prompt_description. Each outfit has outfit_id (o1,
  o2...), description, and context (when worn).
- Scene beats: character_outfits mapping (char_id → outfit_id) per scene
- RULES: outfit assignment guidance (protagonists 2-4, supporting 1-2)
- Chapter prompt Rule 11: character_outfits required in output, no
  mid-scene outfit changes (split scenes instead)
- Cinematic scaffolding: MULTI-OUTFIT CHARACTER SYSTEM section explaining
  element naming, downstream resolution, and constraints

Orchestrator (orchestrator.js):
- Portrait stage: backward-compat charDescription builder using
  physical_description + o1 outfit when full_prompt_description absent
- Outfit portrait sub-loop: after master portraits are approved,
  generates outfit portraits (o2, o3...) using master as face reference
- Grid generation: iterates gridUnits (character × outfit pairs) instead
  of bare characters — one grid per outfit
- Element creation: pending list from gridUnits, element name format
  @baseName_oN_suffix (multi-outfit) or @baseName_suffix (legacy)
- _outfitElements map: [baseName][outfitId] → elementName for precise
  outfit-aware prompt resolution
- Scene image stage: outfit-aware @reference resolution via
  scene.character_outfits + _outfitElements lookup
- Video stage: characterOutfits passed through allKlingClips, @reference
  sanitization resolves to correct outfit element per scene
- Bare character name auto-fix: outfit-aware resolution

Backward compatibility: scripts without outfits[] array (legacy
full_prompt_description) continue working with single element per
character — no migration needed for existing projects.

CLAUDE.md: Session 30g summary documenting all changes
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
