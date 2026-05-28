# Improvement: Social Engagement Posts Around Scheduled Shorts

## Status

Implemented and live-tested for the May 2026 campaign.

Current production state:

- May 26-29, 2026 engagement posts are scheduled for the May project.
- Captions are locked in; no further caption iteration is planned for this campaign.
- The remaining work is future-campaign hardening, especially the fresh-campaign Type 1A/Type 1B split and any Facebook UI drift found during the next run.

## Problem

The current Shorts tab supports one distribution artifact: a scheduled Facebook Reel assembled from project video clips. This fills a 30-day calendar with roughly one Reel per day, but it does not create supporting engagement posts around each Reel.

The desired feature is a social engagement layer that turns scheduled shorts into a richer posting calendar:

1. Character profile text/image post
2. Pre-short teaser text/image post
3. Existing Short Reel post
4. Post-short recap text/image post

Post types 2 and 4 must depend on the Reel being successfully scheduled first. In practice, teaser and recap posts should only be generated/scheduled for a short where `shorts.status = 'scheduled'`.

Post type 1 is now detached from the daily short. Character profile posts are a finite launch sequence for the movie/script: if the script has four unique characters, the first four future campaign days get one character intro each. A character with multiple outfits is still one unique character for this purpose.

## Current Shorts Architecture

Key files:

- `src/main/shorts/shorts-scheduler.js`
- `src/main/shorts/facebook-uploader.js`
- `src/main/shorts/index.js`
- `src/renderer/index.html`
- `src/main/database/migrations/019-shorts-scheduler.sql`

Current DB anchor:

- `shorts.source_clips` stores the project asset IDs used in each short.
- `shorts.scheduled_date` and `shorts.scheduled_time` store the Reel schedule slot.
- `shorts.status` is the best dependency signal.

Actual status lifecycle in code:

```text
planned -> assembled -> seo_done -> scheduled
                         \-> upload_failed
```

Note: migration comments mention some older status names, but the implementation currently uses the lifecycle above.

## Recommended Product Shape

Create a separate tab, likely called "Engagement Calendar" or "Social Posts", instead of expanding the Shorts tab. The Shorts tab remains responsible for creating and scheduling Reels. The new tab is responsible for generating and scheduling surrounding image/text posts once Reels are scheduled.

The project dropdown should show projects with scheduled shorts:

```sql
EXISTS (
  SELECT 1 FROM shorts
  WHERE shorts.project_id = projects.id
    AND shorts.status = 'scheduled'
)
```

The UI should show a calendar grouped by day. Character intros appear only while unused unique characters remain; teaser and recap posts attach to scheduled Reels:

```text
Character Intro (optional launch sequence) -> Pre-Short Teaser -> Reel -> Post-Short Recap
```

Recommended default times:

- Character intro: 12:00 PM, for the first N future campaign days where N = unique speaking-character count
- Pre-short teaser: 3:00 PM
- Reel: existing `shorts.scheduled_time`
- Post-short recap: 9:00 PM

Only future-dated scheduled Reels should produce teaser/recap posts. This matches the operating pattern where Shorts are typically scheduled at the end of a month for the next month. If there are only a few future scheduled shorts left in the current month, engagement posts should only be created for those future Reel dates.

Operating expectation: run the Shorts workflow first, schedule all Reels, then run the engagement workflow afterward. The engagement tab should assume the selected project already has all intended shorts scheduled.

## Proposed Data Model

Add a new table instead of expanding `shorts`, because each short can produce multiple supporting posts.

Draft schema:

```sql
CREATE TABLE social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_id INTEGER REFERENCES shorts(id) ON DELETE CASCADE,
  post_type TEXT NOT NULL,
  sequence INTEGER DEFAULT 1,
  title TEXT,
  body TEXT,
  hashtags TEXT DEFAULT '[]',
  media_path TEXT,
  scheduled_date TEXT,
  scheduled_time TEXT,
  status TEXT DEFAULT 'planned',
  facebook_post_id TEXT,
  error_message TEXT,
  source_character_id TEXT,
  source_character_element_name TEXT,
  source_scene_asset_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Likely `post_type` values:

- `character_intro`
- `pre_short_teaser`
- `post_short_recap`

`short_id` is nullable because character intro posts are project-level launch posts, not per-short posts. Teaser and recap posts should always have a `short_id`.

The existing Reel can remain represented by the `shorts` row, at least for MVP. A later unified calendar could render the Reel virtually beside the `social_posts` rows.

Likely `social_posts.status` lifecycle:

```text
planned -> content_done -> scheduled
             \-> upload_failed
             \-> skipped
```

## Source Data Strategy

For teaser and recap posts, use each future scheduled short:

1. Read `shorts.source_clips`.
2. Load those `project_assets` rows.
3. Use each clip asset's `chapter`, `scene`, and `line_refs`.
4. Parse `projects.script_json`.
5. Resolve matching scenes, lines, speakers, and scene metadata.
6. Resolve character identity through `character_bible`, `element_name_hint`, persisted `element_name`, and project `settings`.
7. Pick local media files from `project_assets`.

For character intro posts:

1. Parse `projects.script_json`.
2. Enumerate unique speaking-role `character_bible` entries.
3. Treat multiple outfits as one character.
4. Select one intro post per unique character until all major characters are introduced.
5. Use the master portrait asset for the character where possible.

Useful existing data:

- `project_assets.type = 'video_clip_cinematic'`
- `project_assets.line_refs`
- `project_assets.kling_clip_id`
- `project_assets.prompt_used`
- `project_assets.type = 'portrait'`
- `project_assets.type = 'character_grid'`
- `project_assets.type = 'scene_image_cinematic'`
- `project_assets.element_name`
- `projects.script_json`
- `projects.settings._cinematicElementNames`
- `projects.settings._outfitElements`

## Character Resolution

The script prompt requires cinematic speakers to use element-name hints:

```text
speaker_id: "@mama_adaeze"
characters_present: ["mama_adaeze", "eze_okonkwo"]
```

The pipeline later creates full Higgsfield element names, often with outfit and project suffix:

```text
mama_adaeze_o1_abcd_0525
mama_adaeze_o2_abcd_0525
```

The resolver should normalize all of these:

```text
@mama_adaeze -> mama_adaeze -> character_bible entry
mama_adaeze_o1_abcd_0525 -> mama_adaeze -> character_bible entry
```

The safest MVP lookup order:

1. Exact match on `character_bible[].id`
2. Exact match on `character_bible[].element_name_hint`, ignoring leading `@`
3. Slug match on `character_bible[].description_label`
4. Match persisted `project_assets.element_name` and strip outfit/suffix back to base hint

## Post Type Requirements

### 1. Character Intro

Goal: introduce one unique movie/script character as part of the campaign launch sequence. This is not selected from the day's short and does not repeat per short.

Input:

- Raw character bible description
- Character role, speech style, outfit context if available
- Optional: a small sample of dialogue from the full script for voice flavor

Media:

- Prefer master portrait: `project_assets.type = 'portrait'` with `character_id = char.id`
- Multiple outfits do not create multiple character intros.
- Later enhancement: let the operator override portrait choice if a non-default outfit better represents the character.

Claude output should feel like a social post, not a database card. It can tease the character's want, flaw, secret, or conflict without spoiling the whole movie.

Scheduling rule:

- One intro per unique character.
- Character must have dialogue / a speaking role.
- Place intros on the first N future campaign days, where N is the number of unique characters selected.
- Do not repeat a character unless a later explicit feature adds reruns.

### 2. Pre-Short Teaser

Goal: create curiosity before the Reel publishes.

Input:

- Dialogue from the short
- Scene location/context
- Main conflict in the short
- The short's chronological position in the movie/script

Media:

- Prefer scene image from the first or strongest source clip:
  `project_assets.type = 'scene_image_cinematic'` matching `chapter` + `scene`

Copy direction:

- "What will happen today?"
- "What will she do when she finds out?"
- Avoid spoiling the Reel's strongest reveal.
- Assume shorts are chronological in the movie/script, but still ground copy in the actual source clips.

### 3. Short Reel

Already handled by the Shorts tab.

Dependency:

- New posts should require this row to be `shorts.status = 'scheduled'`.

### 4. Post-Short Recap

Goal: prompt comments after the Reel.

Input:

- Dialogue from the short
- Main action, decision, confrontation, or twist

Media:

- Prefer a scene image from the same short.
- If possible, use a different scene image from the pre-short teaser when the short includes multiple scenes.

Copy direction:

- "Do you agree with what she did?"
- "Was he wrong for saying that?"
- "What would you have done?"

## Claude Generation

The repo already uses `@anthropic-ai/sdk` and `claude-sonnet-4-6`.

Recommended new module:

```text
src/main/social/social-post-generator.js
```

Keep prompts grounded in the specific short. Pass exact dialogue lines, character metadata, scene metadata, and the desired post type. Require strict JSON.

Draft output shape:

```json
{
  "title": "short internal label",
  "body": "caption text",
  "hashtags": ["#nollywood", "#africandrama"],
  "selected_character_hint": "mama_adaeze",
  "media_reason": "why this image fits"
}
```

Persist generated text before upload so retries do not regenerate different copy.

Generation should only target future-dated scheduled Reels for teaser/recap posts. Character intro posts should also use future campaign dates only.

### Prompt Schema Reference: Bloodlines Sample

User provided a sample schema:

```text
C:\Users\chris\Downloads\bloodlines_prompt_schema.json
```

The sample is a strong reference for Facebook caption voice, but it is not directly reusable as-is because it is hardcoded around:

- Series title: `BLOODLINES`
- Hashtags: `#BloodLine`, `#DramaSeries`, etc.
- A separate 3-shot-script input model
- Outputting a `video_gen_prompt`, which this engagement workflow does not need
- Generating `image_prompt`, while this workflow uses already-generated local portraits/scene images
- Deriving character info only from shot labels/dialogue, while this project has richer `character_bible`, portraits, element names, scenes, and clip metadata

Reusable parts:

- Emotional narrator voice
- Scroll-stopping hook style
- Short paragraphs
- Debate-oriented CTA
- Separate post intents:
  - character intro: speak about the character
  - pre-short teaser: anticipation without spoilers
  - post-short recap: moral/emotional debate after viewing
- Strict JSON output contract

Adaptation rules for this project:

- Replace hardcoded `BLOODLINES` with project/series title from `projects.title` or a configurable campaign label.
- Replace hardcoded hashtags with a configurable core hashtag set plus project/episode-relevant tags.
- Do not ask Claude to create image prompts for MVP. The generator should return `media_reason` or `selected_media_role`, while the app chooses existing local image files.
- Do not ask Claude to derive character identity from scratch when `character_bible` is available. Provide character metadata directly.
- For character intros, use full-script character data and sample dialogue, not one short's clips.
- For teaser/recap, use only the selected short's dialogue/context plus chronological position.
- Output only the fields the app needs to persist and schedule:

```json
{
  "hook_line": "...",
  "body": "...",
  "engagement_cta": "...",
  "series_signoff": "...",
  "hashtags": ["..."],
  "media_reason": "...",
  "safety_notes": "optional"
}
```

Recommended caption assembly:

```text
{hook_line}

{body}

{engagement_cta}

{series_signoff}

{hashtags joined by spaces}
```

Prompt guardrails:

- No plot invention beyond provided script/short context.
- No fake episode claims if not supported by the selected short.
- No image prompt output required for MVP.
- No all-caps shouting except a configurable series signoff if desired.
- Emojis are allowed but should be sparse: 1-2 in hook/CTA, no emoji spam.

## Facebook Automation

The existing `FacebookUploader` is Reel-specific:

```text
Create -> Reel -> video upload -> description -> schedule
```

Image/text posts likely require a different branch:

```text
Create -> Post -> photo upload -> caption -> scheduling options -> schedule
```

UI exploration is required. Facebook DOM changes often, so the first implementation should live-test one image/text post path before batch scheduling.

Recommended approach:

1. Extract reusable login, popup dismissal, date/time, and confirmation helpers from `facebook-uploader.js`, or subclass/reuse carefully.
2. Add a separate method:

```js
scheduleImagePost({ imagePath, caption, scheduledDate, scheduledTime })
```

3. Keep screenshot diagnostics on failure, matching the current Reel uploader pattern.

### Live Image-Post UI Exploration (May 25, 2026)

Source references:

- User-provided DOCX: `C:\Users\chris\Cowork_Nollywood\Mass-produced\Mass production - Nollywood\engagment post facebook auto UI steps.docx`
- Extracted screenshots confirmed the same broad flow as the live run.
- Live non-publishing exploration used a logged-in persistent Playwright profile and stopped before any final schedule confirmation.

Observed flow:

```text
Content Library (?filter=SCHEDULED)
-> Create
-> Post
-> Composer
-> type caption
-> Photo/video
-> upload image through input[type=file]
-> Next
-> Post settings
-> Scheduling options
-> date/time inputs
-> Schedule for later
-> final Post settings page changes final button from "Post" to "Schedule"
```

The live run stopped at the `Scheduling options` panel and did not click `Schedule for later` or the final scheduling button.

Follow-up live test did click all the way through final scheduling using:

```text
C:\Users\chris\Cowork_Nollywood\Mass-produced\ch01_sc01_cinematic.png
```

Result:

- Image upload succeeded.
- Preview controls appeared: `Edit media` and `Remove post attachment`.
- `Next` reached Post settings.
- Date/time inputs were filled as `May 26, 2026` and `12:00 PM`.
- `Schedule for later` succeeded.
- Final `Schedule` succeeded.
- Scheduled list showed the post as `Automation scheduling test...` scheduled for `Tomorrow at 12:00 PM`.

Reliable selectors observed:

```js
// Start location
await page.goto('https://www.facebook.com/professional_dashboard/content/content_library/?filter=SCHEDULED');

// Create button in Content Library
page.getByRole('button', { name: /^Create$/i })
page.locator('[role="button"][aria-label="Create"]')

// Create menu -> Post
page.getByRole('menuitem', { name: /^Post$/i })
page.getByText('Post', { exact: true })

// Composer caption field
page.locator('[contenteditable="true"][role="textbox"], [role="textbox"][contenteditable="true"]')
// Placeholder observed: "What's on your mind, Fayehun?"

// Composer media button
page.getByRole('button', { name: /Photo\/video/i })
page.locator('[aria-label="Photo/video"]')

// Image upload
page.locator('input[type="file"]').first().setInputFiles(imagePath)

// After image upload
page.getByRole('button', { name: /^Next$/i })
page.locator('[aria-label="Next"]')

// Post settings rows
page.locator('[role="button"]').filter({ hasText: /Scheduling options/i })
page.getByText('Scheduling options', { exact: true })

// Scheduling panel fields
page.locator('input[role="combobox"]').nth(0) // date, observed value like "May 25, 2026"
page.locator('input[role="combobox"]').nth(1) // time, observed value like "3:37 AM"

// Scheduling panel confirmation, NOT final publish
page.getByRole('button', { name: /^Schedule for later$/i })
page.locator('[aria-label="Schedule for later"]')
```

Important distinction:

- `Schedule for later` is an intermediate confirmation inside the scheduling sub-panel.
- After clicking it, the automation should return to Post settings and verify the final button is `Schedule`, not `Post`.
- Only then should it click the final `Schedule` button.

Observed Post settings rows after `Next`:

- `Post audience` row
- `Scheduling options` row, initially `Publish now`
- `Share to groups`
- `Share to story`
- `Boost post` toggle
- Bottom buttons: `Save` and `Post`

Observed Scheduling options panel:

- Header: `Scheduling options`
- Instruction: `Choose a date and time in the future when you want your post to be published.`
- Date input: visible text/value like `May 25, 2026`
- Time input: visible text/value like `3:37 AM`
- Button: `Schedule for later`

Automation notes:

- The audience dialog did not block the live run because the composer opened with `Public` already selected.
- The image upload path worked with direct `input[type=file].setInputFiles(imagePath)` after clicking `Photo/video`.
- `Next` stayed disabled until caption/media existed.
- A production uploader should wait for the image preview or the `Edit media` / `Remove post attachment` buttons before clicking `Next`.
- The existing Reel uploader's login, popup dismissal, date/time formatting, retry, screenshot diagnostics, and confirmation polling patterns should be reused, but image-post scheduling should be a separate method such as `scheduleImagePost()`.
- Facebook may show a `Leave Page?` guard if a previous composer was abandoned. Production automation should handle it explicitly:
  - At startup, choose `Leave` to discard stale unfinished composer state.
  - While inside the intended composer, choose `Keep editing` if the guard appears unexpectedly.
- The `Photo/video` control was sometimes visible but not Playwright-actionable. A DOM click fallback worked, followed by `input[type=file].setInputFiles(imagePath)`.
- The global Facebook search box is also `role="combobox"`. Date/time automation must scope inputs to the scheduling modal, e.g. by bounding box or nearby panel text, not by raw combobox index.
- Final confirmation can be detected by returning to the Scheduled content list and finding the scheduled post row/date text.

## Open Questions

- Should the next fresh campaign expose Type 1A project-level intros and Type 1B day-specific spotlights as separate operator-visible labels?
- Should the Electron Engagement tab eventually include a read-only "campaign complete" summary once all future rows are scheduled?

## Major Risks

- Facebook image/text post scheduling UI may differ significantly from Reel scheduling UI.
- Character identity resolution must handle element-name suffixes and multi-outfit names.
- Claude can over-infer beyond the short. Prompts should explicitly forbid inventing story events outside the provided context.
- Bulk scheduling needs DB backups and resumable status updates, like Shorts upload does.

Resolved design decisions:

- Character intros are finite project-level launch posts, not daily per-short posts.
- Character intro uniqueness is based on character identity, not outfit count.
- Shorts are expected to be chronological in the movie/script for this workflow.
- Image posts can use the available portrait/scene image as-is; no crop preview is required for MVP.
- Engagement posts are created only for future-dated scheduled Reels, avoiding same-day/past scheduling failures during late-month operation.
- Claude output must be persisted before upload so failed upload retries reuse the same copy.
- Bulk status changes should create DB backups, matching Shorts assembly/upload behavior.
- Manual review/edit remains desirable, but can be a later polish phase rather than an MVP blocker.
- Fixed schedule times are: intro 12 PM, teaser 3 PM, Reel 6 PM from Shorts, recap 9 PM.
- Character intros include every unique character with dialogue/speaking role.
- Engagement generation should run after all Shorts are scheduled for the project.
- Failed image posts should not block the batch; mark `upload_failed`, continue, and retry later.
- No review/edit gate is required for MVP: generate, persist, upload/schedule.
- A scene image can be reused for pre and post if needed; copy differences carry the post distinction.

## Suggested Implementation Phases

1. Read-only planner:
   - List projects with scheduled shorts.
   - Derive per-short dialogue, character candidates, portrait path, and scene image path.
   - Render a preview calendar in the new tab.

2. Caption generator:
   - Generate and persist content for planned posts.
   - No Facebook upload yet.

3. One-post Facebook image scheduler:
   - Live-test scheduling one image/text post.
   - Harden selectors and diagnostics.

4. Batch scheduler:
   - Upload/schedule all `content_done` posts.
   - Retry `upload_failed` posts.

5. Review/edit polish:
   - Manual caption edits.
   - Per-type time controls.
   - Character repeat controls.
   - Media selection overrides.

## Implementation Plan

### Phase 1: Schema + Data Helpers

Add migration `020-social-posts.sql`.

Core table:

```sql
CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_id INTEGER REFERENCES shorts(id) ON DELETE CASCADE,
  post_type TEXT NOT NULL,
  sequence INTEGER DEFAULT 1,
  title TEXT,
  body TEXT,
  hashtags TEXT DEFAULT '[]',
  caption_json TEXT,
  media_path TEXT,
  scheduled_date TEXT,
  scheduled_time TEXT,
  status TEXT DEFAULT 'planned',
  facebook_post_id TEXT,
  error_message TEXT,
  source_character_id TEXT,
  source_character_element_name TEXT,
  source_scene_asset_id INTEGER,
  generated_at TEXT,
  upload_confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
```

Indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_social_posts_project ON social_posts(project_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_short ON social_posts(short_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_social_posts_schedule ON social_posts(scheduled_date, scheduled_time);
```

Uniqueness:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_unique_intro
ON social_posts(project_id, source_character_id, post_type)
WHERE post_type = 'character_intro';

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_unique_short_type
ON social_posts(short_id, post_type)
WHERE post_type IN ('pre_short_teaser', 'post_short_recap');
```

DB helper additions in `src/main/database/db.js`:

- `getSocialPostProjects()`
- `getSocialPostsForProject(projectId)`
- `insertSocialPost(post)`
- `updateSocialPost(id, fields)`
- `getPendingSocialUploads(projectId)`
- `markSocialPostScheduled(id, facebookPostId)`
- `markSocialPostFailed(id, errorMessage)`

Status lifecycle:

```text
planned -> content_done -> scheduled
             \-> upload_failed
             \-> skipped
```

### Phase 2: Planner Module

Add:

```text
src/main/social/social-planner.js
```

Responsibilities:

- List eligible projects with future scheduled shorts.
- Build future-only schedule rows from `shorts.status = 'scheduled'`.
- Derive character intros from speaking characters.
- Derive teaser/recap rows from each future scheduled short.
- Select local media paths.
- Persist only missing planned rows; do not duplicate existing rows.

Project eligibility:

```sql
SELECT p.*
FROM projects p
WHERE EXISTS (
  SELECT 1 FROM shorts s
  WHERE s.project_id = p.id
    AND s.status = 'scheduled'
    AND date(s.scheduled_date) >= date('now')
)
```

Future short rule:

- A short is eligible for teaser/recap if `status = 'scheduled'` and `scheduled_date` is today-or-future.
- If a scheduled time for today has already passed, skip it for safety.
- Normal operation expects the Shorts workflow to have scheduled the full upcoming calendar first.

Fixed times:

```js
const SOCIAL_POST_TIMES = {
  character_intro: '12:00',
  pre_short_teaser: '15:00',
  post_short_recap: '21:00',
};
```

Character intro derivation:

- Parse `projects.script_json`.
- Resolve every unique character with at least one spoken line.
- Sort by first speaking appearance, then by dialogue count as a fallback.
- Treat outfit variants as the same character.
- Use `project_assets.type = 'portrait' AND character_id = char.id` for media.
- Schedule the first N future campaign dates, one character per day.

Speaking character detection:

- Iterate `script.chapters[].scenes[].lines[]`.
- Normalize `speaker_id`: strip leading `@`, compare against `character_bible[].id`, `element_name_hint`, and slugged label.
- Count dialogue lines per character.

Short context derivation:

```text
shorts.source_clips
-> project_assets rows
-> video_clip_cinematic.chapter / scene / line_refs
-> script chapter / scene / lines
-> scene_image_cinematic by chapter + scene
```

Scene image selection:

- Prefer the first source clip's `scene_image_cinematic` if file exists.
- If missing, try any source clip scene image.
- If multiple valid scene images exist, choose the scene with strongest dialogue density.
- Pre and post can reuse the same scene image in MVP.

### Phase 3: Caption Generator

Add:

```text
src/main/social/social-post-generator.js
```

Responsibilities:

- Wrap Anthropic client.
- Generate strict JSON for each planned post.
- Validate JSON shape.
- Build final caption string from JSON.
- Persist before any Facebook upload.

Inputs by type:

`character_intro`:

- Project title / campaign title
- Character name, role, description, speech style, speech notes
- A few sample lines from that character
- Core hashtag config

`pre_short_teaser`:

- Project title / campaign title
- Short number/date
- Dialogue lines from source clips
- Scene location/context
- Main characters in the short
- Chronological position
- Core hashtag config

`post_short_recap`:

- Same short context as teaser
- Ask Claude to produce a moral/debate question using only provided context

Output schema:

```json
{
  "hook_line": "...",
  "body": "...",
  "engagement_cta": "...",
  "series_signoff": "...",
  "hashtags": ["..."],
  "media_reason": "...",
  "safety_notes": ""
}
```

Caption assembly:

```text
{hook_line}

{body}

{engagement_cta}

{series_signoff}

{hashtags joined by spaces}
```

Persistence:

- Save raw JSON in `caption_json`.
- Save assembled text in `body`.
- Save hashtags array in `hashtags`.
- Set `status = 'content_done'`.
- Set `generated_at = datetime('now')`.

No review/edit gate for MVP.

### Phase 4: Facebook Image Post Uploader

Add:

```text
src/main/social/facebook-post-uploader.js
```

This should not replace `src/main/shorts/facebook-uploader.js`. Keep it separate to avoid Reels regression. It can copy/reuse helper patterns from the Shorts uploader.

Primary method:

```js
async scheduleImagePost({
  imagePath,
  caption,
  scheduledDate,
  scheduledTime,
})
```

Proven flow:

```text
Content Library ?filter=SCHEDULED
-> Create
-> Post
-> caption
-> Photo/video
-> input[type=file].setInputFiles(imagePath)
-> wait for image preview
-> Next
-> Scheduling options
-> fill modal-scoped date/time inputs
-> Schedule for later
-> final Schedule
-> confirm scheduled list row / success state
```

Required hardening:

- On startup, if `Leave Page?` appears from a stale composer, close with X/Escape first; use `Leave` only when deliberately discarding a stale draft before starting a new run.
- During active composer flow, close `Leave Page?` with X/Escape or `Keep editing`; never click `Leave`.
- Do not rely on current mouse position after typing.
- Scope all clicks to the active modal when possible.
- Prefer file input upload after opening `Photo/video`.
- Use DOM click fallback for `Photo/video`.
- Wait for `Edit media` or `Remove post attachment` before `Next`.
- Treat enabled `Next` alone as insufficient.
- Click the bottom composer `Next` by active modal context / coordinates, not global page text.
- Scope scheduling date/time inputs to the scheduling modal; global Facebook Search is also a combobox.
- After `Schedule for later`, verify the final button is `Schedule`, not `Post`.
- Confirm by scheduled list row/date text or success toast.

Date/time helpers:

- Date format for Facebook: `MMM D, YYYY`, e.g. `May 26, 2026`.
- Time format for Facebook: `h:mm AM/PM`, e.g. `12:00 PM`.

### Phase 5: Controller + IPC

Add:

```text
src/main/social/index.js
```

Controller:

```js
class SocialPostsController {
  getProjects()
  getStatus(projectId)
  plan(projectId)
  generate(projectId)
  scheduleAll(projectId)
}
```

Progress events:

```text
social-progress
```

IPC in `src/main/main.js`:

```js
ipcMain.handle('social:getProjects', ...)
ipcMain.handle('social:getStatus', ...)
ipcMain.handle('social:plan', ...)
ipcMain.handle('social:generate', ...)
ipcMain.handle('social:scheduleAll', ...)
```

Preload in `src/preload/preload.js`:

```js
getSocialProjects()
getSocialStatus(projectId)
planSocialPosts(projectId)
generateSocialPosts(projectId)
scheduleAllSocialPosts(projectId)
onSocialProgress(callback)
```

Backups:

- Before planning bulk inserts: optional.
- Before generation status changes: `db.backup('pre-social-generate')`.
- Before scheduling/upload status changes: `db.backup('pre-social-upload')`.

### Phase 6: Renderer Tab

Add a new header button:

```text
Engagement
```

New view:

```text
view-social
```

UI sections:

- Project dropdown
- Status summary
- Buttons:
  - `Plan Posts`
  - `Generate Copy`
  - `Schedule All to Facebook`
- Calendar table grouped by date:
  - Date
  - Time
  - Type
  - Media
  - Status
  - Short number / character name

Button enablement:

- `Plan Posts`: enabled when project has scheduled future shorts.
- `Generate Copy`: enabled when planned rows exist.
- `Schedule All`: enabled when `content_done` or `upload_failed` rows exist.

No manual review/edit in MVP.

### Phase 7: Verification Strategy

Local planner checks:

- Project with scheduled shorts appears in Social tab project list.
- Future-only filtering works.
- Past scheduled shorts are ignored.
- Character intro rows equal unique speaking characters.
- Outfit variants do not create duplicate intros.
- Teaser/recap rows equal `2 * future_scheduled_short_count`.
- `short_id + post_type` uniqueness prevents duplicate planning.

Traceability checks:

- For one real scheduled short, print:

```text
short id
source clip ids
clip chapter/scene/line_refs
resolved dialogue lines
selected scene image path
```

Generator checks:

- Claude output parses as JSON.
- Required fields exist.
- Caption string is persisted before upload.
- Bad JSON marks row failed or leaves row planned with error.

Facebook checks:

- Single image post schedule using a known image.
- Forced missing image marks `upload_failed` and continues.
- Batch continues after one failure.
- Retry only uploads `upload_failed` / `content_done`.

Live safety:

- Use a clearly labeled test caption for one end-to-end test.
- Verify the scheduled list row appears.
- User deletes the temporary Facebook test post afterward.

### Phase 7B: Regression Test Plan

Migration regression:

- Fresh database applies migrations through `020-social-posts.sql`.
- Existing database at Shorts migration `019` upgrades to `020` without changing existing Shorts rows.
- `social_posts` unique indexes prevent duplicate character intros and duplicate teaser/recap rows per short.
- Type 1A project-level intros remain unique by `(project_id, source_character_id, post_type)` only when `short_id IS NULL`.
- Type 1B day-specific spotlights are unique by `(short_id, post_type)`, allowing the same dominant character to appear on multiple short days without blocking the row.
- Re-running `Plan Posts` is idempotent: existing rows remain, and `inserted` is `0` when nothing new is eligible.

Existing Shorts regression:

- Shorts tab still opens and lists completed projects.
- `getShortsStatus`, `planShortsCalendar`, `assembleShorts`, and `uploadAllShorts` IPC names remain unchanged.
- Existing Reel upload automation is not touched by image-post automation.
- Scheduled Reel rows remain the source of truth for Engagement eligibility.

Planner regression:

- Projects with no scheduled shorts do not appear in the Engagement project dropdown.
- Future-only logic excludes past dates and same-day times that have already passed.
- Per-post slot filtering uses a 60-minute buffer before scheduling.
- A same-day Reel at 6 PM is skipped if its 3 PM teaser slot is less than 60 minutes away.
- Late-day production runs start from tomorrow when today's pre-Reel engagement slots are no longer safely schedulable.
- Recap-only same-day scheduling is avoided when the teaser slot is already ineligible.
- `Next eligible day only` scope plans only the first eligible scheduled-Reel date.
- `All future days` scope plans every eligible scheduled-Reel date.
- Character intro count equals unique speaking characters, not outfit variants.
- Character intros are capped by remaining eligible 12 PM intro slots.
- If remaining intro slots are fewer than unique speaking characters, only the earliest speaking characters are introduced.
- Missing portrait or scene image records an error on the planned row instead of crashing the whole plan.
- Short traceability resolves from `shorts.source_clips` to clip assets, `line_refs`, dialogue, and scene image assets.

Renderer regression:

- Engagement header button opens `view-social`; Back restores launcher and stepper.
- Empty project list shows a helpful no-projects state.
- Selecting a project loads existing `social_posts` rows.
- `Plan Posts` populates the table and stats without requiring app restart.
- If a target date already has only `scheduled` rows, `Plan Posts` is disabled and the status text says all posts for that date are already scheduled.
- If `All future days` is selected and every loaded future engagement row is already `scheduled`, `Plan Posts` is disabled and the status text says all future engagement posts are already scheduled.
- Completed-state button logic must keep `Generate Copy` disabled when there are no `planned` rows and `Schedule All` disabled when there are no `content_done` / `upload_failed` rows.
- Shorts and Publish header buttons still route to their original views.

Future Facebook automation regression:

- Caption typing is scoped to the active Create Post modal.
- Caption entry uses clipboard paste first, then read-back verification before `Next`.
- Caption read-back must compare normalized expected text with the active composer text and fail the row before scheduling if Facebook truncates or corrupts the caption.
- Image upload waits for preview controls before clicking `Next`.
- If the `Leave Page?` guard appears unexpectedly, close it with X/Escape and keep the current draft unless explicitly clearing stale state.
- Missing image upload marks only that row `upload_failed`; the batch continues.
- Retry mode uploads only `content_done` or `upload_failed` rows and does not regenerate copy.
- Expanded `See more` preview should be checked for at least one post per batch, and for any corrected/replaced post. Visible collapsed first lines are not enough to catch full-caption artifacts.

### Implementation Checkpoint

Completed first implementation slice:

- Added `social_posts` schema and DB helpers.
- Added Engagement tab/project selector/table.
- Added planner for character intro, pre-Reel teaser, and post-Reel recap rows.
- Added Claude copy generation for planned rows.
- Persisted generated captions before upload by writing `body`, `hashtags`, `caption_json`, `generated_at`, and `status = content_done`.
- Added Facebook image-post scheduler module for `content_done` / `upload_failed` rows.
- Added Schedule All UI wiring.
- Added planning scope toggle: next eligible day only vs all future days.
- Added Type 1B day-specific behavior: Type 1 rows can now attach to a scheduled short, select the dominant speaking character from that short, use that character portrait, and pass short context to the copy generator with pre-Reel spoiler guardrails.
- Updated social post uniqueness: Type 1A project intros are unique per character only when `short_id IS NULL`; Type 1B rows are unique per short.
- Added caption read-back verification after Facebook caption entry. The uploader now pastes caption text, reads it back, retries once on mismatch, and fails the row before scheduling if the caption remains mismatched.
- Added generator guards for real artifacts found during production: broken title/hashtag fragments such as `aidNo`, empty title fragments such as `in  and I am not okay`, weekday hashtags, internal chapter/scene language, overlong captions, and pre-Reel payoff phrases such as `finally exhales`.
- Added Engagement tab completed-campaign guards:
  - Target-date complete state disables `Plan Posts`.
  - All-future complete state disables `Plan Posts`.
  - `Plan Posts` no-ops defensively when the selected scope is already fully scheduled.
- Added syntax validation for new main/preload/renderer code.

Still pending:

- Combined future Type 1 model:
  - Type 1A: project-level character intro, published during the first week of the 30-day Reel campaign.
  - Type 1A source: character bible + portrait assets; deterministic unique speaking-character order.
  - Type 1B: day-specific character spotlight, used after intro week or when intro slots are exhausted.
  - Type 1B source: that day's scheduled short clips/dialogue/prompt refs + portrait assets.
  - Type 1B timing/content rule: it goes out at 12 PM before the 3 PM teaser, 6 PM Reel, and 9 PM recap. It may use the day's short context to pick the character and emotional tension, but must not reveal the Reel outcome, resolution, twist, legal result, final decision, or last-scene payoff.
  - Type 1B copy shape: character-focused, not outcome-focused. Frame what the character is carrying, about to face, or struggling to decide. Type 2 handles direct "video later today" teasing; Type 4 is the only post allowed to discuss what happened.
  - If fewer characters than first-week intro slots, fill remaining Type 1 slots with day-specific spotlights.
  - If more characters than intro slots, introduce only the strongest/earliest characters in the first week.
  - Late campaign runs should not backfill missed Type 1A intro-week posts unless explicitly selected.
- Scheduled-post confirmation capture.
- Full production scheduling from the Electron Engagement tab on a fresh campaign. May closeout used direct Node runners for speed, while the Electron tab was validated for project selection, date/scoped controls, status loading, and completed-campaign button guards.

### Production Run Notes - May 2026 Campaign

Live project:

```text
2026-04-21_05963753
The Obedient Wife Who Finally Said No | Nigerian AI Movie
```

Outcome:

- May 26 one-day Type 1B/2/4 bundle was reset, regenerated, scheduled, expanded-previewed, and approved.
- May 27-29 all-future run scheduled 9 additional engagement posts: Type 1B at 12 PM, teaser at 3 PM, recap at 9 PM for each remaining scheduled Reel day.
- Final live state after correction: all 12 engagement posts from May 26-29 are scheduled.
- Captions are locked as of May 26, 2026. Do not reset or regenerate this campaign for copy iteration.
- Direct Node runner was used for production because it allowed faster inspection, reset, regeneration, and targeted retries.
- DB backups were created before reset, generation, index update, and upload operations.

Closeout rules:

- Leave the May 26-29 rows as `scheduled`.
- Do not run local reset scripts for this campaign unless Facebook posts are manually deleted or a true upload/schedule correction is required.
- If `All future days` is selected in the Engagement tab after closeout, the UI should show all 12 rows as scheduled and prevent `Plan Posts` from doing more work.
- The next campaign cannot run Engagement until the next script/movie has completed enough of the pipeline for Shorts to be generated and scheduled.

Production issues found and resolved:

- Initial Type 1 project-level intro was not appropriate for late-campaign day-specific posting. Reworked Type 1 for this run as Type 1B, tied to short context and dominant speaking character.
- Existing `idx_social_unique_intro` blocked repeated Type 1B rows for the same dominant character. Updated uniqueness so Type 1A stays per-character, Type 1B is per-short.
- Facebook caption typing could truncate when using keyboard typing. Added clipboard-paste-first caption entry plus read-back verification before `Next`.
- Collapsed Facebook previews hid full-caption artifacts. Expanded `See more` checks caught issues that first-line verification missed.
- May 29 recap initially contained `tonight's aidNo...`; user deleted the scheduled post, row 22 was reset, regenerated, and rescheduled.
- A second regeneration produced `in  and I am not okay`; added another validation guard, reset row 22 again, regenerated clean copy, rescheduled, and user confirmed expanded preview was clean.

Replacement May 29 recap final check:

- Scheduled at May 29, 9:00 PM.
- Expanded preview was user-confirmed clean.
- No `aidNo` fragment.
- No empty `in  and` fragment.
- Image and schedule were correct.

### Production Iteration Order

Current agreed order:

1. Type 2 and Type 4 for the next eligible day have been live-validated and confirmed scheduled.
2. Next, tackle Type 1 for tomorrow as a controlled one-day validation alongside Type 2 and Type 4.
3. Before rerun, user manually deletes any already scheduled Type 1/2/4 Facebook posts for the test day.
4. Add/use a DB reset utility to reset local `social_posts` rows for that date:
   - `scheduled` / `upload_failed` / `content_done` -> `planned` when regenerating copy.
   - Preserve Shorts/Reel rows.
   - Create DB backup before any reset.
5. Re-do next eligible day with Type 1, Type 2, and Type 4.
6. If copy or layout still needs work, repeat the manual Facebook delete + local DB reset loop.
7. Once the one-day Type 1/2/4 bundle is approved, reset again if needed, then run `All future days`.
8. After all-future scheduling, expanded-preview at least one representative post per date/type cluster and any post that had to be corrected.

Open gaps before the next run:

- Decide and implement the fresh-campaign Type 1A/Type 1B split for next month's new story:
  - First week should likely publish Type 1A project-level character intros for unique speaking characters.
  - After Type 1A slots/characters are exhausted, use Type 1B day-specific spotlights.
- Add or expose a UI label that distinguishes Type 1A project intro from Type 1B day-specific spotlight.
- Copy quality hardening added after live review:
  - No Markdown formatting.
  - Type 1 target: 80-140 words, no "coming soon/new movie" language.
  - Type 2 target: 70-130 words.
  - Type 4 target: 120-180 words, no blow-by-blow recap.
  - Hashtags capped to 7.
  - Regenerate/retry once when Claude returns overlong captions, internal chapter/scene language, broken dash fragments, broken title/hashtag fragments, empty title fragments, or pre-Reel spoiler phrases.
- App workflow validation still required:
  - Current successful live tests were driven by direct Node scripts for faster iteration.
  - Before calling the feature production-ready, run the same flow from the Electron Engagement tab.

### Phase 8: Production Guardrails

Do not:

- Touch existing Reel scheduling behavior except for shared helpers if absolutely necessary.
- Re-plan over existing `content_done` or `scheduled` rows.
- Regenerate captions for failed uploads unless explicitly reset.
- Click `Post` when scheduling is expected.
- Proceed to `Next` before media preview is confirmed.

Do:

- Persist every generated caption before upload.
- Persist every upload failure with screenshot path if available.
- Continue batch after upload failure.
- Keep progress events concise.
- Keep Facebook browser visible for operator awareness.
