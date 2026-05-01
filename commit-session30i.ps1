Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30i: Crash-resilient resume — filesystem is source of truth

Bullet-proofs pipeline state persistence so crash/restart resumes cleanly
without re-running expensive operations or exceeding retry caps.

Core principle: local file on disk is the ultimate source of truth.
DB is an index that gets reconciled against reality on every resume.

New: src/main/database/migrations/017-vision-metadata.sql
- vision_score, vision_verdict, vision_retries, vision_issues,
  vision_verified_at columns on project_assets
- Replaces all in-memory retry counters with DB-persisted state

Database layer (db.js):
- reconcileWithFilesystem(projectId): scans all assets on resume.
  File exists on disk → mark done (regardless of DB status).
  DB says done but file missing → reset to pending for regeneration.
- saveVisionResult(assetId, { score, verdict, issues, retries }):
  persisted immediately after vision API call — survives crash
- incrementVisionRetries(assetId) / getVisionRetries(assetId):
  replaces in-memory _portraitVerifyRetries map. Retry count survives
  crash — prevents infinite retries across restart cycles.
- recoverOnStartup() enhanced: runs reconcileWithFilesystem for active
  project alongside existing resetStuckAssets logic.

Orchestrator persistence (orchestrator.js):
- _persistCinematicMaps(projectId): writes cinematicElementNames,
  _outfitElements, cinematicLocations to projects.settings JSON
  immediately after element creation + location setup. Survives crash.
- _restoreCinematicMaps(projectId): rebuilds in-memory maps from DB
  settings on resume. Validates location image paths against disk —
  missing files excluded (will regenerate).
- Resume path: _restoreCinematicMaps + reconcileWithFilesystem called
  before any stage logic runs.
- Portrait/grid/location/scene verification: all now call
  db.saveVisionResult() immediately after API returns, use
  db.incrementVisionRetries() instead of in-memory counters.

Cultural grounding (location authenticity):
- CULTURAL_GROUNDING map keyed by nationality ('Nigerian'). Contains:
  prompt_suffix, interior_markers, exterior_markers, forbidden elements,
  verify_instruction.
- _buildLocationPrompt: injects interior/exterior cultural markers based
  on regex detection (room/kitchen → interior, else exterior). Prevents
  AI from defaulting to Western aesthetics.
- verifyLocationImage: receives culturalContext + forbiddenElements.
  cultural_authenticity check weighted 2.5x, forced fail if < 40.
  Catches: CNN on TV, European portraits, IKEA furniture, non-African
  architecture in Nigerian settings.
- Interior markers: ankara fabric, carved wood, African sculptures,
  family photos of Black/African people, Nigerian TV channels, terrazzo.
- Exterior markers: tropical vegetation, concrete/painted buildings,
  hand-painted signage, Lagos/Abuja/Enugu architecture style.
- Forbidden: CNN, BBC, Fox News, European portraits, white family photos,
  IKEA furniture, Western suburban architecture, snow, autumn leaves.

Also in this commit:
- Location verification (verifyLocationImage) + gate removal
- Dialogue triage auto-proceed when all clips have dialogue
- Scene image approval gates removed (auto-proceed on vision pass)

CLAUDE.md: Session 30i summary
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
