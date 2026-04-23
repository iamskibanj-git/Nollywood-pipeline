# Improvement Exploration: Cinematic Workflow Mode

> Status: **All 6 phases shipped** (Session 8, April 2026). Cinematic workflow is end-to-end functional alongside the staged pipeline. Captures a **parallel production pipeline** that runs alongside the existing "staged" workflow — not a replacement. Both ship; user picks per-project.
>
> Progress tracker:
> - ✅ **Phase 0** — validation (Kling docs + live UI inspection + end-to-end test ~32 credits)
> - ✅ **Phase 1** — schema + script prompt + mode selector UI + structural review rubric extension (migration 009)
> - ✅ **Phase 2** — character grids + Higgsfield character element creation automation + manual-checklist fallback (migration 010)
> - ✅ **Phase 3** — location extraction + empty-location image generation + location element creation + Cinema Studio 2.0 scene image automation (migration 011)
> - ✅ **Phase 4** — Kling 3.0 multi-shot video generation automation with per-clip start-frame anchoring + native audio + Higgsfield element resolution (migration 012)
> - ✅ **Phase 5** — Verify Clip adaptation: per-line scoring within multi-shot cinematic clips + speaker attribution + shot-cut detection (no schema migration; cinematic verify data folded into existing verify_notes column via tagged JSON suffix)
> - ✅ **Phase 6** — Assembly fork (mode-aware asset reading + `chapter→scene→clip-order` sort), mode/aspect/duration badge in generation + completion views, `cinematic_` prefix on output filename, fallback assembler ordering also fixed for staged scenes (no schema migration)
>
> **Optional follow-up backlog (not blocking):**
> - **HIGH PRIORITY — Element creation automation must actually work, not silently fall back to manual.** Session 8 first cinematic run: all 3 character elements fell to the manual checklist. The automation is built (`HiggsfieldElements._createElement`) but the 7-click UI path is fragile — selectors may not match live DOM, popups may interfere, file-chooser interception may race. **Manual checklist is FALLBACK ONLY, not default.** Need: (a) live DOM inspection of the element-creation form (esp. Upload Images filechooser interception, name input selector, category combobox, Create button), (b) explicit pass/fail logging at every step of `_createElement`, (c) consider screenshot-on-failure for diagnosis. Until this works reliably, cinematic runs effectively require manual element setup per character — which is OK for occasional use but defeats the point at scale.
> - **Element name generation produces ugly defaults.** `${char.id.replace(/^character_/, '')}_${titleInitials}` on a char.id of `character_1` yields `@1_matmw` rather than something readable like `@mama_blessing_matmw`. Consider deriving the name suffix from `character.description_label` (slugified) instead of just the numeric id.
> - `kling-history-recovery.js` — parallel to existing Veo recovery, scrapes Higgsfield Kling assets to reclaim orphans when local download fails after server-side generation succeeds. Mid-priority — Kling generations are typically robust; the existing per-clip retry covers most failure modes.
> - Voice-tone binding automation in element creation flow — currently characters are created voice-less; user binds Nigerian English voice manually for best Kling lip-sync.
> - Location-reference picker by CDN URL (currently position-based fallback) — scrape Cinema Studio scene image's CDN URL during Phase 3 for exact match in Phase 4 start-frame attachment.
> - Per-shot framing grader in Phase 5 — currently we count cuts but don't grade whether each shot's framing matched the multi_shot_prompt. Possible if visual drift becomes a recurring problem.

## TL;DR

The current staged workflow (Veo 3.1 Lite, one 8s clip per dialogue line, wide-group framing enforced by the Conversation Lock rule) produces output that feels "stagey" — every clip is the same painting with one character's mouth moving. No coverage, no cinematic rhythm, no dynamic movement.

The **cinematic workflow** replaces the per-line-per-Veo-clip model with a different production stack inspired by how actual film production works:

1. **Pre-production:** portraits + character grids + character/location/prop **elements** (Higgsfield's persistent identity system)
2. **Production (images):** empty location generation (Nano Banana Pro) → blocked scene images (Cinema Studio 2.0 with `@element` references + blocking)
3. **Cinematography (video):** **Kling 3.0** with multi-shot prompts containing up to 6 shots per 10-15s clip, native audio with lip-synced Nigerian English dialogue per character, start-frame anchoring from the Cinema Studio scene image

Each discipline uses the tool best suited for it. Multi-shot coverage happens *inside* a single Kling generation instead of being manufactured across separate 8s Veo clips — which is why the staged workflow will always feel like editing a slideshow no matter how we tune its prompts.

**Phase 0 validation (Session 8):** Every blocking assumption confirmed against real Higgsfield UI + Kling docs + one end-to-end test generation. Building is no longer speculative.

**Isolation from staged workflow:** project-level `generator_mode = 'staged' | 'cinematic'` flag, set at Start Research time alongside aspect ratio + duration, locked for the project's lifetime. Staged projects run the existing pipeline untouched. Cinematic projects route through the new stages. ~60% of infrastructure is shared (research pools, script generation with structural review, project DB, history recovery, Verify Clip with adapted scope, assembly, publish). The diverging ~40% is the asset-creation + video-generation surface.

## Why This Is Needed (Root-Cause Analysis of "Stagey" Output)

### The root cause in the script-prompt

`prompts/script-prompt.txt` enforces the **Conversation Lock** rule (line 13):

> "the subsequent image prompt MUST re-create that exact scene and group of characters. The only changes are the micro-expressions and focus, shifting to show the next character replying to the previous speaker."

This rule exists for a GOOD reason — it prevents character drift between clips in the staged workflow. Veo's 1-line-per-8s-clip model means 90 separate generations for a 10-min story, and without a strict continuity rule each image freewheels and characters mutate across frames.

But the rule also **enforces wide-group framing on every single clip**. Every line in a scene gets the same painting with one character's mouth moving. That's the source of the stagey feeling.

### Why "staged" can't escape this by prompt tuning alone

You can't fix this by relaxing the Conversation Lock in the staged workflow because:

1. **Veo generates only single-shot clips.** No cuts within an 8s generation. Coverage can only be manufactured across *separate* clips.
2. **Separate clips re-roll character identity every time.** Even with the character bible + element refs, going from a wide on Line 1 to a close-up on Line 2 in separate Veo generations risks face drift. Each generation is independent.
3. **Stitching coverage across Veo clips is editing, not filming.** Real TV drama is shot with multiple cameras running simultaneously and cut in post. Simulating that by generating one close-up and one wide separately and cutting between them always feels artificial.

### Why the cinematic stack escapes it

Kling 3.0's **Multi-Shot** feature plans shot transitions *inside* a single generation. The model sees the full arc — wide establishing, cut to medium on speaker, cut to close-up on reaction — and generates coherent coverage as ONE continuous piece of cinema. Character identity holds across the cuts because they're all part of the same generation pass, anchored to the same start frame + element references + voice tone.

That's architecturally different from "generate 3 separate 8s Veo clips and concatenate them." And it's why Kling 3.0 is the unlock.

## Phase 0 Validation — Confirmed Findings

### From Kling 3.0 official docs (kling.ai/quickstart/klingai-video-3-model-user-guide)

| Capability | Confirmed? |
|---|---|
| Native audio (dialogue + ambient + music in one pass) | ✅ |
| Lip-sync baked in | ✅ |
| Multi-shot up to 6 shots per generation | ✅ |
| Duration 3-15s flexible | ✅ (10-12s sweet spot — things degrade near 15s max) |
| Start frame + element reference (Image-to-Video) | ✅ |
| Multi-character coreference (3+ characters per scene) | ✅ |
| Multilingual: EN, CN, JP, KR, ES | ✅ |
| English accents: American, British, Indian, **etc.** | ⚠️ "etc." — Nigerian not explicitly listed but user confirms working in production |

### From live DevTools + UI inspection (Session 8)

- **Elements panel** categories: Characters, Locations, Props. Each element created via upload of 2-4 reference images + name + category + description (optional voice tone for characters).
- **Element creation UI path** (7-8 clicks deep): Higgsfield logo → Cinema Studio 3.0 → 2.5 toggle top-right → Image → switch model dropdown to Cinema 2.0 → click `@` button → click `+ Create new` → fill form → Create. Testable via `@element-name` autocomplete in prompt textbox.
- **Cinema Studio 2.0** supports `@character_name`, `@location_name`, `@prop_name` mentions + reference image attachment via `+` button → Image Generations tab (to pick already-generated assets instead of local upload).
- **Kling 3.0 Video page** has explicit Multi-shot toggle (Auto / Custom), Start frame + End frame slots, duration selector (4s / 6s / 8s / 10s / 15s), aspect ratio (16:9 / 9:16 / 1:1 / etc.), resolution (720p / 1080p).
- **Pricing** (confirmed in UI): 26.25 Higgsfield credits for 15s 720p Kling 3.0 Multi-Shot with native audio. ≈ 1.75 credits/sec.

### From user's prior production use (Jan 2026+)

User has been running Kling 3.0 in production since January 2026. Nigerian English accent renders correctly. Character consistency across multi-shot cuts holds. Lip-sync per-character switches correctly. Audio quality is acceptable. Phase 0 is effectively done.

### Credit math comparison at Higgsfield rates

| Mode | Clip length | Credits/clip | Credits/min of runtime |
|---|---|---|---|
| Staged (Veo 3.1 Lite) | 8s | 12 | 90 |
| Cinematic (Kling 3.0) 720p | 10s | ~17.5 | ~105 |
| Cinematic (Kling 3.0) 720p | 12s | ~21 | ~105 |

Cinematic costs ~15-17% more per minute of runtime BUT delivers multi-shot coverage + native audio + music + ambient sound inside the same credit — capabilities the staged workflow cannot produce at any credit cost.

At the 6000-credit Creator sub budget: roughly 5 × 10-min stories, 2-3 × 20-min, or 1-2 × 30-min per month in either mode. Cost parity is close enough that cinematic is viable for every long-form project the user cares about.

## Pipeline Topology (Cinematic Mode)

```
┌─ SHARED WITH STAGED WORKFLOW ────────────────────────────────────┐
│  Research → Script (+ structural review, tier-aware scaffolding) │
│  → Title approval → Script approval                              │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼ (mode = cinematic)
┌─ CINEMATIC-ONLY STAGES ──────────────────────────────────────────┐
│  1. Element Setup                                                │
│     • Portrait per character (Nano Banana)                       │
│     • Character grid per character (Nano Banana, portrait = ref) │
│     • Character element created (portrait + grid as ref, voice)  │
│     • Location elements (one per distinct scene location)        │
│     • Prop elements (recurring plot objects — Chekhov's gun)     │
│                                                                  │
│  2. Location Generation                                          │
│     • Empty location images via Nano Banana Pro                  │
│     • One per distinct location extracted from script            │
│     • No characters baked in (characters composited in Stage 3)  │
│                                                                  │
│  3. Scene Image Generation (Blocking)                            │
│     • Cinema Studio 2.0 per scene                                │
│     • Uses: @location + @character elements + blocking prompt    │
│     • Blocking = explicit frame positions (L/center/R)           │
│     • Output: scene master image — 16:9 start frame for Kling    │
│                                                                  │
│  4. Video Generation (Cinematic)                                 │
│     • Kling 3.0 per shot group                                   │
│     • Start frame = Stage 3 scene image                          │
│     • Multi-shot ON, Custom mode (Claude's shot list executed)   │
│     • Native audio ON, Nigerian English voice tone per character │
│     • 10-12s duration (sweet spot, avoid 15s max)                │
│     • Up to 6 shots per clip (Kling limit)                       │
└──────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─ SHARED WITH STAGED WORKFLOW ────────────────────────────────────┐
│  Verify Clip (scope adapted — grades shot groups, not lines)     │
│  → Assembly → Publish                                            │
└──────────────────────────────────────────────────────────────────┘
```

### What's shared (no rewrite needed)

- Research stage + multi-pool picker + research cache
- Script generation (Claude) + structural review grader
- Tier-aware structural scaffolding (test / standard / long-form)
- Title dedup + research-informed title prompts
- Project DB schema (with new `generator_mode` column)
- Aspect ratio + duration presets
- History recovery infrastructure
- Verify Clip infrastructure (adapted to grade shot groups instead of individual lines)
- Assembly (FFmpeg concat + upscale)
- Publish (SEO + thumbnail) — this stage's thumbnail three-stage flow already uses Cinema Studio + Nano Banana

### What's net-new

- Element creation automation (7-8 click deep UI path)
- Character grid generation (one extra Nano Banana gen per character)
- Location element extraction + generation stage
- Blocking author in script engine (Claude emits scene.blocking field)
- Shot list author in script engine (Claude emits kling_clips array per scene)
- Cinema Studio 2.0 automation (new model, new selector surface)
- Kling 3.0 automation (new model, new selector surface)
- Higgsfield `@name` autocomplete interaction pattern

## Script Schema Additions (Cinematic Mode)

New fields added to the scene object. All optional when `generator_mode = 'staged'`; required when `generator_mode = 'cinematic'`.

```json
{
  "chapter_number": 3,
  "scenes": [
    {
      "scene_number": 3,
      "location": "Nigerian village kitchen at dusk",
      "location_details": "earthen red clay walls, kerosene lamp, window with sunset light",
      "location_element_hint": "clara_kitchen",
      "characters_present": ["@claire", "@richard"],

      "blocking": {
        "frame_left":   "@claire near the wooden table, body angled toward the window, arms tense",
        "frame_center": null,
        "frame_right":  "@richard in the doorway, hands clenched, eyes fixed on @claire",
        "notes": "dusk light from single window behind @richard casts back-rim on his silhouette"
      },

      "props_in_scene": ["@flashlight"],

      "lines": [
        { "line_number": 1, "speaker_id": "@claire", "dialogue": "I saw you at the market yesterday.", "tone": "Strained" },
        { "line_number": 2, "speaker_id": "@richard", "dialogue": "You saw nothing.", "tone": "Controlled" },
        { "line_number": 3, "speaker_id": "@claire", "dialogue": "Don't lie to me again.", "tone": "Hurt" }
      ],

      "kling_clips": [
        {
          "clip_id": "ch3_sc3_c1",
          "duration_seconds": 10,
          "aspect_ratio": "16:9",
          "resolution": "720p",
          "start_frame_asset_id": "<uuid of Cinema Studio scene image>",
          "line_refs": [1, 2, 3],
          "multi_shot_prompt": "Inside the kitchen from the reference image at dusk, warm kerosene lamp light.\n\nShot 1 (0-3s): WIDE establishing shot. @claire stands frame-left near the wooden table. @richard stands frame-right near the doorway. Static camera.\n\nShot 2 (3-7s): CUT TO MEDIUM SHOT, slow push-in on @claire turning from the window, face tense.\n[@claire, speaking in a strained Nigerian English accent]: \"I saw you at the market yesterday.\"\n\nShot 3 (7-10s): CUT TO CLOSE-UP on @richard, jaw tightens, static camera.\n[@richard, speaking in a controlled Nigerian English accent]: \"You saw nothing.\""
        }
      ]
    }
  ]
}
```

Key constraints:

- **`line_refs`** indexes into the scene's `lines` array. One dialogue line typically maps to one shot, but a single shot can cover 1-2 lines if they're tight exchanges.
- **`multi_shot_prompt`** must stay under **2500 characters** (Higgsfield/Kling prompt budget). Long scenes with many lines split across multiple `kling_clips`.
- **Max 6 shots per clip** (Kling 3.0 limit). Typical target: 3-4 shots per 10s clip.
- **Dialogue in prompts**: use Kling's native syntax `[@character, tone/accent description]: "dialogue in quotes"`. Voice tone bound to element via `@name` resolution — once the element has a voice tone attached, we don't respecify.

## Elements System (Critical to Understand)

Higgsfield's Elements panel is the cornerstone of character/location/prop consistency. Three categories:

### Characters

- **Creation**: 2-4 reference images (typically portrait + grid + optional extra angles) + name + description + voice tone.
- **Voice tone**: either select from Higgsfield's library, upload an audio sample to clone, OR clone from the uploaded reference video. Once bound, voice is consistent across all future Kling generations referencing `@character_name`.
- **Reference in prompt**: `@character_name` in Cinema Studio 2.0 OR Kling 3.0 resolves to that element's visual + voice.
- **Lifetime**: per-account, not per-project. Elements persist. Naming convention for our pipeline: `@charactername_{first-letters-of-script-title}` to avoid cross-project collisions.

### Locations (NOT created as elements)

**Important correction (Session 8 mid-build):** locations are NOT Higgsfield Elements. They're plain reference images.

- **Creation**: 1 empty-location image per unique `location_element_hint` via Nano Banana Pro. Constraint: no characters, no people, no figures in the image.
- **Use in pipeline**: when Cinema Studio generates a scene image, the empty-location image is attached as a REFERENCE IMAGE via the `+` button → "Uploads" tab → local file upload via Playwright `fileChooser` event. Cinema Studio composites @character elements into the location reference. **Do NOT use "Image Generations" tab** — it shows random character images, not the specific location file.
- **Reference in prompts**: describe locations naturally ("inside the kitchen from the reference image") — do NOT use `@location_name` syntax. Only @character (and @prop) references resolve to Higgsfield elements; locations are carried by the reference image attachment.
- **Lifetime**: per-project. The image is generated once per unique `location_element_hint` and reused across scenes sharing that location.
- **Why not elements?** Higgsfield's Location element category exists, but creating elements adds friction (7-click UI flow per element, brittle automation) for zero benefit — Cinema Studio's reference image attachment already locks the visual context. Earlier Phase 3 design attempted location-element creation; removed mid-build after the user flagged it. Validated by Session 8 Phase 0 end-to-end test which used reference-image flow successfully.

### Props

- **Creation**: 1-4 reference images of the object + name + description. No voice.
- **Reference in prompt**: `@prop_name` keeps object appearance consistent across scenes.
- **Use case**: Chekhov's gun scaffolding. When the structural review flags setup/payoff pairs, they're enforced by promoting the object to a prop element. Story plants `@the_necklace` in Chapter 2, pays off in Chapter 9, visual identity locked.

### Character grid (pre-production asset)

Before creating a character element, we generate a character GRID via Nano Banana Pro using the portrait as a reference image. Grid prompt:

> Create a professional character reference sheet for the attached portrait. Match the current appearance. Plain background. Arrange into four vertical columns, each representing one viewing angle. Each column contains a full-body view on top and a matching close-up portrait directly beneath it. Columns (left → right): Column 1: front view (full body character, front portrait below). Column 2: left profile (full body character facing left, with portrait facing left below). Column 3: right profile (full body character facing right, with portrait facing right below). Column 4: back view (full body character, back of head portrait below). Maintain even spacing and framing around the character portraits. Clean silhouette, consistent alignment, and clean panel separation. Photorealistic, DSLR, muted tones. No text. Single thin borders.

Settings: 16:9, 2K, Unlimited ON when available. Grid becomes the second reference image in the character element (portrait is the first).

Why the grid matters: gives Higgsfield multiple angles of the character for identity locking across camera moves. Character stays consistent in profile, back view, close-up, etc.

## Kling 3.0 Prompt Template

Per-clip prompt authored by Claude during script generation. Template:

```
Inside @location_name at <time>, <lighting>.

Shot 1 (0-Xs): <shot type> <camera move>. <blocking description with @character refs>.

Shot 2 (X-Ys): CUT TO <shot type>, <camera move> on @character_name.
[@character_name, speaking in a <tone> Nigerian English accent]: "<dialogue>"

Shot 3 (Y-Zs): CUT TO <shot type> on @character_name, <action>, <camera>.
[@character_name, speaking in a <tone> Nigerian English accent]: "<dialogue>"
```

### Shot type vocabulary

Claude picks from this enum in the `shot_list` authoring step:

- `WIDE ESTABLISHING` — scene master, all characters in frame
- `WIDE` — two-shot or group shot, narrative context
- `MEDIUM` — single character chest-up, conversational
- `CLOSE-UP` — character face, emotional beat
- `EXTREME CLOSE-UP` — detail on eyes/mouth, tension
- `OVER-SHOULDER` (OTS) — from behind one character looking at another
- `REACTION` — cut to non-speaking character's response
- `INSERT` — object/prop detail (Chekhov's gun payoff)

### Camera movement vocabulary

- `STATIC` — locked camera
- `SLOW PUSH-IN` / `SLOW PUSH-OUT` — dolly toward/away
- `PAN LEFT` / `PAN RIGHT` — horizontal camera sweep
- `TILT UP` / `TILT DOWN`
- `HANDHELD` — documentary feel
- `TRACKING` — camera follows subject motion

### Dialogue label format (from Kling docs)

```
[@character_name, speaking in a <tone> Nigerian English accent]: "<dialogue>"
```

Alternative inline format also works:

```
@character_name <action/expression>, and says "<dialogue>" (in a <tone> Nigerian English accent).
```

Prefer the bracketed format — it maps 1:1 to our schema fields and is less ambiguous for Kling's parser.

## Project-Level Mode Selector

New column: `projects.generator_mode TEXT NOT NULL DEFAULT 'staged' CHECK (generator_mode IN ('staged', 'cinematic'))`.

Set at Start Research time alongside aspect ratio + duration. **Locked once research begins** (same lock as aspect_ratio — enforced via DB setter that throws if any project_assets exist).

UI: radio row on the Start Research card:

```
Generator mode:
  ( ) Staged (Veo 3.1 Lite, proven, cheaper, stagey single-shot)
  ( ) Cinematic (Kling 3.0, multi-shot coverage, prestige — requires character element setup)
```

Default `staged` so existing muscle memory is preserved.

When `cinematic` is picked, UI shows an element-setup precheck:

> "Cinematic mode requires elements for all characters, locations, and key props. You'll set up portraits + grids + elements after script approval. Budget: ~5 credits per character, runs once per project."

## Automation Gotchas Discovered in Session 8

Captured live so they don't have to be rediscovered:

1. **Cinema Studio defaults to 3.0, need to click 2.5 every session.** The toggle is top-right. Session doesn't persist — automation must always click it at page load.

2. **"Cinema 2.0" vs "Cinema 2.5"**: user wants scene images generated at 2.0 specifically (model dropdown at bottom of prompt area, not the 2.5/3.0 toggle top-right). Two concepts, two controls.

3. **Native file picker is unautomatable.** Clicking Start frame in Kling opens an OS-level file dialog that Playwright cannot interact with. Workaround: always route through Higgsfield's "Image Generations" tab to pick already-generated assets. For uploads that truly need local files (reference portraits during element creation), use the `file_upload` tool or require a manual step.

4. **`@` autocomplete gotcha.** Typing `@` alone sometimes inserts the most recent reference image as an "Image N" chip instead of opening the character picker. Pattern that works reliably:
   - Type `@` + 2-3 letters of the character name (e.g., `@cla` or `@ric`)
   - Wait for the autocomplete popup to appear (Characters section)
   - Press `Enter` (or `Down` + `Enter` if multiple candidates)
   - Do NOT type the full name before pressing Enter — it sometimes scrolls past the match

5. **Aspect ratio differs between models.** Nano Banana supports 12 ratios. Veo 3.1 Lite supports 3 via native select. Kling 3.0 has its own set. Cinema Studio 2.0 has its own dropdown with a "Cinematic" tag on 16:9. Automation must be model-aware.

6. **Generation timing varies.** Cinema Studio 2.0 scene image at 4K: ~60-90s. Kling 3.0 at 15s multi-shot: 2-4 minutes. Automation timeouts must be generous.

7. **Credit display after generation.** "Credits are running low" notification can cover parts of the UI. Ad-dismissal logic from staged workflow applies.

8. **Multi-shot toggle.** User clarified: Multi-shot ON + Auto mode is typically what you want. Custom mode is rigid and unforgiving. Auto lets Kling interpret the shot list flexibly.

## Phased Implementation Plan

All phases gated behind `generator_mode = 'cinematic'`. Staged workflow stays live throughout development.

### Phase 1 — Schema + script prompt changes ✅ SHIPPED

Pure prompt engineering + DB migration. No new automation.

**What landed:**
- Migration 009: `projects.generator_mode TEXT NOT NULL DEFAULT 'staged'` (validation enforced in `setProjectGeneratorMode()` — CHECK-constraint-less because SQLite's ALTER TABLE doesn't support adding constraints post-creation)
- `db.setProjectGeneratorMode(projectId, mode)` with lock-on-start semantics (throws if project_assets rows exist)
- `db.createProject()` + `db.getActiveProject()` accept + return `generatorMode` field
- Orchestrator: `start()` reads `options.generatorMode`, persists to DB + `this.state.generatorMode`. Resume path restores from DB. Passed through to script engine via `storyBrief.generatorMode`.
- `ScriptEngine._buildCinematicScaffolding(mode, tier)` — returns mandatory authoring rules for `scene.blocking`, `scene.location_element_hint`, `scene.props_in_scene`, `scene.kling_clips` when mode = cinematic. Empty string for staged (no behavior change).
- Script prompt template: new `{{CINEMATIC_SCAFFOLDING}}` + `{{CINEMATIC_SCHEMA_ADDENDUM}}` placeholders
- Structure review prompt: new `{{GENERATOR_MODE}}` + `{{CINEMATIC_RUBRIC_EXTENSION}}` placeholders
- `CINEMATIC_RUBRIC_EXTENSION` constant in script-engine.js: adds 4 grader dimensions (blocking completeness, kling clip coherence, element-hint discipline, props-as-elements) + cinematic-specific critical failure modes
- Pass thresholds bumped +5 in cinematic mode: test=55, standard=65, long-form=75
- Renderer: third dropdown `Generator mode` alongside Duration + Aspect on both pool picker + fresh-start cards. `getActiveGeneratorMode()` helper. Passed via `window.api.startPipeline({..., generatorMode})`. Research view badge shows mode. Resume card progress-info shows mode badge.
- IPC + preload already pass whole `options` object through, so `generatorMode` flows transparently.

**Testable against existing projects** by regenerating their scripts in cinematic mode and reading the JSON output. Zero video generation spend to validate.

### Phase 2 — Element setup ✅ SHIPPED

New automation surface for the 7-8-click character-element creation path + character grid generation.

**What landed:**
- Migration 010: `project_assets.higgsfield_element_id TEXT` + `project_assets.element_name TEXT` + indexes `idx_assets_element_name`, `idx_assets_type_project`
- New asset type: `character_grid` — 4-column reference sheet (front / left profile / right profile / back, each with full-body + close-up) generated via Nano Banana Pro using the portrait as reference. Grid prompt verbatim from the design doc's character-grid section.
- `src/main/automation/higgsfield-elements.js` (new file, ~250 lines) — `HiggsfieldElements` class with:
  - `_openElementsPanel()` — navigates Cinema Studio → 2.5 → Image → @ button
  - `listExistingElements()` — scrapes panel, caches
  - `elementExists(name)` — case-insensitive + leading-@ normalized
  - `createCharacterElement({name, portraitPath, gridPath, description})` — idempotent (skips if exists); fills form; uploads portrait + grid via Playwright `filechooser` interception; sets Characters category; clicks Create; verifies creation
  - Static `buildManualChecklist(pending)` — text checklist used in fallback path
- Orchestrator: new `_runCinematicElementSetup(projectId, projectDir)` method + Stage 3A.5 hook (runs between `portraits-done` and scene generation; gated on `generatorMode === 'cinematic'`; staged mode is a no-op passthrough)
- `_titleInitials(title)` helper for naming: `@{char-id-suffix}_{title-initials}` convention (e.g. `@claire_thp`)
- `_generateCharacterGrid(character, portraitPath, outputPath)` — wraps `automation.generateImage` with the grid prompt + portrait-as-reference
- New approval gate: `elements-ready`. Triggered when automation fails or partial elements are still missing after creation attempts. Emits `cinematic-manual-element-checklist` event with pending list, then pauses. `approveElementsReady()` resolves.
- IPC `approve-elements-ready` + preload `window.api.approveElementsReady()`
- Renderer: new `#view-cinematic-elements` view with yellow-accent header, pending-elements list (populated by event data), collapsible 9-step manual walkthrough, and "Elements Ready — Continue" button

**Known limitations (honest):**
- 7-click UI automation is best-effort; selectors may drift. Graceful fallback to manual checklist is mandatory-by-design, not a backup — treat automation as click-reducer, not a guarantee.
- **Voice tone binding is NOT automated.** Elements get created voice-less. For best Kling lip-sync output, user should manually bind a Nigerian English voice tone after element creation. Phase 2 doesn't enforce this; Phase 4 may surface warnings at Kling generation time.
- Location elements + prop elements are Phase 3 territory, not Phase 2.
- Native file picker for portrait + grid upload handled via Playwright's `page.waitForEvent('filechooser')` pattern. If interception fails (ad popup, racey timing), automation falls back to manual.

### Phase 3 — Location + scene image generation (4-5 hours)

- Location extraction: post-script stage, parse unique locations from scene.location fields, create a locations manifest
- Location generation: Nano Banana per location, "no characters, empty" constraint
- Location → element conversion (reuse Phase 2 automation)
- Cinema Studio 2.0 automation: new config section in `higgsfield-selectors.json`, new module `cinema-studio-automation.js`
- Scene image generation per scene: `@location` + character elements + blocking prompt → 16:9 2K image
- Asset tracking: new asset types `location_image`, `scene_image_cinematic` in DB

### Phase 4 — Kling 3.0 video generation (4-5 hours)

The main lift.

- Kling 3.0 automation: new config section + new module `kling-automation.js`
- Start frame upload via Image Generations picker (NOT native file dialog)
- Multi-shot toggle ON + Auto mode
- Duration selector (10s default)
- Prompt composition: emit the `multi_shot_prompt` authored by Claude in the script stage
- Element reference resolution: verify `@name` chips resolve correctly in Kling's prompt area
- Download + local save using persistent filechooser pattern (reuse staged workflow mechanism)
- Asset type: `video_clip_cinematic`

### Phase 5 — Verify Clip adaptation (2 hours)

Current Verify Clip grades individual Veo clips (1 line = 1 clip). Cinematic clips contain multiple lines + cuts in one file.

- Extend `verifyClip()` signature to accept the expected `line_refs` array and shot list
- Grader prompt updates: assess each shot's framing + dialogue + character correctness, not just "is this clip correct?"
- Approval gate surfaces shot-group-level decisions

### Phase 6 — Assembly + mode switcher UX (2-3 hours)

- Assembly reads either `video_clip` (staged) or `video_clip_cinematic` (cinematic), concatenates same way
- Mode selector on launcher + resume card badge
- Project history shows mode alongside aspect + duration

### Total: ~20-25 hours across 6 phases

All phases ship additive. Phase 1 ships first and provides test data (cinematic script JSON) for validating later phases without burning video-generation credits.

## Open Decisions

1. **Character element auto-creation vs. manual-first MVP.** Phase 2 automation is the most fragile (7-8 click deep UI path). MVP could skip automation entirely and have the user manually create elements via Higgsfield UI, pipeline just checks they exist by name. Pro: faster to ship. Con: friction per character per project.

2. **Voice tone strategy.** Options: (a) Higgsfield's voice library — free, inconsistent Nigerian coverage; (b) upload audio samples per character — requires user to source Nigerian English voice clips; (c) clone from a reference video — simplest once we have a source. Need to test which gives best Nigerian English.

3. **Portrait → grid → element is 3 generations per character.** At ~4 credits/grid + ~2 credits/portrait × 5 characters = ~30 credits one-time per project just for element setup. Material cost. Consider caching elements across projects (rename convention `@character_{title-initials}` enables reuse for sequels / spinoffs).

4. **Shared vs per-project locations.** If the user produces multiple stories in the same fictional village, the `@village_kitchen` element could persist across projects. Pro: cost amortized. Con: naming collisions, stale elements accumulating. Probably fine to start per-project and revisit.

5. **Kling duration standard.** 10s gives safer multi-shot (3-4 shots, reliable cuts). 12s gives more cinema time but approaches the 15s cliff. 15s max is the user-confirmed failure zone. MVP: 10s. Phase N tuning: experiment with 12s.

6. **Fallback to staged on Kling failure.** If a Kling generation fails repeatedly (quota, NSFW rejection, infra), should we fall back to generating that clip with Veo in staged mode? Probably no — the aesthetic mismatch between a Kling-dominant project with one Veo clip would be jarring. Better to regenerate Kling or fail the stage.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Kling 3.0 rate-limited during long-form runs (60+ clips sequential) | Pipeline stalls | Insert adaptive delays, use parallel browser contexts if Higgsfield supports it |
| Element creation UI changes break the 7-8-click automation | Blocks every new project | Keep the DOM inspection fresh via shortcut in dev tools; version selectors in config |
| Nigerian English accent quality varies across Kling updates | Inconsistent output tone | User's prior testing suggests it's stable. Monitor; if regression, consider voice cloning step |
| Character elements hit some quota in Higgsfield | Can't create new chars | Rename/delete stale elements; consider manual UI management per account |
| Scene image (Cinema Studio 2.0) doesn't match blocking prompt well | Start frame wrong → video wrong | Regenerate with adjusted prompt. Same approval gate as staged workflow catches this |
| Multi-shot cuts land at unexpected timings | Pacing off | Use Custom mode instead of Auto for strict timing control — tradeoff is rigidity |
| Prompt budget (2500 chars) exceeded on complex scenes | Clip truncated or fails | Split into multiple kling_clips per scene; grader enforces budget |
| Higgsfield's `@` resolution drops voice tone for elements without one | Silent clip | Require voice tone at element creation; validate before generation |
| `generator_mode` flag not enforced → staged project tries to use cinematic assets | Asset type mismatch crash | DB CHECK constraint + early-stage validation in orchestrator |

## Anti-Patterns to Avoid

- **Don't mix Veo and Kling output in the same project.** Even if one stage fails, keep the failure in the same model family. Mixing produces obvious aesthetic discontinuity.
- **Don't let Claude author free-form dialogue tone.** Use the structured `[@character, tone/accent description]: "..."` format. Free prose descriptions of voice ("she says angrily") do NOT reliably route to Kling's voice synthesis.
- **Don't generate Kling clips without a start frame.** The start frame anchors location + character positions. Text-to-video Kling without start frame produces much higher drift risk across multi-shot cuts.
- **Don't skip the character grid.** Portrait alone gives the model only one angle. Grid gives 4 angles + close-ups. Multi-shot coverage (close-up, OTS, profile) depends on multi-angle reference.
- **Don't reuse `@character_name` across unrelated projects.** Name collisions silently pull the wrong face. Use the project-title-initials suffix convention.
- **Don't exceed 6 shots per Kling clip.** Hard limit. 4 shots is the cinematic sweet spot (establishing + coverage + close + reaction).
- **Don't set aspect ratio in the Kling prompt.** Kling derives aspect from the start frame. The UI aspect selector is secondary. Match start frame aspect to project aspect_ratio.
- ~~**Don't automate native file-picker dialogs.**~~ **RESOLVED (Session 10):** Playwright's `page.waitForEvent('filechooser')` intercepts the native picker. Location images upload via Uploads tab + fileChooser event. Do NOT use "Image Generations" tab for location references — it shows random character images.

## Pre-Flight Checklist (Before Starting Phase 1)

- [ ] One completed project with character portraits already generated to seed the first cinematic run
- [ ] Higgsfield account has enough credits for ~30 credits/project of element setup during development
- [ ] Kling 3.0 access confirmed on the account (it is — we used it in Session 8)
- [ ] Cinema Studio 2.0 access confirmed
- [ ] Decide Phase 2 manual-vs-automated element creation (defer if automation is risky)
- [ ] DOM inspection captured for: Elements panel, `+ Create new` form, Cinema 2.0 selector, Kling Multi-shot toggle, Start frame picker
- [ ] Git commit the staged workflow before starting so we can diff changes cleanly

## Success Metrics

When this ships, success looks like:

1. **Visual quality delta** — cinematic output passes a blind A/B vs. staged output with non-expert viewers preferring cinematic ≥70% of the time
2. **Credit efficiency** — cinematic 10-min project uses no more than 120% of a staged 10-min project's credits
3. **Pipeline reliability** — cinematic pipeline completes end-to-end unattended ≥80% of the time (match staged reliability ceiling)
4. **Character consistency** — across a full 10-min project's ~60 Kling clips, character faces remain identifiably the same person (subjective eye check)
5. **Nigerian accent** — 100% of dialogue audio sounds Nigerian (or user-configured accent), not defaulting to American/British

## What This Is NOT

- **Not a replacement for the staged workflow.** Staged ships today, keeps shipping. Cinematic is a parallel mode.
- **Not automatic opt-in.** User explicitly picks cinematic per-project. Default stays staged.
- **Not a dependency change.** No new npm packages. No new API keys. All new tooling is inside Higgsfield (Cinema Studio 2.0 + Kling 3.0).
- **Not a fix for bad scripts.** The structural review gate still runs first. Cinematic mode makes good scripts look great; it doesn't rescue weak ones.
- **Not incompatible with the Multi-Cam exploration doc.** `IMPROVEMENT-MULTICAM.md` proposed per-line shot types within the staged workflow. This doc effectively supersedes it for long-form prestige work, but the multi-cam doc's thinking still applies for users who stay on staged and want some coverage variety within that model.

## Dependencies

- Existing: Claude API (script + structural review + shot list authoring)
- Existing: Gemini API (structural review fallback, Verify Clip)
- Existing: Higgsfield + Playwright automation infrastructure
- Existing: Nano Banana Pro automation (for portraits, grids, locations)
- **New surface:** Cinema Studio 2.0 automation
- **New surface:** Kling 3.0 automation
- **New surface:** Higgsfield Elements panel automation (for Phase 2)

No external blockers. Builds on everything shipped in Sessions 6-8.

## Implementation Order When We Ship

If green-lit:

1. **Discovery (30 min)** — verify DOM selectors for all new automation surfaces are still current (Higgsfield UI may have changed since Session 8 inspection)
2. **Phase 1 (schema + script prompt)** — 2-3 hours. Ship first.
3. **Test Phase 1 against existing project** — regenerate one script in cinematic mode, eyeball the JSON output. No credits spent on video.
4. **Phase 2 (element setup)** — 5-6 hours. Ship to alpha on one project.
5. **Test Phase 2 end-to-end** — create all elements for one project, verify Higgsfield state.
6. **Phase 3 (locations + scene images)** — 4-5 hours. Cumulative cost per test run: ~20 credits for scene images.
7. **Phase 4 (Kling)** — 4-5 hours. Cumulative cost per test run: ~120 credits for 10 clips.
8. **Phase 5 (verify adaptation)** — 2 hours.
9. **Phase 6 (assembly + UX)** — 2-3 hours.
10. **First real cinematic run** — 10-min project end-to-end. ~1100 credits. Decision point: ship broadly or iterate.

## Session 8 Validation Test — Recorded for Reference

**Scene concept**: Two characters in a Nigerian village kitchen at dusk, mid-confrontation. @claire (frame-left) and @richard (frame-right).

**Assets used** (Session 8 Phase 0):
- Nano Banana Pro location: "A modest Nigerian village kitchen interior at dusk. Earthen red clay walls, a small wooden dining table with two wooden stools, a kerosene lamp casting warm amber light, handwoven baskets, window with fading golden-orange sunset light..." (2 credits)
- Cinema Studio 2.0 scene image: location reference + `@claire stands frame-left` + `@richard stands frame-right` blocking prompt, 16:9 cinematic, 4K (4 credits)
- Kling 3.0 video: start frame = scene image, multi-shot auto, 15s, 720p, prompt with 3 shots + dialogue in Nigerian English (26.25 credits)

**Total Phase 0 spend**: ~32 credits for full end-to-end pipeline validation.

**Outcome**: Cinema Studio scene image composition was correct (character placement, location consistency with the Nano Banana reference, cinematic 16:9 aspect). Kling 3.0 generation completed. User confirmed Kling output quality based on prior production use since January 2026.

**Phase 0 verdict: pipeline is buildable.** Moving to design doc (this file). Implementation awaits explicit green-light.
