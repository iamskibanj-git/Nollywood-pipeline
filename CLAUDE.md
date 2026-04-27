# Nollywood AI Drama Pipeline — Project Knowledge

This file persists operational knowledge across sessions. Read this before making any changes to the codebase.

## What This App Does

Electron desktop app that automates AI-generated Nollywood dramas end-to-end: YouTube research → Gemini analysis → Claude script generation → Higgsfield image/video generation → FFmpeg assembly into a final 4K video.

## Architecture

- **Main process** (Node.js): `src/main/main.js` — IPC handlers, Electron lifecycle
- **Renderer** (HTML/JS): `src/renderer/index.html` — single-page dashboard UI
- **Preload bridge**: `src/preload/preload.js` — IPC bridge between renderer and main
- **BrowserView**: Embedded Playwright Chromium for Higgsfield automation

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| Orchestrator | `src/main/pipeline/orchestrator.js` | Pipeline state machine, stage sequencing, approval gates, research cache, duration presets |
| ScriptEngine | `src/main/pipeline/script-engine.js` | Claude API calls for titles + scripts, research context sanitization, title similarity scoring, `_safeParseScriptJson()` multi-strategy JSON recovery |
| YouTubeScraper | `src/main/research/youtube-scraper.js` | Two-pool YouTube search (AI originals + remake candidates) |
| GeminiAnalyzer | `src/main/research/gemini-analyzer.js` | Gemini 2.5 Flash video/title analysis, `_safeParseJSON()` fallback |
| HiggsField | `src/main/automation/higgsfield.js` | Playwright browser automation for image + video generation |
| Assembler | `src/main/assembly/assembler.js` | FFmpeg: trim → branding card → concat → 4K upscale |
| Database | `src/main/database/db.js` | SQLite init, migrations, query helpers |

### Storage (Dual System)

**SQLite** (`sql.js`) — all stateful data:
- Projects (title, stage, script JSON, settings)
- Asset tracking (portraits, scene images, video clips — each with status: pending/generating/done/failed)
- Research cache (replaces old electron-store researchCache)
- Used video history
- Produced title dedup

**electron-store** — simple config only:
- API keys (Claude, Gemini)
- UI preferences (window size, theme)
- Higgsfield session cookies

### SQLite Schema (5 tables)

```sql
projects         -- id, title, source_video_ids, duration_preset, stage, script_json, settings, timestamps
project_assets   -- id, project_id, type, chapter/scene/line, character_id, file_path, status, retry_count, error_message, prompt_used, model_used, source_gen_id
research_cache   -- id, fetched_at, expires_at, youtube_data, analysis_data, is_active
used_videos      -- video_id, project_id, used_at
produced_titles  -- id, project_id, title, similarity_score, created_at
```

Full schema with all columns: see TESTING-RESULTS.md §13.

### Migration Files
- `src/main/database/db.js` — init, migration runner, helpers
- `src/main/database/migrations/001-initial.sql` — full schema
- `src/main/database/migrations/002-asset-gen-metadata.sql` — adds `model_used`, `source_gen_id` columns to `project_assets`

## Pipeline Flow

1. **Pre-flight**: Ping Claude + Gemini APIs
2. **Research**: YouTube search → Gemini analysis → cache results (7-day TTL)
3. **Script**: Claude generates title candidates → user approves → Claude generates full screenplay JSON
4. **Portraits**: Higgsfield Nano Banana Pro (Unlimited mode, free) for character reference sheets
5. **Scenes**: Higgsfield image gen with reference chaining (character portraits + previous scene)
6. **Video**: Higgsfield Veo 3.1 Lite — 12 credits/clip, 8s at 720p
7. **Assembly**: FFmpeg trims → branding cards → concat → 4K upscale (lanczos)

## Project State Lifecycle

A story has NO abandon concept — once started, it always resumes until assembly completes. Credits running out just pauses progress; the project waits for the user to come back.

**Stages** (in order): `research-done` → `title-chosen` → `script-done` → `portraits-done` → `scenes-done` → `videos-done` → `assembled`

**Pool locking**: Source video is "claimed" when title is chosen, marked "used" only when assembly completes. No new story can start while a project is in progress.

**Launcher UI** (two-card layout in `index.html`):

The launcher shows one of three states:

1. **Resume card** (`#resume-card`): Shown when an in-progress project exists. Big "Continue: [Title]" button with stage label and asset progress count.

2. **Pool entry card** (`#pool-entry-card`): Shown when research pool has unused videos and no active project. This is the primary action — a large green-bordered card that acts as one big clickable button. Contains pool stats, progress bar, and an embedded duration picker. Clicking anywhere on the card calls `startPipeline()`. Below it sits a ghost "Start Fresh Research Instead" button (`#force-refresh-row`).

3. **Fresh start card** (`#fresh-start-card`): Shown when no pool exists or pool is exhausted. Has its own duration select and "Start Research" button. If pool is exhausted, shows a yellow info banner via `#cache-exhausted-widget`.

**Key implementation details**:
- Two duration selects exist: `#duration-preset` (pool card) and `#duration-preset-fresh` (fresh card). `getActiveDuration()` reads from whichever card is visible.
- `loadCacheStatus()` orchestrates which card is visible based on `getActiveProjectStatus()` and `getResearchCacheStatus()` results.
- `updateDurationInfo()` updates both duration info labels independently.
- The pool card's duration select uses `event.stopPropagation()` so clicking the dropdown doesn't trigger the card's `startPipeline()` click.

### Crash Recovery & Graceful Shutdown

Every expected asset gets its own row in `project_assets` with status tracking:
1. After script gen → INSERT all expected assets as `pending`
2. Before generating → UPDATE to `generating`
3. After success → UPDATE to `done` with `file_path`
4. After failure → UPDATE to `failed` with `error_message`, increment `retry_count`

**On startup**: `recoverOnStartup()` in db.js resets any assets stuck at `generating` back to `pending` (they were mid-generation when the app crashed). Also cleans up stale `.tmp` write files.

**On shutdown** (`gracefulShutdown()` in main.js): Single handler covers all exit paths:
- X button / Alt+F4 → Electron's `before-quit` event
- Ctrl+C in terminal → `SIGINT` signal handler
- `kill` command → `SIGTERM` signal handler
- Uncaught exceptions → `uncaughtException` handler (saves DB then exits)
- Unhandled rejections → defensive `db.save()` only (doesn't exit)

Shutdown sequence: cancel pipeline → close Playwright browser (saves Higgsfield cookies) → reset stuck assets → save + close DB.

**Close confirmation dialog**: If the pipeline is actively running when the user clicks X, a dialog warns them and lets them cancel the close. Progress is always safe regardless.

**Atomic DB writes**: `save()` writes to `.tmp` then `fs.renameSync()` over the real file. Prevents half-written corrupt files if the process dies mid-write. If the DB file is corrupt on load, it's backed up as `.corrupt.[timestamp]` and a fresh DB is created.

**Pipeline picks up exactly where it left off** — query for `status != 'done'`, retry anything that was generating.

## Research Cache System — Pattern Library Model + Multi-Pool (Session 8)

The research pool is analyzed once and the resulting pattern library (themes, archetypes, settings, tones, audience triggers) is reused across **unlimited stories** until the 7-day TTL expires. Videos are never "consumed" — variety comes from Claude picking different theme combinations each time, plus the title dedup system preventing repetition.

**Multi-pool (migration 008):** The pipeline supports up to 5 coexisting research pools. "New Research Pool" creates a fresh pool without touching existing ones (old design overwrote); user picks which pool to work from via the home-screen pool list. Cap enforced at save time — when a 6th pool would be created, the oldest non-expired pool is hard-deleted to make room.

- 7-day TTL per pool, stored in SQLite `research_cache` (migration 008 dropped the exclusive `is_active` semantics)
- **Project-pool linkage:** `projects.research_cache_id` FK records which pool each project came from. Per-pool counts (unused videos, stories produced) JOIN through this. Without the FK, a new pool's "X of Y unused" would be polluted by old-pool projects that happened to share video IDs with the new pool — the original bug that motivated this design.
- **Fresh research**: YouTube scrape → Gemini analyzes up to 10 videos (interleaved: alternating remakes + AI originals via `_interleaveVideos()`, remakes first since they're proven formulas) → patterns extracted → saved as a NEW pool via `saveResearchCache()` which returns the new pool id → orchestrator writes the id back onto the project row via `updateProject(projectId, { research_cache_id })`
- **Cached reuse**: User picks a pool from the launcher → orchestrator receives `options.researchCacheId` → loads that specific pool via `getResearchPoolById()`. No re-analysis. Gemini API calls only happen on fresh research.
- **Pool refresh**: Time-based only (7 days per pool) or manual (`forceRefresh=true` creates a new pool). No consumption-based exhaustion.
- **Story uniqueness**: Title dedup (`checkDuplicate()`) prevents generating similar titles. Dedup is **per-pool** — `getProducedStories(poolId)` scopes to that pool's projects so titles from pool A don't block a same-named story in pool B (they're different research contexts targeting different trends).
- **DB helpers** (`src/main/database/db.js`): `listResearchPoolSummaries()` (home list), `getResearchPoolById()`, `getResearchCacheStatus(poolId)`, `getUnusedVideos(poolId)`, `getProducedTitlesForPool(poolId)`, `saveResearchCache()` (returns new id, enforces 5-pool cap), `deleteResearchPool(poolId)`.
- **IPC**: `listResearchPools`, `deleteResearchPool`. The back-compat `getResearchCacheStatus` returns the most-recent pool when no id provided.

## Baked-In Settings

- **Nationality**: Always "Nigerian" — hardcoded in storyBrief
- **Accent**: Always "Nigerian accent" — hardcoded in storyBrief, used in `buildVideoPrompt()` for Veo lip-sync dialogue
- **Tone**: **Per-line, not project-level.** Each `line.tone` in the script JSON (e.g. "Blissful", "Spiteful", "Terrified") is chosen by Claude based on the specific line's emotional beat, not locked for the whole story
- **Setting**: **Per-scene, not project-level.** Each `scene.location` + `scene.location_details` in the script JSON is chosen by Claude based on narrative need — a story can open in a Lagos high-rise, move to a village, visit a palace. The script-prompt includes an explicit clause telling Claude to use the research patterns as a palette, not a constraint (Session 8 fix — previously `_deriveSettingFromPatterns()` picked one setting from research and forced it project-wide, producing village-monoculture output)
- **Research patterns flow to Claude naturally** via the research summary in the system prompt (both title and script generation) — Claude picks settings and tones per-scene/per-line from what the research shows works
- **Quick Settings panel removed** from research view — nationality/accent are the only project-level constants; everything else is generator-driven from research

## Duration Presets

Defined as `DURATION_PRESETS` constant in orchestrator.js, grouped into three tiers by `getDurationTier(preset)`:

### Staged (Veo) — fixed grid model

Staged mode uses a rigid `chapters × scenesPerChapter × linesPerScene` grid. Each line = 1 clip = 1 scene image = ~7 seconds.

**Test tier** (cheap iteration, 1/9/45 clips):
- **1 min** (~108 credits): 1 chapter × 3 scenes × 3 lines = 9 clips
- **2 min** (~216 credits): 2 chapters × 3 scenes × 3 lines = 18 clips
- **5 min** (~540 credits): 3 chapters × 3 scenes × 5 lines = 45 clips

**Standard tier** (the real 10-min baseline):
- **10 min** (~1080 credits): 6 chapters × 3 scenes × 5 lines = 90 clips

**Long-form tier:**
- **20 min** (~2160 credits): 8 chapters × 3 scenes × 8 lines = 192 clips
- **30 min** (~3240 credits): 10 chapters × 3 scenes × 9 lines = 270 clips

Character caps (staged only): test 2-3, standard 3-4, long-form 4-6.

1/2/5-min presets are kept for test runs when iterating on non-scripting features (Verify Clip, History Recovery, etc.) — they don't get the full structural review pressure because a bad test run only burns ~$0.80 instead of 2000+ credits.

### Cinematic (Kling) — story-driven model

Cinematic mode uses a **credit-first, story-driven** approach. The clip is the atomic cost unit, not the line. Structure is flexible — scenes, lines, and characters are unlimited and driven by what the story needs.

**Key principle:** Each Kling clip = exactly 3 shot directions/dialogue lines = 10-12 seconds = ~11 credits. Lines are "free" (up to 3 per clip). Scene images are ~2 credits each. Portraits are ~2 credits each (one-time per character).

**Budget math for cinematic:**
- Total clips = `duration_seconds ÷ 11`
- Total credits = `(clips × 11) + (scenes × 2) + (characters × 2) + buffer`
- 30 min film: ~164 clips × 11 = ~1,804 + ~80 scenes + ~16 portraits + ~200 buffer = **~2,100 credits**
- Monthly budget (6000 credits): can produce ~2.8 × 30-min films (vs ~1.8 under old grid model)

**What's flexible (cinematic only):**
- **Scenes per chapter**: unlimited — a confrontation chapter might have 8 scenes, a reflective chapter might have 2
- **Lines per scene**: unlimited — groups into clips of 3 lines each (e.g. 9 lines = 3 clips, all sharing the same scene image)
- **Characters per project**: unlimited — every speaking character gets a portrait + element grid. A 30-min ensemble drama might have 8-12 characters
- **Locations**: unlimited (already was)
- **Chapters**: flexible range (8-12 for long-form, story-driven)

**What's fixed (Kling platform constraints):**
- **Exactly 3 shots per Kling clip** — Kling degrades at 4+
- **Max 3 characters per scene** — Kling lip-sync/positioning quality
- **≤9 words per dialogue sentence** — video pacing + lip-sync
- **≤2500 chars per Kling prompt** — Kling internal limit
- **Clip duration**: 10-12 seconds per Kling generation

**Scene = conversation beat, not location change.** A 30-min courtroom drama can have 25 scenes in the same courtroom — what changes is who's addressing whom, who enters/exits. The scene image stays the same for all clips within that scene. Locations are unlimited but scenes are the organizational unit for character groupings + dialogue flow.

**Credit estimation shifts from line-based to clip-based.** The start screen shows estimated clips and credits derived from target duration, not from a fixed grid formula. The script prompt tells Claude the target clip count and lets the story distribute scenes/lines/characters freely within that budget.

## Script Structural Review (Session 8)

**Status:** ✅ Shipped. Runs automatically after script generation, hard-blocks the approval gate if the script scores below tier threshold.

**Problem it solves:** Long-form scripts (20-30 min) burn 2000-3000 credits in video generation. A structurally weak script — no inciting incident, no midpoint reversal, no B-plot, flat stakes — will produce 180-270 video clips that viewers won't watch. The human is the only quality gate today, and structural weakness is hard to spot by eye in a JSON dump of 200+ lines.

**Architecture:**

1. **Tier-aware scaffolding injected into script-prompt.** `{{STRUCTURAL_SCAFFOLDING}}` placeholder expands to different rule sets per tier:
   - Test tier: hook + escalation + punch; 2-3 characters
   - Standard tier: classic 3-act with midpoint reversal; 3-4 characters with protagonist/antagonist/supporting roles; every non-final chapter ends on a hook; monotonic stakes escalation
   - Long-form tier: 3-act + midpoint reversal (must be a REFRAME, not just a twist) + B-plot (secondary storyline with its own mini-arc intersecting main plot before climax) + setup-payoff pairs (2+ details planted early, paid off late) + no exposition dumps
   - **Staged long-form:** 4-6 characters (hard cap in scaffolding)
   - **Cinematic long-form:** unlimited characters (every speaking role gets portrait), unlimited scenes per chapter, unlimited lines per scene (grouped into clips of 3). Max 3 characters per scene (Kling constraint). Scaffolding specifies target clip count instead of fixed grid.
2. **Grader prompt** (`prompts/structure-review-prompt.txt`): Low-temperature (0.2) Claude call with a point-scored rubric. Returns JSON `{score, pass, issues[], strengths[], summary}`. ~$0.05-0.10 per review.
3. **Pass thresholds:** test ≥50, standard ≥60, long-form ≥70. Long-form has the highest bar because it has the highest credit cost per fail.
4. **Hard-block:** `orchestrator.approveScript()` rejects approval when `review.pass === false` unless explicit `{ override: true }`. UI surfaces three buttons: primary Approve (disabled), secondary Regenerate, tertiary Override (with confirmation dialog warning of credit risk).
5. **Regenerate loop:** capped at `MAX_SCRIPT_REGEN_ITERATIONS=3` (env-tunable). Each regen is a fresh `generateScript()` + fresh review. If the cap is hit, the last-generated script goes through (so pathological concepts can't loop forever).

**UI:** script approval view shows a review panel with colour-coded status (green pass, red block), score/threshold/tier, toggleable details (issues with severity + location + description, plus strengths). Override button is red-bordered and requires a confirm dialog.

**Files:** `src/main/pipeline/script-engine.js` (`reviewScriptStructure`, `_buildStructuralScaffolding`), `prompts/structure-review-prompt.txt`, `src/main/pipeline/orchestrator.js` (generate-review-approve loop around script stage), `src/renderer/index.html` (review panel + gated buttons).

## Cinematic Workflow Mode (Session 8 — All 6 phases shipped ✅)

**Status:** ✅ Cinematic workflow is end-to-end functional. Coexists with the staged pipeline; both ship. User picks per-project via the generator-mode selector on the launcher. See `IMPROVEMENT-CINEMATIC-WORKFLOW.md` for the full architecture + per-phase implementation notes.

**Phase 6 added on top of Phase 5:**
- Assembly stage forks based on `generatorMode`: cinematic reads `video_clip_cinematic` rows; staged reads `video_clip` (zero behavior change for staged).
- Clip ordering: orchestrator computes a `sortKey` per clip — `chapter * 1e6 + scene * 1e3 + (line || klingClipNum)` — and the assembler sorts by that key. Falls back to `chapter → scene → line` for backwards compat with callers that don't pass sortKey. Fixes a latent staged bug too: previously sort was chapter+line only, which collided when multiple scenes within a chapter both had line 1.
- Output filename gains a `cinematic_` prefix when mode is cinematic — e.g. `final_cinematic_16x9_4K.mp4` vs `final_16x9_4K.mp4` for staged. Makes side-by-side outputs from the same project distinguishable on disk.
- Generation view (the per-stage progress card) now shows a mode/aspect badge in the top-right corner. Mirrors the research-view badge — stays visible throughout portraits, scenes, videos, verify, and assembly.
- Completion view shows mode + aspect + duration as a rounded badge below the success message. Lets the user confirm at the end of a 30-min long-form run that they got cinematic output as intended.

**Cinematic backlog (priority-ordered):**
- 🟢 **RESOLVED (Session 9) — Element creation automation works.** Elements are detected and created correctly. The blocking issue was the **Elements panel → Generations view transition**: after element setup, the UI stayed on the Elements panel, and scene generation couldn't find the toolbar. Fixed by: (a) orchestrator clicks Generations tab after element setup, (b) `_ensureGenerationsView()` detects Elements panel via "Add to Project" button count, (c) `_setupToolbarSequence()` has stuck-guard that clicks Generations on any 5s hang.
- 🔴 **HIGH — Scene image generation end-to-end verification needed.** The toolbar setup sequence (Generations → Image → Cinematic Cameras → 1/4 → aspect → 2K → 1x1) is coded but needs live validation. Model selector guards against Elements panel misclicks. execCommand prompt typing proven to work.
- 🟡 Element name generation: `${char.id.replace(/^character_/, '')}_${titleInitials}` produces ugly identifiers like `@1_matmw` (from `character_1` + `Mass production - Nollywood`). Should derive from `character.description_label` (slugified) instead — would yield `@mama_blessing_matmw`.
- `kling-history-recovery.js` — parallel to existing Veo `higgsfield-history.js`. Scrapes Higgsfield Kling assets to reclaim orphans when a local download fails after server-side generation succeeded. Same scoring + tier infrastructure can be reused. Estimated 3-4 hours.
- Voice-tone binding automation in element creation flow — currently elements are created voice-less. User must manually bind Nigerian English voice tone in Higgsfield UI for best Kling lip-sync. Phase 2 fallback step the user opts into per-character.
- 🟢 **RESOLVED (Session 10) — Location-reference picker rewrite.** Previously used Strategy A (`setInputFiles` on hidden `input[type="file"]`) which caused double uploads, and tile detection searched RIGHT of the "Upload Images" box (found 0 tiles). Fixes: single `fileChooser` event path only, tile detection scans 80x80+ images in the full picker zone, location key normalization fix in orchestrator. See "Reference Image Attachment" section below for full details.
- Per-shot framing grader in cinematic Verify Clip — currently grades dialogue + cuts but not whether each shot's framing (WIDE/MEDIUM/CLOSE-UP) matched the multi_shot_prompt. Add only if visual drift becomes a recurring complaint.

**End-to-end cinematic pipeline (final):**

```
Research → Title → Script (cinematic schema with blocking + kling_clips)
  → Portraits (Nano Banana Pro, 1 per char — unlimited characters)
  → [Element Setup — Phases 2+3]
       → Char grids (~2 cr each) → Char elements (UI automation + fallback)
       → Empty location images (~2 cr each) → Location elements
       → Manual-checklist gate if any element creation fails
  → [Scene Images — Phase 3] Cinema Studio 2.0 with @location + @char + blocking (~2 cr/scene)
       1 image per scene (shared across all clips in that scene)
  → [Videos — Phase 4] Kling 3.0 multi-shot + native audio (~11 cr per 10-12s clip, exactly 3 shots)
       Multiple clips per scene (e.g. 9 lines = 3 clips, all sharing same scene image)
       Max 3 characters per scene (Kling quality constraint)
  → [Verify — Phase 5] Per-line scoring + speaker attribution + cut detection
  → [Assembly — Phase 6] Reads video_clip_cinematic, sorted by chapter→scene→clip-order
  → Final output: final_cinematic_16x9_4K.mp4
  → Publish (auto-closes when final video + thumbnail both exist on disk)
```

**Cinematic story-driven structure:** scenes per chapter, lines per scene, and character count are all unlimited (story-driven). The only fixed constraints are: exactly 3 shots per Kling clip, max 3 characters per scene, ≤9 words per dialogue sentence, and the total clip count derived from duration target ÷ 11 seconds. See "Duration Presets → Cinematic (Kling)" section above for full budget math.

**Files added/modified across all 6 phases:**

| File | Phase | Purpose |
|---|---|---|
| `migrations/009-generator-mode.sql` | 1 | `projects.generator_mode` column |
| `migrations/010-cinematic-elements.sql` | 2 | `higgsfield_element_id`, `element_name` columns + indexes |
| `migrations/011-cinematic-scenes.sql` | 3 | Indexes for cinematic asset lookups |
| `migrations/012-cinematic-video.sql` | 4 | `kling_clip_id`, `line_refs` columns + index |
| `prompts/script-prompt.txt` | 1 | `{{CINEMATIC_SCAFFOLDING}}` placeholder |
| `prompts/structure-review-prompt.txt` | 1 | `{{CINEMATIC_RUBRIC_EXTENSION}}` placeholder |
| `src/main/automation/higgsfield-elements.js` | 2, 3 | Element creation (chars + locations + props), 7-click UI path automation |
| `src/main/automation/cinema-studio-automation.js` | 3 | Cinema Studio 2.0 scene image generation with @-element resolution |
| `src/main/automation/kling-automation.js` | 4 | Kling 3.0 multi-shot video gen with start-frame + native audio + parsePromptSegments helper |
| `src/main/verify/clipVerifier.js` | 5 | `verifyCinematicClip()` + per-line greedy matching |
| `src/main/database/db.js` | 1-6 | Helpers: `setProjectGeneratorMode`, `setAssetElementName`, `_setKlingClipMeta`, `abandonProject`; mode-aware `getClipVerifications` |
| `src/main/pipeline/orchestrator.js` | 1-6 | Mode-state plumbing, `_runCinematicElementSetup`, `_runCinematicLocationSetup`, `_runCinematicSceneImageStage`, `_runCinematicVideoStage`, mode-fork in verify + assembly + redo loop |
| `src/main/pipeline/script-engine.js` | 1, 5 | `_buildCinematicScaffolding`, `CINEMATIC_RUBRIC_EXTENSION` constant, mode-aware structural review |
| `src/main/assembly/assembler.js` | 6 | Sort-by-sortKey support |
| `src/main/main.js`, `src/preload/preload.js` | 1, 2 | IPC for `approve-elements-ready`, `abandon-active-project` |
| `src/renderer/index.html` | 1, 2, 5, 6 | Mode dropdown, cinematic-elements panel, verify per-line dots, generation/completion mode badges |

**Phase 5 added on top of Phase 4:**
- Extended `ClipVerifier` (in `src/main/verify/clipVerifier.js`) with `verifyCinematicClip({clipPath, expectedLines, clipLabel})`. Different from `verifyClip()` because cinematic clips contain 2-4 dialogue lines + visible cuts in one file, so the grader needs per-line transcription + per-line speaker attribution + shot cut count.
- New `_analyzeCinematicWithGemini(clipPath, expectedLines)` and `_buildCinematicVerifyPrompt(expectedLines)` — Gemini receives the expected line count + speaker hints, returns a JSON schema with `spoken_lines[]` (each with `approximate_start_ms`, `speaker_visible`, `transcript`, `accent`), `shot_cuts_observed`, `accent_consistent`, plus the standard mouth-sync/artifacts/notes fields.
- Per-line matching done in JS via greedy assignment by Levenshtein similarity. Each expected line gets matched to its best detected line; consumed detected lines aren't re-matched. Result includes `linesVerified[]` with per-line `similarity`, `tier`, `speaker_match`, `accent_detected`, `accent_match` flags.
- Aggregate scoring: overall `similarity` = mean of per-line scores; overall `tier` = WORST per-line tier (any single failed line forces review). Speaker mismatch on any line bumps tier from accept → review minimum.
- **Accent drift detection (Session 27):** Per-line accent classification added to Gemini's cinematic verify prompt. Each `spoken_line` now includes an `accent` field (e.g. "Nigerian English", "American English"). Acceptable accents: "Nigerian English", "West African English", "neutral/unclear". Any other accent (American, British, etc.) on any line triggers auto-reject with `accent drift` artifact. Three-signal detection: (a) per-line `accent_match` flag, (b) Gemini's `accent_consistent` boolean, (c) `accent drift` in artifacts array. Any of the three triggers reject. Accent drift is treated as worse than lip sync failure — it breaks immersion entirely and is an auto-redo trigger.
- `verifyBatch()` dispatches automatically — items with `expectedLines` array → cinematic path, items with `expectedDialogue` string → staged path. Mixed batches work.
- `db.saveClipVerification` extended to fold cinematic per-line results into `verify_notes` via a tagged JSON suffix `[CINEMATIC_VERIFY]{...}[/CINEMATIC_VERIFY]`. No schema migration needed (Phase 5 keeps schema stable).
- `db.getClipVerifications` now returns BOTH `video_clip` and `video_clip_cinematic` rows; cinematic rows have a parsed `cinematic_verify` field with the per-line breakdown.
- Orchestrator's verify stage forks based on `generatorMode`: cinematic → builds items with `expectedLines` resolved from script via `line_refs`; staged → existing single-line `expectedDialogue` items.
- Post-verify "redo" loop uses mode-appropriate asset type (`video_clip_cinematic` vs `video_clip`).
- Renderer's verify table renders cinematic rows distinctly: shows `kling_clip_id` + line count + cut count as the row label, and renders per-line tier dots (colored boxes with line numbers + ⚠ for speaker mismatches) under the overall tier badge. Hover tooltip on each dot shows expected vs transcribed text + similarity score.

**Phase 5 known limitations:**
- Per-line speaker matching uses simple substring matching on the speaker_visible string Gemini returns. If Gemini describes the speaker by appearance rather than name (e.g. "woman in green dress" instead of "claire"), the match falls through and we accept-by-default unless the tier is otherwise low. This is generous on purpose — false speaker-mismatch flags would block more clips than they save.
- Tail-word forgiveness from staged Verify Clip is preserved per-line — gives the model a forgive-window for the last 10-15% of each line's dialogue.
- The Verify Clip "Redo" button on a cinematic clip currently re-runs the entire multi-shot clip even if only one line within it was problematic. Per-line redo would require splitting + recomposing which is not feasible with Kling's clip-as-atomic-unit model. Acceptable trade-off: rejecting one bad line costs ~17 credits to regenerate the whole clip.
- History recovery (Veo orphan reclamation) doesn't yet have a Kling counterpart. Captured as Phase 6 optional work: `kling-history-recovery.js` mirroring the existing pattern.

**Phases 3+4 added on top of Phase 2:**

**Phase 3 (Migration 011, asset types: `location_image`, `scene_image_cinematic`):**
- Extended `HiggsfieldElements` with `createLocationElement()` + `createPropElement()` (refactored common path into `_createElement({category})` helper)
- New automation module: `src/main/automation/cinema-studio-automation.js` — `CinemaStudioAutomation` class with `_ensureCinemaStudioActive`, `_setupToolbarSequence` (master 7-step setup: Generations→Image→CinematicCameras→1/4→aspect→2K→1x1), `_clickGenerationsReset` (stuck recovery), `_runStepWithStuckGuard` (5s timeout per step), `_ensureImageMode` (aria-selected on leftmost dual tabs), `_ensureCinematicCamerasModel` (model dropdown with Elements-panel guard), `_setImageCount`, `_setResolution2K`, `_setGrid1x1`, `_attachLocationReference`, `_setAspectRatio`, `_typeBlockingPrompt` (execCommand for Lexical + keyboard.type for @mentions), `_ensureGenerationsView` (Elements panel detection + Generations click), `generateSceneImage`, `_waitAndDownload` (polls images.higgs.ai gallery), `_readToolbarState` (mode/model/aspect/cost from aria-selected + button text)
- Orchestrator: new `_runCinematicLocationSetup()` (extracts unique `location_element_hint` values from script, generates empty location images, creates location elements) + `_runCinematicSceneImageStage()` (per scene: resolves @location + @character refs, builds blocking, generates via Cinema Studio 2.0)
- Element-setup stage now runs both character + location element creation in sequence
- Stage 3B forks based on `generatorMode`: cinematic → `_runCinematicSceneImageStage`, staged → existing Nano Banana per-line generation (unchanged)

**Phase 4 (Migration 012, asset type: `video_clip_cinematic`):**
- New module: `src/main/automation/kling-automation.js` — `KlingAutomation` class with `_ensureKling30Active`, `_attachStartFrame` (Image Generations picker, optional sourceGenId match), `_enableMultiShotAuto`, `_setDuration`, `_typeMultiShotPrompt` (uses shared `parsePromptSegments()` for @-element parsing), `_generateAndDownload` (polls cloudfront video src, fetches via page-context fetch, writes to disk)
- Orchestrator: new `_runCinematicVideoStage()` — walks `scene.kling_clips`, finds matching `scene_image_cinematic` per scene, generates one Kling clip per kling_clips entry. Resume-aware via `kling_clip_id` column. Each clip = 10-12s with multi-shot Auto + native audio + Nigerian English lip-sync.
- New DB columns on `project_assets`: `kling_clip_id` (stable identifier from script) + `line_refs` (JSON array of dialogue lines covered) + `idx_assets_kling_clip_id` index for resume lookups
- New helpers: `db._setKlingClipMeta(assetId, klingClipId, lineRefsJson)` for setting clip metadata
- Stage 4 forks based on `generatorMode`: cinematic → `_runCinematicVideoStage` (Kling 3.0), staged → existing Veo 3.1 Lite generation (unchanged)
- Architectural shift: in cinematic mode, **the unit of video generation changes from "1 dialogue line = 1 Veo 8s clip" to "1 kling_clips entry = 1 Kling 10-12s multi-shot clip containing 2-4 lines + cuts"**. Total clip count drops ~3x for the same runtime; per-clip credit cost rises ~2x; net per-minute cost roughly equivalent (~17% more for cinematic) but quality ceiling far higher.

**End-to-end cinematic pipeline (after Phases 1-4):**

```
Research → Title → Script (with cinematic fields)
  → Portraits (Nano Banana, 1 per char)
  → [Element Setup — Phases 2+3]
       → Char grids (~2 cr each) → Char elements → Location images (~2 cr each) → Location elements
       → SUCCESS or FAILURE → manual checklist + pause
  → [Scene Images — Phase 3] Cinema Studio 2.0 (~4 cr each)
  → [Videos — Phase 4] Kling 3.0 multi-shot (~17 cr per 10s clip)
  → Verify (Phase 5 pending — Verify Clip still grades line-by-line)
  → Assembly (Phase 6 pending — needs to read video_clip_cinematic when mode=cinematic)
  → Publish
```

**Known gaps remaining (Phase 5+6 work):**
- Verify Clip grades each line individually but cinematic clips cover multiple lines per file. Phase 5 needs to extend `verifyClip()` to grade by `line_refs` array.
- Assembly currently reads `video_clip` only. For cinematic mode it needs to read `video_clip_cinematic`. Trivial fork in `assembler.js`.
- History recovery (Session 8 inline auto-recovery) only handles staged Veo clips. Cinematic clips need a parallel recovery path that scrapes Kling generations from Higgsfield assets — Phase 5 candidate.
- No mode-aware UX in the assembly view yet (badges / final filename). Phase 6 polish.

**What Phase 2 added (on top of Phase 1):**
- Migration 010: `project_assets.higgsfield_element_id TEXT` + `project_assets.element_name TEXT` + two indexes. Schema ready to track which Higgsfield element each asset maps to.
- New asset type: `character_grid` — 4-column reference sheet (front / left profile / right profile / back view, each with full-body + close-up) generated via Nano Banana Pro using the character's portrait as the reference image. Grid prompt from IMPROVEMENT-CINEMATIC-WORKFLOW.md's character-grid section.
- New automation module: `src/main/automation/higgsfield-elements.js`. Class `HiggsfieldElements` with methods: `_openElementsPanel`, `listExistingElements`, `elementExists(name)`, `createCharacterElement({name, portraitPath, gridPath, description})`, static `buildManualChecklist(pending)`. Navigates the 7-click UI path Higgsfield → Cinema Studio → 2.5 toggle → Image tab → Cinema 2.0 → @ button → + Create new → form. Idempotent — checks existing elements by name before creating. Graceful fallback: per-element failures are collected, catastrophic failures surface the manual checklist via orchestrator event.
- New orchestrator stage: `_runCinematicElementSetup(projectId, projectDir)`. Gated behind `generatorMode === 'cinematic'` — staged mode is a no-op passthrough. Runs between `portraits-done` and scene generation (Stage 3A.5). Generates grids for every character, then creates character elements. On automation failure, emits `cinematic-manual-element-checklist` event and pauses at new `elements-ready` approval gate until user confirms elements are ready.
- Element naming convention: `@{char-id-suffix}_{title-initials}` (e.g. `@claire_thp` for Claire in "The Heir's Probation"). `_titleInitials()` helper derives initials from the project title.
- New IPC: `approve-elements-ready` routes to `orchestrator.approveElementsReady()`.
- New renderer view: `#view-cinematic-elements` with pending-elements list + manual-creation steps (collapsible) + "Elements Ready — Continue" button. Shown when `event.gate === 'elements-ready'` OR `cinematic-manual-element-checklist` event received.

**Phase 2 known limitations (honest):**
- The 7-click UI path automation is best-effort. Selectors may need refinement against a fresh Higgsfield UI pass (Session 8 DevTools inspection covered the path conceptually but specific role/aria attributes weren't all captured). The fallback is MANDATORY, not optional — treat automation as a convenience that reduces clicks, not a guarantee.
- Voice tone binding is NOT automated. Character elements are created voice-less. For the best Kling lip-sync output, the user should manually bind a Nigerian English voice tone to each element via Higgsfield's UI after creation. Phase 2 doesn't block on this — voice tone can be bound before or during Phase 4 (Kling video generation).
- Location elements + prop elements are NOT in Phase 2. Locations are Phase 3 (paired with location image generation). Props emerge from `scene.props_in_scene` during Phase 3 or later.
- Native file picker for uploading portrait + grid images to the element form — this is the one OS-level dialog we CAN'T automate through Playwright, so the automation uses Playwright's `page.waitForEvent('filechooser')` + `fileChooser.setFiles()` pattern. If that interception fails (ad popup covers the click, filechooser doesn't fire in time), the automation fails and we fall back to manual.

**Phase 2 test plan (costs some credits):**
1. Resume or create a cinematic-mode project through title approval + script generation
2. Proceed through portrait generation normally (standard Nano Banana portraits, 1 per character)
3. After portrait approval, the pipeline should automatically run the new `elements-setup` stage:
   - Progress events for `elements-grids` (one per character, ~2 credits each via Nano Banana)
   - Progress events for `elements-create` (one per character, free — just UI automation)
4. Either: stage finishes cleanly and advances to scene image generation, OR pipeline pauses at the cinematic-elements panel with the manual checklist
5. If panel appears, create the listed elements manually in Higgsfield UI, then click "Elements Ready — Continue"

**What Phase 1 shipped:**
- Migration 009: `projects.generator_mode TEXT NOT NULL DEFAULT 'staged'` with validation enforced in `setProjectGeneratorMode()` (same lock-on-start semantics as aspect_ratio — throws if any project_assets rows exist)
- Renderer: third dropdown alongside Duration + Aspect on both pool and fresh-start cards. Values: `staged` (default, proven) vs `cinematic` (opt-in, WIP). Research view badge shows mode. Resume card shows mode badge.
- Script prompt: new `{{CINEMATIC_SCAFFOLDING}}` placeholder. When `generator_mode = 'cinematic'`, Claude receives detailed authoring requirements for `scene.blocking` (frame-left/center/right with character references), `scene.location_element_hint` (snake_case location key), `scene.props_in_scene` (Chekhov's-gun array), and `scene.kling_clips` (multi-shot prompt array using Kling's bracketed dialogue syntax). Staged mode gets an empty string — no change to existing behavior.
- Structural review rubric: `CINEMATIC_RUBRIC_EXTENSION` injected when mode is cinematic. Adds 4 scoring dimensions (blocking completeness, kling clip coherence, element-hint discipline, props-as-elements) plus cinematic-specific critical failure modes. Cinematic mode thresholds bumped +5 across all tiers (test=55, standard=65, long-form=75).
- Orchestrator: reads `options.generatorMode`, persists to DB, carries on `this.state.generatorMode`, passes through `storyBrief.generatorMode` to script engine. Resume path restores from DB.
- Test: migration 009 verified against fresh DB; cinematic scaffolding substitution verified via integration test.

**What Phase 1 deliberately does NOT do (deferred to Phases 2-6):**
- No element-creation automation (UI path is 7-8 clicks deep; Phase 2)
- No location generation stage (Phase 3)
- No Cinema Studio 2.0 scene image automation (Phase 3)
- No Kling 3.0 video generation automation (Phase 4)
- No Verify Clip adaptation to grade shot groups instead of lines (Phase 5)

Cinematic mode projects created today will generate cinematic-format script JSON with blocking + kling_clips fields, BUT downstream stages still route through the staged pipeline. You can test the mode toggle + script output without burning any video generation credits. Pick a project, set mode=cinematic, run through title approval + script generation + structural review, inspect `script.json` for the new fields, then abandon the project before video generation.

**Phase 1 test plan:**
1. Launch app → new project → set Duration=1min, Aspect=16:9, Generator mode=cinematic, click Proceed to Research
2. Run through research + title selection + script generation
3. Open `projects/<project-id>/script.json` — scenes should have `blocking`, `location_element_hint`, `props_in_scene`, and `kling_clips` fields populated
4. Structural review panel should show cinematic-specific rubric in issues (blocking completeness, kling clip coherence, etc.) and apply threshold 55 instead of 50
5. Abandon the project (don't proceed to portraits) — Phase 2+ infrastructure doesn't exist yet

## Cinematic Workflow Mode — Architecture (designed, full build TBD)

**The TL;DR:** There's a parallel production pipeline being designed that coexists with the current "staged" workflow. Same shared research + script stages, but **diverges at asset generation** — uses Cinema Studio 2.0 for blocked scene images + Kling 3.0 for multi-shot cinematic video with native lip-synced Nigerian English audio. Project-level `generator_mode = 'staged' | 'cinematic'` flag selects which pipeline runs. Staged stays the default; cinematic is opt-in for prestige long-form.

**Why it exists:** Current staged output feels "stagey" because of the Conversation Lock rule in `script-prompt.txt` — every clip is a wide-group shot with one character's mouth moving. The fix isn't prompt-tuning (Veo generates single-shot 8s clips, no cuts within a generation). The fix is switching to Kling 3.0 which plans multi-shot coverage inside one generation, producing real cinematic rhythm with character consistency across cuts.

**Key architectural pieces:**
- **Higgsfield Elements panel** is load-bearing for Characters and Props (`@claire`, `@flashlight`) with voice tones baked into character elements. **Locations are NOT elements** — they're plain reference images attached via the `+` button → "Image Generations" tab when Cinema Studio 2.0 generates a scene image. Earlier Phase 3 design tried creating Location elements; removed mid-build after user confirmed locations are reference images, never @-referenced in prompts.
- **Pre-production:** portraits + character grids (4-angle reference sheets) → character elements with voice tones.
- **Production (images):** Nano Banana empty locations → Cinema Studio 2.0 scene images using `@element` refs + explicit blocking (frame-left/center/right).
- **Cinematography (video):** Kling 3.0 multi-shot (up to 6 shots per 10-12s clip) with dialogue in Kling's bracketed syntax: `[@claire, speaking in a strained Nigerian English accent]: "..."`.
- **Credit math:** ~15-17% more per runtime than staged, but delivers multi-shot + native audio + music in one credit — capabilities staged can't produce at any cost.

**What's shared with staged:** research stage, script generation + structural review, title approval, project DB, history recovery, Verify Clip (with adapted scope — grades shot groups not individual lines), assembly, publish.

**What's new:** element creation automation (7-8 click deep UI path), location generation stage, Cinema Studio 2.0 automation surface, Kling 3.0 automation surface, `blocking` + `kling_clips` fields in script schema, generator_mode flag + migration 009.

**Phase 0 validation (Session 8):** end-to-end test run confirmed Nano Banana → Cinema Studio 2.0 (with `@claire` + `@richard` element refs + 16:9 cinematic + kitchen location) → Kling 3.0 (multi-shot Auto mode, 15s, 720p, start frame from Cinema Studio, Nigerian English dialogue per character). Cost: ~32 credits. User has production-tested Kling 3.0 since January 2026; Nigerian accent renders correctly, character consistency holds across cuts, lip-sync switches per character.

**Automation gotchas captured:**
- Cinema Studio defaults to 3.0; must click 2.5 toggle top-right every session (doesn't persist)
- "Cinema 2.5" (page) vs "Cinema 2.0" (model dropdown at bottom of prompt area) — two different controls
- Native file picker is unautomatable; route uploads through "Image Generations" tab
- `@` autocomplete gotcha: type `@xxx` (2-3 letters), wait for popup, Enter. Typing full name can scroll past match.
- Multi-shot: toggle ON + Auto mode is the right default (Custom is rigid)
- Generation timings: Cinema Studio 2.0 4K = 60-90s, Kling 3.0 15s multi-shot = 2-4 min

Implementation is gated behind explicit green-light. Estimated 20-25 hours across 6 phases. See doc for the full plan, risks, anti-patterns, and pre-flight checklist.

## Aspect Ratio (Session 8)

Each project has a single `aspect_ratio` column (migration 007), chosen at Start Research time and **locked once generation begins** (setter throws if any project_assets rows exist). MVP supports `16:9` (YouTube long-form, default) and `9:16` (Shorts / TikTok / Reels). Portraits are always 1:1 regardless of project aspect.

**How it threads through the pipeline:**

- **UI:** Aspect dropdown sits next to the Duration dropdown on both pool + fresh-start cards. Resume card shows a badge (e.g. "18/18 assets complete · 9:16 (vertical)")
- **Automation (image):** `generateImage({..., aspectRatio})` — the Nano Banana Pro page has a native `<select>` (12 options, wrapped in a custom dark popup). `selectOption()` is the whole story; no popup-click dance.
- **Automation (video):** `generateVideo({..., aspectRatio})` — Veo 3.1 Lite page ALSO has a native `<select>` behind its chip UI (confirmed via DevTools). Replaces the older fragile `setVideoDropdownOption('Ratio', ...)` button path; that helper remains only as a fallback.
- **Dedup:** `findExistingGeneration(prompt, type, aspectRatio)` now JOINs `projects.aspect_ratio` — a 16:9 scene cannot reuse a 9:16 scene with the same prompt, even across projects.
- **Script prompt:** `{{ASPECT_FRAMING_GUIDANCE}}` injects a vertical-framing clause for 9:16 projects (single-character framing, avoid wide establishing shots, medium-close bias). 16:9 gets a passthrough (no restrictions).
- **Assembly:** Final upscale dims derive from aspect — `3840×2160` (16:9) or `2160×3840` (9:16). Output filename reflects the aspect (`final_16x9_4K.mp4` or `final_9x16_4K.mp4`). Branding card is skipped for 9:16 projects because the existing card is 16:9 — portrait card variant is post-MVP.
- **Veo support set:** Native select exposes 7 ratios (auto, 16:9, 9:16, 4:3, 3:4, 1:1, 21:9) but the visible popup only shows 3. Pipeline ships with 16:9 + 9:16 only; the others are a future image-only expansion.

**DB:** `projects.aspect_ratio TEXT NOT NULL DEFAULT '16:9'`. `setProjectAspectRatio(projectId, aspectRatio)` enforces the lock — throws if any asset rows exist for the project.

## Veo Lip-Sync Fix

Veo 3.1 tends to mis-assign lip-sync in multi-character scenes. The fix in `buildVideoPrompt()`:
- Explicitly names the speaking character for lip-sync
- Adds "IMPORTANT: [non-speaker] — mouth CLOSED, absolutely no lip movement" for each non-speaking character in the scene
- `findLineAndScene()` helper resolves chapter/line numbers to the full line + scene context

## Assembly Pipeline

Assembler (`src/main/assembly/assembler.js`):

1. Sort clips by chapter + line number
2. Trim 0.3s dead frames from each clip start
3. Interleave branding card clips: intro → every 13 clips (~1.5 min) → outro
4. Concat all segments via FFmpeg concat demuxer
5. Upscale to 4K (lanczos)

- **Branding card**: `config/branding.fw.png` — Fayehun Ayo channel card, 16:9 transparent PNG
- **No baked-in subtitles** — YouTube/Facebook auto-generate captions from Veo audio
- Graceful fallback if branding PNG is missing

## Copyright Protection (4 Layers)

The pipeline researches existing YouTube content, so copyright protection is critical. Four layers prevent derivative output:

### Layer 1 — Prompt Guardrails
- `prompts/research-brief-prompt.txt`: ORIGINALITY REQUIREMENTS section
- `prompts/script-prompt.txt`: ORIGINALITY GUARDRAILS section
- Both prohibit copying/paraphrasing source content

### Layer 2 — Title Similarity Scoring
- `findSimilarSourceTitle()` in script-engine.js
- Word-overlap algorithm with stop-word filtering
- >40% overlap flags the title with `tooSimilar: true`

### Layer 3 — Source Title Injection
- Orchestrator injects `sourceVideoTitles` into researchData
- Shown to Claude as "EXISTING TITLES IN THIS SPACE (DO NOT COPY OR PARAPHRASE)"

### Layer 4 — Research Context Sanitization
- `buildScriptResearchContext()`: Individual video story structures (setup/conflict/climax) are NOT passed to Claude — removed entirely
- All pattern entries run through `sanitizePatternEntry()` which strips plot-summary-like text
- `looksLikePlotSummary()` detects narrative indicators (action verbs, "A/The [person] [verb]" patterns)
- Short abstract entries (≤60 chars, no narrative indicators) pass through unchanged
- Long/narrative entries get truncated to first clause boundary or first 4 significant words
- Both `buildResearchSummary()` and `buildScriptResearchContext()` are sanitized

**Important**: Raw research data in the electron-store cache is NOT sanitized — it retains full Gemini analysis for UI display and debugging. Sanitization happens at the point of injection to Claude's API only.

## Higgsfield UI Automation Notes

Selectors are in `config/higgsfield-selectors.json` (last verified: 2026-04-12).

Key differences between image and video pages:
- **Image page**: prompt is a `contenteditable div`, settings are native `<select>` elements, Unlimited toggle is `button[role="switch"]`
- **Video page**: prompt is a `textbox div`, settings are **button dropdowns** (not `<select>`), NO Unlimited mode (always costs credits)

### Cinema Studio 3.5 — Critical Automation Findings (Session 9, April 2026)

**Prompt Textbox — Lexical Editor:**
- The Cinema Studio prompt is a **Lexical editor** (`div[role="textbox"][contenteditable="true"]`), NOT a standard input or textarea.
- `keyboard.type()` does NOT work — Lexical ignores standard keyboard events from Playwright.
- `document.execCommand('insertText', false, text)` is the **ONLY** reliable way to insert plain text. It creates proper Lexical nodes: `<p class="text-sm" dir="auto"><span data-lexical-text="true">text</span></p>`.
- For `@mentions`, use `keyboard.type()` (real keystrokes needed to trigger the autocomplete dropdown), then `Enter` to select.
- **Clear textbox (April 2026 update):** Use `Ctrl+A → Backspace` (goes through browser input pipeline that Lexical listens to). This is MORE reliable than the old `Range.selectNodeContents() + execCommand('delete')` approach which failed to clear @mention nodes. Strategy: 3-attempt loop — `Ctrl+A → Backspace`, then `execCommand('delete')` fallback, then verify empty via `textContent`. If still not empty, nuclear: click away → Escape → re-focus → `Ctrl+A → Delete → Backspace`.
- **NEVER walk React fibers** (`__reactFiber$` keys) on this page — causes cascading cross-origin `SecurityError` that crashes the page with "Oops - Something went wrong". Page cannot recover via Retry button; requires full URL reload.
- After `execCommand('insertText')`, the text may not appear in `innerHTML` immediately — Lexical takes a moment to process. Wait ~500ms then verify via `textContent`.

**Image/Video Mode Tabs — THREE "Image" Locations in DOM (CRITICAL):**
- **Location 1 — Top Navigation Bar:** "Explore, **Image**, Video, Audio, Chat, Character, Marketing Studio, Cinema Studio 3.5..." at y < 100px. This is the SITE-WIDE nav. Clicking it navigates AWAY from Cinema Studio. **NEVER click this.**
- **Location 2 — Bottom Mode Toggle:** Image/Video toggle buttons stacked vertically near the prompt area. Position verified: Image at (471, 715), Video at (471, 773) in 1920×847 viewport. **ALWAYS target this.**
- **Location 3 — Duplicate tabs:** The mode toggle renders as TWO duplicate sets at slightly different x positions (e.g. x:471 and x:480). The **controlling set** is the leftmost. Clicking the wrong set changes `aria-selected` but does NOT switch modes.
- **Position filter rule:** When searching for Image/Video mode toggle, MUST constrain to `y > vh * 0.55` (bottom half of screen). NO x constraint — the buttons are at x ≈ 470-480, not far-left. The top nav "Image" is at y ~22px.
- **CRITICAL: Plain `.click()` does NOT work** on these React tab buttons. Must dispatch the full pointer event sequence: `pointerdown → mousedown → pointerup → mouseup → click` with proper `clientX`/`clientY` coordinates and `bubbles: true`.

**DOM Text Casing and Variants (verified live April 2026):**
- Resolution shows as **`"2k"` (lowercase k)**, not "2K". All comparisons must be case-insensitive: `/^2k$/i`.
- Video duration can be **`"15s"`** (not just "8s"). Both must be detected.
- Video resolution can be **`"720p"`** (not just "1080p"). Both must be detected.
- Video model can be **`"Kling 3.0"`** (not just "Cinema Studio 3.5"). Both must be detected.
- Image model defaults to **`"Soul Cinema"`** (not "Cinematic Cameras" or "Nano Banana Pro"). Must be in image indicator list.
- GENERATE button text can be `"GENERATE0.125"` or `"Generate26.25"` (no space/symbol between text and cost). Regex `/([\d,.]+)\s*$/` handles all variants.

**Elements Panel — CRITICAL Stuck State:**
- After element creation/checking, the UI stays on the Elements panel (shows "Project elements", "Personal elements", "Add to Project" buttons, "Delete"/"Save" buttons, "Advanced settings", "Create Element").
- The Elements panel does NOT have Image/Video tabs, GENERATE button, or prompt textbox. All toolbar detection fails.
- **The ONLY way out is clicking the "Generations" tab** (top of page, next to "Elements" tab). Going home does NOT dismiss it — the panel persists across navigation.
- Detection signals: `"Add to Project"` button count ≥ 2, `"Delete"` + `"Save"` buttons present, `"Advanced settings"` text, `"Project elements"` heading, NO GENERATE button.

**Model Selector:**
- The model button is in the bottom toolbar (y > 65% of viewport). Shows the model name text: "Cinematic Cameras", "Cinema Studio 3.5", "Nano Banana Pro", etc.
- **DUAL TOOLBAR BUG (CRITICAL):** The bottom toolbar renders TWO duplicate sets at slightly different x positions (e.g. x:373 vs x:378). Each set has its own model button showing DIFFERENT model names. The controlling set is the LEFTMOST (minimum x). The duplicate set at higher x shows stale/wrong model (e.g. "Nano Banana Pro" when the controlling set shows "Cinematic Cameras"). **ALL model reads and clicks MUST filter to the leftmost set** — collect all model-name buttons, find minX, only use buttons within 10px of minX. Reading from the wrong set causes infinite switch loops.
- **Dropdown dismissal on reset:** When a stuck guard fires during model selection, the dropdown stays open and contaminates subsequent toolbar scans. `_clickGenerationsReset()` now presses Escape twice before resetting to dismiss any open dropdowns/popovers.
- Model dropdown (verified live): Cinematic section (Cinematic Characters, Cinematic Locations, Soul Cinema, Cinematic Cameras), All models section (Auto, Higgsfield Soul, Google, ByteDance, Grok, Z-Image).
- **GUARD against Elements panel**: When on Elements panel, element rows (e.g. "mama_agbadoA 48-year-old Nigerian...") are wide buttons (526px) in the same y zone. The model selector must check for "Add to Project" buttons and skip fallback matching if detected.
- "Style:Auto" and "Camera:Auto" are style/camera pickers, NOT model selectors. Do not match "Auto" as a model name — it's too ambiguous.
- Default model for new projects: "Nano Banana Pro" (not Cinematic Cameras). Must explicitly switch.
- **If controlling set already shows "Cinematic Cameras", do NOT click it** — clicking an already-selected model opens an "All models" dropdown where "Cinematic Cameras" is not listed, creating a stuck loop.

**Toolbar Setup Sequence (the correct order):**
1. Click **Generations** tab (exit Elements panel)
2. Click **Image** tab (not Video)
3. Select **Cinematic Cameras** model
4. Set **1/4** image count (decrement button)
5. Set **aspect ratio** (16:9 or 9:16)
6. Set **2K** resolution
7. Set **1x1** grid
8. Attach **reference image** (+ button → Uploads tab → fileChooser upload → click tile → verify thumbnail)
8b. **Verify elements via @ button** — The @ element check types `@` into the prompt to verify character elements exist in the Higgsfield project. This MUST ONLY run when mode = Image AND model = Cinematic Cameras. **Root cause of past failures (April 2026):** After a page nuke (`resetFormForNextGeneration()`), the page lands on the base Cinema Studio URL which defaults to Video mode. The toolbar takes seconds to render. The old toolbar setup had a `no-video-guns-fallback` that returned success when it found NO indicators at all (neither video nor image) — treating an empty/loading toolbar as "probably Image mode". This let the pipeline proceed, and by the time the @ check ran, the toolbar had loaded into Video mode. **Fix:** (1) `_setupToolbarSequence()` now has a PRE-STEP that waits up to 15s for the toolbar to render at least one concrete indicator (video OR image) before starting any steps. (2) The Step 2 (Image mode) verification no longer falls back to `ok: true` on ambiguous/empty states — if it can't positively confirm Image mode, it returns failure and triggers a restart. (3) Phase 1b in `generateSceneImage()` runs a final DOM smoke check — if video indicators are STILL present after setup "passed", it throws `SAFETY STOP` instead of silently skipping. The @ button is the RIGHTMOST small no-text SVG button in the toolbar (after 1x1 grid). Click → read dropdown → confirm characters exist → Escape to dismiss. Must happen AFTER toolbar setup, BEFORE reference attachment. **If the @ check runs in the wrong mode, it injects `@@@@` into the textbox which contaminates the prompt and can trigger a 96-credit video generation.**
8c. **@ button cleanup (CRITICAL — April 2026):** Clicking the @ button inserts an `@` character (and potentially partial mention state) into the Lexical textbox. After dismissing the dropdown with Escape, `_verifyElementsViaAtButton()` runs a 3-attempt cleanup loop: `Ctrl+A → Backspace` + `execCommand('delete')` fallback, verifying the textbox is empty after each attempt. If 3 attempts fail, a nuclear fallback clicks away from textbox → Escape → re-focus → `Ctrl+A → Delete → Backspace`. This ensures no residual `@` text contaminates the prompt in Phase 3. Without this cleanup, the subsequent `_typeBlockingPrompt()` clear may fail to remove Lexical mention nodes, producing malformed generations with `@@` prefixes.
9. Attach **reference image** (+ button → Uploads tab → local file → click tile → wait for thumbnail)
10. Paste prompt (execCommand) with @mentions for characters
11. Reconfirm all settings
12. Click GENERATE

**Reference Image Attachment (+ button → Upload) — REWRITTEN Session 10, April 2026:**
- The `+` button (reference picker) is a ≤40px button with SVG icon, near the textbox in the prompt area.
- **Upload strategy (single path — fileChooser only):** Click `+` → click "Uploads" tab → click "Upload Images" button/zone → intercept `fileChooser` event via `page.waitForEvent('filechooser')` → `fileChooser.setFiles(locationImagePath)` → click uploaded tile → confirm thumbnail. **Strategy A (`setInputFiles()` on hidden `input[type="file"]`) was REMOVED** — it caused double uploads because two hidden `input[type="file"]` elements exist when picker is open (both `display:none`, `accept="image/*"`), and setting files on one triggered a React handler that uploaded through a different path than the picker, resulting in two sequential uploads.
- **Upload button label matching:** Use `getByText()` with `exact: true` and specific labels: `['Upload Images', '+ Upload Images', 'Upload Image']`. **NEVER use `exact: false`** — it matches the "Uploads" tab instead of the upload zone. Fallback: `page.evaluate()` that walks buttons/divs/labels, explicitly skipping elements whose text is exactly "Uploads" or "Upload" (single word).
- **DO NOT use "Image Generations" tab** — it shows random character images, not locations. Always upload the specific local location file.
- **Picker layout (CRITICAL — verified via Chrome DOM, April 2026):** The "Upload Images" zone is a **892×298 container div** that holds BOTH the drag-drop upload area AND the tile grid INSIDE/BELOW it — tiles are NOT to its right. Tiles are 100×100px, laid out in rows within the picker at y≈461–785. The picker area spans from the tab buttons (y≈387) down to the toolbar overlay (y≈898). **Old code searched for tiles to the RIGHT of the Upload Images box (x > 1443) — this found ZERO tiles every time.** New code scans the full picker zone.
- **Tile detection (complete rewrite):** Pre-upload: snapshot all 80×80+ image srcs in the picker zone (y between tab buttons and toolbar, x > 500 to exclude sidebar project icons). Post-upload: scan again for 80×80+ images in the same zone, find any tile whose `src` is NOT in the pre-upload set (= newly uploaded). If no new tile found, fall back to first tile in zone. **Chrome DOM test confirmed: old logic found 0 tiles, new logic found 22.**
- **Picker zone boundaries (dynamic):** Top = minimum y of "Uploads" / "Image Generations" tab buttons. Bottom = y of `div[data-tour-anchor="tour-cinema-form"]` overlay (fixed at y≈898). x > 500 filter excludes sidebar project icon images.
- **Overlay and tile clicks:** The toolbar overlay (`div[data-tour-anchor="tour-cinema-form"]`, `position: fixed`, `pointer-events: auto`) is at y≈898. All tiles are at y≈461–785, which is **ABOVE the overlay** — overlay does NOT cover tiles. Clicks use `page.mouse.click(x, y)` (not synthetic `dispatchEvent`). As a safety measure, overlay `pointer-events` is set to `'none'` before clicking and restored after. Double-click pattern: click → 500ms wait → click again → 500ms wait (for React state to process).
- **Confirm button after tile click:** If picker doesn't auto-close after tile click, scan for buttons with labels `['Add', 'Done', 'Confirm', 'Select', 'Apply']` and click the first visible one.
- **Tile selection flow:** Click tile → Higgsfield marks it (green checkmark + yellow border) → picker may auto-close OR stay open (e.g. "This image is already added" toast). After clicking, poll for picker closure (up to 8s). If picker doesn't auto-close: try confirm button first, then click the **X close button** (top-right of picker), then Escape fallback. After picker closes, poll for thumbnail to appear in `+` button area (up to 15s).
- After clicking the uploaded tile, the `+` icon transforms into an **image thumbnail**. This confirms the reference is attached.
- **HARD STOP (dual gate):** (1) `_attachLocationReference()` throws if thumbnail doesn't appear within 15s. (2) Gate 4 in `generateSceneImage()` re-checks the `+` button for thumbnail RIGHT BEFORE typing the prompt. No reference = no generation, no exceptions.
- **Reference confirmation (CRITICAL):** Do NOT count generic `<img>` elements near the prompt — @mention avatars (tiny inline images from character references) create false positives. The ONLY reliable signals are: (a) the `+` button contains an `<img>` child element (thumbnail), or (b) an `<img>` element exists LEFT of the textbox with dimensions 25-80px (thumbnail size, not avatar size ~20px).
- **Dual toolbar tolerance (revised April 2026):** The two toolbar sets differ by **Y position** (~4px: y=686 vs y=690), not x. Within each set, buttons span a wide x range (model at x=373, aspect at x=592, resolution at x=653). Using x-proximity to the model button filtered OUT aspect/resolution/grid — caused `aspect=null, res=null` on every read, failing the hard gate 3 times in a row. **Correct approach:** find the leftmost model button → get its y → all toolbar buttons within ±3px of that y belong to the controlling set. The ±3px tolerance separates sets that are 4px apart.
- `locationImagePath` is the absolute local path to the location PNG (e.g. `assets/locations/mama_agbado_corn_stall.png`).

**Location Key Normalization (Session 10 fix):**
- `_runCinematicLocationSetup` stores location keys cleaned with `toLowerCase().replace(/[^a-z0-9_]/g, '_')` in `this.state.cinematicLocations`.
- `_runCinematicSceneImageStage` was looking up with raw `scene.location_element_hint` — mismatch caused wrong location image (e.g. scene 1 got `chief_reception_hall` instead of `village_compound_entrance`).
- **Fix:** Apply same cleaning at lookup time: `const locHintClean = (scene.location_element_hint || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');` then try `_locMap[locHintClean] || _locMap[scene.location_element_hint]`.
- Diagnostic logging added: full location map dump + per-scene hint values logged before scene loop starts.

**Stale Asset Cleanup (April 2026 — CRITICAL):** The scene loop inserts `scene_image_cinematic` DB rows as it processes scenes. On pipeline restarts (or if the script changes between runs), stale rows accumulate — scenes that no longer exist in the current script still have pending assets in the DB. `verifyStageComplete()` sees these as incomplete and blocks the pipeline with "43 assets not done" even though all current scenes generated successfully. Fix: at the start of `_runCinematicSceneImageStage()`, build a `validKeys` set from the current script's scenes, delete any `scene_image_cinematic` assets whose `chapter_scene` key isn't in that set, and dedup any remaining duplicates (keeping the best status: done > generating > pending). Also: `insertExpectedAssets` inside the scene loop is now guarded by a dedup check — only inserts if no row exists for that chapter+scene. The `deleteAsset(id)` function was added to `db.js` for this purpose.

**Vision-Based Blocking Refinement (April 2026):**
- **Problem:** Script-generated blocking uses generic `frame_left/frame_center/frame_right` positions — the script never sees the location image, so it can't reference spatial anchors (the grill, the counter, the signpost). Result: 2+ character scenes look like police lineups instead of cinematic compositions.
- **Solution:** Before building the Higgsfield prompt, send the location image + scene context to Claude API (vision) and ask it to propose spatially-grounded blocking. The refined blocking references actual objects in the image ("behind the grill, arms folded," "leaning on the counter frame-right") instead of abstract frame positions.
- **Method:** `_refineBlockingWithVision(locationImagePath, scene, characters)` in `orchestrator.js`. Takes the location PNG (base64), scene emotional context + characters, returns a refined prompt string with @mentions + spatial descriptions. Falls back to original script blocking on API failure.
- **Placement:** Inside `_runCinematicSceneImageStage()` per-scene loop, AFTER resolving `locInfo` and `characters`, BEFORE calling `cinema.generateSceneImage()`. The refined blocking text replaces the raw `characters` array's position strings.
- **Prompt design:** System prompt instructs Claude to: (1) describe spatial anchors in the location image, (2) propose character positions that use those anchors, (3) output @mention names with environment-relative positions, (4) never use generic frame-left/center/right language. Single-character scenes get intimate framing; multi-character scenes get dynamic spatial relationships.
- **Cost:** One Claude API call per scene (~$0.01-0.03 with vision) vs 2 Higgsfield credits ($0.20+) per generation. The quality uplift is worth 10x the cost.
- **Fallback:** If vision call fails or returns unparseable result, use original `scene.blocking` from script. Existing code path stays intact as safety net.

**Inter-Generation Reset (April 2026 — CRITICAL):** After each successful scene generation + download, the form MUST be reset before the next scene starts. Higgsfield persists references and prompts at the PROJECT level AND in the browser context (localStorage, session storage, React in-memory state) — there is no UI control to remove a reference image once attached. Reloading the same project or even navigating to a different URL does NOT clear this state. The ONLY reliable reset is `recreateContext()`: tear down the entire browser page + context, preserve cookies for auth, create a brand new context with no localStorage, open a fresh page. This is the same pattern used by `clearVideoStartFrame()` in the staged workflow. Fix: `resetFormForNextGeneration()` in `cinema-studio-automation.js` calls `this.automation.recreateContext()`, then navigates the fresh page to `https://higgsfield.ai/cinema-studio`. Clears `_projectId` and `_projectCreated` so the next `generateSceneImage()` → `ensureProject()` call re-creates/finds the project fresh. Orchestrator calls this with a 5s cooldown between scenes. Similarly, `_nukePageForToolbarReset()` uses the same `recreateContext()` pattern when the toolbar setup can't switch modes — if clicking the Image tab doesn't work, nuke the whole context and retry from scratch.

**Harvest Recovery (April 2026 — CRITICAL):** When `_waitAndDownload()` times out (120s), the generation may have completed on Higgsfield's side — the tile detection just missed it. Instead of re-generating (wastes credits), `_harvestRecentGeneration()` kicks in: nuke the context (recreateContext), navigate back to the project URL, switch to Generations tab, scan the first few image tiles (most recent = first), and download the first one with a CDN src that's large enough (>10KB, not a placeholder). Returns `{ sourceGenId }` on success or `null` if no suitable tile found. If harvest fails, the error propagates as "Timeout — harvest also failed".

**Inter-Generation Reset Runs After EVERY Scene (April 2026):** The `recreateContext()` nuke now fires after every scene attempt — success OR failure. Previously it only fired after successful download, so a timed-out Sc2 left dirty state (stale prompt text, leftover reference images, orphaned UI state) that broke Sc3 ("+ button not found"). The nuke is in a post-try/catch block in the orchestrator's scene loop, gated only by `!browserDead`.

**Higgsfield Project ID Persistence (April 2026):** The Cinema Studio project UUID (from the URL `cinematic-project-id=<UUID>`) is saved to the DB `projects.settings` JSON as `higgsfield_cinema_project_id`. On pipeline resume, it's loaded back into `this.state.higgsfield_project_id` and passed to `CinemaStudioAutomation`. This means: (1) the same project is reused across nukes (recreateContext clears browser state but the project lives server-side), (2) the same project is reused across app restarts, (3) no more one-project-per-restart sidebar clutter. `ensureProject()` now navigates directly to the project URL if `_projectId` is set, regardless of `_projectCreated` state.

**Stuck Recovery Rule:** Any misclick or 5 seconds stuck on any step → nuke the browser context (recreateContext) → restart from step 1. Up to 3 full restarts. Implemented in `_setupToolbarSequence()` with `_runStepWithStuckGuard()` wrapper and `_nukePageForToolbarReset()` helper (replaces old `_clickGenerationsReset()` approach which just clicked the Generations tab and didn't fix mode switch failures).

**Target toolbar state** (from screenshot): Image mode, Cinematic Cameras, 1/4, 16:9, 2K, 1x1, @, Studio Digital S35 camera preview, GENERATE ✦ 2.

**Viewport/Coordinate Notes:**
- Electron BrowserView viewport: 1920×847.
- Screenshot resolution differs from DOM coordinates (scale ~0.817x). Clicking at DOM coordinates doesn't work for coordinate-based clicks — need to scale.
- Cost: Cinematic Cameras = 2 credits/image, Soul Cinema = 0.125 credits, Cinema Studio 3.5 video = 8 credits. Safety gate: anything > 10 credits is suspicious (likely wrong mode).

**GENERATE button text variants:** Can show as `"GENERATE ✦ 2"` (uppercase) or `"Generate2"` (compressed, depending on viewport). Match with `/^GENERATE|^Generate/` + digit check.

**Files:** `cinema-studio-automation.js` (main automation), `higgsfield-elements.js` (element creation). Both use execCommand for Lexical editor. The orchestrator (`orchestrator.js`) handles the transition between element-setup and scene-generation stages — must click Generations tab before handing off to scene gen.

## Two-Pool YouTube Research

- **AI Originals**: Filtered by `/\bai\b/i` regex in title, minimum 10k views
- **Remake Candidates**: Traditional Nollywood hits, minimum 500k views
- YouTube deduplicates by `videoId` (extracted from URL param `v=`) within and across pools — fixes duplicates from overlapping search queries
- For Gemini analysis, videos are interleaved: remake, AI, remake, AI... (remakes first — proven formulas are richer ingredient sources)

## Credit Budget

Higgsfield Creator subscription: 6000 credits/month, resets on the 15th.
- 5 min movie: ~540 credits (~11 movies/month)
- 10 min movie: ~1080 credits (~5 movies/month)
- Only video generation costs credits — image gen uses Unlimited mode (free)

## Gemini JSON Parsing Gotcha

Gemini 2.5 Flash sometimes returns malformed JSON despite `responseMimeType: 'application/json'` — unescaped quotes inside strings, trailing commas, unclosed brackets. The `_safeParseJSON()` method in gemini-analyzer.js has 3 fallback strategies: direct parse → extract JSON object via regex → fix trailing commas + close unclosed brackets. Always use this method when parsing Gemini output.

## Script JSON Recovery

Claude's script responses (especially at 90+ lines) can be truncated or malformed. `_safeParseScriptJson()` in script-engine.js provides 6-strategy progressive recovery: direct parse → regex extraction → trailing comma fix → bracket closing → unescaped quote fix → truncation to last complete element. Helper methods: `_closeUnclosedBrackets()`, `_fixUnescapedQuotes()`, `_truncateToLastComplete()`. The `max_tokens` is set to 16384 to minimize truncation in the first place.

## Node.js Fetch Polyfill

The Electron main process needs `fetch()` for Gemini API calls. A polyfill guard in `main.js` and `gemini-analyzer.js` checks `typeof globalThis.fetch` and imports `node-fetch` if undefined (for Node < 18 / Electron < 28).

## Windows Path Note

FFmpeg concat file paths on Windows need backslashes replaced: `.replace(/\\\\/g, '/')`.

## Git Commits from Sandbox (NTFS Lock Workaround)

The sandbox runs on Linux but writes to an NTFS-mounted volume. Git creates `.lock` files (e.g. `.git/HEAD.lock`, `.git/index.lock`) during operations, but NTFS permission semantics prevent the sandbox from deleting them afterward. The lock files are zero-byte and stale — no git process is actually running.

**Workaround:** `mv` the lock file instead of `rm` (rename works on NTFS even when unlink doesn't):

```bash
# Before git add/commit, clear any stale locks:
mv .git/index.lock .git/index.lock.stale 2>/dev/null
mv .git/HEAD.lock .git/HEAD.lock.stale 2>/dev/null

# Then run git add + git commit as normal.
# Warnings like "unable to unlink .git/HEAD.lock" are harmless — the commit succeeds.
```

**Why this happens:** Each successful `git commit` creates a NEW `HEAD.lock` (and sometimes `index.lock`). Since the sandbox can't unlink the old one, the NEXT commit will fail until you rename it again. So **always rename locks before every commit** — it's not a one-time fix.

**The `scripts/commit-fix.bat` file is obsolete** — it tried to `del` from Windows, but the `mv` trick works directly from the sandbox.

## Generation Detection & Download (URL-Targeted)

`waitForGeneration()` **returns the new CDN URL** it detects. This URL is then passed to `downloadLatestImage(outputPath, detectedUrl)` which fetches that specific image directly — no "click first card in history" guesswork.

Detection tiers:
1. **CDN URL diffing** (primary): `_getHistoryCdnUrls(type)` snapshots all CDN URLs before generation. Each poll checks for new URLs. Returns the new URL on detection.
2. **Item count increase**: `countHistoryItems()` — if count goes up, waits briefly then tries to capture the new URL.
3. **Status transition safety valve**: After 5 polls post-"generating" → "unknown", assumes done. Returns null (no URL).

Download tiers (uses the returned URL):
1. **Direct fetch** of the detected CDN URL — extracts full-res original from CDN params if present
2. **Matched card click** — finds the `<img>` element with matching src, clicks it, uses lightbox Download button
3. **First card fallback** — only if no URL was detected (logged as warning)
4. **Screenshot last resort**

The old approach of always clicking "first card in history" was downloading community images instead of our generations.

## Stage Completion Verification

`verifyStageComplete(type, stageName)` runs after every generation loop, before `updateProjectStage()`. Two checks:

1. **DB check**: `getIncompleteAssets()` — any non-done assets → throw (blocks stage transition)
2. **File check**: All `done` assets verified with `fs.existsSync()` — any missing file → asset reset to `pending` → throw

If verification fails, the error bubbles up and the user can resume. On resume, `getIncompleteAssets()` picks up the reset assets and re-generates only what's missing.

## Scene Staging & Reference Chain

`stageSceneReferences(imagePrompt, sceneImageMap, chapterNum, charactersPresent)` handles both reference types:

**A) Character portraits** — determined by `scene.characters_present` (the authoritative list from the script JSON). Every character in the list gets their portrait uploaded as a reference, regardless of whether their description appears in the prompt text. Fingerprint matching via `_extractCharacterFingerprints()` is used ONLY for ordering — finding each character's position in the prompt so ref[0] = first described, ref[1] = second. Characters present in the scene but not found in the prompt text are appended at the end (not dropped). If `characters_present` is empty (backward compat), falls back to scanning all bible characters against the prompt.

**Relationship chain**: `script.character_bible[].id` → `portrait_<id>.png` (generated during portrait stage) → stored in DB as `{ character_id, file_path }` → restored to `this.state.portraits` on resume → `scene.characters_present` lists which character IDs appear in the scene → portraits looked up by `characterId` match → uploaded as Higgsfield references.

**B) Continuity reference** — parses `(Continuity: Using Image Prompt [Line X] as reference)` from the prompt text. Resolves Line X against `sceneImageMap` (a `chapter_line → filePath` lookup built from DB + newly generated images). Line 1 of a scene has no continuity tag; Lines 2+ reference the specific previous line's generated image.

**Final ref order**: `[character portraits in prompt-position order, then unpositioned] + [continuity scene image]`

Nano Banana supports **up to 14 reference slots**. Slots load dynamically — upload code re-queries `input[type='file']` after each upload, targets first empty slot. Each upload verified by thumbnail confirmation. After `setInputFiles()`, explicit `change` and `input` events are dispatched for React compatibility.

The old `previousSceneImage` variable tracking is gone — continuity target is parsed directly from the prompt text, pointing to a specific line number.

**File input scoping**: The selector `input[type='file']` was picking up file inputs from outside the reference area (community tab, profile, etc.), causing unrelated images to appear as references. Now scoped to `.size-14 input[type='file']` (56x56 reference slot containers). Fallback filters by container size (≤80px). Upload code also validates slot size — skips any input where the container is >120px wide.

## Reference Hard Gate

`verifyReferenceThumbnails(expectedCount, references)` in `higgsfield.js` — called AFTER `uploadImageReferences()` and BEFORE clicking Generate. Counts visible thumbnails (with real `blob:`, `data:`, or `http` src) in the 56x56 reference slots.

Gate logic:
1. Count thumbnails → if matches expected, proceed
2. Wait 3s for late-loading thumbnails → recount
3. Clear all + re-upload + recount
4. If still mismatched → throws `REFERENCE_GATE_FAILED` error, aborting generation

This prevents scenes from being generated without face consistency references. Video generation has an equivalent gate for the start frame upload.

## Reference Slot Timing & Dynamic Upload Trigger

Higgsfield's reference upload UI is fully dynamic:
- **Fresh page**: No `.size-14` containers exist. Only a single `+` button (file input inside `form.image-form > fieldset`) is present.
- **After each upload**: A `.size-14` thumbnail container appears for the filled reference AND a new empty `+` slot is created next to it.
- Each subsequent upload must target the NEW empty slot, not re-click a filled one.

`_findReferenceUploadTrigger()` returns `{ clickable, fileInput, fileChooser }` — the button/label for filechooser interception, the slot-specific `<input type="file">` for setInputFiles fallback, and optionally a pre-obtained FileChooser from clicking the add button. Uses `page.evaluateHandle()` (not CSS `:has()`).

**CRITICAL DOM STRUCTURE** (verified April 2026):
```
form.image-form > fieldset > div.flex-1 > div.flex.gap-3 (reference row)
  └ DIV.touch-none.cursor-grab  (drag wrapper for slot 1)
      └ DIV.size-14 (slot — filled or empty, 56x56)
  └ DIV.touch-none.cursor-grab  (drag wrapper for slot 2)
      └ DIV.size-14 (slot)
  └ ??? (the "+" add button — NOT .size-14, sibling of drag wrappers)
```

Each `.size-14` is wrapped in a drag wrapper (`touch-none cursor-grab`). The "+" add button is a **sibling of the drag wrappers** at the **grandparent level** of `.size-14`. Using setInputFiles on a filled slot's input REPLACES that image instead of adding (the "replace loop" bug).

Strategies (in order):
1. **Empty .size-14 slot** — tags the LAST empty slot with `data-ref-target`, gets both button and file input
2. **"+" add button at grandparent level** — when all slots filled, goes `.size-14` → drag wrapper → flex row, searches flex row's children for non-slot elements with file inputs, labels, buttons, or SVGs. Clicks it → either filechooser fires or a new empty slot appears (recurse to Strategy 1)
3. **Non-slot file input** — finds `input[type="file"]` NOT inside `.size-14` anywhere in form
4. **Fresh page** — only when 0 `.size-14` slots exist
5. **NO broadest fallback** — removed to prevent replace-loop bug

**DOM diagnostics**: Each call dumps `refRowInfo` — the **grandparent** container's children (drag wrappers + add button) with tag, classes, hasSlot14, hasFileInput, hasSvg, hasImg, dimensions.

**Upload cascade** (4 approaches per reference — filechooser-only priority):
0. Pre-obtained filechooser from add button click
1. Filechooser interception on `clickable` button
2. Filechooser on `fileInput.click()` (native path)
3. LAST RESORT: `setInputFiles()` + events (UNRELIABLE — React may not register)
If all fail: throws `REFERENCE_UPLOAD_FAILED` to abort (prevents identity drift).

**CRITICAL: `setInputFiles()` bypasses React state.** Thumbnails appear in DOM (browser-rendered preview) but Higgsfield's form state stays empty. References NOT sent to backend. This caused 70% identity drift in Session 6. Always use filechooser interception.

**Thumbnail confirmation** uses before/after count comparison (snapshot count before upload, wait for count to increase).

**MANDATORY inter-upload wait** (`INTER_UPLOAD_WAIT_MS = 2500`): Fixed 2.5s delay between each upload. Higgsfield needs time to process the image, render the thumbnail, and create the next empty `+` slot. Without this, the next iteration finds stale DOM. This is the single most important fix — the user confirmed that manual uploads require waiting between each one.

**`clearImageReferences()`**: Loops one-at-a-time (up to 15 passes), clicking first filled slot's close button each pass, waiting 600ms for DOM update. Searches all descendant `button` elements. If filled slots remain, force-reloads the page as nuclear fallback.

## Prompt Continuity Sanitizer

`sanitizeContinuityTag(imagePrompt, lineNumber)` in `orchestrator.js` — called before staging references and sending prompts to Higgsfield for Lines 2+.

The LLM (Claude script generator) sometimes produces garbled continuity tags where the tag text is interleaved with the scene description (e.g., `(Continuity: Using Image Prompt [Line 1] as rs slightly parted...`). The sanitizer:
1. Detects well-formed tag → passes through unchanged
2. Detects garbled tag fragments → strips them, extracts line number, prepends clean tag
3. No tag but line > 1 → prepends tag referencing previous line

This ensures `stageSceneReferences()` always receives a parseable continuity tag.

## Asset Reset Script

`scripts/reset-assets.js` — standalone Node script for resetting assets when re-generation is needed.

Usage: `node scripts/reset-assets.js [mode]`
- `scenes` — reset scene images only, stage → `portraits-done`
- `portraits` — reset portraits only, stage → `script-done`
- `clips` — reset video clips only, stage → `scenes-done`
- `all` — full reset (portraits + scenes + clips), stage → `script-done`

Deletes files from disk, clears DB fields (file_path, model, gen_id, prompt_used), sets all assets to `pending`. App must be closed first.

## Selective Scene Redo Script

`scripts/redo-scenes.js` — reset specific scenes for re-generation (identity drift, bad composition, etc.).

Usage:
- `node scripts/redo-scenes.js 2,5,14` — redo specific scene lines
- `node scripts/redo-scenes.js 2-5` — redo a range of lines
- `node scripts/redo-scenes.js 2,5-8,14` — mix of individual + range
- `node scripts/redo-scenes.js all-failed` — redo all scenes with status `failed`
- `node scripts/redo-scenes.js list` — show all scene assets with status, file, chapter

Resets only the targeted scenes to `pending`, deletes their image files, and sets project stage to `portraits-done`. On next Resume, the pipeline re-enters scene generation and regenerates only the reset scenes (skips all still-done scenes via the `doneSet` check in orchestrator).

Note on continuity: if you redo Line 2 but keep Line 3, Line 3 was generated with Line 2 as a continuity reference. The new Line 2 image will be different, but Line 3's existing image still uses the old Line 2. If visual continuity matters, redo downstream scenes too (e.g., `2-5` instead of just `2`).

## Generation Deduplication

Before every generation call, the orchestrator checks `db.findExistingGeneration(prompt, type)` — a single SQLite query that looks for a completed asset with the exact same `prompt_used` text and asset type. Searches across ALL projects. If found and the file still exists on disk, it copies the file to the expected output path and skips Higgsfield entirely. Effectively free (no network, no browser interaction). Prevents the Higgsfield history from filling up with duplicate generations on resume/retry.

## Throttle Detection & Credit Fallback

Higgsfield throttles Unlimited (free) generations by deprioritizing them in the queue. When throttled, a generation that normally takes ~30-45s can exceed 3+ minutes. At 2 credits per 2K Nano Banana image, credits are cheap.

**Auto-fallback flow:**
1. Every generation starts with Unlimited ON (free)
2. `_pollJobCompletion()` monitors elapsed time — if still `in_progress` after 180s, throws `GENERATION_THROTTLED`
3. `generateImage()` catches the error, sets `this.throttled = true`, logs a clear banner
4. Immediately retries the same generation with `useUnlimited: false` — which calls `disableUnlimited()` to toggle the switch OFF
5. All subsequent generations in the session use credits (the `this.throttled` flag is checked at the top of `generateImage`)
6. No cooldown/re-check — once throttled, stay on credits for the session

**Key implementation details:**
- `this.throttled` is a session-level flag on HiggsFieldAutomation — resets on app restart
- The retry re-navigates and re-uploads references (clean slate, not partial state)
- `disableUnlimited()` mirrors `enableUnlimited()` — finds the Unlimited switch and clicks only if ON
- Throttle threshold: 180s (configurable via `THROTTLE_THRESHOLD_MS` in `_pollJobCompletion`)
- Overall timeout remains 300s, but throttle fires at 180s — the remaining 120s is used by the credit-based retry

## Asset Tracking & Metadata Persistence

Every generated asset (portrait, scene image, video clip) is tracked in the `project_assets` SQLite table with full traceability:

**Columns persisted per asset:**
- `file_path` — absolute path to the downloaded PNG/MP4 on disk
- `status` — lifecycle: `pending → generating → done/failed`
- `prompt_used` — the exact prompt sent to Higgsfield (set at `markAssetGenerating`)
- `model_used` — extracted from Higgsfield detail page (e.g. "Nano Banana Pro")
- `source_gen_id` — Higgsfield's internal asset/generation ID (from URL or CDN hash)
- `cdn_url` — the CDN URL the image was downloaded from (for re-download if local file lost)
- `references_used` — JSON array of portrait file paths used as face references for the scene
- `generation_duration_ms` — wall-clock time from generation start to download complete
- `completed_at` — timestamp when marked done
- `retry_count` / `error_message` — failure tracking

**Data flow:** `generateImage()` returns `genMeta = { model, sourceGenId, cdnUrl, referencesUsed, generationDurationMs }` → orchestrator passes it to `markAssetDone(assetId, filePath, genMeta)` → DB persists all fields.

**Dedup path:** `findExistingGeneration()` returns stored `cdnUrl` and `referencesUsed` alongside model/genId, so deduped assets inherit the original generation's metadata.

**Migration:** `004-asset-tracking-extras.sql` adds `cdn_url`, `references_used`, `generation_duration_ms` columns.

## Double Execution Guard

`orchestrator.start()` has a guard at the top that rejects duplicate calls if the pipeline is already running or waiting for approval. This prevents the "everything runs twice" bug where the renderer calls start twice on resume.

## Pipeline Activity Log (Resume Context)

Every meaningful pipeline action is recorded in the `pipeline_events` SQLite table: session start/end, stage start/complete, asset start/done/failed/dedup, pause/resume/cancel, verification failures, and errors. Each event carries the project ID, stage, asset ID, a human-readable label, and a detail string.

On resume, `db.getResumeContext(projectId)` builds a structured summary: what was the last action, was an asset interrupted mid-generation, how many assets completed/failed/deduped in the previous session, and the 10 most recent events. This context is:
- Logged to the pipeline output at resume time (`[RESUME]` prefix lines)
- Emitted to the UI as a `resume-context` event (shown in the log panel)
- Displayed on the resume card (interrupted asset warning, previous session stats, time-ago)
- Returned from `getActiveProjectStatus()` so the launcher screen can display it

Migration: `003-pipeline-events.sql`. DB functions: `logEvent()`, `getRecentEvents()`, `getLastEvent()`, `getResumeContext()`.

## Navigation Failsafe

Higgsfield's page can load in a "history-only" state where the generation bar (prompt input, settings, Generate button) doesn't render. This happens when the URL is stale or the SPA router doesn't fully initialize the generation UI.

`_navigateWithFailsafe(type, sel)` in `higgsfield.js` handles this with 4 attempts:
1. Direct URL navigation + landing page redirect detection (if URL redirects to `/ai-image`, retries with `/ai/image?model=nano-banana-pro`)
2. Extended wait (3s extra if prompt element missing)
3. Failsafe: logo click → home → direct URL retry
4. Nav menu path: "Image" button dropdown → "Nano Banana Pro" link or "Create Image Now" CTA
5. Nuclear: full context recreate + fresh navigation to known-good URL

Used by both `generateImage()` and `generateVideo()`. If all 4 attempts fail, throws `NAVIGATION_FAILED`.

The Nano Banana Pro URL history: `/image/nano_banana_2` → `/image/nano-banana-pro` → `/ai/image?model=nano-banana-pro` (current as of April 20 2026). Old path-based URLs now redirect to `/ai-image` landing page with no generation UI. Updated in `higgsfield-selectors.json`.

## Generation Detection — API Job Tracking + Timestamp Gating

After clicking Generate, `waitForGeneration()` must identify the exact CDN URL of our image/video. The detection uses a layered combo strategy:

**Layer 1 — API Job Tracking (primary, 100% reliable):**
- `_interceptJobId()` — network response listener set up BEFORE clicking Generate. Captures the job UUID from the first `fnf.higgsfield.ai/jobs/{uuid}/status` poll.
- `_pollJobCompletion(jobId)` — fetches `fnf.higgsfield.ai/jobs/{jobId}` until `status === "completed"`. Returns `results.raw.url` — the exact CDN URL, zero ambiguity.
- Higgsfield API response structure: `{ status, params.prompt, results.raw.url, results.min.url, created_at }`
- CDN URL format: `hf_YYYYMMDD_HHMMSS_{jobUUID}.png` — job UUID is embedded in the filename.

**Layer 2 — Timestamp-Gated CDN URL Diffing (fallback if Layer 1 fails):**
- Scans History tab for new CDN URLs (before/after diff, same as before).
- `_parseCdnTimestamp(url)` extracts the date from the CDN filename (`hf_YYYYMMDD_HHMMSS_...`).
- Rejects any URL whose timestamp predates our Generate click (2-minute tolerance for clock skew).
- No lightbox opening, no DOM walking, no fuzzy prompt matching — just string parsing.

Both `generateImage()` and `generateVideo()` call `_interceptJobId()` before clicking Generate, then pass the promise to `waitForGeneration()`.

Note: `_verifyPromptMatch()` still exists in the codebase as a utility but is no longer called in the detection flow — it was unreliable for template-based prompts (character reference sheets all share the same boilerplate).

## Known Issues

1. ~~**Script JSON truncation** at 90+ lines~~ — RESOLVED: `max_tokens` increased to 16384, plus `_safeParseScriptJson()` provides 6-strategy progressive JSON recovery (direct parse → regex extract → fix trailing commas → close unclosed brackets → fix unescaped quotes → truncate to last complete element)
2. **Gemini video processing** intermittent HTTP 400 — title-only fallback catches this
3. **Veo lip-sync** not 100% reliable even with explicit "mouth CLOSED" — manual review at clip approval gate
4. **Branding card resolution**: Generated at 1280×720, final 4K upscale normalizes but intermediate concat could fail if source clip resolutions differ wildly
5. ~~**Prompt matching reads "Copy..." / downloads wrong image**~~ — RESOLVED: API job tracking (intercept UUID → poll → get exact CDN URL) with timestamp-gated CDN diffing as fallback
6. ~~**Double pipeline execution on resume**~~ — RESOLVED: Added guard in `start()` + renamed duplicate `btn-resume` IDs
7. ~~**Nano Banana Pro URL changed**~~ — RESOLVED: Updated from `/image/nano_banana_2` to `/image/nano-banner-pro` + added `_navigateWithFailsafe()` for resilience
8. ~~**Scene references not applied**~~ — RESOLVED: Replaced `setInputFiles()` entirely with real-mouse-click filechooser interception + network response confirmation (see "Reference Upload" section). The root cause was React checking `isTrusted` on events — only real mouse clicks produce trusted events that React accepts.
9. ~~**Line 2+ prompt truncation/garbling**~~ — RESOLVED: `sanitizeContinuityTag()` detects and fixes interleaved continuity tags before staging references and submitting to Higgsfield
10. ~~**70% identity drift (refs not reaching backend)**~~ — RESOLVED: Switched to network-response-based upload confirmation. DOM img src stays as `blob:` even after successful upload (Higgsfield doesn't swap), so DOM inspection produced false negatives. Watching HTTP responses for upload endpoints (`/reference-media`, `/upload`, S3 PUT) gives ground-truth confirmation.
11. ~~**Start frame upload failing / video with random characters**~~ — RESOLVED: Same filechooser + trusted click + network confirmation pattern applied to video start frame. Upload settle gate with 30s buffer prevents Generate firing before backend accepts the file.
12. ~~**App navigated to wrong page (/create/edit Motion Control)**~~ — RESOLVED: `isOnVeoCreationPage()` strict check with URL + left-panel + wrong-page-markers. Plus page-state guard before prompt typing forces Logo recovery.
13. ~~**OS-native file picker leaking to user**~~ — RESOLVED: Persistent `page.on('filechooser', handler)` catches ANY filechooser event during upload phase. No race conditions, no abandoned promises.
14. ~~**Higgsfield ads blocking clicks**~~ — RESOLVED: `_dismissPromoAd()` with 2-strategy detection (sized panels with close buttons + fallback small-X-button scan). 3-round patient dismissal with waits (ads render async 1-3s after page load).
15. ~~**History grid thumbnails accidentally selected**~~ — RESOLVED: `_deselectHistoryItems()` recovery + viewport-bottom-half filter in `_findReferenceUploadTrigger()` to skip grid items.
16. ~~**Persistence across generations (stale refs/prompt)**~~ — RESOLVED: `recreateContext()` tears down and rebuilds the browser context for every scene and every clip. Only guaranteed clean slate.
17. ~~**Pipeline cascades after browser close**~~ — RESOLVED: `this.cancelled = true` now set in all browser-closed catch paths. Pipeline halts immediately instead of falling through to downstream stages with a dead browser.
18. ~~**Throttle retry changes aspect ratio / wastes credits**~~ — RESOLVED: Replaced hard `GENERATION_THROTTLED` throw + recursive re-submit with progressive wait (3 extensions, 234s effective) + soft throttle flag. No more context nuke, no duplicate submission, no aspect ratio loss.
19. ~~**No portrait recovery after crash**~~ — RESOLVED: `gen_clicked_at` tracking + CDN URL persistence + Asset library recovery (`recoverTimedOutImage()` in higgsfield.js). Same pattern as cinematic clip recovery.

## Generation Workflows

**MVP (current):** Nano Banana Pro (portraits + scenes) → VEO 3.1 Lite (video clips)
- Identity drift in scenes is addressed manually via `redo-scenes.js` and the approval gate
- Scene approval is a human eyeball check — no automated quality/consistency validation

**Future workflow (post-MVP):** Nano Banana Pro (portraits) → New Image Model (scenes) → VEO 3.1 Lite (video clips)
- Introduces a dedicated scene image model between portraits and video to reduce identity drift
- The new model slot would need its own Higgsfield automation path (navigate, prompt, generate, download)
- Orchestrator pipeline stages would expand: Research → Script → Portraits → **Scene Images (new model)** → Video → Assembly → Export
- Implementation: add a `sceneImageModel` config option, a second automation class or mode in `higgsfield.js`, and update the orchestrator's scene loop to route to the chosen model

## Verify Clip Stage (Gemini multimodal, wired into pipeline)

**Status:** ✅ Shipped in Session 7. Runs between `videos-done` and `assembly`. All clips are auto-verified via Gemini 2.5 Flash; only flagged ones require human attention in the Verify tab.

**Benchmark vs Whisper (18 clips, real data from "Bush Girl" MVP):**
- Gemini: 17 accept / 1 review / 0 reject — **matched human eyeball exactly** (only L14 needed redo)
- Whisper: 14 accept / 4 review / 0 reject — 3 false-positives from garbled Nigerian-accent transcription

Gemini wins because it sees both video + audio. Whisper alone gets tripped up on accented English ("Njezo. Jago!" on a perfectly-good clip). Cost: ~$0.036 per 18-clip 2-min script via Gemini. Whisper backend still available via `--backend=whisper` for English-only content where cost matters more than accuracy.

**Problem it solves:** Veo 3.1 Lite occasionally produces videos where the spoken dialogue doesn't match what we prompted — wrong words, slurred endings, wrong character's mouth moving, or completely different lines.

**Proposed feature:** A new **Verify** tab between Video and Assembly in the pipeline stages. Each generated clip is automatically transcribed and compared against its expected dialogue (extracted from the animation prompt / script line). The tab presents a pre-scored table so the user reviews only flagged clips, not all 18.

**Architecture:**

Pipeline stages expand to:
```
Research → Script → Portraits → Scenes → Videos → Verify → Assembly → Export
```

**Transcription approach (recommended): Gemini multimodal.**
- Upload the .mp4 directly to Gemini 2.0 Flash (or newer) — it processes video natively, no ffmpeg audio extraction needed
- Cost is trivial: 7-second clips at ~$0.002 per clip → $0.036 for an 18-clip 2-min script
- One API call per clip, in parallel (rate-limit permitting) → whole verification stage completes in ~1-2 minutes for a full run
- Alternative (local, no API cost): ffmpeg extract audio → Whisper transcription. More setup but no per-clip cost.

**Ask Gemini for multiple signals in one call:**
- Verbatim transcript with word-level timestamps
- Speaker mouth-sync quality assessment ("mouth movement matches audio: yes/no/partial")
- Unexpected audio artifacts (background music we didn't ask for, wrong language, silence where dialogue should be)
- Character count in frame (catches Veo adding/removing people)

**Comparison logic:**
- Strip punctuation, lowercase both transcribed and expected text
- Character-level Levenshtein distance → similarity score (0-100%)
- OR semantic similarity via embeddings (handles paraphrase — Veo sometimes says "I won't do it" for "I will not do it")
- **Thresholds:**
  - ≥85% → auto-accept (green row)
  - 50-85% → flag for human review (yellow row)
  - <50% → auto-reject, queue for redo (red row)
- **Trailing-word forgiveness:** weight the last 10-15% of the transcript lower — Veo often drops or slurs the final 1-2 words of an 8-second clip. A mismatch only in the tail isn't always a genuine error.

**UI (new "Verify" tab):**
Table view with one row per clip:
| Clip | Expected Dialogue | Transcribed | Similarity | Mouth-Sync | Action |
|------|-------------------|-------------|------------|------------|--------|
| Ch1 L1 | "Do you know the girl from the bush?" | "do you know the girl from the bush" | 97% | ✓ | Accept |
| Ch1 L2 | "She has no people, no name." | "she has no purpose, no name" | 71% | ✓ | Review |
| Ch2 L5 | "Sit down, my daughter." | "[silence]" | 0% | ✗ | Reject → Redo |

Row actions:
- **Accept** — mark clip as verified, proceed
- **Review** — play inline, manually approve or reject
- **Reject → Redo** — mark clip as `failed`, add to redo queue, regenerate on next launch via existing `redo-videos.js` infrastructure

Bulk actions: Accept all green, Review all yellow, Reject all red.

**Where to gate approval:**
- Verification runs automatically when clips finish (before human sees anything)
- Human approval gate (currently between videos-done and assembly) becomes: user reviews ONLY flagged clips, not all clips
- Auto-accepted clips skip to assembly immediately

**Data persistence:**
- New `verification_results` table or extend `project_assets` with columns: `transcript TEXT`, `similarity_score REAL`, `mouth_sync_ok BOOLEAN`, `verification_notes TEXT`
- Store for audit, future redo decisions, and subtitle generation

**Bonus: free SRT subtitles.** Gemini's word-level timestamps from the transcription step give us perfect subtitles for each clip. Combine them in order during assembly → final video ships with accurate SRT without an extra transcription pass. Major quality-of-life win that Higgsfield/Veo doesn't provide natively.

**Implementation sketch:**
1. New module `src/main/verify/clipVerifier.js` with `verifyClip(clipPath, expectedDialogue) → {transcript, similarity, mouthSync, artifacts}`
2. Use `@google/generative-ai` SDK (already in deps for Gemini analyzer) with `gemini-2.0-flash-exp` model
3. Orchestrator: add Stage 4.5 between `videos-done` and `assembly`. On entry, iterate done clips, call `verifyClip()` in parallel batches of 5 (rate limit), write results to DB
4. Renderer: new tab/view reading from `verification_results`, same pattern as existing scene approval UI
5. Approval gate post-verify only shows flagged clips (not all)
6. Rejected clips → update asset status to `failed` → existing redo path handles regeneration

**Risk & mitigation:**
- Gemini misreads a clip (false positive rejection) → human review of yellow-band clips catches this
- Gemini API rate limits → batch with backoff, cap concurrency at 5
- Transcript includes ambient sounds ("[breathing]", "[music]") — strip these patterns before similarity scoring
- Short clips (<3s) may get poor transcription → lower the auto-accept threshold for short clips or fall back to manual review

## Fresh Context Per Scene/Clip (The Only Reliable Clear)

Higgsfield persists references, prompts, and form state in React state + localStorage across generations. Neither `clearImageReferences()`, `page.reload()`, nor nav clicks reliably clear it. The **only guaranteed clean slate** is tearing down the entire browser context and rebuilding it.

**`recreateContext()`** — captures cookies/auth into `storageState`, strips localStorage from it, closes the old context, creates a fresh context with just the cookies. The result: a brand-new React app instance. Cost: ~3-5s. Cookies preserved → still logged in.

**Used at the start of every generation:**
- `generateImage()` (scenes + portraits): recreate at start of each scene
- `generateVideo()` → `clearVideoStartFrame()` → recreate at start of each clip

**Eliminates these issues:**
- Stale references persisting from the previous scene
- Replace-loop bugs (no existing slots to accidentally overwrite)
- localStorage form-draft restoration
- Cross-contamination between generations
- Selected history grid items carrying over

## Reference Upload (Trusted Clicks + Network Confirmation)

The fundamental rule learned the hard way: **React checks `isTrusted` on events. `setInputFiles()` and `el.click()` via JS produce untrusted events that React may silently ignore.** The blob preview shows up (DOM-level file attach), but Higgsfield never triggers the actual backend upload → file stays local forever → reference never included in generation.

**Only real-mouse clicks work:** `page.mouse.click(x, y)` at real coordinates dispatches a `isTrusted: true` event that React's onClick handlers accept.

**Per-ref upload flow:**
1. `_findReferenceUploadTrigger()` — finds empty slot OR "+" add button OR fresh-page candidate (filters out history-grid buttons by viewport position and parent-class detection)
2. Set `currentUploadFile` variable (picked up by persistent filechooser handler)
3. `page.mouse.click()` on the trigger's bounding box center
4. Persistent `page.on('filechooser', handler)` catches ANY filechooser event and attaches `currentUploadFile` — no race conditions, no abandoned promises, no OS dialog leaking to the user
5. If primary click doesn't fire a filechooser, check for modal upload option ("Upload from device"), click it
6. Confirm upload completed via **network response interception** — watch for `POST 2xx` to `/upload|/asset|/media|/image|/reference` or `PUT 2xx` to S3/CloudFront URLs

**Why network confirmation, not DOM:** Higgsfield keeps the img src as `blob:` even after the backend upload completes (they don't swap to CDN URL). So the only ground-truth "upload succeeded" signal is the HTTP response, not DOM inspection.

**Upload approaches (fallback cascade):**
1. Real mouse click at clickable center (TRUSTED)
2. `elementHandle.click({force: true})` (fallback)
3. Real mouse click on input's parent container

`setInputFiles()` and `fileInput.click()` via JS are explicitly **removed** — they fake a successful upload (blob shows) but the backend never receives the file.

**Configurable timeouts (env vars):**
```
REFERENCE_SETTLE_TIMEOUT_MS   = 180000  (3 min, per-upload backend settle)
REFERENCE_SETTLE_EXTRA_MS     = 30000   (30s post-upload buffer before Generate)
START_FRAME_SETTLE_TIMEOUT_MS = 180000
START_FRAME_SETTLE_EXTRA_MS   = 30000
```

Tune down as confidence grows: `REFERENCE_SETTLE_EXTRA_MS=5000 npm start`.

## Video Start Frame Upload

Same principles as image references: filechooser interception, real-mouse clicks, network-based confirmation, persistent handler.

**Upload approaches:**
1. Real mouse click on visible upload area (label containing the file input) — TRUSTED
2. `locator.click()` with Playwright actionability
3. `fileInput.evaluate(el => el.click())` as last resort

**Hard gate:** After upload, waits for preview src to transition from blob: to https:// (CDN URL) + no spinners. If strict gate fails in timeout, falls back to network-response check.

**`clearVideoStartFrame()`** — uses `recreateContext()` as primary, same as image gen. Tears down page, rebuilds with cookies, navigates to higgsfield.ai, runs `selectVideoModel()`. Skips everything if page is already clean (previews=0, prompt=empty).

**All-clips-failed guard:** If ALL clips fail (0 done, N failed), pipeline throws `ALL_CLIPS_FAILED` instead of showing the approval gate. No point approving nothing.

## Ad Dismissal (Patient, Multi-Round)

Higgsfield shows promo/ad overlays ("Soul Cinema", "Get 7-Day Unlimited Seedance 2.0", etc.) on page load. Ads render **asynchronously 1-3s after load** — clicking too fast causes ads to pop up mid-action and intercept our clicks, navigating the browser to wrong pages.

**`_dismissPromoAd()`** — two-strategy dismissal:

**Strategy A:** Find sizeable panels (`div`, `section`, `aside`, `dialog`) that are:
- ≥150×150px but NOT viewport-sized (skips page content)
- Position `fixed`/`absolute` with z-index > 0
- NOT scrollable containers (`overflow-auto`, `hide-scrollbar`)
- NOT containing our upload form or submit button
- Scored by: has close button (+10), contains ad-like text like "cinema/introducing/new model/try now/unleashed" (+5), overlay-class (+3), plus z-index tiebreaker

For the top-scored panel, clicks the smallest close button in its top-right quadrant with a real mouse click.

**Strategy B (fallback):** Scans entire viewport for any small button (15-50px) that:
- Has close-like text (`×`, `x`, `✕`, `⨯`) or aria-label with "close"/"dismiss"
- OR has an SVG child AND is in upper 60% of viewport

Loops up to 5 times (dismissing one ad may reveal another).

**3-round patient dismissal pattern** (applied at every entry point):
```
wait 3s → dismiss → wait 2.5s → dismiss → wait 2s → dismiss → wait 1.5s
```
~9s overhead per scene/clip. Used in:
- `generateImage()` after context recreate and navigation
- `generateVideo()` after `clearVideoStartFrame()`
- `clearVideoStartFrame()` after homepage navigation, before `selectVideoModel()` clicks
- `selectVideoModel()` at entry (short 2-round version) to protect all call sites

## Page-State Guard

Higgsfield can redirect us to wrong pages (`/create/edit`, Motion Control, homepage) at unexpected times. Before prompt typing, `generateVideo()` runs a guard:

- Rejects URL if it matches `/edit` or lacks `/create/video`
- Rejects body text containing wrong-page markers (`"generate ai videos from"`, `"motion control"`, `"kling 3.0 motion"`, `"scene control mode"`, `"get 7-day unlimited seedance"`) when not paired with "veo 3.1 lite"
- Requires `div[role='textbox']` to exist in DOM

If guard fails: logs diagnostic, attempts Logo → Video → Veo recovery, then throws `PAGE_NAVIGATED_AWAY` so the clip fails cleanly (non-fatal, pipeline continues to next clip).

## History Grid Protection

Higgsfield's image gen page shows a multi-select History grid above the prompt form. An accidental click on a history thumbnail toggles its selected state (checkmark), confusing downstream actions.

**Prevention:** `_findReferenceUploadTrigger()` Strategy 3 (fresh page) filters candidates to the **bottom 55% of viewport** (history grid lives in top half; form is always at bottom). Also excludes elements inside `[class*="grid|thumbnail|card|history|overflow-x-hidden"]` unless inside a `<form>`.

**Recovery:** `_deselectHistoryItems()` — finds checked checkboxes, `aria-selected="true"`, `data-selected="true"` containers, and SVG checkmark icons (matches common checkmark path data like `M5 13l4 4L19 7`), clicks them to deselect. Runs at start of every `generateImage()`.

## Video Navigation (Higgsfield UI)

Navigating to Veo 3.1 Lite uses **UI clicks, not URL navigation**. Direct URL (`/create/video`) is unreliable — often lands on wrong model or stale page.

**Correct path:** Click "Video" in top nav bar → Click "Google Veo 3.1 Lite" in dropdown.
**When stuck:** Click Higgsfield logo (resets to home) → Video → Veo 3.1 Lite.

**`selectVideoModel()` flow:**
1. Short ad dismissal at entry (protects all call sites)
2. `isOnVeoCreationPage()` strict check: URL must match `/create/video` AND NOT `/edit|motion`; left panel must contain "veo 3.1 lite"; body must NOT contain wrong-page markers (`"motion control"`, `"kling 3.0 motion"`, `"edit video"`, `"scene control mode"`, `"add motion to copy"`)
3. If already on Veo creation page → skip nav
4. If on wrong page → force Logo reset first, then nav
5. Attempt 1: `_clickNavToVeo()` (Video nav → Veo 3.1 Lite dropdown)
6. Verify landing: re-run `isOnVeoCreationPage()` — if it reports wrong-page, retry
7. Attempt 2: Full reset via `_clickHiggsLogo()` → `_clickNavToVeo()`
8. Attempt 3: Direct URL + `_tryModelPicker()` fallback
9. Final verification throws `MODEL_SELECT_FAILED` with diagnostic state if all fail

**`pageText.includes('Veo 3.1 Lite')` is insufficient** — Motion Control and other pages can mention Veo 3.1 in tooltips/model lists. Must check URL + left-panel text + wrong-page markers together.

Image navigation uses direct URL (`/image/nano-banana-pro`) which works reliably since the model is baked into the path.

## Failed Generation Recovery (CDN URL Re-download)

When generation succeeds on Higgsfield but download fails locally, the CDN URL is preserved so we can retry without re-generating (saving credits).

**How it works:**
1. `waitForGeneration()` detects CDN URL → saved to `this._lastDetectedUrl`
2. If download throws, the error gets `err.detectedCdnUrl` attached
3. Orchestrator catches error → calls `db.markAssetCdnUrl(assetId, cdnUrl)` → URL persisted to DB
4. Asset marked `failed` with error message, CDN URL survives in `cdn_url` column
5. On restart, video loop checks: if `asset.status === 'failed' && asset.cdn_url` → tries direct fetch
6. If fetch succeeds (file >10KB) → marks done, continues. If fails → resets to pending, re-generates.

**Video clips are non-fatal:** A single clip failure marks it `failed` and the loop continues to the next clip. Only `SESSION_EXPIRED` aborts the pipeline. After all clips attempted, stage verification allows failed clips through (only blocks `pending`/`generating` stuck assets).

## History Recovery (Asset History Scraping)

**Status:** ✅ Shipped in Session 8. Saves credits by reclaiming clips Higgsfield generated server-side but we lost track of locally (generation crash between Generate-click and CDN-URL capture).

**Problem it solves:** Sometimes Higgsfield's Veo backend successfully produces a clip and it shows up in `/asset/all`, but our pipeline missed the CDN URL (browser crash, recreateContext during the wait, network blip). Before this feature, those clips were orphaned — the user paid credits but got nothing, and we would regenerate from scratch on retry, double-charging.

**Two operating modes:**

1. **Inline auto-recovery** — runs automatically inside the video catch block. When a clip fails for any non-cancel / non-SESSION_EXPIRED reason, the orchestrator scrapes Higgsfield's Asset History, fuzzy-matches scraped videos against the failed clip's `prompt_used`, and downloads the match if score ≥85% AND timestamp delta ≤10min. No UI, no credits, ~5-15s latency per attempt.
2. **CLI batch recovery** — `node scripts/recover-from-history.js` scans all pending clips in the active project, matches them against the last 24h of Higgsfield assets, and interactively applies high-confidence matches. Used after a pipeline crash where many clips are pending.

**Matching algorithm** (`src/main/recovery/clipMatcher.js`):
- Prompt similarity via normalized Levenshtein (lowercase, punctuation-stripped, whitespace-collapsed) — 0-100
- Timestamp proximity scoring within ±10min window — 0-100 (linear decay)
- Combined score: 85% prompt + 15% timestamp
- Confidence tiers: **high** (≥85% + ≤10min), **medium** (≥70% + ≤30min), **low** (≥50%), **none** (<50%)
- Greedy assignment in `matchAll()` — each scraped video and DB clip is claimed at most once (no double-claims)

**Scraper** (`src/main/automation/higgsfield-history.js`):
- Structured strategy first: looks for `/asset/all/<uuid>` href pattern in thumbnails
- Broad DOM-walk fallback if selectors fail
- Also listens for JSON API responses via `page.on('response', ...)` if Higgsfield exposes one
- Hydrates individual prompts via detail-page navigation when the grid scrape doesn't include them
- In-memory scrape cache with 5-min TTL to avoid hammering the history page

**DB schema** (migration 006):
- `project_assets.higgsfield_asset_id TEXT` — records source UUID for cross-run dedup + audit
- `project_assets.recovered_from_history INTEGER DEFAULT 0` — flag so UI/logs can distinguish recovered clips from fresh generations

**Orchestrator integration:**
- Constructor adds `_historyRecovery` (lazy-loaded), `_historyAttempted` (Set, prevents scrape loops), `_jobIdsSeen` (reserved for future Generate-click tracking)
- `start()` resets per-run state and invalidates scrape cache
- Video catch block calls `_shouldTryHistoryRecovery(asset, err)` — skips if cancelled, SESSION_EXPIRED, browser closed, already attempted, or CDN URL already captured (the standard CDN-recovery path handles that one)
- On match: `db.markAssetRecoveredFromHistory()` marks asset `done`, emits `clip-complete`, `continue`s past `markAssetFailed`

**Policies:**
- Inline mode: **high confidence only** (≥85%). Lower tiers fall through to normal failure — safer for autonomous runs
- CLI mode: auto-applies high, prompts user on medium, skips low. `--auto` flag restricts to high only
- `--dry-run` shows the match table without downloading
- `--max-age-hours=N` broadens the scrape window (default 24h)
- `--project-dir=<path>` targets a specific project (default: most recent incomplete project)

**Precondition for CLI use:** App must be CLOSED before running `recover-from-history.js` — it spins up its own Playwright instance using the saved Higgsfield session cookies.

## Approval Gate Re-gating on Resume

Approval gates live inside their generation stage block (e.g., scene approval is inside Stage 3B). When the app restarts at `scenes-done`, Stage 3B is skipped by `shouldRunStage()`, so its approval gate never fires. Fix: re-gate checks at the top of the *next* stage:

- **Stage 3B (scenes):** Re-gates portrait approval when `resumeStage === 'portraits-done'` and no scene generation has started
- **Stage 4 (video):** Re-gates scene approval when `resumeStage === 'scenes-done'` and no video clips have started
- The `waiting` event handler in the renderer now also calls `showGenerationView()` to set `currentGenGate` correctly, so the approve button sends the right approval type

## Migration Runner

Uses **statement-by-statement execution** (not `db.exec()` or single `db.run()`). Each SQL statement in a migration file runs individually. Gracefully skips "duplicate column" and "already exists" errors from previous partial runs (caused by the old `db.run()` which only executed the first statement). All migrations use `INSERT OR REPLACE INTO schema_version` for idempotent version tracking.

## Recovery & Reset Scripts

- **`node scripts/wipe-project.js`** — Nuke the active project entirely (DB rows + files on disk) so the app shows "Start Research" button. Preserves Higgsfield session cookies + research cache. Flags: `--force` (skip confirmation), `--keep-files` (wipe DB but keep disk files).
- **`node scripts/redo-videos.js all-failed`** — Reset all failed video clips to `pending`. Retries on next launch via CDN-recovery-first path.
- **`node scripts/redo-videos.js all`** / **`node scripts/redo-videos.js <line_number>`** — Reset specific or all clips.
- **`node scripts/redo-scenes.js`** — Reset scene images for regeneration.
- **`node scripts/reset-assets.js [scenes|portraits|clips|all]`** — Bulk reset by asset type.
- **`node scripts/recover-from-history.js`** — Scrape Higgsfield Asset History and recover orphaned clips into pending DB rows. Flags: `--auto` (HIGH confidence only), `--dry-run` (scan + match, no downloads), `--max-age-hours=N`, `--project-dir=<path>`. App must be closed. See "History Recovery" section above.
- **`node scripts/edit-line.js --chapter=N --line=M --dialogue="..."`** — Rewrite a single line's dialogue in `projects.script_json`, reset the matching asset to pending, clear verify_* columns, delete old file, and roll back project stage if past `verified`. Used for NSFW-blocked lines where Veo rejects the original dialogue.
- **`node scripts/status-check.js [--advance]`** — DB/disk reconcile. Finds clips on disk the DB thinks failed/pending and marks them done. `--advance` sets stage to `videos-done` to escape stuck retry loops.
- **`node scripts/reopen-project.js [--stage=videos-done]`** — Reactivate a completed project for re-assembly or re-verification.
- **`node scripts/test-verify.js [--backend=gemini|whisper]`** — Standalone Verify Clip test harness. Runs verification against all done clips in the active project, prints the full results table, no DB writes.

## Session 11 — Kling 3.0 Video Clip Fixes (April 19, 2026)

### GENERATE Button — Single Click Only (cinema-studio-automation.js, kling-automation.js)
**Problem:** The GENERATE button was firing 3 times per scene, creating 3× "Generating" tiles and wasting 12 credits per scene (4 credits × 3 clicks). Root cause: the 3-attempt escalation pattern used `didGenerationStart()` to detect if a click registered, but the CSS selectors (`[class*="generation"], [class*="tile"], [class*="card"]`) didn't match Higgsfield's actual DOM elements for "Generating" tiles. The prompt-cleared check also failed because Higgsfield doesn't clear the textbox after submission. With detection always returning `false`, all 3 attempts fired.

**Fix:** Removed the 3-attempt escalation entirely. GENERATE is now clicked exactly **once** with `page.mouse.click(x, y)` followed by a 4-second wait. If the click doesn't register, the `_waitAndDownload()` polling loop will eventually timeout, and the orchestrator's retry logic will handle it with a fresh browser context. This eliminates the triple-click risk completely.

**Design principle:** For credit-burning operations, it's better to fail and retry (with a fresh context) than to retry in-place and risk duplicate submissions. The orchestrator already has robust retry logic with fresh browser contexts.

Applied to both `cinema-studio-automation.js` (Higgsfield scene images) and `kling-automation.js` (Kling 3.0 video clips).

### Scene Image Asset Library Recovery (cinema-studio-automation.js, orchestrator.js)
**Problem:** When `_waitAndDownload()` timed out (4 minutes), the old `_harvestRecentGeneration()` tried to recover from the Cinema Studio project page — but that page doesn't have a reliable gallery view. If harvest failed, the orchestrator retried generation, burning another 4 credits for an image that may have already completed server-side.

**Fix:** New `recoverTimedOutImage()` method mirrors the proven Kling `recoverTimedOutClip()` pattern:
1. Nuke context → navigate to `https://higgsfield.ai/asset/image` (filtered Image assets grid)
2. Scan `figure[data-asset-id]` tiles (most recent first, date-grouped: Today/Yesterday)
3. For each tile: navigate to `/asset/image/{uuid}` detail page
4. Scrape prompt text (between "PROMPT" and "INFORMATION" in `body.innerText`, strip "Copy"/"See all")
5. Compare with submitted prompt using word-overlap similarity (≥85% threshold)
6. On match: click Download button → save → return success

**DOM facts (confirmed Chrome MCP, April 2026):**
- Grid tiles: `<figure data-asset-id="{uuid}">` containing `<img data-asset-preview="{uuid}">`
- No `<a>` tags — React client-side routing, must navigate directly to URL
- Detail page URL: `/asset/image/{uuid}`
- Right panel: PROMPT section with Copy button (div), INFORMATION section (Model, Quality, Size)
- Download button: `<button>` with text "Download"

**Recovery is called in two places:**
1. Inside `_waitAndDownload()` on timeout (before throwing to orchestrator)
2. In orchestrator's pre-retry harvest (30s wait → recover → only retry generation if recovery fails)

### Failed Clip Auto-Retry (orchestrator.js)
**Problem:** When a clip failed and Asset library recovery found no match, the pipeline marked it `failed` and crashed with `verifyStageComplete` error. No retry.

**Fix:** After recovery fails (not in local folder, not in Higgsfield), the pipeline now automatically retries generation once (fresh browser context). Also retries on pre-gen failures and browser-dead errors since no credits were burned. Only marks `failed` after retry also fails.

### Vision-Refined Blocking — Bare Character Names (orchestrator.js)
**Problem:** Claude Vision API returns blocking text with bare character names ("toward son_emeka") without `@` prefix. These don't become @-mention pills in Higgsfield.

**Fix:** Post-processing in 3 locations ensures all character names get `@` prefix:
1. `_refineBlockingWithVision()` — right after Vision API returns
2. `_injectVisionBlocking()` — preamble and frame-position replacements
3. `cinema-studio-automation.js` — position text before typing into Higgsfield

Uses negative lookbehind `(?<!@)` + word boundaries to avoid double-prefixing.

### Vision Blocking Base Name → Suffixed Name Resolution (orchestrator.js, cinema-studio-automation.js)
**Problem:** With element name suffixes (e.g. `adanna_mseb_0419`), the Vision API only knows the suffixed name but naturally abbreviates cross-references to bare base names (e.g. "body angled toward adanna"). The `@` prefix fixers searched for the full suffixed name, so bare base names like `@adanna` passed through unresolved — appearing as broken pills in Higgsfield instead of resolving to the element.

**Fix:** All three replacement locations now match BOTH base names and suffixed names:
- Characters carry `baseName` alongside `name` (derived by stripping `_[acronym]_[MMDD]` suffix via regex)
- `_refineBlockingWithVision()`: Vision prompt uses base names (`@adanna` not `@adanna_mseb_0419`) for cleaner LLM output; output mapping matches on base name and replaces with `@suffixedName`
- `_injectVisionBlocking()`: `cleanPosition()` derives baseName on the fly for legacy serialized data, replaces `@baseName` → `@suffixedName` before the bare-name pass
- `cinema-studio-automation.js`: position text replacement checks `other.baseName` first, then `other.name` as safety net
- Replacement order matters: `@baseName → @suffixed` runs before `bare baseName → @suffixed` to avoid double-prefixing

### Prompt Character Limit (orchestrator.js)
**Problem:** CHARACTER POSITIONS preamble with verbose vision-refined blocking pushed prompts over Kling's 2500-char limit (2699/2500). Also had duplicate character entries.

**Fix:** `_injectVisionBlocking()` now:
- Deduplicates characters by name (keeps first occurrence)
- Budget-aware truncation: preamble gets max 35% of 2500-char budget (~875 chars)
- Per-character blocking text truncated at sentence/comma boundaries
- Two-pass system: if first pass still exceeds 2500, second tighter trim runs
- `generateClip()` limit check now tagged `[PRE-GEN]` so orchestrator knows no credits burned

### Pre-Generation Auto-Fix Gate — Scene Images (cinema-studio-automation.js)
**Problem:** Plain text segments in the prompt could contain bare character names (e.g. "adanna" or "mama_chisom") that would be typed as literal text instead of resolving to @element UUID pills. The model doesn't recognize characters by human-readable names — only by @element reference.

**Fix:** After all segments are built (position text, lighting, closer) but BEFORE `_typeBlockingPrompt()` runs, a gate scans every string segment for bare character names (both `baseName` and suffixed `name` variants). Instead of throwing an error, it **auto-fixes in place**: bare names get split out into `{ at: name }` segments using `@@MARKER@@` delimiter splitting (same pattern as lighting segmentation). The gate runs longest-name-first to prevent partial matches and handles possessives (`adanna's`). Logs `[PRE-GEN GATE] AUTO-FIXED N untagged character name(s)` when fixes are applied.

### Pre-Generation Auto-Fix — Video Clips (orchestrator.js)
**Problem:** LLM-authored shot descriptions in `multi_shot_prompt` use bare character names like `mama_chisom` or `adanna` without `@` prefix. Kling's `_typeMultiShotPrompt()` only triggers autocomplete for `@name` patterns — bare names get typed as plain text and don't bind to elements.

**Fix:** After the existing `character_N` replacement step, a new pass scans `finalMultiShotPrompt` for any bare character name variant using the `cinematicElementNames` map (which already maps base names → canonical suffixed names on both fresh runs and resume). Replaces bare occurrences with `@suffixed_name` using `(?<!@)\b` negative lookbehind to avoid double-prefixing. Sorted longest-first to prevent partial matches. Runs on every clip before the prompt preview gate, so it works for both new and resumed projects.

### Lighting @mention Duplicates (cinema-studio-automation.js)
**Problem:** Lighting text had @character references creating duplicate @mention pills in the prompt.

**Fix:** Strip all `@` from lighting text before insertion: `lighting.replace(/@/g, '')`.

### character_N → Element Name Replacement (orchestrator.js)
**Problem:** LLM used generic `character_1`, `character_3` labels in video prompt shot breakdowns instead of actual element names.

**Fix:** Post-processing after @-reference sanitization replaces `character_N` with `@element_name` using the `cinematicElementNames` map.

### Element Name Suffix — Cross-Project Collision Avoidance (orchestrator.js)
**Problem:** Higgsfield enforces unique element names across ALL projects. If two scripts share a character name (e.g. "adanna"), the second project fails to create the element.

**Fix:** Element names now include a suffix: `{name}_{acronym}_{MMDD}` where:
- `{name}` = snake_case character name (e.g. `son_emeka`)
- `{acronym}` = lowercase initials from script title via `_titleInitials()` (e.g. "Blood Price of Deceit and Revenge" → `bpdr`)
- `{MMDD}` = month+day datestamp (e.g. `0419`)
- Full example: `son_emeka_bpdr_0419`

**Implementation details:**
- `_elementSuffix(title)` helper computes the suffix once per pipeline run
- Element creation appends suffix: `` `${baseName}_${elementSuffix}` ``
- `cinematicElementNames` map indexes by multiple keys for flexible lookup:
  - `suffixedName → suffixedName` (identity)
  - `baseName → suffixedName` (for prompt references using old-style names)
  - `@baseName → suffixedName` (for @-mention references)
  - `character_N → suffixedName` (for LLM generic labels)
  - Label slug (lowercase, hyphens) for UI scraping
- Both DB resume paths (video stage ~line 1315, element setup ~line 2382) extract baseName via regex `/^(.+)_[a-z]{2,5}_\d{4}$/` and re-index the map
- `baseName` stored alongside `name` in pending element arrays for resume compatibility

**Prompt replacement:** Both scene image and video clip prompts replace `@baseName` references with `@suffixedName` using the `cinematicElementNames` map before sending to Higgsfield/Kling.

### Verified Element Resume — 3-Layer Idempotency Gate (orchestrator.js)
**Problem:** On resume, the idempotency gate blindly trusted DB-stored element names without checking if elements still exist in Higgsfield. If a user deleted elements from Higgsfield UI (or the element stage was only partially complete), the pipeline would skip element creation and later fail during scene/video generation with unresolved @mentions.

**Fix:** Replaced the old single-check idempotency gate with a 3-layer verification system:

**Layer 1 — Count check (no browser, instant):**
After restoring `cinematicElementNames` from DB portrait assets, compare `restoredCount` vs `characters.length`. If fewer elements are stored than characters exist in the bible, clear the map and fall through to full creation. This catches partial completion (e.g. 2 of 3 created).

**Layer 2 — Higgsfield @ button verification (browser-based):**
If the count matches (all elements stored in DB), open the browser, navigate to the Cinema Studio project, and call `_verifyElementsViaAtButton()` against the stored element names. If any are missing from the dropdown (deleted from Higgsfield), clear the map and fall through. Only runs on DB-restored resumes (`restoredFromDb=true`), not during the current run where elements were just created.

**Layer 3 — Creation loop with @ button filtering (existing behavior):**
When the gate falls through, the creation loop runs fresh. The existing `@ button pre-check` (line ~2726) filters out elements that still exist in Higgsfield, so only missing ones get created.

**Suffix consistency on resume:**
When elements are restored from DB, the suffix is extracted from existing names (e.g. `_bpdr_0419`) and stored in `restoredSuffix`. The creation loop uses `restoredSuffix || this._elementSuffix(...)` so partially-created elements get the same suffix even if resumed on a different day. Fresh suffix only generated when zero elements exist in DB.

**Video stage resume path (~line 1312):**
This path only rebuilds the `cinematicElementNames` map for prompt composition — it doesn't need Higgsfield verification since elements must already exist (scenes were generated using them). Added a count-mismatch warning log for diagnostics.

## Files to Know

- `SETUP.md` — User-facing setup guide
- `TESTING-RESULTS.md` — Detailed operational findings from all testing sessions
- `IMPROVEMENT-HISTORY-RECOVERY.md` — Design doc behind the shipped History Recovery feature (architecture, scoring rationale, Phase 4.5 inline-recovery flow)
- `IMPROVEMENT-MULTICAM.md` — Post-MVP design exploration: multi-cam shot generation as opt-in mode (superseded for long-form work by `IMPROVEMENT-CINEMATIC-WORKFLOW.md`; still applies for users staying on staged mode)
- `IMPROVEMENT-SEO-PUBLISH.md` — Post-MVP design exploration: Publish stage + thumbnail generation + YouTube/Facebook SEO (Phase 4 platform integration explicitly out of scope)
- `IMPROVEMENT-CINEMATIC-WORKFLOW.md` — Post-MVP design exploration: a **parallel production pipeline** (Cinema Studio 2.0 + Kling 3.0) using Higgsfield elements for character/location/prop identity lock. Phase 0 validated in Session 8. Project-level `generator_mode = 'staged' | 'cinematic'` flag. Opt-in, not a replacement for staged workflow. See next section.
- `config/higgsfield-selectors.json` — Higgsfield UI selectors (update if their UI changes) — includes `assetHistory` section for the scraper
- `config/branding.fw.png` — Channel branding card
- `prompts/script-prompt.txt` — Master script generation prompt
- `prompts/research-brief-prompt.txt` — Research-informed title generation prompt
- `src/main/recovery/clipMatcher.js` — Scoring + greedy assignment used by inline and CLI recovery
- `src/main/automation/higgsfield-history.js` — Asset History scraper + downloader
- `scripts/wipe-project.js` — Fresh-start cleanup (see Recovery & Reset Scripts above)
- `scripts/redo-videos.js`, `redo-scenes.js`, `reset-assets.js` — Asset-level retry scripts
- `scripts/recover-from-history.js`, `scripts/edit-line.js`, `scripts/test-verify.js` — Session 8 tooling

## Session 12 — Script Quality Rules & Dialogue Sanitizer (April 20, 2026)

### 3-Shot Rule (script-engine.js, orchestrator.js)
**Problem:** 4+ shots in a 10-12s Kling clip cause skipped shots and misattributed dialogue. 3 shots is the proven sweet spot.

**Fix:**
- Script rubric: "Each clip has EXACTLY 3 shots. If a scene needs more than 3 shots, split into multiple clips" (all sharing the same scene image as start frame)
- Script grader: hard fail if shot count per clip is not exactly 3
- Orchestrator: runtime warning logged if clip has 4+ shots
- Removed shot trimming — if more shots needed, scene splits into additional clips instead

### @Element Names Banned in Dialogue (script-engine.js, orchestrator.js)
**Problem:** LLM sometimes writes dialogue like `"I am @okafor_otpto_0420. I am the market."` — the `@` prefix inside quotes triggers Higgsfield autocomplete instead of being spoken text.

**Fix — Script generation:**
- Rubric rule: "NEVER use @element_name inside dialogue quotes. Characters speak their human name, not the element tag."
- Grader failure mode for @element in dialogue

**Fix — Runtime sanitizer (orchestrator.js):**
- Single-pass regex anchored on speaker tag pattern `]: "..."` — only matches dialogue text after `[@character, speaking...]:` tags
- Pattern: `/\]:\s*"([^"]*?)@([a-z0-9_]+)([^"]*?)"/gi`
- Strips the element suffix (e.g. `_otpto_0420`) and capitalizes the base name (e.g. `@okafor_otpto_0420` → `Okafor`)
- **Critical:** Does NOT use a generic `"..."` regex because that matches across multi-line shot blocks, stripping @tags from shot descriptions where they're needed for character identification. Only the `]: "..."` anchored pattern is safe.

### Settings Change on Research Approval Screen (index.html, orchestrator.js, preload.js, main.js, db.js)
**Problem:** User couldn't change duration, aspect ratio, or generator mode after starting research without losing all research data.

**Fix:** Clickable settings badge with pencil icon on the research approval screen. Opens inline editor with dropdowns matching home screen labels (duration with clip/credit counts, aspect ratio with descriptions, generator mode). Changes persist via `updateProjectSettings()` IPC call. Gated to early stages only (before script generation begins). If no changes made, existing values carry through unchanged.

### Per-Project Activity Logs (db.js, orchestrator.js, main.js, preload.js, index.html)
Every `this.log()` call in the orchestrator now persists to three destinations:
1. **SQLite `project_logs` table** (migration 014) — indexed by project_id, queryable by level. Batch-saves every 50 entries or immediately on errors.
2. **Disk log file** — `pipeline.log` in the project directory, plain text, one line per entry with ISO timestamp + level.
3. **Renderer** (unchanged) — live activity log via IPC `log-message` event.

**UI:** Project Logs viewer panel below the live Activity Log. Project selector dropdown, level filter (info/warn/error), pagination (500 entries per page). Populated on init and refreshed when a new pipeline run starts.

**IPC:** `get-project-logs(projectId, options)` and `get-project-log-count(projectId)`.

### BrowserView Removed (main.js, orchestrator.js, higgsfield.js, preload.js, index.html)
The embedded Higgsfield browser panel (BrowserView) that occupied 60% of the window has been removed. It was redundant — Playwright runs its own Chromium instance for all automation.

**Changes:**
- Dashboard now uses full window width (`100vw` instead of `40vw`)
- Window default width reduced to 1100px (was 1600), minWidth to 800px (was 1200)
- "Toggle Browser" button removed from header
- `refreshSessionFromBrowserView()` removed from higgsfield.js — no more Electron→Playwright cookie transfer
- Session auth fully managed by Playwright's own `higgsfield-session.json` (persisted after each operation)

**Session expiry recovery (new flow):**
On `SESSION_EXPIRED`: close old Playwright browser → relaunch fresh browser to `higgsfield.ai` → user logs in there → cookies saved → retry. No more BrowserView intermediary.

### Standalone Publish Tab (orchestrator.js, main.js, preload.js, index.html)
The Publish tab is now accessible as a standalone feature from the header — not only during active pipeline runs.

**How it works:**
- "Publish" button in the header opens a project picker showing all projects with completed scene images
- User selects a project → `loadPublishProject(projectId)` sets `_standalonePublishProjectId` in orchestrator
- All publish operations (scoreSceneThumbnails, generateThumbnail, generateSEOMetadata, etc.) use `_getProjectForPublish()` helper which checks standalone ID first, falls back to active pipeline project
- `_getProjectForPublish()` returns normalized row with camelCase aliases (`scriptJson`, `projectDir`) for downstream compatibility
- `_buildPublishState()` constructs a unified publish state object, merging in-memory pipeline state only for the active project
- `approvePublish()` handles both modes: pipeline (resolves approval gate) or standalone (just marks `published_at`)
- **Project auto-close:** Pipeline publish stage auto-resolves when thumbnail generation succeeds (final video + thumbnail both exist on disk). No manual "Finalize Output Package" button needed. `completeProject()` sets `completed_at` + `stage='published'` so `getActiveProject()` no longer returns it. On resume, publish stage detects both deliverables exist and skips the approval gate entirely.

**DB:** `getPublishableProjects()` — INNER JOIN on `project_assets` where type='scene_image' AND status='done', excludes abandoned projects.

**IPC:** `get-publishable-projects`, `get-publish-state-for-project(id)`, `load-publish-project(id)` — all three already existed from initial publish build, now have working orchestrator methods behind them.

**Renderer:** Project selector bar at top of Publish view (hidden during pipeline runs). `openStandalonePublish()` loads projects, `switchPublishProject(id)` loads state + scores scenes. `renderSceneCandidates()` extracted as shared function used by both pipeline and standalone modes.

## Session 13 — Crash Recovery & Pipeline Halt Fixes (April 20, 2026)

### Pipeline Cascade on Browser Close (orchestrator.js)
**Problem:** When user closes the Playwright browser mid-generation (portrait, scene, or clip), the catch block returns `{ success: false, reason: 'cancelled' }` from the stage callback — but never sets `this.cancelled = true`. The check after `runStage()` passes through and downstream stages (elements-setup, scenes, video) all attempt to run with a dead browser, producing a cascade of "Target page, context or browser has been closed" errors.

**Fix:** Set `this.cancelled = true` in all three browser-closed catch paths:
- Portrait generation (line ~1092)
- Scene image generation (staged mode)
- Video clip generation (staged mode)

After `this.cancelled = true`, the `if (this.cancelled) return` guard after each `runStage()` block properly halts the pipeline.

### Throttle Retry Aspect Ratio Bug (higgsfield.js)
**Problem:** When `GENERATION_THROTTLED` fires (Unlimited tier exceeded 180s), the recursive retry called `this.generateImage({ prompt, outputPath, references, useUnlimited: false })` — dropping `aspectRatio`, `referenceCdnUrl`, and `onGenClicked`. Since `aspectRatio` defaults to `'16:9'` in the function signature, a 9:16 portrait retry would silently become 16:9.

**Fix:** Forward all parameters in the throttle retry:
```js
return this.generateImage({ prompt, outputPath, references, useUnlimited: false, aspectRatio: _aspect, referenceCdnUrl, onGenClicked });
```

### Portrait Asset Recovery (orchestrator.js, higgsfield.js)
**Problem:** Unlike cinematic video clips (which have `gen_clicked_at` + Asset library history recovery), portrait generation had no recovery mechanism. If the app crashed after Generate was clicked but before download completed, credits were wasted on re-generation.

**Fix — Three-tier recovery:**
1. **`gen_clicked_at` tracking:** Added `onGenClicked` callback parameter to `generateImage()`. Fires immediately after the Generate button is clicked, calling `db.markAssetGenClicked(asset.id)`. Survives `resetStuckAssets()` on restart.
2. **CDN URL recovery (fast path):** If `asset.cdn_url` is stored (captured via `err.detectedCdnUrl` before crash), direct HTTPS download on restart.
3. **Asset library recovery (full path):** New `recoverTimedOutImage()` method on `HiggsFieldAutomation`:
   - Recreates browser context (clean state)
   - Navigates to `https://higgsfield.ai/asset/image`
   - Scans `figure[data-asset-id]` tiles (most recent first)
   - For each tile: navigates to `/asset/image/{uuid}`, scrapes PROMPT text
   - Compares submitted prompt vs tile prompt using Jaccard word similarity
   - On match (≥75%): clicks Download → saves to portrait path
   - Falls through to re-generation only if both CDN and Asset library fail

**CDN URL preservation:** Error catch now calls `db.markAssetCdnUrl(asset.id, err.detectedCdnUrl)` before resetting the asset, so the URL persists for next-launch recovery.

### Progressive Wait + Soft Throttle (higgsfield.js `_pollJobCompletion`)
**Problem (old):** At exactly 180s, `_pollJobCompletion` hard-threw `GENERATION_THROTTLED`. The catch in `generateImage` nuked the context and recursively re-submitted the same generation on credits — wasting the Unlimited job that was probably 30-60s from completion, burning credits, and adding 30-60s of overhead for re-navigation.

**New approach — Progressive Wait:**
- Base threshold: 180s (unchanged)
- At 90% of current deadline (162s), extend by 10% of original (18s)
- Max 3 extensions → effective deadline: 234s
- During extensions, keeps polling — many "throttled" jobs complete at 190-240s

**New approach — Soft Throttle Flag:**
- When ALL extensions expire (234s), set `this.throttled = true` as a soft flag
- **Do NOT throw** — keep polling until the hard timeout (420s for images)
- If the job completes after the flag is set, **reset the flag** (it wasn't really throttled, just slow)
- If the job truly times out at 420s, the error propagates up normally to the orchestrator's recovery system
- Next generation checks `if (this.throttled)` at the top of `generateImage()` → disables Unlimited → uses credits

**What's eliminated:**
- No more `GENERATION_THROTTLED` error code thrown
- No more recursive `generateImage()` re-submit (context nuke + re-navigation + re-prompt + re-Generate)
- No more wasted Unlimited jobs that would have completed in 30-60 more seconds
- No more credit burn on duplicate submissions

**Last-chance recovery (same session):** If the job hits the 420s hard timeout, `generateImage` catch block waits 30s (grace period for the job to appear in Higgsfield's Asset library), then calls `recoverTimedOutImage()` to scan `/asset/image` for a prompt match. If found: returns a success result (no error, pipeline continues). If not found: throws the original timeout error → orchestrator marks failed → recovery on next restart via `gen_clicked_at`.

### Key Technical Notes
- `_promptSimilarity()` added to HiggsFieldAutomation (same Jaccard word-overlap algorithm as cinema-studio and kling automations)
- Portrait recovery threshold is 75% (lower than scene images' 85%) because portrait prompts are longer and more distinctive, so even partial matches are reliable
- Recovery runs BEFORE `markAssetGenerating()` — if recovery succeeds, no new generation is submitted

## Session 14 — Nano Banana Pro URL Migration (April 20, 2026)

### NAVIGATION_FAILED: Stale URL Redirect
**Problem:** Higgsfield changed the Nano Banana Pro image generation URL from path-based (`/image/nano-banana-pro`) to query-param-based (`/ai/image?model=nano-banana-pro`). The old URL now redirects to `/ai-image` — a marketing landing page with no generation UI. All 4 failsafe attempts in `_navigateWithFailsafe` failed because they all used the same stale `sel.url`.

**Fix:**
1. Updated `higgsfield-selectors.json` URL: `/image/nano-banana-pro` → `/ai/image?model=nano-banana-pro`
2. Added landing page redirect detection in `_navigateWithFailsafe` — if page redirects to `/ai-image`, automatically retries with the correct `/ai/image?model=` URL (future-proofing against stale config)
3. Updated nav menu path (Attempt 3) — "Image" is now a `button` (dropdown), not an `<a>` link. Added selectors for `button:has-text("Image")` and fallback `a[href*="nano-banana-pro"]` / "Create Image Now" CTA
4. Nuclear context recreate (Attempt 4) now uses known-good URL `https://higgsfield.ai/ai/image?model=nano-banana-pro` instead of blindly reusing the potentially-stale `sel.url`

**Selectors confirmed still valid** (verified via live Chrome inspection April 20 2026):
- `#hf:tour-image-prompt` — contenteditable div (prompt input)
- `div[role='textbox']` — fallback (same element)
- `#hf:image-form-submit` — Generate button
- `button[type='submit']` — fallback

**URL history:** `/image/nano_banana_2` → `/image/nano-banana-pro` → `/ai/image?model=nano-banana-pro`

### Server-Side Failure Handling (higgsfield.js)

**Generic failure** (`status: 'failed'`, "Failed — Credits refunded"):
- `_pollJobCompletion` throws `GENERATION_FAILED` with `retryable: true, serverFailed: true`
- `waitForGeneration` propagates immediately (no Layer 2 fallback — nothing to find)
- `generateImage()` auto-retries up to 2 times with fresh context (credits refunded = free retry)
- Saves ~450s vs the old path (poll Layer 2 → timeout → grace period → Asset scan)

**NSFW rejection** (`status: 'failed'` + "NSFW" / "Restricted content detected"):
- `_pollJobCompletion` detects NSFW via API error field keywords ONLY (no UI fallback scan)
- **Session 15 fix:** Removed the `document.body.innerText` UI fallback scan that caused false positives — it picked up "NSFW" badges from PREVIOUS generations in the history panel, incorrectly flagging unrelated prompts (empty location shots like "Corporate boardroom") as NSFW_REJECTED. The API error field is the authoritative source; when it returns `null`/`unknown`, the failure is classified as generic retryable, NOT NSFW.
- Throws `NSFW_REJECTED` with `nsfwRejected: true, retryable: false`
- `generateImage()` propagates immediately (no same-prompt retry — it'll just fail again)
- **Orchestrator** catches `NSFW_REJECTED` in portrait loop:
  1. Calls `_rewriteCharacterDescription(char)` — Claude rewrites `full_prompt_description` with more fictional/stylized traits while keeping ethnicity, wardrobe, and story role
  2. Updates `character_bible` in memory + persists to `script.json` via `_saveScriptState()`
  3. Resets asset to pending, splices it back into the loop, and retries with the new prompt
  4. Max 2 rewrites per character to prevent infinite loops
- If rewrite fails or exceeds 2 attempts → marks asset as failed (manual intervention needed)

### Unlimited Toggle Fix (higgsfield.js — Session 15)

**Problem:** `enableUnlimited()` / `disableUnlimited()` failed consistently — `data-state="off"` persisted after 3 attempts (Playwright click, JS evaluate, inner thumb click).

**Root cause:** As of April 2026, the `[role="switch"]` element is nested inside a react-aria `<button id="react-aria...">` wrapper. The React event handler (onPress) lives on the **parent wrapper button**, not on the switch element itself. Clicking the switch directly dispatches events that the react-aria press handler doesn't intercept.

**Fix:** All three toggle methods (`enableUnlimited`, `disableUnlimited`, `disableExtraFree`) now click `switchEl.parentElement` (the react-aria wrapper) instead of `switchEl` directly:
- Attempt 1: Playwright `.click()` on parent wrapper (dispatches real pointer events)
- Attempt 2: JS `.click()` on parent wrapper (`el.parentElement.click()`)
- Attempt 3: Direct Playwright click on switch itself (legacy fallback)

**Additional finding:** "Extra free gens" toggle (2nd `[role="switch"]`) no longer exists in the UI — only 1 switch now. `disableExtraFree()` harmlessly bails out (`switches.length < 2`).

### isTrusted Click Fix & Reference Upload (cinema-studio-automation.js — Sessions 16-17)

**Problem:** The `+` (reference picker) and `@` (element mention) buttons weren't showing in Playwright. Initially misdiagnosed as a viewport width issue — Cinema Studio appeared to hide buttons below ~1920px. **Actual root cause:** the Cinematic Cameras model wasn't being selected properly because all toolbar button clicks used `el.click()` or `dispatchEvent(new MouseEvent(...))` inside `page.evaluate()` — these produce `isTrusted: false` events that Cinema Studio's React/Radix handlers silently ignore.

**Root cause:** Cinema Studio uses Radix UI components that check `event.isTrusted`. Only events generated by the browser's input system (CDP `Input.dispatchMouseEvent`) have `isTrusted: true`. JavaScript-dispatched events (`el.click()`, `new MouseEvent()`, full pointer event sequences) are all `isTrusted: false` and get silently ignored by the dropdown/popover triggers.

When the model isn't selected properly, the toolbar doesn't show Cinematic Cameras features (the `+` reference picker, `@` element mention).

**Model activation verification signals (updated Session 18):**
- **Empty projects (1st scene):** Background text "CINEMA STUDIO 2.5" is visible — definitive signal.
- **Projects with history (2nd+ scene):** Background text is replaced by the image grid. Use the `@` button instead — it's a no-text SVG button (width 20-60px) in the bottom toolbar that only appears when Cinematic Cameras is truly active. Combined with model button text showing "Cinematic Cameras" for extra confidence.
- **Do NOT use the `+` button as an activation signal** — it's ambiguous with the project creation `+` button elsewhere in the UI.
- The `@` button renders its symbol as an SVG icon (not text), so `textContent === '@'` will always fail. Detect it as: `!text && button.querySelector('svg') && width >= 20 && width <= 60` in the bottom toolbar (`y > vh * 0.65`).

**Fix (Session 17) — Use `page.mouse.click(x, y)` for all Radix UI interactions:**

1. **`_ensureCinematicCamerasModel()`**: Rewritten. Step A (model selector button) and Step C (dropdown option) now return `{cx, cy}` coordinates from `page.evaluate()` instead of clicking. Then `page.mouse.click(cx, cy)` is called — this goes through CDP `Input.dispatchMouseEvent` and produces `isTrusted: true` events that Radix accepts.

2. **`_ensureImageMode()`**: Same fix. The old code dispatched a full `pointerdown→mousedown→pointerup→mouseup→click` sequence via `dispatchEvent()` — all untrusted. Now returns coordinates and uses `page.mouse.click()`.

3. **`_attachLocationReferenceViaUpload()`**: Reverted to straightforward + button click flow (the + button renders correctly once Cinematic Cameras is properly selected). Uses `page.mouse.click()` for the + button. Flow: find + button → click with real mouse → Uploads tab → Upload Images → fileChooser → wait for processing → dismiss picker → verify thumbnail.

**KEY RULE: NEVER use `el.click()` or `dispatchEvent()` for Cinema Studio toolbar buttons.** Always use `page.mouse.click(x, y)` or Playwright locator `.click()` (which also uses CDP). Return coordinates from `page.evaluate()`, then click externally.

**`_scrollToolbarIntoView()`**: Helper called before toolbar interactions. Scrolls the textbox into view and walks parent overflow containers.

### Iterative Script Generation (script-engine.js — Session 18)

**Problem:** The `generateScript()` method used a single API call with `max_tokens: 16384`. For 30-minute cinematic scripts (10 chapters × 3 scenes × 9 lines with blocking, kling_clips, image/animation prompts), one chapter uses ~12K tokens. A full 10-chapter script needs ~120K tokens — far beyond the 16384 limit. Claude would generate 1 chapter, hit the limit, and the truncation recovery would silently close the JSON with just 1 chapter. The pipeline then processed only 3 scenes instead of 30.

**Fix:** Iterative chapter-by-chapter generation:
- **Threshold detection:** Estimates tokens per chapter (cinematic: ~130 tokens/line, staged: ~45 tokens/line). If total exceeds 85% of max_tokens, switches to iterative path. Short scripts (test/standard staged) still use single-call.
- **Batch planning** (`_calculateBatchPlan`): Cinematic = 2 chapters/batch, staged = 3/batch. Batch 1 gets 1 fewer chapter (character bible overhead). 10-chapter cinematic → 6 batches.
- **Batch 1:** Full prompt template + instruction to generate character_bible + first N chapters. Returns `{ title, character_bible, chapters }`.
- **Batches 2+:** Continuation prompt (`_buildContinuationPrompt`) with character bible + compressed summary of prior chapters (dialogue + blocking + locations, no image_prompts to save tokens). Returns `{ chapters: [...] }`.
- **Assembly:** Merges all batch chapters into final script with same structure as single-call.
- **Post-validation** (`_validateScriptCompleteness`): Checks chapter count, scene count, line count, character references. Logs warnings for mismatches (doesn't throw — partial script is better than none).

**Key design decisions:**
- Continuation prompt passes compressed chapters (strips image_prompt, animation_prompt, multi_shot_prompt) to stay within context limits while preserving narrative coherence
- Validation is soft (warns, doesn't throw) because partial scripts can still be useful
- `onProgress` callback remains backward-compatible (receives string updates per batch)
- `_sanitizeBlocking` extracted as reusable helper

### Location Regeneration (orchestrator.js — Session 19-20)

**Feature:** User reviews location thumbnails in the Locations tab, selects bad ones, clicks "Regenerate N Locations". Pipeline deletes the selected image(s) + DB asset(s), resets stage, and re-generates only the selected locations on next restart.

**Data flow:**
1. `_reEmitGateData('locations-ready')` builds hint from `asset.element_name || path.basename(file_path, ext) || String(asset.id)` — file basename is the reliable fallback since element_name can be null
2. UI renders cards with `data-hint`, user clicks to toggle selection, sends `hints[]` to IPC
3. `regenerateLocations(hints)` strict-matches by **exact file basename only** (`fileBase === hintLower`), deletes file + DB asset, clears `pending_approval_gate`, saves regen hints, resets stage to `portraits-done`

**CRITICAL SAFETY RULES (learned the hard way):**
- **NEVER use `includes()` for asset matching** — `"".includes("")` is `true` in JS, so null element_names match everything. This caused a mass-deletion of all 25 locations when only 1 was selected.
- **Strict exact match only** — `fileBase === hintLower`, no bidirectional, no substring
- **Safety cap** — if a single hint matches >1 asset, abort with error log instead of deleting
- **Must clear `pending_approval_gate`** from DB settings during regen, otherwise pipeline re-enters the wait on restart instead of re-running location generation

**Location assets have null element_name in DB** — `setAssetElementName()` is called during creation but element_name stays null for many assets. Root cause: on resume, the `find(a => a.element_name === loc.name)` doesn't match null names, the disk-recovery path at line 3872 has `if (existing)` which is false when find returned undefined, so re-tagging never happens. The file path basename is the reliable identifier.

**Prompt sanitization (HARD RULE):**
- `sanitizeAspectRatio(prompt)` strips ALL aspect ratio, orientation, camera angle, and composition directives before any prompt reaches Higgsfield
- Patterns stripped: bare ratios (`9:16`, `16:9`), orientation format (`vertical composition`, `portrait orientation`), camera directives (`ground-level perspective`, `bird's-eye view`, `aerial shot`, `top-down`), horizon/tilt directives
- The Higgsfield UI `aspectRatio` selector is the **sole authority** for image orientation
- Regen does NOT inject anti-pattern text into prompts — just uses the clean prompt from `_buildLocationPrompt()`
- Applied at line 3929 via `this.sanitizeAspectRatio(locPrompt)` before every Higgsfield submission

### Session 20 — Location Regen Fix (COMMITTED)

**Committed as `29b605d`** — `fix: location regen uses strict basename matching to prevent mass deletion`

Changes: strict exact file basename matching in `regenerateLocations()`, safety cap, hint derivation from file path basename, cleared `pending_approval_gate` during regen, removed anti-pattern camera directive injection, expanded `sanitizeAspectRatio()` with camera angle/horizon/tilt patterns.

### Scene Verification Tab + Soft Delete (Session 21)

**Feature:** Scene Verification tab replaces the generic scenes approval gate for cinematic mode. Shows scene images grouped by location in sequential order so you can spot continuity issues (character position swaps, prop inconsistencies) before committing to expensive Kling video generation.

**Soft-delete pattern (no hard deletes):**
1. **File:** `fs.renameSync()` moves the original to `assets/scenes/.archive/ch05_sc03_cinematic_v1_20260422.png` — version number increments on repeated regens
2. **DB:** `markAssetArchived(id, archivePath, versionTag)` sets `status = 'archived'`, `file_path = archivePath`, `error_message = 'regen:v1'` — all metadata preserved (prompt_used, model_used, credit_cost, timestamps)
3. **New row:** `insertExpectedAssets()` creates a fresh `pending` row for the same chapter+scene
4. **Pipeline skip logic:** existing `existingByKey` check at line ~4607 skips `status === 'done'` only — archived rows have `status = 'archived'`, so they're invisible to the scene loop. The new pending row triggers generation.
5. **Rollback:** rename the archived file back + set status to 'done' on the archived row

**Guards against archived row interference:**
- Stale asset cleanup (line ~4619): `a.status !== 'archived'` filter — archived rows are not stale
- Dedup logic (line ~4631): `.filter(a => a.status !== 'archived')` — archived rows are not duplicates

**Data flow:**
1. `_emitSceneVerificationData(projectId, projectDir)` builds location-grouped scene data from DB + script
2. Emits `cinematic-scene-verification-data` event with `locationGroups[]`, each containing `scenes[]` sorted by chapter/scene
3. UI renders `renderSceneVerificationGrid()` — location header with thumbnail, horizontal scrolling scene strip
4. Click-to-select scenes → "Regenerate N Scenes" button → `regenerateScenes(hints[])`
5. `regenerateScenes()` does soft-delete + stage reset to `portraits-done`
6. On restart: scene loop re-generates only the pending scenes

**IPC:** `regenerate-scenes` → `orchestrator.regenerateScenes(hints)`
**Preload:** `window.api.regenerateScenes(hints)`

### Scene Continuity Context in Vision Blocking (Session 21)

**Problem:** `_refineBlockingWithVision()` ran independently for each scene — it only saw the empty location image. Consecutive scenes at the same location would get independent blocking, causing character position swaps (e.g. woman left/man right in sc03 → man left/woman right in sc04).

**Fix:** Added optional `previousSceneImagePath` parameter to `_refineBlockingWithVision()`. In the scene loop, `lastSceneImageByLocation[locHint]` tracks the most recent output image per location. When the current scene shares a location with a previous scene, the previous scene's output image is included in the Vision API call as a second image with an explicit continuity instruction:

> "Characters who appear in both scenes MUST maintain the same spatial positions UNLESS the script specifically calls for movement."

**Implementation:**
- `lastSceneImageByLocation` dict initialized before the scene loop, updated after each successful generation AND when skipping already-done scenes (so continuity works on resume too)
- Previous scene image resized if >4MB (same FFmpeg path as location image)
- Falls back silently if previous image can't be loaded
- No schema changes — pure in-memory tracking during the scene generation loop

### Session 22 — Dialogue Triage, Gate Ordering, Vision Blocking Override

#### Dialogue Triage Gate

**Problem:** Kling renders gibberish speech when given clips with no actual dialogue. Silent clips (narration-only, action-only) need to be identified and optionally skipped before expensive video generation.

**Solution:** New gate between scene approval and video gen (gate order 1). `_emitDialogueTriageData(projectId)` scans `kling_clips` line refs against the script — clips with zero dialogue lines are auto-marked `status='skipped'` in DB. UI shows all clips with skip/approve toggles. User can approve silent clips as b-roll.

**DB helpers:** `markAssetSkipped(assetId, reason)` and `markAssetUnskipped(assetId)` in `db.js`. `getIncompleteAssets()` now excludes 'skipped' and 'archived' statuses.

**Video gen skip:** In `_runCinematicVideoStage()`, clips with `status='skipped'` are excluded from generation. Counter tracks `dialogueSkipped` for logging.

#### Gate Ordering System

**Problem:** On resume, the generic pending-gate resolver would fire a gate, then the stage-specific code would fire it again (double-fire). Per-clip gates (prompt-preview, clip-review) couldn't be re-emitted on resume because the video gen loop context (clip data, prompt text) wasn't available.

**Solution:** Numeric gate ordering: `{ 'scenes': 0, 'dialogue-triage': 1, 'prompt-preview': 2, 'clip-review': 3 }`. On resume, `_resumedGateOrder` is set to the resolved gate's order. Stage-level gates with order ≤ `_resumedGateOrder` are skipped. Per-clip gates are cleared from DB on resume and the video gen loop re-fires them naturally with actual clip data.

#### Vision Blocking Override (Strip Original CHARACTER POSITIONS)

**Problem:** When `_injectVisionBlocking()` prepends vision-refined character positions to the Kling prompt, the original `CHARACTER POSITIONS:` line remains in the body — giving Kling conflicting instructions.

**Dependency chain:** portrait → character_grid → element → location_image → scene_image (uses vision blocking) → video_clip (uses scene as start frame + blocking). Vision-refined blocking is the ground truth because it's based on what Claude Vision actually saw in the location image (same image used as Kling start frame).

**Fix:** After building the vision preamble, strip original `CHARACTER POSITIONS:` lines from prompt body via regex. Only affects video gen (`_injectVisionBlocking` is never called from scene gen). Logged when stripping occurs.

#### Scene Verification Improvements

- Images display at true aspect ratio (removed forced 16:9)
- Double-click scene image to view the generation prompt in a modal
- Location thumbnails loaded from local DB assets (survives resume)
- `promptUsed` field added to scene verification event data

#### Reset Script Fix

`scripts/reset-to-scene-verify.js` COMMIT section fixed to iterate `clipTypesToClear` array instead of referencing stale `clipType`/`clipTotal` variables. `orchestrator.resetToSceneVerify()` updated to check both `video_clip` and `video_clip_cinematic` types.

### Current Project State (Session 22)

- Dialogue Triage gate operational — survives restarts
- Gate ordering system prevents double-fire on resume
- Per-clip gates (prompt-preview, clip-review) resume correctly via video loop
- Vision blocking override strips conflicting original positions
- Scene Verification tab has true aspect ratio, prompt viewer, local location images
- Git repo reinitialized after NTFS object corruption (fresh commit `f389ac4`)

### Session 23 — Smart Duration, Cinematic Verify Redo, Early SEO

#### Smart Clip Duration

**Problem:** Kling clips were hard-capped at 12s. Dense dialogue clips (20+ words across 3 shots) would cut off mid-sentence because 10s wasn't enough time for accented delivery.

**Solution:** `effectiveDuration` calculation per clip in `_runCinematicVideoStage()`, computed after the final prompt is built (post vision-blocking, sanitization, etc.):
- Count dialogue words from `]: "..."` patterns in the prompt
- Formula: `ceil(words / 2.0) + (shotTransitions × 0.5) + 1.5` (buffer)
- Take the max of script duration vs calculated minimum
- Cap at 15s (Kling's max), floor at 5s
- Logs when bumped: `[DURATION] clipId: script says 10s but dialogue needs ~12s (20 words, 3 shots) → bumped to 12s`

**Key detail:** Shot timings in the prompt body are NOT rewritten — they stay as authored (e.g. "Shot 3 (6-10s)"). The extra seconds act as natural breathing room for Kling to finish the last line rather than cutting hard. Tested and confirmed: lip sync lands perfectly with the buffer approach.

**Kling automation timeout tiers:** 6min (<12s), 8min (12-13s), 10min (14-15s)

**Guard:** Script engine already caps clips at 1-3 dialogue lines with exactly 3 shots. No single clip should need >15s — the structural split-into-multiple-clips rule prevents runaway duration.

#### Cinematic Verify Redo

**Problem:** The verify redo loop (line ~2309) only handled staged (`video_clip`) clips — it used `findLineAndScene()`, `buildVideoPrompt()`, and `generateVideo()` which don't exist for cinematic mode. Rejecting a cinematic clip in verify would hit a dead loop: gate detected pending `video_clip_cinematic` clips but the redo block queried `video_clip` and found nothing.

**Fix:** Mode-aware fork in the redo block. For cinematic mode, calls `_runCinematicVideoStage(projectId, projectDir)` directly. This method already handles resume (skips done/skipped clips, generates only pending ones), so rejected clips (reset to 'pending' by `setVerifyHumanDecision`) get picked up naturally. All prompt building, vision blocking, smart duration, and prompt-preview gate run as normal.

**Gate behavior:** Dialogue-triage gate is outside `_runCinematicVideoStage()` so it's skipped during redo. Prompt-preview gate is inside and fires for each redo clip.

#### Early SEO Generation

**Problem:** SEO metadata (YouTube title/description/tags, Facebook caption) was only generated at publish time — a manual button click. The script already contains everything needed for SEO.

**Fix:** `_generateEarlySEO(projectId, projectDir)` fires as background promise after script approval. Non-blocking — portrait generation proceeds in parallel. Generates YouTube + Facebook metadata via Claude, persists to DB, writes output files. If it fails, publish stage can still generate on demand.

**Skip logic:** Checks `youtube_metadata` column — if already populated, skips early generation (idempotent on resume).

#### Prompt-Preview Counter Fix

**Problem:** The `0 / 0` counter in the generation view header when prompt-preview gate fires. `showGenerationView()` resets the counter, then the prompt-preview event doesn't restore it.

**Fix:** After `showGenerationView()`, immediately call `updateGenProgress(event.clipIndex, event.clipTotal)` using the clip data from the event.

#### Credit Cost Inflation Gate

**Problem:** Kling defaulted to 4K resolution, burning 72 credits for a 12s clip instead of ~18 at 720p. No automation existed to set or verify resolution.

**Fix — 3-layer protection:**
1. **Pre-gen resolution check:** DOM scan for resolution label ("720p", "4K", etc.) in the verification gate. Throws `[PRE-GEN]` if not 720p.
2. **Credit cost gate:** Parses credit number from Generate button text. If cost > `duration × 3` (generous 720p ceiling), throws `[PRE-GEN]` before clicking Generate.
3. **Pipeline pause on inflation:** Instead of retrying (same wrong resolution), pipeline pauses. UI shows error + Resume button. User fixes resolution in Kling, clicks Resume, clip retries. Asset reset to `pending`, loop index decremented to retry same clip.

#### Smart Duration — Field Observations (revisit for tuning)

Data from first production run. Formula: `ceil(words / 2.0) + (transitions × 0.5) + 1.5`

| Clip | Words | Per-Shot Words | Shots | Script | Effective | Result | Prompt Snippet |
|------|-------|----------------|-------|--------|-----------|--------|----------------|
| ch1_sc1_c1 | 19 | 9/6/7 | 3 | 10s | 12s | ✓ Perfect lip sync, all dialogue delivered | S1: "She burned the rice again this morning." S2: "Twelve years married. Still burning rice." S3: "I was rushing. The children needed—" |
| ch1_sc1_c2 | 20 | 7/7/6 | 3 | 10s | 12s | ✓ Perfect lip sync | S1: "You see? Always an excuse. Always." S2: "A good wife wakes before the children." S3: "Exactly. My mother understands these things." |
| ch1_sc1_c3 | 20 | 8/5/7 | 3 | 10s | 12s | ⚠ Lip sync wonky on Shot 3 (5 words + heavy action: "prayer beads clicking, eyes cold and satisfied" + slow push-in). Voice delivered but lips didn't match well. Short dialogue competing with dense action. | S1: "You are right. I will do better." S2: "She says that every Sunday." S3: "Prayer will help her remember her place." |
| ch1_sc2_c1 | 21 | 8/11/7 | 3 | 10s | 13s | ⚡ Shots 1-2 lip-synced, Shot 3 narrated over action (jaw tightens, push-in). Dramatically works as inner monologue — "He humiliated you in front of everyone" felt like unspoken thought. Acceptable. | S1: "Ada. Ada, stop walking. Talk to me." S2: "I know exactly how he is. That is the problem." S3: "He humiliated you in front of everyone." |
| ch1_sc2_c2 | 25 | 9/6/10 | 3 | 10s | 14s | ⚠ Shots 1-2 lip-synced. Shot 3 (5 words): voice delivered but lip sync didn't match. Short dialogue line in final shot. | S1: "He was joking. You know how he is." S2: "I am fine, Ngozi. Leave it." S3: "Every marriage has its difficulties." |
| ch1_sc2_c3 | 26 | 8/7/11 | 3 | 10s | 15s | ⚠ Shots 1-2 perfect (static camera). Shot 3 (11 words, ECU + slow push-in): transition/expression/camera perfect, lip sync broken. Camera movement + dialogue = split attention. | S1: "Ada. When last did you laugh? Real laugh?" S2: "Do not start this today. Please." S3: "Something is wrong. I can see it on your face." |
| ch1_sc3_c1 | 21 | 8/6/7 | 3 | 10s | 14s | ⚠ S1 ✓ perfect, S3 ✓ perfect. S2 WRONG CHARACTER — Ngozi's line delivered by Ada. All static camera. 3-char scene. Blocking conflict: text says Ngozi closest to camera but scene image shows Ada closest. Double @ref in S3 (@emeka + @adaeze) worked fine — visually distinct (male vs female). **Fixed by vision verification (Session 24).** | S1: "Ngozi! You are still here. Good to see you." S2: "Emeka. We were just talking." S3: "Ada, the car is ready. Let us go." |
| ch1_sc3_c2 | 20 | 5/8/8 | 3 | 10s | 13s | ⚠ S1 ✓ perfect, S2 unknown (push-in risk). S3: **dialogue replaced entirely** — scripted "She is always busy. You know how it is." became "ok ok good bye". Kling interpreted "already turning away" action as departure cue and generated contextually fitting but wrong dialogue. Static camera on S3 but action verb ("turning away") competed with dialogue. Blocking now correct (vision verified). | S1: "Yes. I am coming." S2: "I will call you this week, Ada." S3: "She is always busy. You know how it is." |
| ch1_sc4_c1 | 20 | 7/6/7 | 3 | 10s | 13s | ✓ All 3 shots delivered perfectly — dialogue, lip sync, camera, expressions all correct. BUT **American accent** instead of Nigerian English. Voice tone binding issue on elements, not a prompt problem. S3 had slow push-in + dialogue yet lip sync worked — 2-char car interior with minimal body movement may reduce competing action. | S1: "You were looking sad again in there." S2: "I was not. I was smiling." S3: "A dead smile. People notice these things." |
| ch1_sc4_c2 | 18 | 8/8/2 | 3 | 10s | 12s | ✓ Perfect. All 3 shots correct — lip sync, dialogue, expressions. S3: ECU + slow push-in + only 2 words ("I understand") — worked flawlessly. Seated car interior = push-in safe even with ECU and ultra-short dialogue. Confirms: minimal body movement negates the push-in risk. | S1: "I am sorry. I did not mean to—" S2: "You embarrass me when you look like that." S3: "I understand." |
| ch1_sc5_c1 | ~20 | ~7/7/6 | 3 | 10s | 13s | ⚠ S1-S2 fine. S3: complex physical action + dialogue — "wait I dropped something" delivered, "what now we are going" + gesture toward dash, car starts. Ada doesn't get her reaction line, no narration, no lip sync. She picks item from car floor, hands on lap, cut. Physical choreography consumed the animation budget. | S1-S3: (car interior, driver/passenger scene with manual blocking swap) |
| ch2_sc1_c1 | ~20 | ~7/7/6 | 3 | 10s | 15s | ✓ All 3 shots perfect. Split-screen composition preserved — no panel merging, no morphing. Shot scale (closeup/medium) obeyed. Lip sync intact including S3 (push-in + subtle facial action "eyes down, hands pressing"). Ifeoma pronunciation off (expected TTS limitation). | S1-S3: (split-screen bedroom, Ada at vanity, Emeka standing) |
| ch2_sc1_c2 | ~20 | ~7/6/7 | 3 | 10s | 15s | ⚠ S1-S2 ✓. S3: push-in + "turns slightly toward door" + dialogue "I'll handle it" — lip sync crashed. Accent flipped to American. Even minimal physical action in S3 with push-in = failure. | S1: "You cannot manage simple money." S2: "I am asking for our daughter." S3: "I will handle it. Stop bringing this to me every morning." |
| ch2_sc1_c3 | ~20 | ~7/6/7 | 3 | 10s | 13s | ⚠ S1-S2 ✓. S3: physical action executed (opened drawer, reached in, cut) but dialogue "Yes. We are done." never delivered. Two complex physical actions in dialogue shot consumed animation budget. Drawer IS in scene image (grounded). No morphs. Split-screen preserved. | S1: "You said that last week. And the week before." S2: "My phone is ringing. We are done here." S3: "Yes. We are done." |
| ch2_sc2_c1 | 24 | 10/9/5 | 3 | 10s | 15s | ⚠ S1-S2 ✓ (both static). S3: push-in + facial action + 5 words — lip sync doesn't match on "Since when." Short dialogue + push-in = consistent failure. | S1: "Ada. Talk to me. You look like you have not slept." S2: "I am fine. Just tired. The house does not run itself." S3: "Tired. You are always tired. Since when?" |
| ch2_sc2_c2 | 18 | 5/9/4 | 3 | 10s | 12s | ⚠ S1-S2 ✓ (both static). S3: push-in + facial expression + 7 words — lip sync fell apart on "Lagos people talk too much." | S1: "Ngozi. Please. Not today." S2: "I heard something. About Emeka. From Chioma's cousin." S3: "People talk. Lagos people talk too much." |
| ch2_sc2_c3 | 22 | 7/7/8 | 3 | 10s | 15s | ✓ Lip sync + dialogue delivered across all 3 shots including S3. S3 had INSERT→PULL BACK camera change + prop (paper) + dialogue — lip sync survived. BUT prop duplication: one paper became two. INSERT shot may reset animation state, avoiding temporal degradation. | S1: "Ada. This is not gossip. I am your friend." S2: "Then be my friend and leave it alone." S3: "Fine. But take this. His name is Tunde Afolabi." |
| ch2_sc3_c1 | ~15 | ~5/5/1 | 3 | 10s | 13s | ✓ All 3 shots perfect. Single character scene — no attribution ambiguity. S2 had push-in + dialogue and delivered. Solo character may negate push-in lip sync degradation. | S1: "Barrister Tunde Afolabi. What do you know, Ngozi?" S2: "Nothing is wrong. Nothing is wrong with my home." S3: "Nothing." |
| ch2_sc4_c1 | 22 | 7/8/7 | 3 | 10s | 15s | ✓ All 3 shots perfect. All static cameras, minimal grounded actions (stirring, pencil). Adult/child pairing = no attribution confusion. | S1: "Mummy. Why is Daddy always angry?" S2: "Daddy is not angry. He is just busy. Men get tired." S3: "He does not look tired. He looks angry." |
| ch2_sc4_c2 | 14 | 6/7/0 | 3 | 10s | 11s | ✓ S1 static + dialogue perfect. S2 push-in + dialogue on single character framing — delivered. S3 no dialogue: INSERT on spoon hand → tilt up to face, perfectly executed. Camera movement without dialogue = safe. | S1: "Ifeoma. Focus on your homework, my love." S2: "Mummy. I do not want to marry someone like Daddy." S3: (no dialogue — visual only) |
| ch2_sc5_c1 | 29 | 9/10/10 | 3 | 10s | 15s | ⚠ S1-S2 delivered. S3: dialogue delivered but off-screen — Kling cut to INSERT of hands on bedpost instead of showing face. 29 words total high for 15s (~2 words/sec). Single character, not attention-split — model ran out of visual budget. | S1: "I said handle it. I do not repeat myself." S2: "The account must be clean before Friday. You hear me?" S3: "Nobody will find anything. I have made sure of that." |
| ch2_sc6_c1 | 22 | 6/8/8 | 3 | 10s | 14s | ⚠ S1-S2 delivered. S3: ECU on eyes — dialogue delivered off-screen because framing excluded the mouth. Kling can't lip sync what it can't show. Single char. New rule: ECU on eyes + dialogue = voiceover at best. | S1: "Clean. He said clean the account." S2: "What account? He never told me about any account." S3: "Who is he talking to at this hour?" |
| ch2_sc7_c1 | 22 | 6/8/2 | 3 | 12s | 12s | ✓ All dialogue delivered with lip sync, mouth visible. S2 push-in + dialogue worked (single char). S3 ECU on face (not just eyes) = lip sync intact. Phantom props: paper + drawer hallucinated but didn't compete with dialogue. 2-word S3 delivered cleanly. | S1: "Abuja Grand Prestige Hotel. November the fourteenth." S2: "He was in Port Harcourt. He told me Port Harcourt." S3: "He lied." |
| ch3_sc1_c1 | 20 | 6/7/7 | 3 | 10s | 13s | ✓ All 3 shots perfect. All static, two characters well-separated (foreground/mid-ground), minimal body actions. | S1: "Ada, relax. It is just a party." S2: "Emeka said he might come tonight." S3: "So? You are allowed to be here too." |
| ch3_sc1_c2 | 21 | 7/6/8 | 3 | 10s | 13s | ⚠ S1 ✓ (static). S2 push-in on single char framing in multi-char scene — delivered. S3: static CU + 8 words — lip sync fell apart. Push-in in S2 may have depleted budget for S3 even though S3 was static. | S1: "You know it is never that simple." S2: "Tonight, let it be simple. Come." S3: "Wait. Ada. Wait — do not look left." |
| ch3_sc2_c1 | 20 | 7/6/7 | 3 | 10s | 14s | ⚠ S1-S2 ✓ (both static). S3: push-in + dialogue + multi-char — lip sync fell apart. Pattern holds. | S1: "You always look good in white, Emeka." S2: "And you always know what to say." S3: "I mean it. You belong in rooms like this." |
| ch3_sc2_c2 | 20 | 8/5/7 | 3 | 10s | 13s | ✓ All 3 shots perfect lip sync. All static. Minor hand morphing on Chidinma — cosmetic only. | S1: "We both do. That is why I chose you." S2: "Chosen. That is a big word." S3: "Do not ruin the night, Chidinma." |
| ch3_sc3_c1 | 20 | 6/7/7 | 3 | 10s | 13s | ✓ All dialogue delivered. All static. 3-char scene — visually distinct, well-separated. S3: Kling added its own insert shot of Ada after Emeka's gesture — creative improvisation, dialogue still landed. | S1: "Adaeze. I did not expect you here." S2: "Ngozi invited me. Is that a problem?" S3: "Of course not. Come, meet someone." |
| ch3_sc3_c2 | 18 | 7/6/5 | 3 | 10s | 12s | ✓ All 3 shots perfect. All static, 3-char scene. Light word density. | S1: "This is Chidinma Obi. My business associate." S2: "Mrs. Okafor. I have heard so much." S3: "Have you. How interesting." |
| ch3_sc3_c3 | 19 | 6/6/7 | 3 | 10s | 13s | ⚠ S1 ✓. S3: ECU on eyes — dialogue "Yes. I know exactly who he is." not delivered at all (dropped entirely, not even voiceover). Silent reaction shot only. Kling also repositioned Chidinma from standing to seated — blocking drift in 3-char scene. | S1: "Chidinma handles our Port Harcourt contracts." S2: "Your husband is a very brilliant man." S3: "Yes. I know exactly who he is." |
| ch3_sc4_c1 | ~20 | ?/?/? | 3 | 10s | ~13s | ⚠ ALL STATIC multi-char — S3 dialogue completely ignored. No narration, no lip sync. Transition to S3 executed but dialogue dropped. FIRST all-static multi-char failure — breaks the "all-static = safe" rule. | S3 dialogue dropped entirely |
| ch3_sc4_c2 | 22 | ?/?/? | 3 | 10s | 15s | ⚠ S2 slow push-in in multi-char scene. S3: dialogue REPLACED — Kling fabricated "I will move" instead of scripted line. Worse than lip sync failure — model substituted its own words. Second dialogue-replaced instance. | S3: Kling said "I will move" instead of scripted dialogue |
| ch3_sc4_c3 | 20 | 10/4/6 | 3 | 10s | 14s | ✓ All dialogue lip synced well. All static. S3 INSERT→CU static — INSERT cut likely reset animation state. Phantom prop: "folded paper receipt" morphed out of thin air (not in scene image). | S1: "I do not know why. I just — I kept it." S2: "What is it? Show me." S3: "A hotel receipt. From his jacket." |
| ch3_sc4_c4 | 8 | 8 | 1 | 10s | 11s | ✓ Perfect. Single shot, static, wide, 8 words. Name mispronunciation (constant). Phantom prop: paper/receipt from thin air (continuity ref, not in scene image). | S1: "Ada. You need to call Tunde tonight." |
| ch3_sc5_c1 | 24 | 8/7/9 | 3 | 10s | 15s | ⚠ Kling understood phone call context — added phone audio filter to Ngozi's off-screen dialogue (S1, S3). Single char in frame (Tunde). S2: lip sync fell off on "It is past ten. What happened?" (7 words, static, single char — should have been safe). Visual-state fix confirmed: "jacket off, sleeves rolled" stripped by 3rd Vision pass. | S1: "Tunde. It is Ngozi. I need your help." S2: "Ngozi. It is past ten. What happened?" S3: "My friend. Her husband — his name is Emeka Okafor." |
| ch3_sc5_c2 | 19 | 4/7/8 | 3 | 10s | 13s | ⚠ Phone call handled well again. S1-S2 ✓. S3: ECU + slow push-in on single char — mouth visibly moving but dialogue delivered off-screen. ECU too tight for lip sync to read visually even with mouth partially visible. Push-in on single char still safe (no merge/morph). | S1: "Say that name again." S2: "Emeka Okafor. He is abusing her, Tunde." S3: "I know that name. I know it very well." |
| ch3_sc5_c3 | 22 | 7/9/6 | 3 | 10s | 14s | ⚠ Phone call context maintained. S1 ✓ (Ngozi off-screen). S2: Tunde's lip sync fell off on "this will get complicated" — 9 words, static, medium, single char, should have been safe. Third clip in this phone scene where Tunde's on-screen lip sync breaks. Phone-to-ear pose or speaker alternation may be a factor. S3 ✓ (Ngozi off-screen, CU on Tunde's reaction). | S1: "Can you help her or not?" S2: "I can. But Ngozi — this will get complicated." S3: "Complicated is better than what she has now." |
| ch3_sc5_c4 | 24 | 6/7/11 | 3 | 12s | 15s | ⚠ Phone call context maintained. S1-S2 ✓. S3: ECU + very slow push-in + action ("lowers the phone") + dialogue + phantom prop text — WARDROBE MORPH: Tunde changed from dark suit to white traditional outfit mid-clip. Lip sync fell apart. S3 overloaded: camera move + action + dialogue + prop ref. NEW failure mode: character appearance drift under heavy S3 load. | S1: "Bring her to my office. Tomorrow morning." S2: "We will be there. Thank you, Tunde." S3: "This woman has no idea what her husband has done." |
| ch4_sc1_c1 | 19 | 6/7/6 | 3 | 10s | 13s | ⚠ S1-S2 ✓ (both static). S3: slow push-in + dialogue + multi-char — lip sync fell off on "I will try." Pattern holds. | S1: "Thank you for coming, Mrs. Okafor." S2: "Ngozi said you could help me." S3: "I will try. Tell me about your finances." |
| ch4_sc1_c2 | 17 | 4/7/6 | 3 | 10s | 12s | ⚠ S1-S2 ✓ (both static). Shot directions followed 100%. S3: slow push-in + CU + dialogue + multi-char — lip sync fell off slightly on "He said it was easier his way." Pattern holds. | S1: "My husband handles everything." S2: "Do you have a joint account with him?" S3: "He said it was easier his way." |
| ch4_sc1_c3 | 20 | 6/7/7 | 3 | 10s | 14s | ⚠ S1-S2 ✓ (both static). S3: slow push-in + dialogue + multi-char — dialogue DROPPED entirely. Only push-in and shot direction executed, no dialogue at all. Worse than lip sync failure. | S1: "Is your name on any property document?" S2: "The house? I assumed it was both of us." S3: "You assumed. But you have never checked." |
| ch4_sc2_c1 | 20 | 6/7/7 | 3 | 10s | 13s | ✓ All static, multi-char. S3 lip sync ~98% accurate. All-static rule holds. | S1: "You have legal options, Mrs. Okafor." S2: "I am not looking for a divorce." S3: "I did not say divorce. I said options." |
| ch4_sc2_c2 | 20 | 6/7/7 | 3 | 10s | 12s | ⚠ S1 ✓ (static). S2: Kling improvised INSERT shot of card being extended — dialogue delivered off-screen over insert. S3: push-in + CU + action + dialogue + multi-char — lip sync survived. Failure shifted to S2 instead of S3. | S1: "I just want it to stop." S2: "Then take my card. Think about it." S3: "What if thinking makes things worse?" |
| ch4_sc3_c1 | 11 | 0/0/11 | 3 | 8s | 8s | ⚠ Single char (Tunde). S1-S2 non-dialogue reaction shots — clean, no gibberish. S3: slow push-in + CU + single char — lip sync fell off. Only dialogue in the entire clip. Contradicts "single char push-in = safe" — may be pose-specific (leaning forward, looking down at documents). | S3: "She does not even know her own name is in here." |
| ch4_sc4_c1 | 13 | 3/7/3 | 3 | 10s | 10s | ⚠ S1-S2 ✓. S3: slow push-in + action ("takes a slow sip of whiskey") + dialogue + multi-char — clip ended on the whiskey sip, dialogue never delivered. Action consumed remaining budget entirely. | S1: "You are late." S2: "I was with Ngozi. I told you this morning." S3: "Ngozi. Always Ngozi." |
| ch4_sc4_c2 | 20 | 6/6/8 | 3 | 10s | 13s | ⚠ ALL STATIC multi-char. S1-S2 ✓. S3: CU on Adaeze, static — Kling improvised mug-drinking action (mug visible in scene image), consumed S3 entirely, dialogue dropped. Shot direction was subtle facial acting ("jaw is set") but Kling animated the prop instead. NEW: Kling prop improvisation overriding shot direction. | S1: "We had lunch. That is all." S2: "Lunch does not take six hours, Adaeze." S3: "We talked. Time passed. I am home now." |
| ch4_sc4_c3 | 10 | 2/3/5 | 3 | 10s | 10s | ✓ No lip sync issues. Very low word count (~1 word/sec). Emeka stood up in S1 matching shot direction despite being seated in scene image. Body language on point. 3rd Vision pass fired but guardrail violation (verb count +1 in S1) caused fallback to original prompt. | S1: "Come here." S2: "Emeka, I am tired." S3: "I said come here." |
| ch4_sc5_c1 | 17 | 4/5/8 | 3 | 10s | 11s | ✓ S3 push-in + CU + multi-char — lip sync survived. Physical confrontation (grabbed her arm) executed well. Phantom prop: handbag morphed out of thin air then dropped to floor (not in scene image). S3 dialogue delivered despite push-in — possible exception to multi-char push-in rule when word count is low and action is intense. | S1: "Where were you really?" S2: "Let go of me." S3: "You do not give me orders in my house." |
| ch4_sc5_c2 | 7 | ?/?/7 | 3 | 10s | 11s | ⚠ S3: ECU + slow push-in on Adaeze + multi-char scene + 7 words "I am not afraid of you, Emeka" — lip sync failed. Pattern holds: S3 push-in + dialogue + multi-char = near-certain failure. Camera movement killed delivery. | S3: "I am not afraid of you, Emeka." |
| ch4_sc6_c1 | 9 | ?/?/9 | 3 | 10s | 12s | ⚠ Hallway scene: S1 WIDE (Ifeoma + Mama Okafor, static) ✓, S2 CU on Mama Okafor (static) ✓, S3 CU on Ifeoma (static) — dialogue "But she is in there alone with him" (9 words) never delivered. PROP IMPROVISATION: Kling conjured an off-shoulder pink bag out of nowhere despite backpack being referenced in character portrait/grid but NOT in scene image. No bag was visible in the start frame. Kling substituted its own prop interpretation for scene context, consuming dialogue budget. Props in character descriptions don't translate to scene; props must be baked into location prompts. | S1: "What happened?" S2: "He came for her. In the morning." S3: "But she is in there alone with him." |
| ch4_sc6_c2 | 22 | 7/7/8 | 3 | 10s | 13s | ✓ Same hallway, Ifeoma + Mama Okafor. S1 WIDE static (7 words), S2 CU on Ifeoma slow push-in + turn + dialogue "That is not an answer, Grandma" (7 words) — LANDED (single-char push-in works when isolated), S3 CU on Mama Okafor static "Forget what you heard. Go. Now." (8 words) — minor lip sync fail on "Go. Now." Staccato phrasing may be hard for Kling. | S1: (7 words) S2: "That is not an answer, Grandma" S3: "Forget what you heard. Go. Now." |
| ch4_sc7_c1 | 17 | 6/4/7 | 3 | 10s | 12s | ⚠ Bedroom scene, Ifeoma at desk, Adaeze on bed. All static cameras. S1 WIDE static Adaeze speaks (6 words), S2 CU on Ifeoma static "I heard you, Mummy" (4 words) — single word failure "Mummy" dropped. Trailing word cut. S3 CU on Adaeze static (7 words) — landed. | S1: (6 words) S2: "I heard you, Mummy" S3: (7 words) |
| ch4_sc7_c2 | 14 | 6/6/7 | 3 | 10s | 13s | ⚠ Same bedroom continuation. S1 WIDE static, Ifeoma delivers "Mummy. Why do you stay?" (6 words) — dialogue delivered but stiff/static character, no lip sync on WIDE (face too small). S2 ECU on Adaeze slow push-in, "Ifeoma —" (1 word) — no tears animated, stiff. S3 CU on Ifeoma static "You do not have to answer" (7 words) — FAILED, "reaches out" direction caused big arm raise, dialogue dropped. | S1: "Mummy. Why do you stay?" S2: "Ifeoma —" S3: "You do not have to answer" |
| ch4_sc8_c1 | 55 | 0/5/0 | 3 | 8s | 10s | ✓ Bathroom, single character Adaeze. S1 WIDE static no dialogue — clean. S2 MEDIUM static "Mummy. Why do you stay?" (5 words) — landed clean. S3 ECU slow push-in, no dialogue, just visual — clean. Textbook safe setup: dialogue on MEDIUM static, camera movement reserved for non-dialogue shot. Single character on dialogue eliminates multi-char merge risk. | S2: "Mummy. Why do you stay." |
| ch5_sc1_c1 | 56 | 6/8/8 | 3 | 12s | 14s | ⚠ Ngozi's apartment, Tunde + Ngozi multi-char scene. S1 WIDE ESTABLISHING static, Tunde faces camera "Ngozi, sit down. This is serious." (6 words) — lip sync WORKED because Tunde's face visible to camera on WIDE. Proves WIDE ≠ automatic failure; face visibility is the constraint, not shot size. S2 MEDIUM static on Ngozi "You are scaring me, Tunde. Just talk." (8 words) — landed. S3 CU on Tunde slow push-in "Emeka has a shell company. Fake construction subsidiary." (8 words) — lip sync FAILED, push-in killed dialogue delivery despite face visible and single-char isolation. Push-in failure in single-char S3 contradicts ch4_sc8_c1 where single-char S3 push-in was clean. Difference: ch4_sc8_c1 had no dialogue on push-in shot, ch5_sc1_c1 had 8 words on push-in. Word count on single-char push-in may have ceiling. | S1: "Ngozi, sit down. This is serious." S2: "You are scaring me, Tunde. Just talk." S3: "Emeka has a shell company. Fake construction subsidiary." |
| ch5_sc1_c2 | 23 | 6/7/10 | 3 | 10s | 13s | ⚠ Same apartment continuation, Tunde + Ngozi multi-char. S1 WIDE static Ngozi "Fake? What does that mean exactly?" (6 words) — face visible, landed. S2 MEDIUM static Tunde "He has been laundering money. Government contracts." (7 words) — lip sync failed on "government contracts", gesture direction "taps documents firmly with two fingers" ate dialogue budget. S3 MEDIUM static Ngozi "Okay. Emeka is a criminal. We knew he was bad." (10 words) — lip sync failed, "jaw tightens, bitter laugh escaping" body language ate budget. Pattern observed: directed gestures/actions in S2-S3 compete with lip sync. | S1: "Fake? What does that mean exactly?" S2: "He has been laundering money. Government contracts." S3: "Okay. Emeka is a criminal. We knew he was bad." |
| ch5_sc1_c3 | 23 | 8/7/8 | 3 | 12s | 14s | ⚠ Same apartment continuation. S1 WIDE static Tunde "Ngozi. Adaeze's signature is on seven filings." (8 words) — face visible, landed. S2 ECU static Ngozi "Her signature? She signed for his fraud?" (7 words) — lip sync failed on "her signature", facial expression direction ("face drains, eyes widening in horror") competed with dialogue. S3 CU slow push-in Tunde "She did not sign. Someone signed for her." (8 words) — LANDED. Push-in with minimal body direction ("eyes hold steady") worked. Insight: push-in succeeds when body language is minimal/static despite camera movement. | S1: "Ngozi. Adaeze's signature is on seven filings." S2: "Her signature? She signed for his fraud?" S3: "She did not sign. Someone signed for her." |
| ch5_sc2_c1 | 21 | 9/6/6 | 3 | 10s | 13s | ⚠ Ngozi's apartment, Adaeze on sofa, Ngozi by window. All static. S1 WIDE ESTABLISHING static Ngozi "Ada. I need you to look at something." (9 words) — lip sync failed on "something", Ngozi's face turned away from camera. S2 MEDIUM static Adaeze "You called me urgently. What happened?" (6 words) — pronunciation issue "urgently" became "urgencently" (TTS issue). S3 MEDIUM static Ngozi "Tunde brought documents. About Emeka's company." (6 words) — lip sync failed, "turns slightly toward Adaeze" direction may have eaten budget. Face position matters more than camera angle for lip sync — dialogue fails when speaking character's face turned away even in static shot. | S1: "Ada. I need you to look at something." S2: "You called me urgently. What happened?" S3: "Tunde brought documents. About Emeka's company." |
| ch5_sc2_c2 | 18 | 5/5/8 | 3 | 10s | 12s | ⚠ Same apartment continuation. S1 WIDE slow push-in, Adaeze leaning forward, two chars. "What kind of documents, Ngozi?" (5 words) — Kling morphed documents into her hands (prop improvisation) but dialogue LANDED despite push-in. S2 CU static Ngozi "Company filings. Fraud filings. Look at page three." (8 words) — no issues, clean. S3 ECU static Adaeze "That is my name. That is my signature." (9 words) — dialogue NEVER DELIVERED. "Face goes pale, lips barely moving" direction implicitly suppressed lip sync. NEW category: shot directions describing suppressed emotional states can contradict lip sync animation requirements, causing dialogue dropout. | S1: "What kind of documents, Ngozi?" S2: "Company filings. Fraud filings. Look at page three." S3: "That is my name. That is my signature." |

**Emerging patterns (updated Session 26, 45 clips):**
- **Push-in + dialogue in multi-character scenes = near-certain lip sync failure.** 13/17 multi-char clips with push-in S3 failed. Exceptions: car interior (ch1_sc4_c1/c2), INSERT→PULL BACK (ch2_sc2_c3).
- **Single-character scenes are push-in safe.** ch2_sc3_c1, ch2_sc4_c2, ch2_sc7_c1 all delivered push-in + dialogue. No second character to split attention.
- **Camera movement WITHOUT dialogue = always safe.** ch2_sc4_c2 S3 INSERT→tilt, no dialogue — perfect. Full budget when not lip syncing.
- **ECU on eyes + dialogue = dialogue dropped.** ch2_sc6_c1: voiceover only. ch3_sc3_c3: dialogue not delivered at all. Framing excludes mouth = no lip sync possible. ECU on face (mouth visible) works fine (ch2_sc7_c1).
- **Push-in in S2 can deplete S3 budget.** ch3_sc1_c2: S2 push-in delivered, but S3 (static) still failed lip sync. Budget depletion carries across shots.
- **Word density ceiling emerging.** ch2_sc5_c1: 29 words / 15s = dialogue delivered off-screen. Model ran out of visual budget at ~2 words/sec density.
- **Blocking drift in 3-char scenes.** ch3_sc3_c3: Kling repositioned Chidinma from standing to seated. More characters = more spatial decisions = more drift risk.
- **Kling creative improvisation.** ch3_sc3_c1: model added its own insert shot after a gesture direction. Dialogue still landed — improvisation not always negative.
- **INSERT shot may reset animation state.** ch2_sc2_c3 S3 had INSERT→PULL BACK + prop + dialogue — lip sync survived. Camera cut may give Kling a fresh start vs continuous push-in degradation.
- **Split-screen compositions preserved.** ch2_sc1_c1/c2/c3 all maintained two-panel split-screen. No merging or morphing.
- **Prop duplication failure mode.** ch2_sc2_c3: one paper became two. Kling understands prop concept but doubles the action.
- **Physical action + dialogue in S3 = dialogue dropped.** ch1_sc5_c1 and ch2_sc1_c3 both executed actions but dropped dialogue entirely.
- **All-static + well-separated characters = mostly safe but not guaranteed.** ch2_sc4_c1 (adult at stove, child at table) perfect. ch3_sc4_c1: FIRST all-static multi-char failure — S3 dialogue dropped entirely. 7/8 all-static multi-char clips succeed, but it's not a guarantee.
- **Departure action + dialogue = Kling substitutes its own words.** ch1_sc3_c2 S3. WORSE than lip sync issues.
- **Accent flip (American) is a recurring constant.** Not prompt-fixable. Igbo/Yoruba name pronunciation also consistently off.

**Shot 3 failure taxonomy (34 clips):**
| Type | Count | Examples | Cause |
|------|-------|---------|-------|
| Perfect (all static) | 7 | ch1_sc1_c1/c2, ch2_sc4_c1/c2, ch3_sc1_c1, ch3_sc2_c2, ch3_sc3_c1/c2 | All static cameras OR no dialogue in S3 |
| All-static failure | 1 | ch3_sc4_c1 | All static multi-char but S3 dialogue dropped — first outlier |
| Perfect (single char) | 3 | ch2_sc3_c1, ch2_sc1_c1, ch2_sc7_c1 | Single character, push-in safe |
| Perfect (INSERT cut) | 2 | ch2_sc2_c3, ch3_sc4_c3 | INSERT cut may reset animation state |
| Lip sync wonky | 7 | ch1_sc1_c3, ch1_sc2_c2/c3, ch2_sc2_c1/c2, ch3_sc1_c2, ch3_sc2_c1 | Push-in + dialogue in multi-char scene |
| Dialogue dropped | 2 | ch1_sc5_c1, ch2_sc1_c3 | Complex physical action consumed budget |
| Dialogue off-screen | 3 | ch2_sc5_c1, ch2_sc6_c1, ch3_sc3_c3 | ECU on eyes (no mouth) or word density ceiling |
| Narrated (no lip sync) | 1 | ch1_sc2_c1 | Push-in + heavy action |
| Wrong character | 1 | ch1_sc3_c1 | Blocking mismatch (fixed) |
| Dialogue replaced | 2 | ch1_sc3_c2, ch3_sc4_c2 | Departure action verb or push-in budget depletion |

**Actionable rules (refined, Session 26, 31 clips):**
> 1. If a shot has dialogue AND multiple characters, keep the camera STATIC. Push-in + dialogue only safe in single-character scenes or with INSERT camera cuts.
> 2. Reserve camera movements (push-in, tilt, dolly) for non-dialogue shots — they execute perfectly without lip sync competition.
> 3. NEVER pair ECU on eyes/hands/body parts with dialogue. If no mouth is visible, dialogue will be dropped or delivered off-screen. ECU on face (mouth visible) is fine.
> 4. Shot 3 should have the SIMPLEST dialogue line — fewest words, no action verbs that imply motion/departure.
> 5. Avoid complex physical action + dialogue in the same shot. If both are needed, split into two clips.
> 6. Avoid departure action verbs ("turning away", "walking off"). Kling substitutes its own dialogue.
> 7. Push-in in S2 can deplete animation budget for S3 even if S3 is static. Consider all-static when S3 dialogue is critical.
> 8. Word density: keep under ~1.5 words/sec. 29 words / 15s caused off-screen delivery.
> 9. CHARACTER POSITIONS must describe scene image as-rendered. **RESOLVED:** `_verifyBlockingWithSceneImage()`.
> 10. Split-screen and non-standard compositions are safe if source image framing is clear.

**Open questions:**
- Does INSERT camera cut genuinely reset animation state, or was ch2_sc2_c3 an outlier?
- Is the push-in failure purely about multi-character attention splitting, or also temporal budget depletion?
- Word count threshold below which Kling skips lip animation (≤5 words)?
- Is narration-as-inner-monologue reliable enough to be intentional?
- At what clip count do we have enough data to implement automated rules in the script prompt?
- 3-char blocking drift: is it cumulative across clips in the same scene, or random?

**Known upstream issues (not fixable in 3rd Vision pass):**
- **Cultural grounding in scene images and video prompts.** ch4_sc4_c1: "Okafor living room" rendered with European family photos on walls and CNN on TV screen. Scene image models default to Western imagery for generic interior props. Two prompt-level fixes needed:
  - **Scene image generation (Cinema Studio prompt):** Add cultural context preamble to location descriptions — e.g. "In a Nigerian city. Nigerian home with African art on walls, Nigerian family photographs, local TV channel (Channels TV, AIT, TVC News)." Currently location descriptions are generic ("living room," "law office").
  - **Kling video prompt scene setting line:** Reinforce cultural context — "Inside a Nigerian household" not just "Inside the Okafor living room." The scene setting line is the first thing Kling reads after CHARACTER POSITIONS.
- **Props should be baked into location images.** Currently props appear as phantom objects (morphing out of thin air) or trigger unwanted Kling improvisation when visible in the scene image but not directed. Fix: include story-relevant props in the location prompt so they're rendered into the location image before character compositing. Props become static scenery in the background — Kling treats them as environment, not interactable objects. Examples: "law office with mahogany desk, manila case folder on desk, brass desk lamp" rather than just "law office with mahogany desk." When a shot direction then calls for prop interaction, Kling has a real visual reference instead of hallucinating. Upstream change at script generation: each scene's location description includes key story props. No pipeline architecture change needed, just richer location prompts.
  - **CRITICAL:** Do NOT bake props into character descriptions, portraits, or grids. Kling reads character visuals as "this is what they look like" and ignores the wardrobe/held-item context from portrait generation. If props are mentioned only in character portraits but NOT in the location image, Kling will conjure its own visual interpretation or improvise props it sees in the scene image instead. Prop descriptions belong ONLY in location/scene prompts where they render into the background before character compositing.
- **Single wardrobe per character across all scenes.** Currently 1 character = 1 portrait = 1 grid = 1 outfit for the entire production. Unrealistic for long-form: Adaeze should wear homely clothes at home, formal outfit at the lawyer's office, different attire at church/party, etc. Future architecture: each outfit becomes its own element in the pipeline (`@adaeze_home`, `@adaeze_formal`, `@adaeze_church`). Each outfit gets its own portrait grid generated from the original base portrait (face anchor preserved, wardrobe inpainted). Script engine associates outfit context with each scene based on location type. Character bible expands from one entry per character to one entry per character-outfit combo. Downstream pipeline (scene image, Kling prompts) stays the same — just references the outfit-specific element ID. Key constraint: all outfit variants must preserve face consistency from the original portrait. This is a significant feature for long-form productions but not mid-generation work.
- **Script-vs-scene-image time-of-day mismatch.** ch3_sc5_c1: dialogue says "It is past ten" (late night) but scene image lighting doesn't match — not dark enough. The scene image is generated earlier in the pipeline and its lighting prompt may not reflect the script's time-of-day cues. This is a continuity error between the script stage and scene image generation stage. The 3rd Vision pass can't fix it — it takes the scene image as-is. Would need to be addressed upstream: either scene image generation prompt should extract time-of-day from the script, or the script should avoid specific time references that conflict with visual rendering.
- **Face visibility to camera determines lip sync, not shot size.** Dialogue fails when the speaking character's face is NOT visible to camera, regardless of shot size. WIDE shots CAN deliver lip sync if the character's face is visible to camera. Example: ch5_sc1_c1 S1 WIDE ESTABLISHING with Tunde's face visible — "Ngozi, sit down. This is serious." (6 words) lip sync WORKED. Counterexample: ch4_sc7_c2 S1 WIDE static with Ifeoma's back to camera — "Mummy. Why do you stay?" (6 words) delivered as stiff/static voiceover with no facial animation. Root issue: shot/reverse-shot blocking rules (180-degree rule, character always faces camera during dialogue) not applied at blocking stage. Future guardrail to implement in cinematography composition stage (see upstream work item below).
- **Cinematography rules in shot direction generation** — Apply proper cinematography composition at the blocking/shot direction stage to eliminate face-visibility failures at the source:
  - **180-degree rule:** Establish axis between speaking character and other character(s), keep camera positioned on one side of the axis for consistent eyelines and camera clarity
  - **Shot/reverse-shot pattern for dialogue:** Speaking character always faces camera (or minimum 3/4 profile, never back-to-camera). Listening character can take any angle. Each dialogue exchange gets reverse shot.
  - **Frame dominance:** Speaking character receives frame dominance (larger, centered, higher); listening character is frame-secondary (offset, smaller, or partially visible)
  - **No full back-to-camera or deep profile on dialogue.** Only front-facing or 3/4 profile when character is speaking
  - **Blocking rule (upstream implementation):** When shot direction generator assigns dialogue to a character, validate that the character's position vector allows front-facing or 3/4 profile. If blocking places character with back to camera, either re-block the character or move the dialogue to the other character.
  - This solves the face-visibility problem upstream rather than adding downstream guardrails
  - **Implementation timing:** After 150-clip observation gathering is complete, codify these rules into the blocking generator and shot direction prompt templates. Current manual fixes at script stage validate the concept; automation is the next iteration.
- **Dialogue-to-scene-image reconciliation** — Dialogue is written at the script stage before scene images exist, causing lines that reference spatial/environmental elements not visible in the rendered scene. Examples: "Close the door behind you" when no door is visible, character already standing at desk; "hand me that file" when no file/desk surfaces exist in the scene image. Two potential solutions:
  - **Option A: Dialogue-aware scene image generation** — Extract spatial/environmental cues from dialogue lines ("close the door," "hand me that file," "sit down") and feed them as constraints to the scene image prompt. If dialogue references a door, ensure the scene image includes a visible door. Solves at the source but requires reworking the scene image prompt builder to parse dialogue for spatial cues — more invasive change.
  - **Option B: Post-image dialogue reconciliation (recommended)** — After scene image is generated, run a Vision pass that reads the image + dialogue together and flags lines referencing things not visible in the scene. Flagged lines get rewritten to preserve the dramatic beat while matching visual context (e.g., "Close the door behind you first" → "Sit down. We need to talk about this carefully."). Fits existing pipeline pattern — same concept as shot direction reconciliation applied one level up. Less invasive.
  - **Option C: Bidirectional** — Both A and B together. Belt and suspenders.
  - **Example:** ch5_sc3_c1 — "Close the door behind you first" but scene image shows both characters already at the desk with no door context.
  - **Implementation timing:** After 150-clip observation gathering is complete.

### Session 24 — Vision Blocking Verification, Resolution Enforcement

**Problem: Blocking text ↔ scene image mismatch.** `_refineBlockingWithVision()` proposes character positions based on the empty location image, BEFORE the scene is rendered. Cinema Studio then renders characters wherever it decides — which may not match the proposed positions. The stashed blocking text is injected into Kling prompts verbatim, leading to conflicts: text says "Ngozi closest to camera" but start frame shows Ada closest. Kling trusts the image → wrong character delivers dialogue.

**Root cause:** One-shot blocking. Vision proposes positions → scene renders → no verification step → blocking text may be stale by the time Kling reads it.

**Fix: `_verifyBlockingWithSceneImage(sceneImagePath, characters, characterDescs)`** — A lightweight Vision call that runs once per scene at video gen time. It reads the actual rendered scene image (same image Kling uses as start frame), identifies each character using their visual descriptions from `character_bible` (clothing, hair, body type), and describes where they ACTUALLY are. This corrected blocking replaces the stashed blocking before injection into Kling prompts.

Flow change:
1. `_refineBlockingWithVision(locationImage)` → proposes blocking (unchanged)
2. Cinema Studio renders scene image (unchanged)
3. **NEW:** `_verifyBlockingWithSceneImage(sceneImage, chars, charDescs)` → reads scene image, identifies characters by visual description, corrects positions to match what was actually rendered
4. `_injectVisionBlocking(prompt, correctedChars)` → injects into Kling prompt

**Character identification:** Vision receives `full_prompt_description` from `character_bible` for each character (e.g. "young Nigerian woman, sage green blouse, navy wrap skirt, natural hair in updo"). This is critical for multi-character scenes where Vision must distinguish who is who before it can describe positions. Without descriptions, Vision was guessing — leading to the original blocking mismatch.

**Lazy execution:** Verification only runs when the first PENDING clip for a scene is encountered in the generation loop. Scenes whose clips are all done skip verification entirely. This avoids 64 Vision calls at startup.

**DB persistence:** After successful verification, corrected `vision_refined_characters` + `vision_blocking_verified: true` flag are written back to the scene asset's `prompt_used` JSON via `db.updateAssetPromptUsed()`. On subsequent runs, scenes with the verified flag skip the Vision call entirely — no redundant API calls.

**WebP-in-PNG handling:** Cinema Studio saves scene images with `.png` extension but WebP content. The verification detects actual format from file magic bytes (first 12 bytes: PNG `89504E47`, JPEG `FFD8FF`, WebP `RIFF....WEBP`) and converts WebP→JPEG via ffmpeg before sending to Claude Vision API.

**Name format preservation:** Vision returns base names (e.g. "ngozi"). Post-processing converts all bare names and @base names to the full suffixed element format (`@ngozi_towwf_0421`) using the same regex pattern as `_refineBlockingWithVision`.

**Frame-position warnings:** Downgraded from `WARNING: Could not replace position` to informational `No inline position to replace (preamble will override)`. These are expected for cinematic prompts where character positions live in a separate `CHARACTER POSITIONS:` block (which gets stripped), not inline in shot directions.

Cost: ~1 Sonnet call per scene with pending clips. Cached in-memory per run + persisted to DB across runs.

**Also added: `_ensureResolution720p()`** in kling-automation.js. Before every clip generation, Playwright actively reads the resolution chip from the DOM, and if it's 4K/1080p/2K, clicks it open and selects 720p. This is Layer 1 of the 4-layer resolution protection (active fix → pre-gen gate → credit cost gate → pipeline pause).

### Session 25 — Shot Direction Reconciliation (3rd Vision Pass)

**Problem: Shot directions conflict with verified blocking.** Shot directions in `multi_shot_prompt` are written at script stage against PROPOSED blocking (generic frame-left/center/right positions). The 2nd Vision pass (`_verifyBlockingWithSceneImage`) corrects the CHARACTER POSITIONS preamble to match the actual rendered scene, but body action verbs inside shot directions go untouched. Result: preamble says "@ada — seated behind the steering wheel" but Shot 3 says "@emeka turns toward the ignition." Kling receives contradictory instructions and improvises — sometimes acceptably (Emeka leans toward door handle), sometimes not.

**Categories of spatially-dependent actions that break:**
- Object interactions: "turns toward the ignition", "reaches for the door handle" — only valid if character is near that object
- Relative movements: "steps toward @ada", "turns away from the counter" — depends on actual positions
- Posture transitions: "stands up from the chair" — only valid if character is seated

Position-independent actions need no fix: "gestures with hand", "narrows eyes", "crosses arms", "nods slowly."

**Fix: `_reconcileShotDirectionsWithImage(sceneImagePath, verifiedPositions, prompt, imageData, mimeType)`** — 3rd Vision pass, per-clip. Sends the scene image + verified character positions + full shot directions to Claude Vision. Checks for TWO types of problems: (A) physically impossible actions given character positions, and (B) visual-state contradictions — wardrobe, props, or appearance described in shot directions that contradict what's visible in the scene image (the start frame). Kling cannot change wardrobe or conjure props not in the start frame. For visual-state contradictions, the fix is always STRIP (remove the contradicting phrase) — never invent a replacement. Runs ONLY when the 2nd Vision pass made corrections (corrections > 0).

**Critical guardrails (action density vs lip sync trade-off):**
Too much body action competes with dialogue lip sync — observed pattern from clip generation data. The 3rd Vision pass must simplify, never elaborate.

1. **Word count ceiling:** Replacement direction ≤ original word count per shot. Enforced in Vision prompt AND verified in post-validation code.
2. **Dialogue shots get minimal action:** Shots containing `[@character, speaking...]` dialogue get subtle gestures only — "nods", "glances down", "sits still." Prompt instruction: "For shots with dialogue, prefer REMOVING the impossible action over replacing it."
3. **Simplify-or-remove bias:** Instruction hierarchy: (a) keep as-is if physically possible, (b) remove entirely (character holds position), (c) last resort — replace with simpler equivalent (fewer verbs, no object interaction).
4. **Action verb cap:** Max 1 action verb per shot when dialogue is present. Max 2 for non-dialogue shots.
5. **Character budget:** Reconciled prompt must respect Kling's 2500-char limit. Vision instructed to stay within original shot direction character count.
6. **Post-validation check (updated Session 27):** Per-shot granular guardrails. Each shot is validated independently — shots that got shorter/simpler are ACCEPTED (visual-state stripping worked), shots that grew >20% in word count or gained action verbs are REVERTED to the original shot direction for that shot only. This replaces the previous all-or-nothing approach where a single violation caused the entire reconciled prompt to be rejected. The old behavior caused valid visual-state fixes (stripping contradictions) to be thrown away because Vision added a verb to one shot while correctly stripping another.
7. **Reasoning stripping (Session 26):** Vision's STEP 1/STEP 2 anti-anchoring prompt causes it to echo reasoning (analysis, audit notes, checkmarks, markdown headers, dividers) mixed into its response — before, between, and after the actual prompt content. This reasoning noise must be stripped before the prompt goes to Kling. Approach: reconstruct the clean prompt by extracting the three structural components: (a) CHARACTER POSITIONS line — extracted from Vision's response if present (matched via exact `CHARACTER POSITIONS (matching start frame):`), otherwise recovered from the original input prompt; (b) scene setting line — found by scanning backwards from Shot 1, skipping reasoning lines (identified by patterns: `**`, `---`, `STEP`, `CONFIRMED`, `✅`, `→`, `Physically`, `The woman/man in the image`, etc.); (c) shot directions (Shot 1 onwards). These three pieces are reassembled into a clean `CHARACTER POSITIONS + scene setting + shots` prompt. Handles reasoning appearing anywhere: before blocking, between blocking and shots, or interleaved with shots.
8. **Curly quote normalization (Session 26):** Vision (3rd pass) sometimes returns dialogue with Unicode curly/smart quotes (`\u201C` `\u201D` `\u2018` `\u2019`) instead of ASCII quotes. This broke the downstream dialogue @-stripping regex which only matched ASCII `"`. Fix: normalize all curly quotes to ASCII before the @-strip runs. Placed immediately before the dialogue @-strip block.
10. **Visual-state contradiction stripping (Session 27, updated):** Shot directions may describe wardrobe, props, spatial position, facing direction, or appearance states that contradict the scene image (the Kling start frame). Five categories checked: (a) WARDROBE — clothing doesn't match image; (b) PROPS IN HAND — shot references prop character isn't holding (e.g. "handbag strap" but holding a mug); (c) SPATIAL POSITION — shot places character somewhere they aren't (e.g. "near the door" but seated on sofa, "standing" but seated); (d) FACING DIRECTION — shot requires face angle impossible from character's orientation (e.g. ECU on face but back is to camera); (e) APPEARANCE — hair, accessories don't match. Fix: 3rd Vision pass prompt expanded with explicit category-by-category checklist and real examples from observed failures. Guardrail is STRIP — remove contradicting phrase, never invent replacement. **Gate removed (Session 27):** 3rd pass now runs for EVERY clip, not just scenes where 2nd pass had corrections. Visual-state contradictions are independent of blocking accuracy. DB cache prevents re-runs on restart.
9. **Dialogue @-strip multi-match fix (Session 26):** The original dialogue @-strip regex (`/\]:\s*"([^"]*?)@([a-z0-9_]+)([^"]*?)"/gi`) only caught the FIRST `@element_name` per dialogue line — the second @-ref was inside the non-greedy capture group and passed through unchanged. New approach: match dialogue blocks (`]: "..."`), then run a second inner replace on the dialogue text to convert ALL `@element_name` patterns to human-readable names. Also fixed ordering bug: the dialogue @-strip MUST run AFTER the bare-name fixer (which converts bare names like "Tunde" → `@tunde_towwf_0421` throughout the prompt, including inside dialogue). Moving it earlier caused the @-strip to run when there were no @-refs yet, then the bare-name fixer would add them with no cleanup after. Correct order: (1) generic @-ref sanitizer, (2) bare-name fixer, (3) curly quote normalizer, (4) dialogue @-strip.

**Trigger condition (updated Session 27):** Runs for EVERY clip on first generation, regardless of whether the 2nd Vision pass made blocking corrections. Visual-state contradictions (wardrobe, props in hand, spatial position, facing direction) exist independently of blocking accuracy — a scene can have perfect CHARACTER POSITIONS but shot directions that say "standing near the door" when the character is seated on the sofa, or "hand tightens on handbag strap" when she's holding a mug. The `sceneHadCorrections` gate was removed because it caused the 3rd pass to be skipped entirely for scenes with correct blocking, missing all visual-state contradictions. DB cache (`shot_directions_reconciled = true`) still prevents re-running on previously reconciled clips, so restarts don't waste API calls.

**Caching:** Reconciled prompt stored per-clip in DB via `prompt_used.shot_directions_reconciled = true`. On restart, clips with this flag skip the 3rd Vision call. In-memory cache keyed by clipId within a run.

**BLOCKING_MISMATCH detection (self-healing):** The 3rd Vision pass cross-checks the "verified" positions against what it actually sees in the scene image BEFORE reconciling shot directions. If characters appear swapped or misidentified, it returns `BLOCKING_MISMATCH` instead of reconciled directions. The caller then:
1. Re-runs `_verifyBlockingWithSceneImage()` fresh (2nd Vision pass, new API call)
2. Updates the in-memory cache AND DB with corrected positions
3. Re-injects corrected blocking via `_injectVisionBlocking()`
4. Re-runs the 3rd Vision pass with corrected positions
5. If still mismatched after re-verification, gives up and uses the re-injected prompt as-is

This handles the case where the 2nd Vision pass misidentified characters (e.g. swapped driver/passenger in a car interior scene despite having visual descriptions). The 3rd pass acts as a safety net that catches what the 2nd pass got wrong.

**Cache propagation for re-verification:** When a BLOCKING_MISMATCH triggers re-verification for a scene, the corrected positions are stored in `verifiedBlockingCache[sceneKey]`. Subsequent clips in the same scene pick up the corrected cache entry (the `visionBlockingVerified && verifiedBlockingCache[sceneKey]` branch runs before the DB-read branch), ensuring all clips in the scene get correct positions.

**Architecture — where it fits in the flow:**
1. Scene-level: `_verifyBlockingWithSceneImage()` → corrects CHARACTER POSITIONS → cached/persisted (unchanged)
2. Clip-level: `_injectVisionBlocking()` → rewrites preamble + Shot 1 posture verbs (unchanged)
3. **NEW — clip-level:** `_reconcileShotDirectionsWithImage()` → Vision sees scene image + corrected positions + shot directions → cross-checks positions first, then fixes physically impossible actions AND strips visual-state contradictions (wardrobe/props/appearance not matching scene image)
4. **NEW — clip-level (conditional):** If BLOCKING_MISMATCH detected → re-run 2nd Vision pass → re-inject → re-reconcile
5. Clip-level: prompt sanitization (@-ref cleanup, bare name fix, dialogue @-strip) (unchanged)

**Connection to duration formula:** Reducing action density before duration calculation means more temporal budget for lip sync at any given clip duration. This is a pre-optimization for the future duration tuning work.

Cost: ~$0.01-0.02 per clip, only for clips in corrected scenes. If 10-15 of ~50 scenes had corrections × ~3 clips each = 30-45 calls ≈ $0.30-0.90 total for a 150-clip project. Re-verification adds ~$0.02 per scene where mismatch is detected (rare).

### Current Project State (Session 25)

- Video generation in progress — clip 15 of 150
- 3-pass Vision blocking system: propose → verify → reconcile shot directions
- Self-healing: 3rd pass detects when 2nd pass misidentified characters → auto re-verifies
- Legacy scenes (pre-Session 25) default to hadCorrections=true for safety
- Left-hand drive spatial anchoring in all 3 Vision pass prompts (steering wheel = driver identification)
- Verified blocking persisted to DB (no redundant Vision calls on restart)
- Active 720p resolution enforcement added
- Smart duration working (12-15s bumps confirmed)
- Credit cost inflation gate + pipeline pause on cost inflation
- WebP magic bytes detection for scene images
- Duration/lip-sync observation table being gathered (15 clips so far)
- Split-screen compositions confirmed working (ch2_sc1_c1 preserved panels, obeyed shot scale)
- Shot 3 failure pattern: ~9/12 clips have Shot 3 lip sync issues, not purely action-density related

**Vehicle scene identification fix:** All 3 Vision passes (1st propose, 2nd verify, 3rd reconcile) now include `SPATIAL CONTEXT: Nigerian production, LEFT-HAND DRIVE` with explicit instructions to locate the steering wheel first and use it to anchor driver/passenger identification. Previously, Vision confused driver/passenger in ch1_sc5 despite having character visual descriptions — the amber lighting and side-angle made clothing-based identification unreliable. Steering wheel anchoring provides a definitive spatial reference that doesn't depend on character appearance.

**Known limitation: persistent gender bias in vehicle scenes.** Despite steering wheel anchoring, left-hand drive hints, and independent identification prompts, Sonnet consistently identifies the man as the driver in ch1_sc5's amber-lit car interior. Four separate Vision calls (2nd pass × 2, 3rd pass × 2) all made the same error. The 3rd pass's BLOCKING_MISMATCH detection worked correctly (detected the discrepancy between manual swap and Vision's assessment), but re-verification also got it wrong — creating a loop that undid the manual fix.

**Fix: `manually_swapped` lock.** When `swap-scene-blocking.js` sets `manually_swapped: true` on a scene asset, the code treats the blocking as locked — `hadCorrections` is forced to `false`, preventing the 3rd pass from running and undoing the manual fix. This is the human-override escape hatch for when Vision is persistently wrong.

**3rd Vision pass prompt restructured (anti-anchoring).** Changed from presenting "VERIFIED CHARACTER POSITIONS (claimed to match)" upfront (which caused confirmation bias) to a two-phase approach: STEP 1 asks Vision to independently identify characters using visual descriptions + spatial anchors (steering wheel), THEN compare with claimed positions. This eliminates anchoring bias for cases where Vision CAN correctly identify characters. Also added raw response logging (`[SHOT-RECONCILE] Raw response (first 300 chars):`) and markdown code block stripping for the response.

**Utility scripts added:**
- `scripts/clear-vision-verified.js` — clears `vision_blocking_verified` for specific scenes, forcing 2nd Vision pass re-run. Usage: `node scripts/clear-vision-verified.js --scene 1_5 --commit`
- `scripts/swap-scene-blocking.js` — swaps character positions for a 2-character scene, splitting spatial vs visual descriptions so clothing/pronouns stay with the correct character. Sets `manually_swapped: true` lock. Usage: `node scripts/swap-scene-blocking.js --scene 1_5 --commit`
