Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30k: Publish tab + custom thumbnail + session wait + FB upload waits

Publish tab — standalone (not pipeline-gated):
- publish/index.js: PublishController — IPC-ready entry point
- Accessible at any time for projects with scene images done
- Dropdown lists eligible projects (scene_count > 0)
- Two thumbnail modes: scene-based (existing) and custom close-up

Custom close-up thumbnail:
- generateCustomThumbnail() in ThumbnailGenerator: 3-stage flow
  1. Custom key art: close-up of @element with emotional expression
  2. Title card on transparent background (same as scene-based)
  3. Composite overlay (same as scene-based)
- generateCustomKeyArt(): tight close-up prompt with @element ref
  for face consistency via Nano Banana Pro
- Character picker: getCharactersForThumbnail() returns characters
  from script bible sorted by dialogue count (lead = most lines)
- Expression auto-suggest: suggestExpression() analyzes script tone
  markers → maps to thumbnail expressions (e.g. "fierce defiant")
  User can override the suggestion.

Session wait (thumbnail generation):
- _ensureLoggedIn(): called before every generateImage() in all
  3 stages. Proactively checks isLoggedIn() before attempting gen.
- _waitForLogin(): on SESSION_EXPIRED, closes browser, relaunches
  to higgsfield.ai, polls isLoggedIn() every 10s (max 10 min).
  No more wasted retries on dead sessions.
- All 3 stages (key art, title card, composite) now catch
  SESSION_EXPIRED specifically and wait instead of burning attempts.

Shorts tab UI — full wiring:
- Header button, project dropdown, plan controls, calendar table
- Upload controls: Launch Browser → Upload Next → Close
- IPC: shorts:getProjects/getStatus/plan/startUpload/uploadNext/closeUpload
- Main.js: lazy-initialized ShortsController

@element autocomplete in generateImage (higgsfield.js):
- Reuses parsePromptSegments from kling-automation (same pattern)
- Detects @element refs in prompt → slow autocomplete typing
- 80ms/char + 1500ms dropdown wait + Enter to select
- Enables custom thumbnail @element to bind correctly

Publish tab UI — custom thumbnail mode wired:
- Thumbnail tab: toggle between "Scene-based" and "Custom Close-up"
- Custom mode: character dropdown (sorted by dialogue count) +
  expression input (auto-suggested from script tone, overridable)
- Scene scoring deferred: only fires when scene-based mode active
  (was auto-firing on project load regardless of mode)
- Preview window aspect ratio driven by global aspect ratio setting
  (9:16 or 16:9 depending on project config)
- IPC: get-publish-characters, generate-custom-thumbnail
- Orchestrator: getPublishCharacters(), generateCustomThumbnail()
  with full browser launch/login check + auto-resolve publish gate

Facebook uploader — proper wait times:
- Named timeout constants: POST_UPLOAD_SETTLE (15s), POST_CLICK_SETTLE
  (3s), POST_NAV_SETTLE (4s), POST_SCHEDULE_CONFIRM (10s)
- scheduleReel() uses named constants instead of hardcoded waits
- _waitForUploadProcessing(): polls for Next button enabled or
  progress bar gone (max 3min). Video uploads need time to process.
- _waitForScheduleConfirmation(): polls for success toast, tab return,
  or URL change (max 10s). Confirms FB acknowledged the schedule.
- _enterDescription() uses DESCRIPTION_TYPE_DELAY (15ms/key) to
  avoid anti-bot detection on typing speed.

CLAUDE.md: Session 30k summary
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
