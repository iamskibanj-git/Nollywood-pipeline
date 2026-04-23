# Testing Results — April 13-14, 2026 (Updated: Session 7 — FIRST MVP SHIPPED)

Live end-to-end testing of every pipeline stage. All findings have been applied to the codebase; this document captures the operational knowledge behind each change.

> **Session 2 additions** (marked with [S2]): Research cache system, duration presets, Veo lip-sync fix, branding card assembly, subtitle removal, copyright protection system.
> **Session 3 additions** (marked with [S3]): SQLite database, project state lifecycle, crash recovery, launcher UI redesign, pattern library model (analyze once, reuse forever), YouTube dedup fix, auto-derived tone/setting, graceful shutdown & DB corruption protection, script JSON multi-strategy recovery, session recovery with cookie transfer, CDN URL diffing for generation completion, generation metadata traceability, Extra free toggle disable, double execution guard, preview overlay dismissal, stage completion verification gates, generation deduplication, scene staging (character fingerprint matching + continuity line parsing), URL-targeted image/video download, pipeline activity log with resume context, navigation failsafe with URL fix.
> **Session 4 additions** (marked with [S4]): API job tracking for generation detection (intercept UUID → poll jobs API → extract exact CDN URL), timestamp-gated CDN URL diffing as fallback, Higgsfield API reverse-engineering (job submission, status polling, completion response structure).
> **Session 5 additions** (marked with [S5]): Reference upload hard gate (verify thumbnails visible before Generate), React event dispatch fix for `setInputFiles()`, continuity tag sanitizer for garbled LLM output, video start frame hard gate, refactored `stageSceneReferences()` to use `scene.characters_present` as primary source (fingerprints for ordering only), dynamic reference slot targeting fix (`_findReferenceUploadTrigger()` rewritten with `page.evaluateHandle()` to find the LAST empty "+" slot after each upload instead of re-clicking filled slots).
> **Session 6 additions** (marked with [S6]): Asset tracking extras (cdn_url, references_used, generation_duration_ms), migration runner fix (statement-by-statement execution with duplicate column tolerance), approval gate re-gating on resume (scenes/portraits gates re-fire when app restarts at done stage), video navigation rewrite (UI clicks: Video nav → Veo 3.1 Lite, with logo-click stuck recovery), video download CDN URL passthrough, failed clip recovery (CDN URL saved to DB on failure, re-downloaded on restart before re-generating), non-fatal video clip failures (mark failed + continue loop), renderer currentGenGate fix on resume.
> **Session 7 additions** (marked with [S7]): **🎬 FIRST MVP VIDEO SHIPPED END-TO-END**. 2-min preset added, fresh browser context per scene/clip (the only reliable state clear), real-mouse-click uploads (React `isTrusted` fix — the 70% identity drift root cause), persistent filechooser handler (no OS picker leaks), network-response-based upload confirmation (DOM `blob:` stays blob: even after backend upload), patient 3-round ad dismissal with async waits, strict page-state verification using URL + active-tab detection (not body text), nuclear recovery via context recreate when stuck on wrong pages, auto-retry loop for failed video clips (3 rounds, approval gate blocked until 0 failures), video generation timeout bumped 5min→10min, audio-drift fix in assembly (per-clip codec/sample-rate normalization + re-encoded concat with `aresample=async=1`), branding card disabled by default. Plus new utility scripts: `wipe-project.js`, `status-check.js`, `reopen-project.js`.

---

## 1. YouTube Scraper

**Status**: PASS

**Key findings**:
- The `sp=CAMSAhAB` sort-by-view-count filter severely limits YouTube results (only 2 renderers returned). Switched default to `sortBy: 'relevance'` — YouTube returns 19+ results, and we sort by views ourselves after extraction.
- Searching "AI Nollywood movie" sorted by views returns traditional multi-million-view Nollywood movies, not AI content. Solved with a two-pool architecture: `aiOriginals` (filtered by `/\bai\b/i` regex in title, minViews 10k) + `remakeCandidates` (traditional hits, minViews 500k).
- YouTube deduplicates by URL within and across pools.

**Code updated**: `src/main/research/youtube-scraper.js` — full rewrite with two-pool `searchTopPerformers()`.

---

## 2. Gemini Analyzer (API Mode)

**Status**: PASS

**Key findings**:
- Gemini 2.5 Flash supports YouTube URL video processing via `fileData` with `mimeType: 'video/*'`. Takes ~30 seconds per video.
- Title-only analysis is much faster (~3-5s) and works as a reliable fallback when video processing fails (HTTP 400/500).
- Gemini sometimes returns JSON with unescaped quotes inside string values (e.g., `"Soft Life"` inside an array). Fixed with `_safeParseJSON()` — 3 fallback strategies: direct parse, extract JSON object, fix trailing commas + close unclosed brackets.
- `responseMimeType: 'application/json'` in generationConfig helps but doesn't fully prevent malformed output.
- Pattern extraction across 3+ videos produces actionable insights: recurring themes, winning archetypes, title formulas, audience triggers.

**Code updated**: `src/main/research/gemini-analyzer.js` — added `_safeParseJSON()`, fetch polyfill guard.

---

## 3. Claude Script Generation

**Status**: PASS

**Key findings**:
- Claude Sonnet 4.6 reliably generates the full script JSON structure: character bible with hyper-detailed physical descriptions, image prompts, animation prompts, dialogue with 9-word rule enforced.
- Despite system prompt saying "No markdown, just raw JSON", Claude sometimes wraps output in ` ```json ``` ` code blocks. The `jsonMatch` regex (`/\{[\s\S]*\}/`) in script-engine.js handles this correctly.
- 4096 max_tokens is NOT enough for a full script. Production uses 8192. For 90 lines (6 chapters × 3 scenes × 5 lines), may need batch generation by chapter or 16384+ tokens.
- Truncated JSON is common at higher line counts. The bracket-closing recovery logic in script-engine.js works but loses the last incomplete line. Acceptable — the pipeline can detect missing lines and regenerate.
- Research context injection works — themes, archetypes, and conflict patterns from Gemini analysis visibly influence character dynamics and story direction.
- The `anthropic-dangerous-direct-browser-access: true` header is required when calling Claude API from a browser context (testing only — the Electron app uses the SDK from Node.js, which doesn't need it).

**Code updated**: `src/main/pipeline/script-engine.js` — placeholder replacements for `SCENES_PER_CHAPTER`, `LINES_PER_SCENE`, `TOTAL_LINES`.

---

## 4. Higgsfield Image Generation (Nano Banana Pro)

**Status**: PASS

**Timing**: ~30 seconds per image (Queued → Generating → Complete)

**Key findings**:
- Model is pre-selected via URL path (`/image/nano_banana_2`) — no model picker needed.
- Prompt input is a **contenteditable div** (`#hf\:tour-image-prompt`), NOT a textarea. Must use: click → Ctrl+A → Backspace → type.
- Aspect ratio and resolution use **native `<select>`** elements. `selectOption()` works directly.
- Reference image slots: 3 hidden `input[type=file]` elements (1×1px). Use `setInputFiles()` directly. Filled slots show a 24×24 close button; empty slots are 56×56.
- **Unlimited toggle** is a `button[role="switch"]`. When ON: green background. Must check `aria-checked` or computed style before toggling. The toggle wrapper button and the submit button are **different elements** — clicking the wrapper toggles the switch; `button[type='submit']` fires the generation.
- Generate button: `#hf\:image-form-submit` or `button[type='submit']`.
- Generation lifecycle visible in History: "Queued" → "Generating" → image appears in grid.
- Download: Click history card → lightbox opens → "Download" button in right panel. Alternative: extract image URL from `images.higgs.ai` CDN.
- Character portraits (no references needed) produce excellent quality in 16:9 at 2K.

**Code updated**: `src/main/automation/higgsfield.js` — added `useUnlimited` param, `enableUnlimited()` method, status logging in `waitForGeneration()`.

---

## 5. Higgsfield Video Generation (Veo 3.1 Lite)

**Status**: PASS

**Timing**: ~90 seconds per 8-second clip

**Key findings**:
- Veo 3.1 Lite is selectable from the Create Video page. If already selected, skip model picker.
- Video page prompt is a **regular textbox** (`div[role='textbox']`), slightly different behavior from the image page.
- **Settings are BUTTON DROPDOWNS, not `<select>` elements!** Duration (4s/6s/8s), Ratio (Auto/16:9/9:16), Resolution (720p/1080p) — click the button to open a dropdown menu, then click the desired option. This was a critical difference from the image page.
- Audio toggle defaults to ON. It's a checkbox. Verify `checked === true`.
- Start frame upload: single hidden `input[type=file]` accepting image/jpeg, image/jpg, image/png, image/webp. `setInputFiles()` works.
- Videos play **inline in the History tab** (no lightbox like images). The `<video>` element has a `src` from `d8j0ntlcm91z4.cloudfront.net`.
- Download: Either extract `video.src` and fetch directly, or hover over the video card to reveal overlay buttons (heart, download arrow, copy, menu).
- Generate costs 12 credits per video (at 8s, 720p, 16:9 with audio). Unlimited mode not available on video page.
- Prompt length: Full animation prompts (150+ words) are accepted and produce accurate results.

**Code updated**: `src/main/automation/higgsfield.js` — added `setVideoDropdownOption()` helper; `config/higgsfield-selectors.json` — corrected video settings from `<select>` to button dropdowns.

---

## 6. FFmpeg Assembly

**Status**: PASS

**Key findings**:
- FFmpeg 4.4+ works (tested on Ubuntu 22.04). libx264 and aac codecs available.
- Trim 0.3s from clip start removes dead frames effectively. Tested on 5-second clips → 4.7s output.
- Text overlay with `drawtext` filter works for both speaker label and dialogue. Font fallback (no fontfile param) uses FFmpeg's built-in font.
- Concat demuxer (`-f concat -safe 0`) with `-c copy` is fast and lossless for joining identically-encoded clips.
- 4K upscale with `scale=3840:2160:flags=lanczos` works but is slow on CPU. For testing, skip upscale or use `-preset ultrafast`.
- Temp file cleanup with `fs.rmSync(tempDir, { recursive: true, force: true })` works.
- Windows path backslashes in concat file need `.replace(/\\\\/g, '/')`.

**Code verified**: `src/main/assembly/assembler.js` — no changes needed, works as-is.

---

## 7. API Connectivity from Electron

**Status**: FIXED

**Problem**: The Electron main process needs `fetch()` for Gemini API calls, but global `fetch` may not exist on older Node.js/Electron versions (< Node 18 / Electron 28).

**Solution implemented**:
- Added `node-fetch@^2.7.0` to `package.json` dependencies.
- Added polyfill guard in `main.js`: checks `typeof globalThis.fetch`, imports `node-fetch` if undefined.
- Same guard added to `gemini-analyzer.js` for standalone use.
- Added `test-api-keys` IPC handler: pings both Claude (via SDK) and Gemini (via fetch) with minimal requests.
- Added "Test API Keys" button to Settings UI — shows green/red results inline.
- Added pre-flight API check in `orchestrator.start()` — fails fast with clear error messages instead of crashing mid-pipeline.

**Code updated**: `main.js`, `gemini-analyzer.js`, `preload.js`, `index.html`, `package.json`.

---

## Selector Reference (Verified Live)

### Image Page (`/image/nano_banana_2`)
| Element | Selector | Type |
|---------|----------|------|
| Prompt | `#hf\:tour-image-prompt` | contenteditable div |
| Generate | `#hf\:image-form-submit` / `button[type='submit']` | button |
| Aspect Ratio | First `<select>` | native select |
| Resolution | Second `<select>` | native select |
| Ref Image Inputs | `input[type='file']` (×3) | hidden file input |
| Unlimited Toggle | `button[role='switch']` near "Unlimited" text | switch button |
| History Grid | `.overflow-x-hidden.grid` | div grid |
| Image CDN | `images.higgs.ai` | — |

### Video Page (`/create/video`)
| Element | Selector | Type |
|---------|----------|------|
| Prompt | `div[role='textbox']` | textbox |
| Generate | `button[type='submit']` | button |
| Duration | Button showing "8s" | button dropdown |
| Ratio | Button showing "16:9" / "Auto" | button dropdown |
| Resolution | Button showing "720p" | button dropdown |
| Audio | `input[type='checkbox']` | checkbox |
| Start Frame | `input[type='file']` (×1) | hidden file input |
| Model | "Google Veo 3.1 Lite" in left panel | pre-selected |
| Video CDN | `d8j0ntlcm91z4.cloudfront.net` | — |

### Auth
| Element | Selector |
|---------|----------|
| Logged-in indicator | `a[href='/asset/all']` (Assets link) |

---

---

## 8. Research Cache System [S2]

**Status**: IMPLEMENTED

**Problem**: Every pipeline run re-scraped YouTube and re-analyzed with Gemini, even when the same videos came back. Wastes 2-5 minutes and Gemini API calls per run.

**Solution implemented**:
- Research results (YouTube videos + Gemini analysis) cached to `electron-store` as `researchCache`.
- Cache has a 7-day TTL. On each run, if a valid cache exists and has unused videos, YouTube + Gemini stages are skipped entirely.
- Each completed story records its `sourceVideoIds`. These are marked as "used" in the cache via `markVideosUsed()`.
- UI shows cache status on launcher: green "Research Pool Active" bar with unused count, or yellow "Pool Exhausted" when all videos are used.
- "Force Refresh" button always available to bypass cache.
- "Next Story (Same Pool)" button appears on the completion screen when unused videos remain.
- When pool is exhausted, next Start Research auto-fetches fresh data.

**Store schema**:
```json
{
  "researchCache": {
    "fetchedAt": "ISO timestamp",
    "youtube": { "aiOriginals": [], "remakeCandidates": [], "all": [] },
    "analysis": { "patterns": {}, "videosAnalyzed": 5 },
    "usedVideoIds": ["videoId1", "videoId2"]
  }
}
```

**Code updated**: `orchestrator.js` (6 new methods + start() rewrite), `main.js` (2 new IPC handlers), `preload.js` (2 new bridge methods), `index.html` (cache status widget, Force Refresh button, Next Story button, used-video styling).

---

## 9. Duration Presets [S2]

**Status**: IMPLEMENTED

**Problem**: Full 10-min movie needs ~1080 credits (90 clips × 12). Higgsfield Creator sub has 6000 credits/month. Need ability to run shorter test movies within credit budget.

**Solution implemented**:
- `calculateStoryStructure()` now takes a preset string ('5min' or '10min') instead of raw clip count.
- Each preset has its own set of balanced story structures.
- UI has a dropdown on the launcher to select duration.
- Duration flows through: `startPipeline({ duration })` → `orchestrator.start(options)` → `calculateStoryStructure(options.duration)`.
- Script prompt template updated: `{{ESTIMATED_DURATION}}` placeholder replaces hardcoded "10+ minutes" so Claude writes a complete short film, not a truncated feature.

**Duration presets**:
| Preset | Structure | Clips | Duration | Credits |
|--------|-----------|-------|----------|---------|
| 5min | 3ch × 3sc × 5ln | 45 | ~5.25 min | ~540 |
| 10min | 6ch × 3sc × 5ln | 90 | ~10.5 min | ~1080 |

**Key design decision**: 5-min preset produces a complete short film (beginning, middle, end) — NOT a feature-length story cut short. 3 chapters gives enough arc structure for setup, escalation, and payoff.

**Code updated**: `orchestrator.js` (DURATION_PRESETS constant, calculateStoryStructure rewrite), `script-engine.js` (ESTIMATED_DURATION placeholder), `prompts/script-prompt.txt` (dynamic duration target), `index.html` (duration dropdown).

---

## 10. Veo Lip-Sync Fix [S2]

**Status**: IMPLEMENTED

**Problem**: In multi-character scenes, Veo 3.1 Lite frequently mis-assigns lip-sync — non-speaking characters mouth the dialogue, or the wrong character gets lip movement.

**Solution implemented**:
- New `buildVideoPrompt(line, scene, accent)` method in orchestrator.
- Uses `scene.characters_present` and `line.speaker_id` to identify who speaks and who doesn't.
- Prompt explicitly names the speaker and says they should lip-sync: "Ada speaks: '...' Ada's mouth moves to match the dialogue."
- Prompt explicitly silences all non-speakers: "IMPORTANT: Emeka — mouth CLOSED, absolutely no lip movement, no dialogue. Emeka listens silently with subtle reactions but does NOT speak or move their lips."
- For solo scenes (1 character), the non-speaker block is omitted.
- New `findLineAndScene()` helper returns both line and parent scene context.

**Example prompt output (2-character scene)**:
```
[animation prompt from script]

Ada speaks: "The river has blessed me" (Nigerian accent). Tone: Emotional. Ada's mouth moves to match the dialogue with natural lip-sync.

IMPORTANT: Emeka — mouth CLOSED, absolutely no lip movement, no dialogue. Emeka listens silently with a subtle reaction but does NOT speak or move their lips.
```

**Code updated**: `orchestrator.js` (buildVideoPrompt, findLineAndScene, video stage rewrite).

---

## 11. Assembly Overhaul: Branding Card + Subtitle Removal [S2]

**Status**: IMPLEMENTED

**Changes**:

### Subtitles removed
- `drawtext` speaker label and dialogue overlay completely removed from FFmpeg pipeline.
- Rationale: YouTube and Facebook auto-generate captions from the Veo audio track. Baked-in subs are redundant, take up visual space, are English-only, and can conflict with platform subtitles.
- Assembly now only trims dead frames (0.3s) from clip starts.

### Branding card added
- `config/branding.fw.png` — transparent 16:9 PNG showing "Fayehun Ayo" channel branding with verified badge.
- FFmpeg generates a 3-second video clip from the static image (with silent audio track for concat compatibility).
- Branding card inserted at 3 points in the timeline:
  - **Intro**: Before the first clip
  - **Periodic**: Every 13 clips (~1.5 minutes of content)
  - **Outro**: After the last clip
- If `branding.fw.png` is missing, assembly runs normally without branding (graceful fallback).
- Branding card path configurable via `store.get('brandingCardPath')` or defaults to `config/branding.fw.png`.

**Assembly pipeline (updated)**:
1. Sort clips by chapter + line
2. Trim 0.3s from start of each clip
3. Interleave branding card clips (intro, every 13 clips, outro)
4. Concat all segments via concat demuxer
5. Upscale to 4K (lanczos)

**Code updated**: `assembler.js` (full rewrite), `orchestrator.js` (brandingCardPath config pass-through).

---

## 12. Copyright Protection System [S2]

**Status**: IMPLEMENTED

**Problem**: The research pipeline extracts content patterns from existing YouTube videos via Gemini analysis. Without safeguards, specific plot summaries, character names, and recognisable storylines could leak through to Claude's script generation — creating derivative content.

**4-layer protection**:

### Layer 1 — Prompt-level guardrails
- `research-brief-prompt.txt`: Added ORIGINALITY REQUIREMENTS section. Prohibits copying/paraphrasing source titles, reproducing specific plots or scenarios, and instructs Claude to treat research as genre analysis only.
- `script-prompt.txt`: Added ORIGINALITY GUARDRAILS section. Prohibits reproducing plots from any existing movie/show/video, reusing character names from known films, and reproducing or paraphrasing memorable dialogue.

### Layer 2 — Title similarity scoring (code-level)
- `findSimilarSourceTitle()` in `script-engine.js`: Word-overlap algorithm with stop-word filtering.
- Tokenizes both generated title and each source title, computes overlap ratio against the shorter title.
- Threshold: >40% significant-word overlap flags the title with `tooSimilar: true`, `similarTo`, and `similarityScore`.
- Warning injected into `hook_reason` so it's visible at the title approval gate.

### Layer 3 — Source title injection for avoidance
- Orchestrator injects `sourceVideoTitles` array into `researchData` before title generation.
- `buildResearchSummary()` shows source titles under "EXISTING TITLES IN THIS SPACE (DO NOT COPY OR PARAPHRASE)" — Claude sees what already exists and is instructed to avoid overlap.

### Layer 4 — Research context sanitization
- `buildScriptResearchContext()`: Removed individual video story structures entirely (setup/conflict/climax from source videos were leaking specific plot summaries).
- Both `buildResearchSummary()` and `buildScriptResearchContext()` now run all pattern entries through `sanitizePatternEntry()`.
- `sanitizePatternEntry()` uses heuristic checks: entries under 60 chars that don't match narrative patterns pass through as abstract categories; longer entries or entries containing plot-summary verbs (discovers, betrays, escapes, etc.) are truncated to first clause boundary or stripped to first 4 significant words.
- `looksLikePlotSummary()` detects narrative indicators: action verbs suggesting a story, and "A/The [adjective] [person] [verb]" patterns.
- Emotional words and title formula structures pass through unfiltered (they're inherently abstract).

**Code updated**: `script-engine.js` (sanitizePatternEntry, looksLikePlotSummary, buildResearchSummary, buildScriptResearchContext), `orchestrator.js` (sourceVideoTitles injection), `prompts/script-prompt.txt`, `prompts/research-brief-prompt.txt`.

---

## 13. SQLite Database & Project State Lifecycle [S3]

**Status**: IMPLEMENTED — SQLite via sql.js, asset tracking, launcher UI redesign complete

**Problem**: The app uses electron-store (flat JSON file) for all persistence. This creates three risks:
- **Crash corruption**: If the app crashes mid-write, the JSON file can be corrupted, losing all state.
- **No resume**: There's no concept of a "project in progress." If you close the app after choosing a title but before assembly, that work is lost.
- **No asset tracking**: The pipeline can't tell which clips are done vs. pending vs. failed. A crash during video generation (the 45-90 clip stage) means restarting from scratch.

### Database: SQLite via `sql.js`

Chosen over alternatives because:
- Atomic writes — crash-safe, no corruption risk
- Pure JavaScript (WASM) via `sql.js` — no native C++ compilation, no Visual Studio Build Tools needed on Windows
- Single file — easy backup, no server process
- Note: `better-sqlite3` was tried first but requires Visual Studio C++ toolchain on Windows. Switched to `sql.js` which has zero native dependencies.

**Schema**:

```sql
-- Core project tracking
projects (
  id TEXT PRIMARY KEY,           -- UUID
  title TEXT,
  source_video_ids JSON,         -- Array of YouTube video IDs
  duration_preset TEXT,           -- '5min' | '10min'
  stage TEXT,                     -- Current pipeline stage
  script_json TEXT,               -- Full script blob
  settings JSON,                  -- accent, tone, nationality, etc.
  created_at DATETIME,
  updated_at DATETIME,
  completed_at DATETIME           -- null until assembled
)

-- Individual asset tracking (portraits, scene images, video clips)
project_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  type TEXT,                      -- 'portrait' | 'scene_image' | 'video_clip' | 'branding_clip' | 'final_video'
  chapter INTEGER,
  scene INTEGER,
  line INTEGER,
  character_id TEXT,
  file_path TEXT,
  status TEXT DEFAULT 'pending',  -- 'pending' | 'generating' | 'done' | 'failed'
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  prompt_used TEXT,                -- The exact prompt sent to Higgsfield
  model_used TEXT,                 -- e.g. 'Nano Banana Pro', 'Veo 3.1 Lite' (added in migration 002)
  source_gen_id TEXT,              -- Higgsfield's internal generation/asset ID (added in migration 002)
  created_at DATETIME,
  completed_at DATETIME
)

-- Research cache (replaces electron-store researchCache)
research_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at DATETIME,
  expires_at DATETIME,
  youtube_data JSON,
  analysis_data JSON,
  is_active BOOLEAN
)

-- Tracks which source videos have been turned into stories
used_videos (
  video_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  used_at DATETIME
)

-- Dedup for generated titles
produced_titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  title TEXT,
  similarity_score REAL,
  created_at DATETIME
)
```

### Project State Lifecycle

A story has no "abandon" concept — once started, it always resumes until assembly completes. The only thing that pauses progress is running out of credits, and even then the project waits for the user to come back.

**Stages** (in order):

| Stage | Meaning | What's persisted |
|-------|---------|-----------------|
| `research-done` | Pool exists, no story started yet | Research cache rows |
| `title-chosen` | User approved a title | `projects` row with title, source_video_ids |
| `script-done` | Full script JSON generated | `projects.script_json`, all expected assets inserted as `pending` rows |
| `portraits-done` | All character portraits generated | Asset rows for portraits set to `done` |
| `scenes-done` | All scene images generated | Asset rows for scene_images set to `done` |
| `videos-done` | All video clips generated | Asset rows for video_clips set to `done` |
| `assembled` | Final video assembled | `projects.completed_at` set, source video marked used |

**Launcher UI** (two-card design, implemented):

| App State | Visible Card | Primary Action | Secondary |
|-----------|-------------|---------------|-----------|
| No project + pool has unused | `#pool-entry-card` (green border) | Click entire card → `startPipeline()` | "Start Fresh Research Instead" ghost button |
| No project + pool exhausted | `#fresh-start-card` + yellow exhaustion banner | "Start Fresh Research" button | — |
| No project + no pool | `#fresh-start-card` | "Start Research" button | — |
| Project in progress | `#resume-card` (accent border) | "Continue Production" button → `resumeProject()` | — |
| Project assembled | "Export" + "Next Story" | Releases pool on export | Enabled |

Each card that allows starting a pipeline has its own duration select (`#duration-preset` for pool card, `#duration-preset-fresh` for fresh card). `getActiveDuration()` reads from whichever card is visible.

**Pool locking**: Source video is "claimed" when title is chosen, "used" when assembly completes. No new story can start while a project is in progress.

### Crash Recovery via Asset-Level Tracking

The key insight: every expected asset gets its own row in `project_assets` with a `status` field.

**Generation workflow per asset**:
1. After script generation → INSERT all expected assets as `pending` (portraits, scene images, video clips)
2. Before generating each asset → UPDATE status to `generating`
3. After successful generation → UPDATE status to `done`, set `file_path`
4. If generation fails → UPDATE status to `failed`, set `error_message`, increment `retry_count`

**On resume** (app restart or crash recovery):
```sql
SELECT * FROM project_assets
WHERE project_id = ? AND status != 'done'
ORDER BY type, chapter, scene, line
```

If a row is still `generating` after app restart, the file may be incomplete — retry it. The pipeline picks up exactly where it left off, never re-generating assets that are already `done`.

### Migration Plan

**What moves to SQLite**: Research cache, project state + progress, asset tracking, used video history, produced title dedup.

**What stays in electron-store**: API keys (sensitive, simple key-value), UI preferences (window size, theme), Higgsfield session cookies.

**Migration on first run**: If old electron-store data exists (`researchCache`, `producedStories`), migrate to SQLite tables, then delete from store.

**New files**:
- `src/main/database/db.js` — init, migrations runner, helper methods
- `src/main/database/migrations/001-initial.sql` — schema above

---

## 14. Pattern Library Model, YouTube Dedup Fix & Auto-Derived Settings [S3]

**Status**: IMPLEMENTED

### Problem 1: Pool exhaustion + wasteful video consumption

The original design marked source videos as "used" per-story, burning through the pool quickly. But since we only extract abstract patterns (themes, archetypes, tones), individual videos don't get "consumed" — patterns are reusable inspiration.

### Fix: Pattern Library Model

Gemini now analyzes up to 10 videos ONCE when the pool is created, building a rich pattern library. This library is cached and reused across unlimited stories until the 7-day TTL expires. No videos are ever marked "used."

- Fresh research: YouTube scrape → Gemini analyzes up to 10 interleaved videos → patterns cached
- Cached reuse: Pattern library loaded as-is. No Gemini API calls. Instant.
- Story variety: Claude picks different theme combinations each time + title dedup prevents repetition
- Pool refresh: Time-based (7 days) or manual only — no consumption-based exhaustion
- `_interleaveVideos()`: Alternates remake, AI, remake, AI... (remakes first — proven formulas are richer)

### Problem 2: Duplicate videos in YouTube results

Multiple search queries returned the same video (e.g., "AI Nollywood movie" and "AI Nigerian movie" both finding the same hit). Dedup was matching by full URL, but YouTube URLs can have different query parameters for the same video.

### Fix: Dedup by videoId

- `videoId` is now extracted from the URL param `v=` (11-char YouTube ID) during scraping
- All dedup (within `_searchPool`, across pools in `searchTopPerformers`) uses `videoId` instead of full URL
- Eliminates duplicates from overlapping search queries

### Auto-derived tone and setting

Nationality and accent are baked in as "Nigerian" / "Nigerian accent" — no user selection needed.

Tone and setting are now automatically derived from Gemini research patterns:

- `_deriveToneFromPatterns(patterns)`: Maps recurring themes, audience triggers, and conflict types to one of: Scandalous, Suspenseful, Heartfelt, Dramatic. Uses keyword matching in priority order.
- `_deriveSettingFromPatterns(patterns)`: Uses Gemini's `effective_settings` field (top result), or infers from themes (village, Lagos, palace, etc.).
- Quick Settings panel removed from research view. `approveResearch()` now only passes `selectedThemes`.

---

## 15. Graceful Shutdown & DB Corruption Protection [S3]

**Status**: IMPLEMENTED

### Problem

The app had minimal shutdown handling — only `before-quit` → `db.close()`. This left gaps:
- **Ctrl+C in terminal**: SIGINT kills the process without triggering Electron's `before-quit`. DB never gets a final save.
- **Crash mid-write**: `fs.writeFileSync()` is not atomic — if the process dies during a write, the SQLite file can be truncated/corrupt.
- **Pipeline mid-generation**: Assets stuck at `status = 'generating'` forever. On next launch they'd never be retried.
- **No close confirmation**: Clicking X while 45 video clips are generating silently kills everything.

### Implementation

**`gracefulShutdown(source)` in main.js** — single function covering all exit paths:
1. Cancel pipeline (sets `cancelled` flag, stops generation loops)
2. Close Playwright browser (fires `automation.close()` which saves Higgsfield session cookies)
3. Reset stuck assets via `db.resetStuckAssets()` — any `generating` → `pending`
4. Final `db.close()` (which does `save()` + WASM cleanup)

**Signal handlers registered**:
- `app.on('before-quit')` — X button, Alt+F4, `app.quit()`
- `process.on('SIGINT')` — Ctrl+C in terminal
- `process.on('SIGTERM')` — `kill` command, system shutdown
- `process.on('uncaughtException')` — saves DB then exits with code 1
- `process.on('unhandledRejection')` — defensive `db.save()` only, doesn't exit
- Guard flag `isShuttingDown` prevents double-shutdown

**Close confirmation dialog**: `mainWindow.on('close')` checks if pipeline status is `'running'`. If so, shows a native Electron dialog: "Pipeline Running — Close Anyway?" with Cancel option. Progress is always safe regardless of choice.

**Atomic DB writes** in `db.save()`:
- Writes to `dbPath + '.tmp'` first
- Then `fs.renameSync(tmp, real)` — atomic on NTFS, ext4, APFS
- If process dies during `writeFileSync`, only the `.tmp` is corrupt — the real file is untouched

**Corrupt DB recovery** in `db.init()`:
- If the `.sqlite` file fails to load (truncated, corrupt, empty), it's renamed to `.corrupt.[timestamp]` as a backup
- Fresh empty DB created in its place
- `recoverOnStartup()` also cleans stale `.tmp` files left from interrupted writes

**`resetStuckAssets()`** — runs on both startup and shutdown:
- Queries `WHERE status = 'generating'`
- Resets to `pending` with message `'Reset after app shutdown/crash'`

---

## 16. Script JSON Recovery — `_safeParseScriptJson()` [S3]

**Status**: IMPLEMENTED

### Problem

At 90+ dialogue lines, Claude's script JSON response can be truncated or malformed:
- `max_tokens: 8192` was too small — response cut off mid-object at position 31457
- Error: `SyntaxError: Expected ',' or ']' after array element in JSON at position 31457`
- Truncated JSON has unclosed brackets, trailing commas, and incomplete string values

### Fix

Two changes in `src/main/pipeline/script-engine.js`:

1. **Increased `max_tokens` from 8192 to 16384** in `generateScript()` — prevents most truncation

2. **Added `_safeParseScriptJson(fullText)` method** — 6-strategy progressive JSON recovery:
   - **Strategy 1**: Direct `JSON.parse()` — works when response is clean
   - **Strategy 2**: Regex extract `{...}` — strips markdown fences, preamble text
   - **Strategy 3**: Fix trailing commas — `},]` → `}]`
   - **Strategy 4**: Close unclosed brackets/braces — counts open/close pairs, appends missing closers
   - **Strategy 5**: Fix unescaped quotes — heuristic lookahead detects inner vs. boundary quotes
   - **Strategy 6**: Truncate to last complete element — finds last valid `}` at depth ≤2, closes everything after

Helper methods: `_closeUnclosedBrackets()`, `_fixUnescapedQuotes()`, `_truncateToLastComplete()`

Similar pattern to `_safeParseJSON()` in gemini-analyzer.js but more aggressive — script JSON is larger and more complex than Gemini's pattern analysis output.

---

## 17. Higgsfield Session Recovery, Prompt-Match Detection & Generation Metadata [S3]

**Status**: IMPLEMENTED

### Session Recovery — Cookie Transfer from BrowserView to Playwright

**Problem**: The app has two browsers — the Electron BrowserView (visible, where user logs in) and Playwright's Chromium (hidden, does automation). When session expired, logging into the BrowserView didn't fix Playwright's expired session. The pipeline crashed to ERROR with no Resume option.

**Fix**: `_withSessionRetry(fn, label)` wraps all Higgsfield automation calls (portraits, scenes, clips). On SESSION_EXPIRED:
1. Pauses pipeline, emits `session-expired` event → UI shows PAUSED + Resume button
2. User logs in via BrowserView, clicks Resume
3. `refreshSessionFromBrowserView()` extracts all cookies + localStorage from BrowserView, converts to Playwright format, saves to session file
4. Closes old Playwright browser → `ensureBrowser()` re-launches with fresh cookies
5. Retries the failed generation

Guard against shutdown race: checks `this.cancelled` after pause resolves to prevent retrying against a dead browser.

### Generation Completion — Prompt Matching

**Problem**: `waitForGeneration()` relied on counting History grid items via `.overflow-x-hidden.grid > div` selector, which broke when Higgsfield's UI changed. Status went "generating" → "unknown" but item count never changed → 180s timeout.

**Fix**: After status transitions from "generating" to "unknown" (generation likely done), clicks first History card → opens detail lightbox → reads PROMPT section → compares against submitted prompt using word-match ratio (60%+ of significant words = match). Falls back to multi-strategy item counting if prompt check fails.

### Extra Free Toggle

Higgsfield's "Extra free" toggle generates lower-quality bonus images. `disableExtraFree()` runs before every image generation, finds the toggle by nearby text, clicks it OFF if ON.

### Generation Metadata Traceability

**Migration 002**: Added `model_used` and `source_gen_id` columns to `project_assets`.

After each download, `_extractGenMetadata()` opens the detail lightbox and extracts:
- **Model name**: Scans page text for known models (Nano Banana Pro, Veo 3.1 Lite, etc.) or reads "Model" label
- **Generation ID**: Extracts from URL (`/asset/<id>`), data attributes, or CDN image URL hash

Both values saved via `markAssetDone(id, path, { model, sourceGenId })` for full traceability.

### Generation Completion Detection — CDN URL Diffing [S3]

The original prompt-matching approach (`_checkFirstCardPrompt`) was unreliable — it consistently read "Copy..." button text instead of the actual prompt from Higgsfield's detail lightbox. The DOM selectors for the PROMPT section didn't match Higgsfield's current layout.

**Replaced with 3-tier detection** in `waitForGeneration()`:

1. **CDN URL diffing** (primary): `_getHistoryCdnUrls(type)` snapshots all CDN image/video URLs (higgs.ai, cloudfront, etc.) before generation starts. Each poll compares current URLs against the initial set. A new URL = generation complete.
2. **Item count increase**: `countHistoryItems()` as before (4 fallback selector strategies).
3. **Status transition safety valve**: Once page status leaves "generating" → "unknown", a counter starts (max 5 checks). After the counter expires without CDN/count detection, assumes done. Prevents infinite polling loops.

The `_checkFirstCardPrompt()` method has been removed entirely. Metadata extraction (model name, gen ID) still works via `_extractGenMetadata()` during download.

### URL-Targeted Image/Video Download [S3]

**Problem**: `downloadLatestImage()` clicked "first card in history" to download, but Higgsfield's history grid mixes the user's generations with community/explore images. The pipeline was downloading random community images (bears in suits, lions, jellyfish lamps) instead of the actual generation.

**Solution**: The detection-to-download pipeline now passes the detected CDN URL end-to-end:

1. `waitForGeneration()` returns the new CDN URL string (was void before).
2. `generateImage()` / `generateVideo()` capture the URL and pass it to `downloadLatestResult()`.
3. `downloadLatestResult()` passes it to `downloadLatestImage()` / `downloadLatestVideo()`.
4. `downloadLatestImage(outputPath, detectedUrl)` uses a 4-method cascade:
   - **Method 1** (primary): Direct fetch of the detected CDN URL. Extracts the full-resolution original URL from Higgsfield's CDN wrapper params (`?url=ORIGINAL`). Falls through if no URL provided or fetch fails.
   - **Method 2**: Find the history card whose `img[src]` contains the detected URL, click it to open lightbox, use the Download button.
   - **Method 3**: First card fallback (with console warning — this is the old behavior, only used if Methods 1-2 fail).
   - **Method 4**: Screenshot fallback as last resort.

This eliminates the "downloading community images" failure mode entirely — the download targets the exact URL that was detected during generation completion.

### Stage Completion Verification Gate [S3]

After every generation loop (portraits, scene images, video clips), `verifyStageComplete(type, stageName)` runs before the stage transitions to "done". It performs two checks:

1. **DB status**: Queries `getIncompleteAssets()` for any non-done assets of that type. If any exist, the stage transition is blocked.
2. **File existence**: For every "done" asset, verifies the file actually exists on disk with `fs.existsSync()`. If files are missing, those assets are reset to `pending` status so they'll be re-generated on resume.

If either check fails, the error bubbles up to the `runStage` error handler. On resume, `getIncompleteAssets()` picks up the reset assets and the generation loop only processes what's still incomplete.

This prevents the "moved on with missing assets" problem where the pipeline advanced to scenes while portraits were silently incomplete.

### Scene Staging — Character + Continuity Reference System [S3]

**Problem**: Character portraits were attached in arbitrary order (based on `characters_present` array), the model couldn't reliably match faces to descriptions, and the continuity reference (previous scene image) was tracked with a simple variable that reset on location change rather than following the explicit continuity tags in the prompt.

**Solution**: `stageSceneReferences(imagePrompt, sceneImageMap, chapterNum)` handles two types of references:

**A) Character portraits**: Scans the `image_prompt` for each character bible entry's descriptive fingerprints (age+nationality, scars/birthmarks/vitiligo, skin tone, hair, build/height, wardrobe). Records where each character first appears in the prompt text. References sorted by position — ref[0] = first described, ref[1] = second, etc.

`_extractCharacterFingerprints()` extracts distinctive fragments: "45-year-old Nigerian woman", "vitiligo patch on left hand", "rich warm ebony brown skin", "long box braids with gold thread", "5'7\"". Match requires 2+ descriptors found (or 1 long >20 char descriptor).

**B) Continuity reference**: Parses `(Continuity: Using Image Prompt [Line X] as reference)` from the prompt text via regex. Resolves Line X against a `sceneImageMap` — a `"chapter_line" → filePath` lookup pre-populated from DB and updated as new images are generated. The old `previousSceneImage` variable tracking is gone.

**Reference order**: `[character portraits in prompt order] + [continuity image]`

**Upload rewrite**: Nano Banana supports up to 14 reference slots (not 3 as originally mapped). Slots appear dynamically — `uploadImageReferences()` re-queries file inputs after each upload, targets the first empty slot (no thumbnail in container). Each upload verified by thumbnail confirmation in the slot.

**File input scoping fix**: The original `input[type='file']` selector was matching file inputs from across the entire page (community tab, profile upload, etc.), causing unrelated images to be uploaded as references. Now scoped to `.size-14 input[type='file']` — only matches inputs inside the 56x56 reference slot containers. Fallback filters by container bounding box (≤80px). Upload code also validates slot size before each upload — skips any input where the container exceeds 120px wide.

**[S5] Dynamic slot targeting fix (v2)**: Three root causes identified from live testing:

1. **Clearing incomplete**: `clearImageReferences()` clicked all close buttons in one `evaluate()` pass, but the DOM shifts after each removal. After clearing "2 slots", 1 remained filled. Fix: now loops one-at-a-time (up to 15 passes), clicking first filled slot's close button, waiting 600ms for DOM update, re-checking. Also searches all descendant `button` elements (not just direct children).

2. **0 empty slots race**: After Upload 1 fills the last empty slot, Upload 2 finds 0 empty `.size-14` slots (UI hasn't created the new `+` yet) and falls to broadest fallback which finds the wrong file input. Fix: `_findReferenceUploadTrigger()` now polls up to 4s for a new empty slot to appear when all slots are filled.

3. **setInputFiles hitting wrong input**: When filechooser timed out, fallback used `page.$('input[type="file"]')` which found the first file input (already filled). Fix: `_findReferenceUploadTrigger()` now returns `{ clickable, fileInput }` — both the button AND the slot-specific `<input type="file">`. The upload method tries 3 approaches in cascade: filechooser on button → setInputFiles on slot input → filechooser on input.click().

Post-upload: polls for new empty slot appearance (up to 3s) instead of fixed 800ms delay. Thumbnail confirmation uses `successCount + 1` instead of `i + 1`.

**Asset reset script**: `scripts/reset-assets.js` supports modes: `scenes`, `portraits`, `clips`, `all`. Deletes files from disk, clears DB fields, sets all assets to `pending`, and reverts project stage. App must be closed first.

### Generation Deduplication [S3]

Before every generation (portrait, scene image, video clip), the orchestrator calls `db.findExistingGeneration(prompt, type)`. This is a single SQLite index scan — effectively zero-cost. It checks all projects for a completed asset with the exact same prompt text and type. If found and the file exists on disk, it copies the file to the expected path and marks the current asset as done, completely skipping the Higgsfield browser automation.

This solves the problem of Higgsfield's history getting cluttered with duplicate generations when the user resumes after a crash, session expiry, or download failure. The dedup also carries metadata (model_used, source_gen_id) from the original generation.

### Double Execution Guard [S3]

The renderer was calling `start()` twice on resume, causing every generation to run in parallel duplicate. Fixed with a guard at the top of `orchestrator.start()` that rejects the call if `this.state.status` is already `running` or `waiting_approval`. Also renamed the duplicate `btn-resume` element to `btn-resume-pipeline`.

### Pipeline Activity Log & Resume Context [S3]

**Problem**: On resume after a crash, session expiry, or manual pause, the pipeline had no record of what happened before the interruption. The user saw aggregate counts (e.g. "12/45 assets complete") but not what the last action was, whether an asset was interrupted mid-generation, or how the previous session performed. Debugging resume issues required guesswork.

**Solution**: A `pipeline_events` table (migration `003-pipeline-events.sql`) records every meaningful action with project ID, event type, stage, asset ID, human-readable label, and detail string.

**Event types logged**:
- `session_start` / `session_end` — pipeline entry and completion/error
- `stage_start` / `stage_complete` — each pipeline stage boundary
- `asset_start` / `asset_done` / `asset_failed` / `asset_dedup` — per-asset generation lifecycle
- `pause` / `resume` / `cancel` — user control actions
- `verification_fail` — stage gate failures (incomplete assets or missing files)
- `error` — unhandled pipeline errors

**Resume context** (`db.getResumeContext(projectId)`): On resume, builds a structured summary from recent events — last action, interrupted asset (asset_start without matching done/failed), previous session stats (completed/failed/deduped counts), and 10-event history. This is:
- Logged to the pipeline output with `[RESUME]` prefix
- Emitted as a `resume-context` event to the UI log panel
- Displayed on the launcher resume card (interrupted asset warning, session stats, relative time)

**Performance**: Event logging is wrapped in try/catch — a failed write never breaks the pipeline. The table uses indexed queries on `(project_id, created_at DESC)`.

### Navigation Failsafe & URL Fix [S3]

**Problem**: The pipeline failed with "Could not find prompt input element" on every generation attempt. Root cause: two issues compounding.

1. **Wrong URL**: The selectors config had `https://higgsfield.ai/image/nano_banana_2` but Higgsfield renamed the model URL to `https://higgsfield.ai/image/nano-banana-pro`. The old URL loaded the page in a history-only view with no generation bar.

2. **No recovery**: When the generation bar didn't render (stale URL, SPA routing glitch, slow load), the automation immediately threw an error with no retry logic.

**Solution**: `_navigateWithFailsafe(type, sel)` in `higgsfield.js`:
- Attempt 1: Direct URL navigation + 2.5s wait (normal fast path)
- Attempt 2: Extended 3s wait if prompt not found
- Attempt 3: Logo click → home page → "Image"/"Video" nav dropdown → model name click. This menu-based navigation reliably triggers the full SPA initialization including the generation bar.

Applied to both `generateImage()` and `generateVideo()`. Also updated `higgsfield-selectors.json` URL from `/image/nano_banana_2` to `/image/nano-banana-pro`.

**Operational note**: When stuck on the Higgsfield page with no generation UI visible, the manual workaround is the same: click the Higgsfield logo, then Image → Nano Banana Pro (or Video → Veo 3.1 Lite).

---

## Known Issues & Workarounds

1. **Claude script truncation at high line counts**: ~~For 90+ lines, `max_tokens: 8192` may not suffice.~~ [S3] RESOLVED — `max_tokens` increased to 16384, plus `_safeParseScriptJson()` provides 6-strategy recovery for any remaining edge cases.

2. **Gemini video processing intermittent failures**: Some YouTube URLs return HTTP 400 from Gemini's video processing endpoint. The title-only fallback catches this gracefully.

3. **Higgsfield Unlimited toggle click ambiguity**: The Unlimited toggle wrapper button and the Generate submit button overlap in the UI. The code now explicitly targets `button[type='submit']` for generation and `button[role='switch']` for the toggle.

4. **Video page has no Unlimited mode**: Unlike image generation, video generation always costs credits (12 per 8s clip at 720p). Budget for ~86 clips × 12 = ~1032 credits per full movie. [S2] Use 5-min preset (~540 credits) when credits are limited.

5. **FFmpeg fontfile path**: ~~The `drawtext` filter's `fontfile` parameter references `arial.ttf` which may not exist on all systems.~~ [S2] RESOLVED — drawtext removed entirely. Subtitles now handled by platform auto-captions.

6. **[S2] Veo lip-sync in 3+ character scenes**: The explicit "mouth CLOSED" prompt technique is researched/community-tested but not 100% reliable. Veo may still occasionally animate the wrong character. Manual review at the clip approval gate catches these.

7. **[S2] Branding card resolution matching**: The branding card clip is generated at 1280×720 by default. If source clips are at a different resolution, the concat may produce inconsistent dimensions. The final 4K upscale normalizes this, but intermediate concat could fail if resolutions differ wildly. Monitor for errors during the concatenation step.

---

### API Job Tracking — Generation Detection Overhaul [S4]

**Problem**: `waitForGeneration()` detected "new" CDN URLs in Higgsfield's History tab that were actually stale or lazy-loaded images from previous generations. The first attempt to fix this (lightbox prompt fuzzy matching via `_verifyPromptMatch()`) failed because portrait prompts all share the same template boilerplate — "character reference sheet", "four vertical columns", "plain background" — causing false positive matches on old images (e.g. bear character reference sheet matched against new Nigerian character reference sheet at >40% threshold).

**Root cause**: Any approach based on scanning the History tab DOM is fundamentally unreliable. Lazy-loaded images, template-shared prompts, and concurrent generations all create false positives.

**Discovery**: Network traffic analysis during a live generation revealed Higgsfield's API structure:
- Submit → creates job with UUID
- Frontend polls `GET fnf.higgsfield.ai/jobs/{uuid}/status` every few seconds
- On completion → `GET fnf.higgsfield.ai/jobs/{uuid}` returns full result including the exact CDN URL
- Response: `{ status, params.prompt, results.raw.url, results.min.url, created_at }`
- CDN filename format: `hf_YYYYMMDD_HHMMSS_{jobUUID}.png` — job UUID embedded in filename

**Solution — Layered combo strategy:**

**Layer 1 — API Job Tracking (primary):**
- `_interceptJobId()` — Playwright `page.on('response')` listener set up BEFORE clicking Generate. Captures job UUID from the first `/jobs/{uuid}/status` network response.
- `_pollJobCompletion(jobId)` — fetches `/jobs/{jobId}` from page context (inherits auth cookies) until `status === "completed"`. Returns `results.raw.url` — the exact CDN URL with zero ambiguity.
- No History tab scanning, no DOM walking, no fuzzy matching. Direct API → exact URL.

**Layer 2 — Timestamp-Gated CDN URL Diffing (fallback if Layer 1 fails):**
- Same CDN URL before/after diffing as before, BUT with timestamp validation.
- `_parseCdnTimestamp(url)` extracts the date from the CDN filename (`hf_YYYYMMDD_HHMMSS_...`).
- Rejects any URL whose embedded timestamp predates our Generate click (2-minute tolerance for clock skew).
- No lightbox opening needed — pure string parsing on the URL itself.

**Wiring:** Both `generateImage()` and `generateVideo()` call `_interceptJobId()` before clicking Generate, then pass the promise to `waitForGeneration(type, timeout, prompt, jobIdPromise)`.

**Why this works where the previous approach failed:** Layer 1 doesn't look at the History tab at all — it talks directly to the API and gets the exact URL back. The bear image could never appear because the API returns only the job we submitted. Layer 2's timestamp gating would also catch it: a stale image from April 12 can't pass a check requiring April 13+ timestamp.

---

## [S5] Reference Hard Gate & Prompt Sanitization

**Problem 1 — References not applied to scenes:**
Portraits downloaded correctly via API job tracking, but scene generation showed no reference influence despite logs saying references were staged and uploaded. Two root causes:

1. **React event not firing**: Playwright's `setInputFiles()` sets the file on the DOM input but some React apps (including Higgsfield's) don't process the file unless a `change` event fires. Playwright normally dispatches this, but the React synthetic event system may not pick it up.
   - **Fix**: After `setInputFiles()`, explicitly dispatch both `change` and `input` events with `{ bubbles: true }` to ensure React's event delegation picks up the file upload.

2. **No verification before Generate**: Even if the upload silently failed (no thumbnail appeared), the pipeline would proceed to click Generate without references.
   - **Fix**: `verifyReferenceThumbnails(expectedCount, references)` — counts actual visible thumbnails (with real `blob:`, `data:`, or `http` src) in the 56x56 reference slot containers.
   - Gate logic: count → wait 3s for late loads → clear + re-upload → final check → throw `REFERENCE_GATE_FAILED` if still mismatched.

**Problem 2 — Video start frame not verified:**
Same issue — `setInputFiles()` for the video start frame had no verification.
   - **Fix**: After uploading the start frame, verify a preview element (`img[src^="blob:"]` or `video[src^="blob:"]`) is visible. Retry once if not. Throws `REFERENCE_GATE_FAILED` on failure.

**Problem 3 — Line 2+ prompt continuity tags garbled:**
The LLM (Claude script generator) sometimes produces malformed continuity tags where the tag text is interleaved with scene description:
```
(Continuity: Using Image Prompt [Line 1] as rs slightly parted. Focus shifts to...
...quiet fire. Photorealistic cinematic still.eference) The same bustling...
```
The word "reference" is split across the prompt, and the description is woven into the tag.

   - **Fix**: `sanitizeContinuityTag(imagePrompt, lineNumber)` in orchestrator.js. Detects garbled tags (partial "as r...", orphaned "eference)", unclosed continuity parens), strips the fragments, extracts the reference line number, and prepends a clean `(Continuity: Using Image Prompt [Line X] as reference) ` prefix.
   - Applied to all scene prompts before `stageSceneReferences()` and before sending to Higgsfield.

**Problem 4 — Character portrait selection relied on fragile fingerprint matching:**
The old `stageSceneReferences()` decided which character portraits to upload by scanning the image prompt text for physical descriptors (age, scars, skin tone, hair, etc.). If the LLM wrote a shorthand description or omitted details, the fingerprints wouldn't match and that character's portrait would silently not be uploaded — even though `scene.characters_present` in the script JSON explicitly listed them.

   - **Fix**: Refactored `stageSceneReferences()` to use `scene.characters_present` as the **primary source of truth** for which portraits to include. Every character listed in the scene gets their portrait uploaded, no exceptions. Fingerprint matching is now used ONLY for ordering (so ref[0] maps to the first character described in the prompt). Characters present in the scene but not found in the prompt text are appended at the end rather than dropped.
   - Falls back to scanning all bible characters if `characters_present` is empty (backward compat for older scripts).
   - The relationship chain is now explicit and traceable: `character_bible.id → portrait_<id>.png → DB asset row → this.state.portraits → scene.characters_present lookup → upload`

**Files changed:**
- `src/main/automation/higgsfield.js` — `verifyReferenceThumbnails()`, event dispatch in `uploadImageReferences()`, video start frame gate, `uploadImageReferences()` now returns `successCount`
- `src/main/pipeline/orchestrator.js` — `sanitizeContinuityTag()`, refactored `stageSceneReferences()` to use `characters_present`, wired into scene generation loop

---

## Session 7 — First MVP Shipped End-to-End (April 14, 2026)

**Status**: 🎬 **SHIPPED**. First complete AI Nollywood drama produced by the pipeline: "They Called Her Bush Girl… God Had Other Plans" (2-min, 18 clips, audio-locked, watchable end-to-end). All major infrastructure issues resolved.

This session exposed and fixed **16 distinct failure modes** that made the prior sessions' pipeline look functional in isolation but unreliable end-to-end. Key themes: React `isTrusted` enforcement, browser state persistence, asynchronous ad loading, audio/video timebase alignment.

### 7.1 Identity Drift Root Cause — React `isTrusted` Event Check

**Status**: ROOT CAUSE FOUND + RESOLVED

**Symptom**: 70% of generated scene images had missing references despite thumbnails appearing in the UI. Previous Session 5 fix (explicit change/input event dispatch after `setInputFiles()`) appeared to work visually but silently failed at generation time.

**Root cause**: React checks `event.isTrusted` on file input change events. `setInputFiles()` and `fileInput.evaluate(el => el.click())` dispatch events with `isTrusted: false`. React accepts the file into the DOM (blob preview appears) but does NOT trigger its internal upload handler, so the file never reaches Higgsfield's backend. The reference is thus not included in the form submission.

**Fix**: Replaced ALL `setInputFiles` and JS-triggered clicks with real mouse clicks via `page.mouse.click(x, y)`. This dispatches a `isTrusted: true` click event React accepts, triggering the proper upload flow.

**Code**: `uploadImageReferences()` upload cascade now:
1. Pre-obtained filechooser from add-button click
2. `page.mouse.click()` at clickable's bounding box center (trusted)
3. `elementHandle.click({force: true})` fallback
4. `page.mouse.click()` on input's parent container

`setInputFiles()` and `input.click()` via JS are explicitly **removed** — they fake success but drop the backend upload.

### 7.2 Network-Based Upload Confirmation

**Status**: RESOLVED (replaces DOM-based CDN URL check)

**Symptom**: After fixing trusted clicks, the upload settle gate still timed out at 90s even when uploads had clearly succeeded.

**Root cause**: Higgsfield keeps the img `src` as `blob:` URL (local preview) even after the backend upload completes. They don't swap to a CDN URL in the DOM for performance reasons. Our "wait for `https://` in slot img src" was a false negative.

**Fix**: Registered `page.on('response')` listener at start of `uploadImageReferences()` to track HTTP responses. When we see a `POST 200` to endpoints matching `/upload|/asset|/media|/reference` or a `PUT 200` to S3/CloudFront URLs, the upload is confirmed. Watching actual network traffic = ground truth; DOM inspection = unreliable.

Per-upload flow: wait for network 2xx since `uploadStartTs` OR fallback to DOM CDN URL transition. 90s timeout per ref.

### 7.3 Persistent Filechooser Handler — No OS Picker Leaks

**Status**: RESOLVED

**Symptom**: Occasionally a native Windows file picker dialog would pop up during upload. User could manually close it and the pipeline would continue, but it was cosmetic noise.

**Root cause**: `Promise.all([page.waitForEvent('filechooser'), click])` has race windows. If the filechooser fires outside the timeout OR a second chooser fires after consumption, Playwright's interception is gone and the native picker shows.

**Fix**: Register `page.on('filechooser', handler)` ONCE at start of upload phase. Handler reads a shared `currentUploadFile` variable and attaches the right file to any picker that fires — no matter when. Applied to both `uploadImageReferences()` and video start frame upload.

```javascript
const fileChooserHandler = async (chooser) => {
  if (!currentUploadFile) {
    await chooser.setFiles([]).catch(() => {}); // dismiss unexpected pickers
    return;
  }
  await chooser.setFiles(currentUploadFile);
  lastFileChooserAt = Date.now();
};
page.on('filechooser', fileChooserHandler);
```

### 7.4 Fresh Browser Context Per Generation (The Only Reliable Clear)

**Status**: RESOLVED (replaces `clearImageReferences()` and in-page nav reset for video)

**Symptom**: Stale references persisted from previous scene, Veo start frame from previous clip showed up on next, approval gates re-triggered spurious state, localStorage drafts restored even after `page.reload()`.

**Root cause**: Higgsfield persists form state in React state + localStorage across generations. No in-page manipulation (nav click, reload, Escape, clicking X buttons) reliably clears it.

**Fix**: `recreateContext()` — capture cookies as `storageState`, strip localStorage, close page + context, create a brand-new context with just cookies, open a fresh page. Cost ~3-5s per generation. Used at the start of every scene (`generateImage`) and every clip (`generateVideo` → `clearVideoStartFrame`).

```javascript
async recreateContext() {
  const storage = await this.page.context().storageState();
  storage.origins = storage.origins.map(o => ({ ...o, localStorage: [] }));
  await this.page.close();
  await oldContext.close();
  const newContext = await this.browser.newContext({ storageState: storage, viewport: {...} });
  this.page = await newContext.newPage();
}
```

### 7.5 Ad Dismissal with Patience

**Status**: RESOLVED (through multiple iterations of tightening)

**Symptom**: Higgsfield shows promo overlays ("Soul Cinema is here", "Get 7-Day Unlimited Seedance") that cover the prompt area and reference upload button. Our clicks landed on ads, navigated to wrong pages.

**Root causes** (layered):
1. Ads render **asynchronously 1-3s after page load** — we were clicking before ads appeared, then ads popped mid-action
2. Overly aggressive ad detection matched page content (viewport-sized scrollable containers) and clicked phantom X buttons
3. Strategy B fallback matched ANY small SVG button in upper viewport, including nav icons
4. False-positive navigation: clicking a nav icon thinking it was an ad X

**Fixes**:
- **3-round patient dismissal** pattern: `wait 3s → dismiss → wait 2.5s → dismiss → wait 2s → dismiss → wait 1.5s`. Applied at every page-click entry point (`generateImage`, `generateVideo`, `clearVideoStartFrame`, `selectVideoModel`).
- **Strategy A** (primary): scan for panels of meaningful size (≥150x150 but NOT >85% viewport width AND >70% viewport height — skips page content), with overlay/modal/popup/promo/banner classes OR ad-like text ("cinema", "introducing", "new model", "try now", "unleashed", "upgrade"). Skip scrollable containers (`overflow-auto`, `hide-scrollbar`).
- **Strategy B** (fallback): only fires if a genuine overlay/backdrop is detected (dark bg, `rgba(0,0,0,*)`, large `[role="dialog"]`). Skips buttons inside nav/header. Requires explicit close markers (text `×`/`x`/`✕`, aria-label with "close"/"dismiss") — no more "SVG in upper half = probably close".

### 7.6 Strict Page-State Verification

**Status**: RESOLVED

**Symptom**: Pipeline got stuck in loops bouncing between `/create/video` (Veo) and other pages (`/create/edit` Motion Control, `/marketing-studio`, homepage). Verification reported the correct Veo page as "wrong" because Higgsfield's left sidebar contains tabs "Create Video | Edit Video | Motion Control" — our body-text wrong-page markers matched the nav tab labels.

**Fix**: `isOnVeoCreationPage()` now checks:
1. **URL first** (primary): must match `/create/video`, not `/create/edit` or `/motion-control`
2. **Active tab detection**: finds which tab has `.active`/`selected` CSS, `aria-selected="true"`, `data-state="active"`, underline border, or bold font-weight. If active tab isn't "create video" → wrong sub-page.
3. **Unique body-text markers only**: phrases that appear ONLY on wrong pages (e.g., `"turn any product into a video ad"`, `"describe what happens in the ad"` for marketing studio; `"kling 3.0 motion control"`, `"add motion to copy"` for motion control page body — NOT generic nav labels).

### 7.7 Nuclear Recovery When Stuck

**Status**: RESOLVED

**Symptom**: When Higgsfield redirected to unexpected pages (Marketing Studio, subscription flows), logo-click recovery sometimes couldn't escape because React state was corrupted.

**Fix**: Added `nuclearRecovery()` helper — tears down entire browser context, creates fresh one with cookies only, navigates to higgsfield.ai home, dismisses ads, clicks through to Veo. Triggered as Attempt 3 in `selectVideoModel()` after two nav attempts fail. A fresh context physically cannot be stuck in any prior React state.

### 7.8 Auto-Retry for Failed Video Clips

**Status**: RESOLVED (new feature)

**Requirement**: "Only approve and continue when there are no failed clips."

**Fix**: Wrapped video generation loop in a retry-until-clean structure. `MAX_RETRY_ROUNDS = 3` (env-tunable via `VIDEO_RETRY_ROUNDS`). Between rounds, reset failed clips to pending (preserving saved `cdn_url`), wait 5s for browser/network to settle, retry. CDN recovery path kicks in first — if Higgsfield actually generated the video before our timeout, direct fetch gets it without burning credits. After all rounds exhausted, if any clips still failed → throw `CLIPS_STILL_FAILED` instead of opening approval gate. Approval only opens at zero failures.

### 7.9 Video Generation Timeout Bumped

**Status**: RESOLVED

**Symptom**: Clips failing with "Generation timed out after 300s" during peak Higgsfield load (Veo can take 2-6 minutes for 8s clips).

**Fix**: Constants at top of `higgsfield.js`:
- `VIDEO_GEN_TIMEOUT_MS = 600000` (10 min, was 300s)
- `IMAGE_GEN_TIMEOUT_MS = 420000` (7 min, was 300s)
- All env-tunable via `VIDEO_GEN_TIMEOUT_MS` / `IMAGE_GEN_TIMEOUT_MS`

### 7.10 Audio Drift in Final Assembly

**Status**: RESOLVED

**Symptom**: First MVP assembly output had severe audio drift — mouths moving seconds apart from spoken words by end of the 2-min video.

**Root causes** (three stacking issues):
1. **Trim snap mismatch**: `trim=start=0.3` on video snaps to frame boundaries (33ms at 30fps), `atrim=start=0.3` on audio snaps to sample boundaries (0.02ms at 48kHz). Each clip lost ~5-20ms of drift between video and audio. Accumulated over 18 clips = ~100-360ms.
2. **`-c copy` during concat demuxer**: stream-copy requires identically-formatted clips (same timebase, codec params, sample rate). Any mismatch between processed clips compounds into audio shift.
3. **No CFR lock**: variable frame rate from Veo output carried through, making concat timeline unstable.

**Fix** (`src/main/assembly/assembler.js`):
1. **Trim disabled by default** (`trimStartSeconds: 0`, env-tunable). Veo dead-frame-at-start assumption doesn't hold for all clips and wasn't worth the drift cost.
2. **Per-clip normalization**: forced `-vf fps=30,format=yuv420p`, `-af aresample=48000:async=1`, `-ar 48000 -ac 2`, `-video_track_timescale 90000` on each processed clip.
3. **Concat now re-encodes** (not stream-copy): `-c:v libx264 -c:a aac -af aresample=async=1 -fps_mode cfr -r 30`. Resyncs audio to video timeline if any residual drift survived step 2.
4. **Final 4K upscale** also adds `-af aresample=async=1` for belt-and-suspenders.

### 7.11 Branding Card Disabled by Default

**Status**: RESOLVED (for MVP; can be re-enabled)

**Change**: `VideoAssembler` constructor now takes `enableBranding: false` default (env `ENABLE_BRANDING=true` to re-enable). `hasBrandingCard()` returns false unless both the flag is set AND the file exists. No intro, interval, or outro cards in MVP output.

### 7.12 2-min Duration Preset

**Status**: NEW

Added to `DURATION_PRESETS` in orchestrator:
```js
'2min': {
  label: '2 min (~216 credits)',
  targetSeconds: 120,
  structures: [
    { chapters: 2, scenesPerChapter: 3, linesPerScene: 3 },  // 18 lines
    { chapters: 3, scenesPerChapter: 2, linesPerScene: 3 },
    { chapters: 2, scenesPerChapter: 2, linesPerScene: 5 },
  ],
},
```

2-min is the MVP test preset. Enough clips to validate the full pipeline (~18) without burning credits on a full 10-min run.

### 7.13 History Grid Protection

**Status**: RESOLVED

**Symptom**: App accidentally clicked generated images in the Higgsfield history grid, toggling their selected state (checkmark), confusing downstream actions.

**Fixes**:
1. `_findReferenceUploadTrigger()` Strategy 3 (fresh page) filters candidates to the **bottom 55% of viewport** (history grid lives in top half; upload form always at bottom). Also excludes buttons inside `[class*="grid|thumbnail|card|history|overflow-x-hidden"]` unless inside a `<form>`.
2. `_deselectHistoryItems()` recovery: finds checked checkboxes, `aria-selected="true"`, `data-selected="true"` containers, and SVG checkmark icons by path data (`M5 13l4 4L19 7`), clicks to deselect. Runs at start of every `generateImage()`.

### 7.14 Prompt Typing — Whitespace-Tolerant Verification

**Status**: RESOLVED

**Symptom**: Prompt verification was ALWAYS failing, causing the app to always retype after first typing — visible as double-typing in the UI.

**Root cause**: Strict equality (`typedText !== animationPrompt.trim()`) against Higgsfield's contenteditable div, which normalizes whitespace (collapses double spaces, inserts invisible `<br>` for newlines, trims zero-width chars). Even a perfectly-typed prompt failed strict equality.

**Fix**: Whitespace-stripped comparison with 5% length tolerance. Only retypes if actual character count differs significantly (>5% or >5 chars), indicating real dropped/extra keystrokes.

### 7.15 Closed Page Detection

**Status**: RESOLVED

**Symptom**: "Target page, context or browser has been closed" cascading across all subsequent clips after one clip's `recreateContext()`.

**Root cause**: `ensureBrowser()` used `if (this.page) return;` — a closed page object still passes truthy, so subsequent clips used the dead reference.

**Fix**: `ensureBrowser()` now calls `this.page.isClosed()` check. If closed, it tries to reuse the existing browser by creating just a new context+page (fast path), or falls back to full browser relaunch if that fails.

### 7.16 New Utility Scripts

**`scripts/wipe-project.js`** — Nuke the active project entirely (DB rows + files on disk) so the app shows "Start Research". Preserves Higgsfield session cookies + research cache. Flags: `--force`, `--keep-files`.

**`scripts/status-check.js`** — Status report + DB/disk reconcile + optional stage advance. Finds clips that exist on disk but DB says `failed`/`pending` and marks them `done`. With `--advance`, sets project stage to `videos-done` to skip stuck retry loops. Useful for recovering from hung pipelines.

**`scripts/reopen-project.js`** — Reactivate a completed project for re-assembly. Sets `completed_at=NULL`, sets stage (default `videos-done`), deletes old output video. Used to rerun assembly with updated code (like the audio-drift fix applied this session).

### Session 7 Files Changed

- `src/main/automation/higgsfield.js` — massive rewrite: real-mouse uploads, network confirmation, persistent filechooser handler, ad dismissal v3, strict page-state verification, nuclear recovery, timeouts bumped, closed-page detection, `recreateContext()`, `_deselectHistoryItems()`
- `src/main/pipeline/orchestrator.js` — 2-min preset added, fresh context per scene wired, auto-retry loop for video clips, approval gate blocked until zero failures, page-state guard before prompt typing
- `src/main/assembly/assembler.js` — per-clip codec/sample-rate normalization, `aresample=async=1` at every stage, concat re-encode (not stream-copy), CFR lock, branding disabled by default, trim disabled by default
- `src/renderer/index.html` — 2-min option in duration dropdowns
- `scripts/wipe-project.js`, `scripts/status-check.js`, `scripts/reopen-project.js` — new
- `CLAUDE.md` — 130+ lines of new documentation covering all of the above, plus post-MVP priority 1 Verify Clip spec

### MVP Shipped Output

**"They Called Her Bush Girl… God Had Other Plans"**
- Duration: 2min (18 clips × ~7s each)
- Audio: locked to video throughout (no drift)
- Quality: 4K, 30fps CFR, yuv420p, 48kHz stereo AAC
- No branding cards
- Assembly time: ~3 minutes (post-all-fixes)

Full pipeline Research → Script → Portraits → Scenes → Videos → Assembly → Export validated end-to-end.

## Session 8 — Verify Clip, NSFW Recovery & History Recovery (April 14, 2026)

**Status**: 🧠 **Post-MVP polish**. Three features shipped that reduce human-in-the-loop burden + claw back lost credits: (1) Gemini-based Verify Clip stage wired into the pipeline, (2) surgical dialogue-edit tool for Veo NSFW rejections, (3) History Recovery — both inline auto and CLI batch — for reclaiming clips Higgsfield generated but we lost track of.

### 8.1 Verify Clip — Gemini vs Whisper Benchmark

**Status**: RESOLVED (Gemini backend is default)

**Data from 18-clip "Bush Girl" MVP output**:
| Backend | Accept | Review | Reject | False-positive rejects | Matches human eyeball |
|---|---|---|---|---|---|
| Gemini 2.5 Flash | 17 | 1 | 0 | 0 | ✓ yes |
| Whisper API | 14 | 4 | 0 | 3 | ✗ no |

**Why Whisper lost**: It auto-detected Nigerian-accented English as Yoruba ("Njezo. Jago!" transcripts on clean clips), so similarity scores collapsed. Forcing `language=en` in the API call and relaxing the auto-reject threshold (only reject on Gemini-reported `silent` or `wrong language`, never on similarity alone) cut the false-positive rate to 0 but Whisper was still stricter than Gemini overall.

**Why Gemini won**: It sees both video AND audio, so accented pronunciation doesn't matter — it can tell a character is clearly delivering the expected line. One API call returns transcript + mouth-sync assessment + silence flag + wrong-language flag in one pass. Cost: ~$0.036 for an 18-clip 2-min script (~$0.002/clip).

**Smart approval gate**: If all clips auto-pass, the Verify tab never opens — pipeline proceeds straight to Assembly. Only flagged items force a manual review. Makes the stage effectively invisible on healthy runs.

**Redo loop hardening**: Original verify stage threw `VERIFY_LOOP_REDO` that wasn't caught, crashing the pipeline. Fixed by wrapping verify in `while` loop with `MAX_VERIFY_REDO_ITERATIONS=3` env-tunable cap, regenerating pending clips inline in subsequent iterations.

### 8.2 NSFW Rejection — Surgical Dialogue Editing (`edit-line.js`)

**Status**: RESOLVED

**Symptom**: Veo 3.1 Lite rejected a specific animation prompt as "NSFW" (line: "You sold me, Mama" — apparently "sold" triggers human-trafficking classifiers). 8 of 9 clips in that session generated fine; the one NSFW line blocked the whole batch since all clips need to complete before the verify stage.

**Root cause**: Veo's NSFW filter is opaque — no clear documentation of triggers, and the same prompt can be accepted or rejected depending on phrasing. No way to predict which lines will fail.

**Fix**: `scripts/edit-line.js` — surgical single-line editor that:
1. Rewrites a line's `dialogue` field in `projects.script_json` by chapter + line number
2. Resets the matching `project_assets` row (type=video_clip) to `pending`
3. Clears verify_* columns (`verify_transcript`, `verify_similarity_score`, `verify_status`, etc.)
4. Deletes the old .mp4 on disk (if any)
5. Rolls back `project.current_stage` if past `verified` so the user can re-run video → verify from the right point

**Usage**: `node scripts/edit-line.js --chapter=3 --line=7 --dialogue="You gave me away, Mama"`

**Workflow**: user hits NSFW → inspects the offending line in app's UI → runs `edit-line.js` with rephrased dialogue → restarts app → pipeline resumes from `scenes-done` and regenerates only that one clip.

### 8.3 History Recovery — Design + Implementation

**Status**: RESOLVED (both modes shipped)

**Problem**: After a pipeline crash mid-generation, user saw "8 of 9 files generated, 1 NSFW to fix, only 4 clips downloaded locally". Higgsfield had successfully produced ~4 clips server-side, but our pipeline died before capturing their CDN URLs. Retrying would double-charge credits for clips Higgsfield already made.

**Design doc**: `IMPROVEMENT-HISTORY-RECOVERY.md` (460 lines) — covers scraper strategy, scoring rationale (prompt + timestamp combination, why no embeddings), policy decisions (auto vs prompt vs skip by tier), failure modes, Phase 4.5 inline-recovery flow.

**Shipped components**:
1. **Migration 006** adds `higgsfield_asset_id` + `recovered_from_history` columns to `project_assets`
2. **Selectors config** — `assetHistory` section in `higgsfield-selectors.json` with placeholders for thumbnail links, detail panel, date partitioning, download button
3. **Scraper** (`src/main/automation/higgsfield-history.js`, ~340 lines):
   - `scrapeRecentVideos({maxAgeHours, maxItems, bypassCache})` — structured strategy first (hunts for `/asset/all/<uuid>` href pattern), broad DOM-walk fallback
   - `getAssetDetails(uuid)` — hydrates individual prompts + timestamps from detail page
   - `findMatchForAsset(asset, options)` — scrape + score + pick highest (uses clipMatcher)
   - `downloadAsset(uuid, destPath, knownCdnUrl)` — direct CDN fetch if we have the URL, else navigate + click Download with persistent filechooser
   - In-memory scrape cache, 5-min TTL, invalidated per run
4. **Matcher** (`src/main/recovery/clipMatcher.js`, ~190 lines):
   - Pure functions: `scoreMatch`, `matchAll`, `promptSimilarity`, `tierForScore`
   - Normalized Levenshtein for prompt similarity (lowercase, no punctuation, collapsed whitespace)
   - Combined: 85% prompt + 15% timestamp proximity (linear decay within ±10min window)
   - Tiers: high (≥85% + ≤10min), medium (≥70% + ≤30min), low (≥50%), none (<50%)
   - `matchAll()` does greedy assignment — each scraped video + DB clip claimed at most once
5. **DB helpers** in `db.js`: `markAssetRecoveredFromHistory()` sets status=done + file_path + cdn_url + higgsfield_asset_id + recovered_from_history=1 + completed_at. `getHistoryRecoveryCandidates(projectId)` returns pending/failed clips with no cdn_url and a prompt_used
6. **CLI** (`scripts/recover-from-history.js`, ~270 lines):
   - Flags: `--auto`, `--dry-run`, `--max-age-hours=N`, `--project-dir=<path>`
   - Interactive flow: scrape → hydrate → match → display table → confirm/apply per tier
   - Updates DB inline via `db.run()` (sql.js style)
7. **Inline auto-recovery** in `orchestrator.js`:
   - Constructor: `_historyRecovery` (lazy), `_historyAttempted` (Set), `_jobIdsSeen` (Set)
   - `start()` resets per-run state + invalidates scrape cache
   - Video catch block: after CDN-URL-save, before `markAssetFailed`, calls `_shouldTryHistoryRecovery(asset, err)` — skips if cancelled, SESSION_EXPIRED, browser closed, already attempted, or CDN URL captured
   - On match: `downloadAsset()` → `markAssetRecoveredFromHistory()` → emit `clip-complete` → `continue` (skip failure path — no credits wasted)

**Policy contrast**:
- Inline mode is conservative: **high confidence only** (≥85%), ~5-15s latency per attempt, silent fall-through on miss
- CLI mode is interactive: auto-applies high, prompts user on medium, skips low. `--auto` restricts to high only. `--dry-run` lets you preview the match table first.

**Unit test** of matcher (functional, not in test suite): identical prompts → 100% high, similar+5min delta → 66% low, different prompts → 32% none, greedy assignment correctly claims each pair once. Verified before wiring into orchestrator.

### 8.4 Verify Clip API Config + Key Management

**Status**: RESOLVED

**Symptom**: User accidentally leaked an OpenAI API key twice in raw form during config setup; also hit a JSON syntax error (missing comma after `geminiApiKey`) in `config.json`.

**Fix**: Refactored API key loading into `getApiKey(name)` helper that reads from `electron-store`-compatible `config.json` (or `process.env.<NAME>_API_KEY` as fallback). Recommended validation:

```bash
node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('config.json'))))"
```

Prints only key names, not values — safe to paste into chat.

**User was twice-warned** to revoke exposed keys at https://platform.openai.com/api-keys. The pipeline works with either Gemini or OpenAI/Whisper backends, so swapping keys is low-friction.

### 8.5 Pipeline Activity Log — Recovery Event

**Status**: RESOLVED

Added `asset_recovered` event type to the pipeline log (alongside existing `asset_start`, `asset_done`, `asset_failed`, `asset_dedup`). Fires whenever an asset is saved via `markAssetRecoveredFromHistory()`, with detail string like `Recovered from history <uuid> (score=95%, tier=high)`. Gives the resume-context summary an audit trail distinct from normal done/failed.

### Session 8 Files Changed

**New**:
- `src/main/database/migrations/006-history-recovery.sql`
- `src/main/automation/higgsfield-history.js` — HiggsfieldHistory class
- `src/main/recovery/clipMatcher.js` — scoring + matching
- `src/main/verify/clipVerifier.js` — Gemini + Whisper backends
- `scripts/recover-from-history.js` — CLI batch recovery
- `scripts/edit-line.js` — surgical dialogue editor
- `scripts/test-verify.js` — isolated verify test harness
- `IMPROVEMENT-HISTORY-RECOVERY.md`, `IMPROVEMENT-MULTICAM.md`, `IMPROVEMENT-SEO-PUBLISH.md` — design docs

**Modified**:
- `src/main/pipeline/orchestrator.js` — Verify stage, inline history recovery, verify redo loop with cap, `_shouldTryHistoryRecovery` helper, constructor state for recovery
- `src/main/database/db.js` — `markAssetRecoveredFromHistory`, `getHistoryRecoveryCandidates` + verify_* column helpers
- `config/higgsfield-selectors.json` — `assetHistory` section
- `config.json` — added `openaiApiKey` slot
- `CLAUDE.md` — History Recovery section + expanded Recovery & Reset Scripts list

### Post-MVP Roadmap Status

| Feature | Status | Docs |
|---|---|---|
| Verify Clip (Priority 1) | ✅ Shipped S8 | CLAUDE.md § Verify Clip Stage |
| History Recovery (Priority 2) | ✅ Shipped S8 | `IMPROVEMENT-HISTORY-RECOVERY.md` |
| SEO Publish Stage | 📋 Designed | `IMPROVEMENT-SEO-PUBLISH.md` |
| Multi-cam shots (staged mode) | 📋 Designed | `IMPROVEMENT-MULTICAM.md` |
| Cinematic workflow mode | 📋 Designed (Phase 0 validated S8) | `IMPROVEMENT-CINEMATIC-WORKFLOW.md` |
| Platform integration (YouTube/FB upload) | ⛔ Out of scope | — |

## Session 8 — Phase 0 Validation: Cinematic Workflow Mode (April 2026)

**Status**: ✅ Design doc shipped (`IMPROVEMENT-CINEMATIC-WORKFLOW.md`). Phase 0 end-to-end pipeline validation complete. Implementation gated behind explicit green-light.

**Goal**: Confirm whether a parallel "cinematic" production pipeline — using Cinema Studio 2.0 for scene images and Kling 3.0 for multi-shot video with native audio — is viable as a prestige alternative to the existing staged (Veo) workflow.

### S8.P0.1 — Kling 3.0 capability confirmation (via official docs)

Read `kling.ai/quickstart/klingai-video-3-model-user-guide` end-to-end. Confirmed:
- Native audio (dialogue + ambient + music) in single generation pass
- Multi-shot: up to 6 shots per generation, Auto mode or explicit Custom mode with timing labels
- Image-to-Video with enhanced subject consistency (element binding)
- Multi-character coreference (3+ characters)
- Multilingual: EN, CN, JP, KR, ES with dialects/accents (Nigerian "etc." per docs, confirmed in user's prior prod use)
- 3-15s flexible duration (10-12s sweet spot per user, 15s degrades)
- Official pricing: 9 credits/s at 720p native audio direct; Higgsfield wrapper rate ≈ 1.75 credits/s

### S8.P0.2 — Live Higgsfield UI inspection

Mapped the Elements panel + Cinema Studio 2.0 + Kling 3.0 UI paths via Chrome automation:
- **Elements panel**: 3 categories — Characters, Locations, Props. Creation requires 2-4 ref images + name + description + (optional) voice tone for characters.
- **Element creation UI path**: Higgsfield → Cinema Studio 3.0 → toggle 2.5 top-right → click Image → switch model dropdown to Cinema 2.0 → click `@` button → `+ Create new` form.
- **Cinema Studio 2.0 prompt** supports `@element_name` mentions (Characters + Locations + Props autocomplete with typed prefix), reference image attachment via `+` button, aspect ratio selector, resolution, 1/4 copies, Unlimited toggle.
- **Kling 3.0 Video page** has Multi-shot toggle (ON/OFF), Auto/Custom mode selector, Start frame + End frame slots, duration selector (4/6/8/10/15s), aspect (16:9/9:16/1:1), resolution (720p/1080p).

### S8.P0.3 — End-to-end test generation (credits spent)

Single-scene pipeline test with pre-existing `@claire` + `@richard` character elements:

1. **Nano Banana Pro location** (2 credits): generated empty Nigerian village kitchen at dusk, earthen walls, kerosene lamp, window with sunset light. 16:9, 2K, Unlimited. Result matched prompt — no people, proper cinematic lighting.
2. **Cinema Studio 2.0 scene blocking** (4 credits): used kitchen image as reference + prompt `WIDE SHOT inside the kitchen from the reference image. @claire stands frame-left near the wooden table, body angled toward the window, arms tense at her sides, brows drawn tight. @richard stands frame-right near the doorway, hands slightly clenched, eyes fixed on her, jaw tight. Warm kerosene lamp light fills the kitchen, dusk light spilling through the window behind them. Both mid-confrontation.` 16:9 Cinematic, 4K, Cinema 2.0 model. Result: both characters correctly placed per blocking, location visually consistent with reference, cinematic framing. Characters rendered using their element references (claire's green dress + richard's suit preserved).
3. **Kling 3.0 multi-shot video** (26.25 credits): start frame = Cinema 2.0 scene image, Multi-shot ON (Auto), 15s, 720p, 16:9. Prompt included 3 shots with camera moves + Nigerian English dialogue using bracketed format `[@character, speaking in a <tone> Nigerian English accent]: "<dialogue>"`. Generation completed after ~3 minutes.

**Total Phase 0 spend**: ~32 credits. Covered the full cinematic pipeline end-to-end.

### S8.P0.4 — Findings

**Pipeline viability**: ✅ Buildable.
- Each stage completed successfully with expected output.
- Element system (`@name` mentions) resolves correctly across Cinema Studio 2.0 and Kling 3.0.
- Character consistency validated: Claire (green dress) and Richard (suit) preserved from elements through to scene image.
- 16:9 Cinematic aspect propagates through the pipeline.
- Location reference locks visual continuity between empty-location image and populated scene image.

**Automation gotchas discovered** (captured in cinematic workflow design doc):
1. Cinema Studio 2.0 requires session-level setup (click 2.5 toggle + model dropdown every page load)
2. ~~Native file-picker dialogs cannot be automated — must use "Image Generations" tab picker~~ **RESOLVED (Session 10):** Playwright's `page.waitForEvent('filechooser')` intercepts the native file dialog. Location images are uploaded via the Uploads tab, NOT Image Generations. `setInputFiles()` on hidden `input[type="file"]` was removed (caused double uploads).
3. `@` autocomplete: type 2-3 letter prefix + wait + Enter (typing full name scrolls past match)
4. `@` typed alone can insert recent reference image as "Image N" chip instead of opening character picker
5. Generation timings: Cinema Studio 4K = 60-90s, Kling 15s multi-shot = 2-4 min
6. **(Session 10)** Picker tile detection: "Upload Images" is an 892×298 container with tiles INSIDE it (not to its right). Tile detection must scan the full picker zone (y between tab buttons and toolbar overlay). Location key normalization must match between setup and lookup (`toLowerCase().replace(/[^a-z0-9_]/g, '_')`).

**Credit math revised**: at Higgsfield rates, Kling 3.0 10s clip costs ~17.5 credits. 10-min cinematic story ≈ 60 clips × 17.5 = ~1050 credits — roughly same as staged 10-min (~1080 credits). Not materially more expensive.

### S8.P0.5 — User production data (independent validation)

User confirmed Kling 3.0 has been in production use since January 2026:
- Nigerian English accent renders correctly (not explicitly listed in Kling docs but works in practice)
- Character consistency across multi-shot cuts holds
- Per-character lip-sync switches correctly when multiple characters speak
- Audio quality acceptable
- 10-12s is the reliable duration zone; 15s approaches failure threshold

This user data substitutes for exhaustive in-session quality validation on the single Phase 0 test clip and makes the "GO" verdict unambiguous.

### S8.P0.6 — Verdict + Next Steps

**Phase 0 verdict: GO**. Cinematic workflow is a real, buildable parallel pipeline.

- Design doc: `IMPROVEMENT-CINEMATIC-WORKFLOW.md` (500+ lines; covers topology, schema additions, elements system, Kling prompt template, 6-phase implementation plan, risks, anti-patterns)
- CLAUDE.md updated with "Cinematic Workflow Mode (Session 8 — designed, not yet implemented)" section
- Implementation scope: ~20-25 hours across 6 phases, all additive to existing infrastructure
- Staged workflow remains unchanged; cinematic is opt-in via `projects.generator_mode = 'staged' | 'cinematic'` (migration 009 when implemented)
- All new automation surfaces (Elements panel, Cinema Studio 2.0, Kling 3.0) documented with DOM inspection notes for future selector mapping

Implementation awaits explicit user green-light.

### S8.P1 — Cinematic Workflow Phase 1 Shipped (schema + script prompt + UI)

**Scope:** dependency-free foundation — no new automation, no new video generation calls. Validates the cinematic script JSON format end-to-end at zero credit cost.

**What landed:**
- Migration 009: `projects.generator_mode TEXT NOT NULL DEFAULT 'staged'`, tested against fresh DB (column adds cleanly, schema_version bumped to 9, default applies on insert)
- `db.setProjectGeneratorMode(projectId, mode)` — lock-on-start semantics mirroring aspect_ratio
- `db.createProject()` + `db.getActiveProject()` now carry `generatorMode`
- Orchestrator: reads `options.generatorMode`, persists + state + passes to script engine
- `ScriptEngine._buildCinematicScaffolding(mode, tier)` — returns authoring rules (blocking, location_element_hint, props_in_scene, kling_clips) when mode = cinematic; empty string for staged (zero behavior change)
- `CINEMATIC_RUBRIC_EXTENSION` constant — 4 new grader dimensions + critical-failure modes for cinematic scripts
- Pass thresholds +5 in cinematic (test=55, standard=65, long-form=75)
- Renderer: third dropdown next to Duration + Aspect. Badge on research view. Mode badge on resume card.
- Prompt files: `{{CINEMATIC_SCAFFOLDING}}` + `{{CINEMATIC_SCHEMA_ADDENDUM}}` placeholders added to script-prompt.txt; `{{GENERATOR_MODE}}` + `{{CINEMATIC_RUBRIC_EXTENSION}}` placeholders added to structure-review-prompt.txt

**Integration test:** verified cinematic scaffolding substitutes correctly — empty for staged, 4772 chars with all expected markers (`kling_clips`, `BLOCKING`, `location_element_hint`, `@claire`, Kling dialogue syntax) for cinematic.

### S8.P1.5 — "Start a different story" Escape Hatch

Added after noticing the Resume card blocks access to the New Story card (with the mode selector) when a project is in-progress. Before this, user had to finish or manually wipe the active project to pick cinematic mode.

- `db.abandonProject(projectId)` — sets `completed_at = datetime('now')` + stage = `'abandoned'`. Data preserved.
- `orchestrator.abandonActiveProject()` — wrapper + running-pipeline guard + state reset
- IPC `abandon-active-project` + preload `window.api.abandonActiveProject()`
- Renderer: ghost button + subtitle on Resume card, confirmation dialog, reload launcher after abandonment

### S8.P2 — Cinematic Workflow Phase 2 Shipped (element automation)

**Scope:** first real Higgsfield automation surface for the cinematic pipeline — generates character grids, creates Character elements, with mandatory graceful fallback to manual creation when automation hits the 7-click UI's fragility.

**What landed:**
- Migration 010: `project_assets.higgsfield_element_id TEXT`, `project_assets.element_name TEXT`, indexes (tested against fresh DB, schema_version 10)
- New asset type: `character_grid` (4-column reference sheet per character, generated via Nano Banana Pro using portrait as reference)
- New automation module: `src/main/automation/higgsfield-elements.js` (~250 lines) with `HiggsfieldElements` class:
  - `_openElementsPanel()` — navigates the 7-click UI path
  - `listExistingElements()` — scrapes + caches
  - `elementExists(name)` — case-insensitive + leading-@ normalized
  - `createCharacterElement({name, portraitPath, gridPath, description})` — idempotent, uses Playwright filechooser interception for image uploads
  - Static `buildManualChecklist(pending)` for fallback path
- Orchestrator: new `_runCinematicElementSetup()` stage (3A.5) gated on `generatorMode === 'cinematic'`. Staged mode = no-op passthrough. Runs between portraits-done and scene generation.
- `_titleInitials(title)` + `_generateCharacterGrid(character, portraitPath, outputPath)` helpers
- Element naming: `@{char-id-suffix}_{title-initials}` e.g. `@claire_thp` for Claire in "The Heir's Probation"
- New approval gate: `elements-ready`. Pipeline emits `cinematic-manual-element-checklist` event + pauses when automation can't finish.
- IPC `approve-elements-ready` + preload + new renderer view `#view-cinematic-elements` with pending list + collapsible manual walkthrough + "Elements Ready — Continue" button

**Known limitations (documented in CLAUDE.md + design doc):**
- Automation is best-effort; fallback to manual checklist is mandatory-by-design
- Voice tone binding is NOT automated; user binds manually if desired (improves Kling lip-sync but not required for creation)
- Location elements + prop elements deferred to Phase 3

### Post-MVP Roadmap Update After Phase 2

| Feature | Status | Notes |
|---|---|---|
| Verify Clip (Priority 1) | ✅ Shipped S7 | |
| History Recovery | ✅ Shipped S7 | |
| Aspect Ratio (16:9 + 9:16) | ✅ Shipped S8 | Migration 007 |
| Multi-research pools | ✅ Shipped S8 | Migration 008, cap 5 |
| Duration long-form (20min, 30min) | ✅ Shipped S8 | |
| Structural review gate | ✅ Shipped S8 | |
| Abandon-project escape hatch | ✅ Shipped S8 | |
| **Cinematic Workflow Phase 1** | ✅ Shipped S8 | Migration 009 |
| **Cinematic Workflow Phase 2** | ✅ Shipped S8 | Migration 010; element creation + grid automation |
| Cinematic Workflow Phase 3 | ✅ Shipped S8 | Migration 011; location extraction + element creation + Cinema Studio 2.0 scene image automation |
| Cinematic Workflow Phase 4 | ✅ Shipped S8 | Migration 012; Kling 3.0 multi-shot video automation with start-frame anchoring |
| Cinematic Workflow Phase 5 | ✅ Shipped S8 | Per-line scoring + speaker attribution + shot-cut detection in `verifyCinematicClip()`; renderer table shows per-line tier dots |
| Cinematic Workflow Phase 6 | ✅ Shipped S8 | Assembly fork (read `video_clip_cinematic`) + sort by chapter→scene→clip-order + mode badges in generation + completion views + cinematic_ filename prefix |
| Cinematic Workflow (overall) | ✅ Shipped S8 — END-TO-END | All 6 phases live; opt-in per project via mode selector; staged pipeline unchanged |
| `kling-history-recovery.js` (optional) | 📋 Backlog | Parallel to existing Veo recovery; only useful when Kling generations crash mid-flight |
| SEO Publish | 📋 Designed | `IMPROVEMENT-SEO-PUBLISH.md` |
| Multi-cam (staged mode) | 📋 Designed | `IMPROVEMENT-MULTICAM.md` (superseded for long-form by cinematic) |
| Platform integration | ⛔ Out of scope | |
