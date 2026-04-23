# Improvement Exploration: SEO + Publish Stage

> Status: design doc, no code yet. Captures the new Publish stage that turns the rendered .mp4 into upload-ready packages for YouTube and Facebook.
>
> **Revision (Session 8):** Thumbnail approach switched from Canvas/Sharp/SVG rendering to a three-stage Nano Banana Pro flow (key art → transparent title card → composite). Manual test proved Higgsfield handles prestige typography end-to-end; single-vendor flow with OCR verify guard. Sharp/font-file dependencies removed.

## TL;DR

Today the pipeline ends with a video file in `output/`. The user still has to hand-write a YouTube title, description, tags, and design a thumbnail before publishing. That's hours of manual work per video.

This feature adds a `Publish` stage that auto-generates platform-specific SEO metadata + a click-worthy thumbnail, leaving the user with a one-click "ready to upload" package.

**Thumbnail approach:** three-stage Nano Banana Pro flow (key art with character-ref faces → transparent-PNG title card → reference-based composite). OCR verify step via Gemini Vision catches the ~5% of title-card regenerations that misspell. No Canvas/Sharp dependency — whole pipeline stays single-vendor.

**Estimated effort:** ~9-11 hours across three phases. MVP-usable after Phase 1 (~5 hours).

## Motivation

The pipeline produces a 2-min Nollywood drama. Then what?

For YouTube monetization to work, you need:
- **Title** (60-100 chars, hooks early) — currently auto-generated for the script but not optimized for YouTube CTR
- **Description** (5000 chars) — currently nothing
- **Tags** (500 chars total) — currently nothing
- **Thumbnail** (1280×720) — currently nothing
- **Hashtags** above title — currently nothing

For Facebook reach:
- **Caption** (different style — chatty, hook-driven first line) — currently nothing
- **Native video upload format** — currently the raw .mp4 works but caption is critical

Without these, the user manually does ~30-60 min of post-production marketing per video. The goal: drop that to <5 min (review + tweak the AI suggestions).

## Where It Fits

Replace the current `Export` stage with `Publish`:

```
Research → Script → Portraits → Scenes → Videos → Verify → Assembly → Publish
                                                                          ↑
                                                                     new stage
```

Inside Publish, sub-views per platform:

```
Publish (sub-tabs):
  ├── Thumbnail (shared)
  ├── YouTube (title, description, tags, hashtags)
  └── Facebook (caption, hashtags)
```

The final `output/` folder structure becomes:

```
output/
  final_16x9_4K.mp4        ← from Assembly stage (unchanged)
  thumbnail.png             ← new (1280×720)
  thumbnail-options/        ← new (alternates the user didn't pick)
  metadata.json             ← new (all platform copy in one file)
  youtube.txt               ← new (formatted for direct copy/paste)
  facebook.txt              ← new (formatted for direct copy/paste)
```

## Architecture

### New orchestrator stage

```javascript
// In orchestrator.js, after the assembly stage:
if (shouldRunStage('assembled')) {
  await this.runStage('publish', async () => {
    // 1. Generate thumbnail candidates (scene scoring + selection)
    // 2. Wait for user to pick one
    // 3. Generate platform metadata (parallel: youtube + facebook)
    // 4. Wait for user approval/edits
    // 5. Compose thumbnail + write metadata files to output/
    db.updateProjectStage(projectId, 'published');
  });
}
```

### New module: `src/main/publish/thumbnailGenerator.js`

**Approach (revised after Session 8 manual test):** three-stage Higgsfield-only flow. No Canvas, no Sharp, no font files shipped. Previously the plan was deterministic SVG/Canvas title rendering with Sharp compositing; a manual test run produced prestige-tier typography directly from Nano Banana Pro using a detailed prompt, so the entire pipeline stays single-vendor.

**Why three stages, not one prompt.** Single-pass "generate a thumbnail with title" prompts consistently produce slightly-wonky kerning, weird ligatures, or text bleeding into faces — the model is solving composition + typography + compositing simultaneously. Splitting the work into three focused prompts (each solving one problem) produces reliably professional output. This mirrors how humans build thumbnails in Photoshop: key art layer + type layer + compositing.

```javascript
class ThumbnailGenerator {
  /**
   * Score scene images by thumbnail-worthiness using Gemini.
   * Returns top-N candidates with scores + reasoning.
   * (Alternative to key-art generation: use a strong existing scene.)
   */
  async scoreSceneCandidates(sceneImagePaths, { topN = 6 }) { ... }

  /**
   * Stage 1: Generate the key art (characters + setting + lighting, no text).
   * Uses character element references for face consistency across projects.
   *
   * Input: characterIds[] (from project.character_bible), setting, mood, genre
   * Output: { keyArtPath } — 16:9 key art image, no title
   */
  async generateKeyArt({ characterIds, setting, mood, genre, outputPath }) { ... }

  /**
   * Stage 2: Generate transparent-PNG title card via Nano Banana Pro.
   * Typography only — no characters, no scenery, no background.
   *
   * Input: title, tagline, palette (hex codes), fontFamilyHint
   * Output: { titleCardPath, verified } — transparent PNG + OCR verification flag
   */
  async generateTitleCard({ title, tagline, palette, fontFamilyHint, outputPath }) {
    // 1. Build prompt from TITLE_CARD_TEMPLATE (see below)
    // 2. Call Nano Banana Pro
    // 3. Verify via Gemini Vision OCR — checks text reads exactly as specified
    // 4. Auto-retry up to 2x on OCR mismatch (misspells, wrong case, bad punctuation)
  }

  /**
   * Stage 3: Composite title card over key art.
   * Uses both as Higgsfield references; prompt dictates placement.
   *
   * Input: keyArtPath, titleCardPath, placement ('lower-third'|'upper-third'|'auto')
   * Output: { thumbnailPath } — final flattened 16:9 thumbnail
   *
   * If placement='auto', a cheap Gemini Vision pass identifies least-cluttered
   * third of the key art before the composite prompt is built.
   */
  async compositeThumbnail({ keyArtPath, titleCardPath, placement, outputPath }) { ... }

  /**
   * Convenience: full 3-stage pipeline in one call.
   */
  async generateThumbnail(projectMeta, options = {}) { ... }
}
```

### Title-card prompt template (parameterized)

This is the proven shape from the Session 8 manual test. Variables in `{{...}}`:

```
Transparent background PNG. Typography only, no characters, no scenery.
Centered text composition. Line 1: "{{TITLE_LINE_1}}" — {{FONT_FAMILY_HINT}},
heavyweight, slightly tracked out, color: {{PRIMARY_HEX}} ({{PRIMARY_NAME}})
with a very subtle inner glow and paper-thin dark outline #0A0A0A. Line 2:
"{{TITLE_LINE_2}}" — same {{FONT_FAMILY_HINT}}, slightly larger than line 1,
same {{PRIMARY_NAME}} treatment. Thin horizontal {{PRIMARY_NAME}} rule
{{PRIMARY_HEX}} separating title from tagline, full width of the text block.
Line 3 tagline: "{{TAGLINE}}" — thin elegant sans-serif, all caps, wide letter
spacing, color: {{SECONDARY_HEX}} ({{SECONDARY_NAME}}). All elements perfectly
center-aligned. Subtle metallic sheen on the {{PRIMARY_NAME}} lettering — not
glittery, just premium. No drop shadow. No background. Pure transparent PNG.
Ultra-sharp. 4K.
```

**Why each clause matters** (dissected from the proven manual prompt):

- `Transparent background PNG` + `No background` + `Pure transparent PNG` — stated three times. Diffusion models love to invent backgrounds; repeating the constraint kills that tendency
- Hex codes (`#C9A84C`), not color names — reproducibility across projects
- Font family by description (`bold condensed serif`), not name — model knows proportions, not Trajan Pro
- `No characters, no scenery` — prevents hallucinated decorative glyphs / crowns / scroll borders
- `Subtle metallic sheen — not glittery` + `No drop shadow` — explicitly blocks the two biggest tells of amateur AI thumbnails

### Genre → palette + font mapping

Configured in `config/thumbnail-presets.json`:

```json
{
  "drama": {
    "font_family_hint": "bold condensed serif",
    "primary_hex": "#C9A84C",
    "primary_name": "burnished gold",
    "secondary_hex": "#F5EDD6",
    "secondary_name": "warm ivory"
  },
  "thriller": {
    "font_family_hint": "modern geometric sans-serif",
    "primary_hex": "#E63946",
    "primary_name": "blood red",
    "secondary_hex": "#F1FAEE",
    "secondary_name": "bone white"
  },
  "romance": {
    "font_family_hint": "high-contrast didone serif",
    "primary_hex": "#E8C5C5",
    "primary_name": "dusty rose",
    "secondary_hex": "#F9E7D6",
    "secondary_name": "candlelight cream"
  }
}
```

Genre is derived from the project's research brief. User can override in the Publish view.

### OCR verify step (same pattern as Verify Clip)

Nano Banana occasionally slips — misspells ("THE HIER'S"), flips apostrophe placement ("HEIRS'"), or renders wrong case. Cheap insurance before compositing:

```javascript
// Gemini Vision check on generated title card
const result = await gemini.vision(titleCardPath, {
  prompt: `Does this image contain EXACTLY the text "${expectedTitle}" on one or two lines, and "${expectedTagline}" as a tagline? Answer strictly JSON: { "title_match": boolean, "tagline_match": boolean, "notes": "..." }`,
});
if (!result.title_match) {
  // auto-retry up to 2x; if all fail, flag for human review
}
```

~$0.0002 per check. Catches the ~5% of regenerations that slip. Same ceiling-as-insurance pattern Verify Clip uses for dialogue accuracy.

### Composite placement — "auto" mode

Hardcoded "lower-third" works for horizontal ensemble compositions but fails on portrait-heavy shots or centered single-character frames. Optional `placement: 'auto'` runs a Gemini Vision pass on the key art first:

```javascript
const layoutHint = await gemini.vision(keyArtPath, {
  prompt: `This is a 16:9 cinematic thumbnail. Which third has the most uncluttered negative space for title text placement? Reply with exactly one of: "upper-third", "lower-third", "left-third", "right-third".`,
});
```

Then the composite prompt embeds `position the title text in the {{LAYOUT_HINT}}` instead of a fixed "lower third".

### New module: `src/main/publish/seoGenerator.js`

```javascript
class SEOGenerator {
  constructor(claudeApiKey, store) { ... }

  /**
   * Generate YouTube metadata package using Claude.
   * Inputs: project script, characters, themes, research patterns.
   * Output: { title, hashtags[], description, tags[], category }
   */
  async generateYouTubeMetadata(project) { ... }

  /**
   * Generate Facebook caption with first-line hook + hashtags.
   * Input: project metadata + youtube version (for cross-platform reuse)
   * Output: { caption, hashtags[] }
   */
  async generateFacebookCaption(project, youtubeMetadata) { ... }
}
```

### DB additions

```sql
-- Migration 008 (when shipped):
ALTER TABLE projects ADD COLUMN thumbnail_path TEXT;
ALTER TABLE projects ADD COLUMN thumbnail_scene_id INTEGER;     -- FK-ish to project_assets.id
ALTER TABLE projects ADD COLUMN youtube_metadata TEXT;          -- JSON: { title, description, tags, hashtags }
ALTER TABLE projects ADD COLUMN facebook_metadata TEXT;         -- JSON: { caption, hashtags }
ALTER TABLE projects ADD COLUMN published_at TEXT;              -- when user confirmed publish-ready
```

### IPC + preload handlers

- `get-publish-state` — load thumbnail candidates + current metadata for active project
- `score-scene-thumbnails` — trigger Gemini scoring on scene images
- `set-thumbnail-scene` — user picked which scene to use
- `regenerate-title-art` — try a different title style
- `update-platform-metadata(platform, fields)` — user-edited copy persists
- `approve-publish` — finalize, write output files, mark stage `published`

### Renderer Publish view

```
┌─────────────────────────────────────────────────────────┐
│ Publish: "Mama Sold Her to Pay a Debt..."               │
├─────────────────────────────────────────────────────────┤
│  [Thumbnail]  [YouTube]  [Facebook]                     │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  THUMBNAIL TAB:                                         │
│  ┌─────────────┬──────────────────────────────────────┐ │
│  │ Choose scene│ Live preview                        │ │
│  │ ┌──┐ ┌──┐  │ ┌────────────────────────────────┐  │ │
│  │ │S2│ │S5│  │ │                                │  │ │
│  │ └──┘ └──┘  │ │  [scene image with title]      │  │ │
│  │ ┌──┐ ┌──┐  │ │                                │  │ │
│  │ │S7│ │S9│  │ └────────────────────────────────┘  │ │
│  │ └──┘ └──┘  │ Title style: [Default ▼]            │ │
│  │            │ Position: [Bottom-left ▼]            │ │
│  │            │ [Regenerate art]                     │ │
│  └─────────────┴──────────────────────────────────────┘ │
│                                                         │
│  YOUTUBE TAB:                                           │
│  Title:    [editable text input, 100 chars max]         │
│  Hashtags: [#nollywood #drama #africanstory] [+]        │
│  Description: [editable textarea, 5000 chars]           │
│  Tags:     [editable textarea, 500 chars]               │
│  Category: [Film & Animation ▼]                         │
│                                                         │
│  FACEBOOK TAB:                                          │
│  Caption: [editable, hook on line 1]                    │
│  Hashtags: [3-5 tags]                                   │
│                                                         │
│  [ Generate output package ]  [ Open output folder ]    │
└─────────────────────────────────────────────────────────┘
```

## Phases

### Phase 1 — MVP Publish stage (~5 hours)

**Goal:** end-to-end publishable package using the proven three-stage Higgsfield flow.

- New `publish` stage in orchestrator
- DB migration + helpers
- IPC + preload
- **Three-stage thumbnail pipeline** (all Nano Banana Pro, no Sharp/Canvas):
  - **Stage 1 — Key art:** generate 16:9 character composition using project's Higgsfield character element IDs for face consistency. Derive setting + mood from research brief.
  - **Stage 2 — Title card:** transparent-PNG typography from the parameterized template, using the genre's palette + font-family hint. OCR verify via Gemini Vision; auto-retry up to 2x on mismatch.
  - **Stage 3 — Composite:** Nano Banana Pro with both images as refs, placement = `lower-third` for MVP (auto placement deferred to Phase 3).
- Claude generates YouTube metadata (single prompt, returns JSON)
- Claude generates Facebook caption (single prompt)
- User reviews + edits in renderer; can regenerate any single stage without redoing the others
- Click "Generate output package" → writes thumbnail.png, key-art.png, title-card.png (archived for variant swaps), metadata.json, youtube.txt, facebook.txt

**Output after Phase 1:** user opens output folder, has all assets to upload manually to YouTube/Facebook studio. Saves ~25 min per video. Thumbnails look professional out of the gate — no deterministic-font-MVP transition.

**Note:** Previous design had Phase 1 = Canvas/Sharp/SVG rendering and Phase 3 = AI title. Session 8 manual test proved Nano Banana Pro handles typography well enough that the deterministic renderer is unnecessary; the whole flow stays single-vendor and AI-native.

### Phase 2 — Research-informed thumbnails (~3 hours)

**Goal:** thumbnails informed by what's actually winning in our niche.

- Extend research module: for each top-performing YouTube video found, download its thumbnail (`https://i.ytimg.com/vi/{videoId}/maxresdefault.jpg` — free, no API key)
- Extend Gemini analyzer to extract thumbnail patterns:
  - Dominant colors (palette)
  - Face count + positioning
  - Text presence + style (bold gold vs bold yellow vs red gradient vs white outline)
  - Composition (rule of thirds, focal point)
  - Emotional tone of expressions
- Cache patterns into `research_cache.thumbnail_patterns`
- Thumbnail generator consumes patterns three ways:
  - **Key-art stage:** scene composition hint ("2 faces with intense expression, golden-hour lighting") derived from winning compositions
  - **Title-card stage:** palette override from `thumbnail-presets.json` — winners in this genre use warm-gold 70% / blood-red 20% / ivory-on-dark 10% → bias the preset accordingly
  - **Candidate scoring:** if user wants to use an existing scene instead of generating key art, scoring boost for scenes matching winning patterns

**Output after Phase 2:** thumbnails feel native to the genre, not generic.

### Phase 3 — Variants + auto placement (~3 hours)

**Goal:** multiple options for A/B testing + smarter composition.

- Generate 3 thumbnail variants per project:
  - Variant A: key art + title card, lower-third placement (MVP default)
  - Variant B: strongest scene image + title card, auto placement
  - Variant C: key art with alternate palette (e.g., if drama preset used gold, variant C uses ivory-on-dark for contrast)
- **Auto placement** (replaces fixed `lower-third`):
  - Gemini Vision pass on the key art identifies least-cluttered third
  - Composite prompt embeds the identified region dynamically
  - Handles portrait-heavy shots, crowd scenes, centered single-character frames
- User can pick any variant or regenerate
- Persist all variants in `output/thumbnail-options/` for later swap without full regeneration

**Output after Phase 3:** A/B testing built in. Auto placement handles non-horizontal compositions that a fixed lower-third would clobber.

### Phase 4 (out of scope per user)

- Facebook Graph API native upload
- TikTok/Instagram cross-posting
- One-click YouTube Data API publish

These are platform integrations, not content generation. Defer indefinitely.

## Open Decisions

**1. Thumbnail picker — automatic top-1 or always show grid?**
- Auto: faster, but user has no agency
- Grid: more clicks, more control
- Recommendation: grid of top 4-6 scored by Gemini; defaults to highest-scored if user clicks "Use auto"

**2. Title rendering — SVG/canvas vs AI?**
- ~~SVG: deterministic, predictable, free, but generic-looking~~
- AI (Nano Banana Pro): creative, on-genre, text generation reliable enough with detailed prompts + OCR verify guard
- **Decided (Session 8):** AI via Nano Banana Pro, single-vendor. Session 8 manual test proved the typography comes out prestige-tier with a detailed prompt template. OCR verify step (Gemini Vision, ~$0.0002/check) catches the ~5% of regenerations that slip. No font files shipped, no Canvas dependency, no SVG renderer.

**3. Compositing tool — Sharp, ffmpeg, or Nano Banana Pro?**
- ~~Sharp (npm): pure JS, fast, predictable, requires npm install~~
- ~~ffmpeg: already a dependency, but heavier syntax for image overlays~~
- Nano Banana Pro: reference-based composite with prompt-driven placement; one vendor end-to-end
- **Decided (Session 8):** Nano Banana Pro. Risk of face mutation is handled by using the already-generated key art AND title card as references (not re-generating faces from scratch). The composite stage only places text over image — the faces are locked by ref. No Sharp install needed.

**4. Hashtag count per platform.**
- YouTube: research suggests 3-5 above title perform best
- Facebook: 3-5 max (more reduces reach)
- Recommendation: cap at 5 per platform, generate 8-10 candidates, user trims

**5. Title length for YouTube.**
- 60 chars hard limit before truncation in mobile feed
- 100 chars max on YouTube
- Hook within first 50 chars
- Recommendation: generate 2 variants — short (<60) and long (60-100), user picks

**6. Description templating.**
- LLM-generated freeform vs templated structure
- Templated: hook → synopsis → timestamps → hashtags → channel CTA
- Recommendation: hybrid — Claude generates the freeform parts, we templates the boilerplate (timestamps, channel link, hashtag block)

**7. Re-run vs persist.**
- Should each Publish stage re-generate metadata, or only on first run?
- Recommendation: persist after first generation. User clicks "Regenerate" if they want fresh attempt. Saves API calls + lets user iterate on edits without losing them.

**8. Multi-language support.**
- Some Nollywood content is in Yoruba, Pidgin, etc.
- For MVP: English only
- Note in design: SEO copy is English-only assumption; revisit if needed

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Claude generates clickbait that violates YouTube ToS | Account strikes | Prompt explicitly: "No misleading claims, no all-caps shouting, no fake urgency" |
| AI-generated title art has typos | Bad thumbnail | OCR verify via Gemini Vision after Stage 2 (title card). Auto-retry 2x on mismatch; flag for human review after that. Same pattern as Verify Clip for dialogue accuracy. |
| Nano Banana fails to produce transparent PNG | Stage 3 composite has background bleed | Prompt template states "transparent background" three times. If DOM inspection shows the output has a background, retry once with more aggressive constraint language. Fallback: use opaque PNG and rely on composite stage to blend. |
| Composite stage mutates character faces | Brand inconsistency | Pass BOTH the key art AND title card as references in the composite prompt. Higgsfield's ref system locks faces; composite prompt only dictates text placement. |
| YouTube algorithm doesn't like AI-generated titles/descriptions | Low CTR | Research-informed patterns (Phase 2) reduce this; A/B variants (Phase 3) test it |
| Thumbnail dimensions wrong for some platforms | Upload rejected | Generate 1280×720 master, derive square + vertical crops as needed |
| User edits lost on re-generation | Frustration | Persist edits separately from generated; "Regenerate" requires confirm |
| Hashtag spam triggers shadowban | Reach killed | Cap at 5, prompt for relevance not stuffing |

## Reusability

This stage's outputs feed naturally into:
- **Phase 4 (out of scope) auto-upload:** metadata.json + thumbnail.png + final.mp4 = exact YouTube Data API payload
- **Cross-platform expansion:** Facebook today, TikTok later — same pipeline, new platform module
- **Analytics feedback:** if you eventually track which titles/thumbnails perform best, that data can train better prompts
- **A/B testing:** Phase 3's variants directly support YouTube's title/thumbnail experiments
- **Thumbnail refresh:** old projects can regenerate thumbnails using new research patterns without re-rendering video

## Anti-patterns to Avoid

- **Don't auto-publish without user review.** Always present LLM output for approval before writing files. SEO is too high-stakes to silently emit garbage.
- **Don't skip the OCR verify step on title cards.** Nano Banana occasionally misspells or flips punctuation. A ~$0.0002 Gemini Vision pass after Stage 2 catches the ~5% of regenerations that slip — cheaper than shipping a typo thumbnail.
- **Don't pass only the title card to the composite stage.** The composite prompt needs BOTH key art + title card as references. Passing only the title card risks Nano Banana regenerating faces from scratch during composite — faces drift, consistency is lost.
- **Don't hardcode "lower-third" placement for all genres.** It works for horizontal ensemble drama but fails on portrait-heavy shots. Phase 3's auto-placement pass (Gemini Vision identifies least-cluttered region) fixes this; until then, expose placement as a user-selectable enum in the Publish view.
- **Don't generate 100 hashtags.** Quality over quantity. Spammy hashtag walls reduce reach on both platforms.
- **Don't ignore platform-specific best practices.** YouTube and Facebook have different optimal formats; don't reuse the same caption verbatim.
- **Don't write the timestamp section before assembly is final.** Need actual final video duration + scene timings; generate timestamps after assembly completes.
- **Don't forget the channel CTA.** YouTube descriptions should end with subscribe link + related videos. User-configurable in settings.

## Pre-flight Checklist

Before starting Phase 1:

- [ ] User has Claude API key configured (already true)
- [ ] User has Gemini API key configured (already true — used for research)
- [ ] Channel branding decided (channel name, subscribe link, hashtag list) — store in app settings
- [ ] One completed project to test against (Bush Girl or Mama Sold Her — both viable)
- [ ] Verify Higgsfield character element IDs persist per-project and can be referenced by the thumbnail prompt the same way they work in scene-image generation
- [ ] Confirm Nano Banana Pro accepts two reference images (key art + title card) in a single composite prompt
- [ ] `config/thumbnail-presets.json` drafted with drama/thriller/romance genre presets (palette + font-family hint)
- [ ] Git committed before starting

## Implementation Order (when we ship)

If you green-light this:

1. **Discovery (30 min)** — review YouTube/Facebook upload requirements + nail down exact format expectations
2. **DB migration + IPC + preload (1 hr)** — schema, handlers, API surface
3. **SEOGenerator module (2 hr)** — Claude prompts for YouTube + Facebook copy generation
4. **ThumbnailGenerator module (2 hr)** — three-stage Higgsfield flow: key art + title card (with OCR verify) + composite. No Sharp/Canvas dependency.
5. **Renderer Publish view (3 hr)** — sub-tabs, picker, editor, preview
6. **End-to-end test on existing project (30 min)** — Mama Sold Her → publishable package
7. **Phase 2 research thumbnail analysis (separate 3-hr session)**
8. **Phase 3 variants + auto placement (separate 3-hr session)**

Each phase is shippable independently. Phase 1 alone gets you to "manual upload becomes one copy/paste."

## Dependencies

- Existing: Claude API (for SEO copy)
- Existing: Gemini API (for OCR verify on title cards, scene candidate scoring, Phase 2 research patterns, Phase 3 auto placement)
- Existing: Higgsfield + Nano Banana Pro (core of three-stage thumbnail flow — no longer "optional")
- Existing: pipeline orchestrator + DB infrastructure
- **Removed from original design:** `sharp` npm package, Canvas/SVG title renderer, font file bundling. The Session 8 three-stage Higgsfield flow eliminates all three.

No blockers. Builds cleanly on top of the current shipped pipeline.

## Success Metrics

When this ships, success looks like:

1. **Time saved per video:** from ~45 min of manual SEO/thumb work to <5 min of review + tweak
2. **Publishability score:** every project completes with a thumbnail.png + youtube.txt + facebook.txt that's directly copy-pasteable
3. **Visual quality:** thumbnails look intentional, not template-y (Phase 2 + 3 deliver this)
4. **Click-through rate:** if the user tracks YouTube CTR, AI-generated thumbnails should be within 80% of their manual designs (and improve with research data)

## What This ISN'T

- Not auto-upload (Phase 4, out of scope)
- Not analytics or feedback loop (separate idea)
- Not video editing — assembled .mp4 is final
- Not multi-language (English-only assumption for MVP)
- Not channel management (subscribe links are copied from settings, not set up automatically)
- Not a thumbnail design studio — limited customization for predictability; user can override final files manually if needed
