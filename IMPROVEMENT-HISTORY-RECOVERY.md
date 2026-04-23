# Improvement Exploration: Higgsfield Asset History Recovery

> Status: design doc, no code yet. Captures the feature, the Higgsfield UI discovery, and the decisions needed before implementation.

## TL;DR

When the pipeline crashes/cancels mid-video-generation, Higgsfield often has already produced the videos but we never captured their CDN URLs. Today the user must either manually download from Higgsfield's Assets page or pay credits to regenerate.

This feature scrapes Higgsfield's Assets page, fuzzy-matches scraped videos against our pending DB clips by prompt + timestamp, and downloads the orphans into the project — saving credits that would otherwise be burned on regeneration.

**Two integration modes, same underlying module:**

1. **Inline auto-recovery** (preferred): pipeline tries history scrape INSIDE the video catch block before giving up. Seamless — user never knows a failure happened.
2. **CLI post-mortem**: `scripts/recover-from-history.js` for batch recovery after crashes or for dry-run diagnostics.

**Estimated effort:** ~5-6 hours total (both modes).

## Motivation

Real scenario from the 1-min MVP test (Session 8 candidate):
- 9 clips planned, 8 generated on Higgsfield
- 4 downloaded to local disk (DB shows `done`)
- 5 marked `pending` (graceful shutdown reset them from `generating` → `pending` mid-batch)
- Of those 5: ~4 already generated on Higgsfield's side (visible in their Assets page), 1 was NSFW-rejected
- Existing CDN-URL recovery requires `status=failed AND cdn_url IS NOT NULL`. Pending state with no captured URL → recovery doesn't fire → pipeline regenerates → ~48 credits wasted on already-paid-for clips

Multiplied across many sessions, this is real money. A 10-min run with 90 clips and a single mid-stream crash could orphan dozens of generations.

The existing CDN-URL recovery (Session 6) handles the case where the URL was captured before the crash. This new feature handles the case where it wasn't.

## Discovery: what Higgsfield's Assets page exposes

From inspection of `https://higgsfield.ai/asset/all`:

**Page structure (clean, scraper-friendly):**
- Direct URL: `/asset/all` — already shows current user's assets
- Auto-grouped by date: "Today" / "Yesterday" / etc. headers
- Left sidebar filter — single click selects "Video" (vs Image, Audio, etc.)
- Asset count badge per category (e.g., "Video (782)")
- Each thumbnail in the grid links to `/asset/all/<uuid>` where UUID is a stable identifier

**Asset detail panel (after clicking a thumbnail):**
- Right-side panel slides open
- Visible fields:
  - **PROMPT** — full text we sent to Veo, exactly as submitted (matches our `prompt_used`)
  - **Author** — display name (confirms ownership)
  - **Model** — "Veo 3.1 Lite"
  - **Quality** — "720p"
  - **Size** — pixel dimensions
  - **Created** — date, possibly with time on hover
- Action buttons: Recreate, Publish, Video edit, **Download**, Heart, Share, more menu

**Key observations:**
- UUID in URL is the natural primary key for matching
- Prompt is plain text, no encoding/truncation visible (need to verify with longer prompts)
- Created date for timestamp matching
- Download button — standard browser download or filechooser (likely fires native save dialog)
- No pagination wall visible — looks like infinite scroll, but "Today" group already filters most of what we need

**Likely network shape (to verify in Phase 1):**
- Page probably fires `GET /api/asset/<uuid>` (or similar) when panel opens
- Response likely contains `cdn_url`, `prompt`, `created_at`, etc.
- If so, we skip DOM scraping entirely — intercept the JSON response

## Architecture

### Module: `src/main/automation/higgsfield-history.js`

```javascript
class HiggsfieldHistory {
  constructor(automation) {
    this.automation = automation; // reuses existing Playwright session (logged in)
  }

  /**
   * Navigate to Assets, filter to Video, scroll-load Today's items.
   * Returns: [{ uuid, prompt, createdAt, thumbnailUrl }, ...]
   */
  async scrapeRecentVideos({ maxAgeHours = 24, maxItems = 100 } = {}) { ... }

  /**
   * Open one asset's detail panel and read the metadata.
   * Prefers JSON API if discovered (Phase 1), falls back to DOM scraping.
   * Returns: { uuid, prompt, createdAt, cdnUrl, model, quality, size }
   */
  async getAssetDetails(uuid) { ... }

  /**
   * Download a single asset to a local path.
   * Either uses the Download button + persistent filechooser handler,
   * or fetches cdnUrl directly via page.evaluate.
   */
  async downloadAsset(uuid, destPath) { ... }
}
```

### Module: `src/main/recovery/clipMatcher.js`

```javascript
/**
 * Score how well a scraped Higgsfield video matches an orphaned DB clip.
 * Returns: { score: 0-100, confidence: 'high'|'medium'|'low'|'none' }
 *   high   ≥85% prompt sim AND <10min timestamp delta
 *   medium ≥70% prompt sim AND <30min timestamp delta
 *   low    ≥50% prompt sim
 *   none   below all thresholds
 */
function scoreMatch(scrapedVideo, dbClip) { ... }

/**
 * Greedy match: each scraped video → best DB clip (no double-claiming).
 * Returns: [{ assetId, scrapedVideo, score, confidence }]
 */
function matchAll(scrapedVideos, pendingClips) { ... }
```

Reuses the Levenshtein implementation already in `clipVerifier.js`.

### Script: `scripts/recover-from-history.js`

CLI flow:

```cmd
node scripts/recover-from-history.js
```

```
[1/4] Scraping Higgsfield assets (last 24h)...
      Found 47 videos in Today's history
[2/4] Loading pending clips from active project...
      Found 5 pending clips: Ch1 L5, L6, L7, L8, L9
[3/4] Matching...

  Asset             Confidence  Match (Higgsfield prompt)              Action
  ────────────────────────────────────────────────────────────────────────────
  Ch1 L5 [pending]  HIGH (94%)  "I will go to school anyway..."        [auto]
  Ch1 L6 [pending]  HIGH (88%)  "Mama, you cannot stop me..."          [auto]
  Ch1 L7 [pending]  MED  (76%)  "Father, this form is mine..."         [confirm? Y/n]
  Ch1 L8 [pending]  LOW  (54%)  none above threshold                    [skip]
  Ch1 L9 [pending]  none        no candidate within timestamp window    [skip]

[4/4] Apply matches?
  Auto-applied: 2
  Pending confirmation: 1
  Skipped (will need regeneration): 2

Confirm Ch1 L7 → "Father, this form is mine..." (y/n)? y
  Downloading f7cacdd0-... → ch01_line007.mp4 ... done (3.2 MB)

Summary:
  ✓ Ch1 L5 recovered (3.1 MB)
  ✓ Ch1 L6 recovered (3.4 MB)
  ✓ Ch1 L7 recovered (3.2 MB)
  ✗ Ch1 L8 NOT recovered — run pipeline to regenerate
  ✗ Ch1 L9 NOT recovered — run pipeline to regenerate

3 clips recovered (~36 credits saved), 2 still need regeneration.
Restart the app to continue.
```

### DB schema addition

```sql
-- Migration 007 (only when we ship):
ALTER TABLE project_assets ADD COLUMN higgsfield_asset_id TEXT;
```

Reasons:
- Cross-run dedup (don't re-scrape an asset we've already matched)
- Audit trail (which Higgsfield asset became which local clip)
- Future cleanup tool ("delete asset on Higgsfield's side after it's safely in our project")

### IPC + Renderer (Phase 5, optional)

- IPC: `recover-from-history` returning the same match table data
- Renderer: button on the active-project card: **"Try Higgsfield Recovery"**
- Shows match table inline with confirm/auto-apply controls
- Triggers download in background, updates UI on completion

## Phases (each independently shippable)

**Phase 1 — Discovery (30 min)**
- Open Higgsfield Assets page in DevTools
- Identify: JSON API endpoint (if any), DOM selectors, pagination behavior, download mechanism
- Document in `config/higgsfield-selectors.json` under `assetHistory:` section

**Phase 2 — Scraper module (2 hrs)**
- `higgsfield-history.js` with `scrapeRecentVideos()` + `getAssetDetails()` + `downloadAsset()`
- Reuses existing Playwright session, ad dismissal, persistent filechooser

**Phase 3 — Matcher (1 hr)**
- `clipMatcher.js` with scoring + greedy assignment
- Unit-testable in isolation

**Phase 4 — CLI script (45 min)**
- `recover-from-history.js` as documented above
- High-confidence auto-apply, medium prompts user, low skips
- Saves to project's clips folder, updates DB

**Phase 4.5 — Inline auto-recovery (1 hr)**
- New method `HiggsfieldHistory.findMatchForAsset(asset, options)` — single-asset lookup (vs batch)
- Orchestrator adds `historyAttempted` Set (per-asset, per-run) + `jobIdsSeen` Set (proxy for "Generate was clicked")
- Wire into video gen catch block: before marking failed, try history recovery if conditions met
- In-memory scrape result cache (5-min TTL) so back-to-back failures share one scrape
- Env-gated via `DISABLE_HISTORY_RECOVERY=1` for debugging

**Phase 5 — In-app integration (45 min, optional)**
- Add `higgsfield_asset_id` column
- IPC handler + button on active-project card
- Match table view in renderer

**MVP version (Phases 1-4):** 4-5 hours, fully usable from CLI
**With inline recovery (Phases 1-4.5):** 5-6 hours, seamless in-pipeline auto-recovery
**Full version (all phases):** 6-7 hours, in-app polish

## Inline Auto-Recovery (Phase 4.5) Details

### Why inline is the better UX

A post-mortem CLI tool requires the user to:
1. Notice a crash happened
2. Remember the recovery script exists
3. Close the app
4. Run the script
5. Interactively confirm matches
6. Reopen the app and resume

With inline recovery, the pipeline handles this invisibly:
1. Clip generation fails
2. Pipeline silently tries history match (30-60s added to failure path)
3. If match found → clip marked done, pipeline continues
4. If no match → clip marked failed, existing auto-retry loop kicks in

The user doesn't even know a failure happened. Only the log shows `[RECOVERY] ✓ Recovered Ch1 L5 from history`.

### Trigger conditions (all must be true)

1. **No CDN URL captured** — otherwise existing session-6 recovery handles it
2. **Generation "likely succeeded" server-side** — heuristics:
   - Job UUID was captured during monitoring (`this.state.jobIdsSeen.has(asset.id)`)
   - OR prompt was submitted + some minimum wait time elapsed
3. **History not already attempted for this asset this run** — `historyAttempted` Set prevents loops
4. **Not during cancel/shutdown** — skip if `this.cancelled` or browser closed
5. **Higgsfield session alive** — skip if we're in SESSION_EXPIRED state

### Integration point (video gen catch block)

```javascript
catch (err) {
  // Clean-abort paths unchanged...
  if (this.cancelled) { db.resetAsset(asset.id); return; }
  if (/Target.*closed/.test(err.message)) { db.resetAsset(asset.id); return; }

  // Inline history recovery (Phase 4.5)
  if (this._shouldTryHistoryRecovery(asset, err)) {
    this.historyAttempted.add(asset.id);
    try {
      const match = await this.historyRecovery.findMatchForAsset(asset, {
        timestampWindowMs: 10 * 60 * 1000,  // ±10 min
        minPromptSimilarity: 85,            // high confidence only
        scrapeTimeoutMs: 30_000,
      });
      if (match) {
        await this.historyRecovery.downloadToPath(match.uuid, clipPath);
        db.markAssetDone(asset.id, clipPath, {
          cdnUrl: match.cdnUrl,
          higgsfieldAssetId: match.uuid,
          recoveredFromHistory: true,
        });
        this.log(`[RECOVERY] ✓ Recovered ${clipLabel} from history`);
        return;  // skip failure path entirely
      }
    } catch (recErr) {
      this.log(`[RECOVERY] History scrape failed: ${recErr.message}`, 'warn');
    }
  }

  // Existing failure path continues...
  if (err.detectedCdnUrl) db.markAssetCdnUrl(asset.id, err.detectedCdnUrl);
  db.markAssetFailed(asset.id, err.message);
  // ...
}

_shouldTryHistoryRecovery(asset, err) {
  if (!this.historyRecoveryEnabled) return false;
  if (this.historyAttempted.has(asset.id)) return false;
  if (err.detectedCdnUrl) return false;                   // existing recovery handles
  if (/SESSION_EXPIRED/.test(err.message)) return false;  // auth issue, skip
  if (!this.state.jobIdsSeen.has(asset.id)) return false; // generate never fired
  return true;
}
```

### Performance caveat: scrape result caching

Without caching, consecutive failures each trigger full Higgsfield page scrapes (slow + wasteful). Add in-memory cache:

```javascript
// In HiggsfieldHistory:
async scrapeRecentVideos(options) {
  if (this._cachedScrape && Date.now() - this._cachedScrape.ts < 5 * 60 * 1000) {
    return this._cachedScrape.videos;  // 5-min TTL
  }
  const videos = await this._doScrape(options);
  this._cachedScrape = { videos, ts: Date.now() };
  return videos;
}
```

So if 3 clips fail back-to-back in the same generation round, only the first triggers a real scrape; subsequent ones reuse the cached result.

### Failure modes to handle gracefully

| Scenario | Behavior |
|---|---|
| History scrape times out (30s) | Log warning, fall through to regenerate |
| Higgsfield returns empty page (rate limited?) | Log warning, fall through |
| Match score 70-85% (medium confidence, no auto-apply) | Skip for safety, fall through to regenerate |
| Multiple clips match same Higgsfield video | First-come-first-served; others fall through |
| Downloaded file is corrupted/empty | Delete, mark failed, fall through to regenerate |
| `DISABLE_HISTORY_RECOVERY=1` env | Skip entirely, pure pre-4.5 behavior |

### When inline CAN'T help (user still sees failure)

- Generate click never fired (ad blocker, UI change, session expired) — no job in history to find
- Higgsfield's own safety filter rejected (NSFW) — video never created
- Veo server-side genuine failure — never queued or dropped
- Credits ran out mid-job — charged but job aborted

In all these cases, history scrape finds nothing matching, falls through to regenerate. User sees the standard failure flow.

### Combined with auto-retry loop

The existing video-clip auto-retry loop (3 rounds) already handles transient failures. Inline history recovery fits BEFORE that:

```
Round 0 (initial):
  Generate → [download fails] → [try history] → SUCCESS → done
Round 0 (if history miss):
  Generate → [download fails] → [try history] → miss → mark failed

Round 1 (auto-retry):
  Generate (fresh attempt) → Success or Fail → [history NOT re-tried — already attempted in Round 0]

Round 2: same
Round 3: same
```

`historyAttempted` is per-asset per-run, so a single asset doesn't trigger multiple scrapes across retry rounds. Fresh generation attempts in retry rounds still happen normally.

## Open Decisions

**1. Match thresholds.**
- Auto-apply at ≥85% prompt sim AND <10min timestamp delta?
- Recommend: yes. False positives at this confidence are vanishingly rare given prompts have 100+ unique characters per clip.

**2. Timestamp matching.**
- Higgsfield "Created" date is shown — does it have hour:minute precision?
- If only date precision (no time), drop timestamp from scoring, rely on prompt similarity alone (still works for unique prompts)

**3. Greedy vs optimal matching.**
- Greedy (each scraped → best DB, claim, move on) is simple and good enough
- Optimal (Hungarian algorithm) handles edge case of "video A could match clip 1 OR clip 2; video B could only match clip 1"
- Recommend: greedy. Prompt similarity at >80% essentially eliminates ambiguity.

**4. Multi-project pollution.**
- User's Higgsfield Assets page contains videos from ALL projects (current + previous)
- Scoping by date window helps but doesn't fully eliminate
- Mitigation: also check that the matched prompt is NOT already used by a `done` clip in any project (cross-project dedup is bad here — we want exact match for THIS project's pending clip)

**5. Download mechanism.**
- Click the Download button + intercept via persistent filechooser (works, follows established pattern)
- OR fetch the CDN URL directly with `page.evaluate` if we can extract it
- Recommend: try direct fetch first (cleaner, no native save dialog), fall back to button click

**6. Higgsfield asset retention.**
- Does Higgsfield keep assets forever, or eventually purge? (User feedback needed.)
- If purge after N days, scraping needs to happen BEFORE that window expires
- For MVP, assume they're kept — can revisit later

**7. Rate limiting.**
- Scraping a few hundred items shouldn't trip anything (it's just a page view)
- But opening 100+ asset detail panels rapidly might. Throttle to 1 every 500ms?

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Higgsfield UI changes break selectors | Medium | Same as the rest of our automation — config-based selectors with fallbacks |
| Wrong match (clip A's video → clip B's slot) | High (visible in final video) | Verify Clip catches it. Plus require ≥85% prompt sim for auto-apply |
| Scraper auth state expires mid-scrape | Low | Reuse `_withSessionRetry()` pattern |
| User has 10k+ history items | Low | Date filter to "Today"/"Yesterday" group, scroll cap |
| Prompt text gets truncated in UI | Medium | Phase 1 verifies — if API endpoint exists, use that for full text |
| Two clips have nearly-identical prompts (close-ups of same character) | Medium | Timestamp window narrows the candidate set; if still ambiguous, prompt user |
| Higgsfield purges old assets | Low (user's account stays alive) | Surface as a warning if the pipeline can't find an expected asset |
| Download fails (network blip) | Low | Retry logic, fall back to existing CDN-URL recovery if URL captured |

## Success Metrics

When this ships, success looks like:

1. **Credit savings.** After a mid-stream crash, ≥80% of orphaned clips recovered without regeneration.
2. **Match precision.** ≤1% false-positive rate (wrong video → wrong clip slot). Verify Clip catches these.
3. **Speed.** Recovery of 50 clips completes in <5 min (vs ~30 min to regenerate).
4. **No regressions.** Doesn't break the existing pipeline or other automation.

## What This ISN'T

- Not a replacement for the existing CDN-URL recovery (that's the fast path when URLs were captured)
- Not a Higgsfield-side cleanup tool (that's a related but separate idea — orphan deletion)
- Not a cross-project asset reuse system (also separate — would need prompt fingerprinting across projects)
- Not in scope: Image asset recovery (only video clips for now; portraits + scenes regenerate cheaply)

## Reusability

Same machinery enables:

- **Storage cleanup:** "you have 47 unused videos on Higgsfield from old projects, delete them?" (saves user's account storage)
- **Cross-project clip reuse:** prompt fingerprinting across projects → "this clip's prompt matches one already in your library"
- **Backup verification:** "5 of your DB clips reference local files that don't exist — try recovering from Higgsfield first"
- **Audit:** detect Higgsfield charges that didn't result in usable clips (paid generations that disappeared from your DB)

Worth building once, leverage many ways.

## Implementation Order (when we ship)

If you green-light this:

1. **Phase 1 first**, with the user watching DevTools. 30 min of "click around, look at what fires." This decides the entire architecture (JSON API vs DOM scraping). Critical to get right.

2. **Phase 2-4 in one sitting** (3-4 hr). Module + matcher + CLI script. Test against the existing orphaned-clip scenario from Session 8 to validate.

3. **Phase 5 deferred** until CLI tool proves out. In-app button is polish, not core functionality.

## Pre-flight Checklist

Before starting Phase 1:

- [ ] Have an active project with known orphaned clips (from a real crash) for testing
- [ ] User signed into Higgsfield in the Playwright browser
- [ ] DevTools accessible (`F12` in headed Chromium)
- [ ] At least one orphaned clip whose CDN URL we DON'T have in DB (proves the new path works, not the existing one)
- [ ] Git committed before starting (so we can diff and roll back if discovery reveals worse complexity than expected)

## Dependencies

None blocking. This builds on:
- Existing Playwright automation (browser, page, ad dismissal, persistent filechooser)
- Existing CDN-URL recovery (Session 6) — we save matched URLs into the same `cdn_url` column
- Existing DB asset model — only one new column added

When we're ready, it's an additive feature, not a migration.

## Anti-patterns to Avoid

- **Don't auto-apply medium-confidence matches.** Even at 70-85%, false positives produce wrong-video-in-final output. User confirmation required.
- **Don't scrape the entire history every time.** Date filter + cap to maxItems. Otherwise users with thousands of historical assets get a slow tool.
- **Don't trust DOM if API exists.** If Phase 1 finds a JSON API, use it — it's faster, more reliable, and survives UI changes better.
- **Don't claim assets that already match a `done` clip.** Two pending clips with similar prompts could both falsely match the same Higgsfield video. Mark assets as claimed once matched.
- **Don't skip the persistent filechooser handler when downloading.** Same lessons learned in image upload — the OS save dialog must be intercepted, not allowed to leak to the user.

---

## Phase 5 — Image Recovery (Deferred)

**Status**: Evaluated in Session 8, deferred. Revisit if a real image-orphan case appears in production.

### Why deferred

The inline auto-recovery pays off when three things are simultaneously true: (1) generation succeeds server-side, (2) CDN-URL capture fails locally, (3) per-item cost of regeneration is meaningful. Videos hit all three. Images don't.

**1. The failure-mode window is much narrower for images.**

Video clips generate in 60-120s and we run `recreateContext()` mid-flight — lots of room for the browser to drop the CDN URL after Higgsfield already produced the file. Image generation is ~10-30s start-to-finish. Most image failures happen BEFORE the Generate click (reference uploads not attaching due to React `isTrusted` enforcement, ad-popup races during ref slot opening, viewport-filter misfires). If the refs don't attach, the click either never fires or Higgsfield rejects the prompt — nothing on the server to recover.

**2. Cost math is ~10x weaker.**

A 2-min script burns roughly 5 portraits + 18 scenes + 18 clips. Veo 3.1 Lite is ~5-10x the per-item credit cost of Nano Banana Pro. Saving 2-3 orphaned video clips per crash-session recovers real money. Saving 2-3 orphaned scene images recovers a rounding error. Portraits are generated once per project — if one fails, you just rerun the portraits stage.

**3. Matching precision is lower for images.**

Video prompts are 150+ chars of animation language + mouth-sync + dialogue + tone — Levenshtein has strong signal. Scene image prompts are shorter and more templated (character + setting + lighting + composition). Higher prompt overlap across scenes means more false positives, and a false positive on an image is **a silent-corruption failure mode the video case doesn't have** — a wrong clip gets caught by Verify Clip, but a wrong scene image propagates invisibly into 1-3 downstream video prompts as the start frame. No downstream gate catches it.

**4. Existing guards already cover the common case.**

- `findExistingGeneration(prompt, type)` dedup runs BEFORE every image generation. If the same prompt produced a file earlier (this run or any prior run), we reuse it and skip the API call entirely.
- Scene images have an explicit approval gate before video kicks off, so dropped/bad images get caught by the human before compounding downstream.

**5. Per-run latency tax.**

Even a fast scrape is 5-15s per attempt. Across 18-23 images per run, that's up to 5 minutes of added pipeline time for an edge case that probably saves one or two image credits per crash session. Net negative EV on healthy runs.

### Trigger conditions to revisit

File this as shipped-deferred and revisit when **any** of these happen:

- A session where a scene image clearly generated server-side (Higgsfield result panel populated) but our pipeline marked it `failed` and regenerated from scratch — i.e., the same three-condition pattern that motivated video recovery
- Image credit burn becomes a material cost line (currently dwarfed by video credits)
- Higgsfield changes their UI such that image generation becomes slower / more crash-prone during the CDN-capture window

### If we ship it, the shape would be

Narrow scope, high precision, CLI-only:

- **Scope:** Scene images only. Portraits are too few + too cheap to be worth it.
- **Thresholds:** Tighter than video. Bump prompt-similarity minimum to **90%** and timestamp window to **±5 min** to compensate for weaker prompt signal.
- **Scraper:** Extend `higgsfield-history.js` with an image-filter mode (`?type=image` or whatever Higgsfield's image-filter query param turns out to be — needs DevTools inspection on `/asset/all`).
- **Matcher:** Same `clipMatcher.js`, but with `tierForScore()` parameterized so image matching can use stricter tier boundaries without duplicating the code.
- **Orchestrator integration:** **Skip inline mode entirely.** Don't tax every image catch block with a 5-15s scrape. Recovery only via CLI.
- **CLI flag:** `node scripts/recover-from-history.js --include-images` to opt in. Default remains video-only.
- **Asset-type filter:** `_shouldTryHistoryRecovery()` needs an asset.type gate that excludes portraits even when `--include-images` is on.
- **Verification follow-up:** Because images feed the video reference chain, any image we recover should trigger a re-verify of all downstream video clips that used it as a start frame. Otherwise we've silently injected a potentially-wrong reference without any downstream catch.

### Unknown unknowns worth validating first

Before writing any code for Phase 5, inspect Higgsfield's image history page in DevTools:

- Does `/asset/all` distinguish images vs videos with a query param, or are they on separate pages entirely?
- Do image assets expose the prompt in the grid or only in the detail panel? (Affects whether we need hydration — images might need more detail fetches since prompts are shorter + harder to display in thumbnails.)
- Does the image downloader use the same filechooser pattern, or do images come back as inline base64 / direct URLs?
- Is there a common "job ID" that links an image asset to the scene that produced it? (Would let us skip fuzzy matching entirely for images generated within a session.)

If that last one turns out to be true, it'd change the whole approach — we'd match by job ID instead of prompt+timestamp, and precision would be ~100% instead of fuzzy. Worth 30 min of DevTools poking before committing to the prompt-matching path.
