# How-To Facebook Content Pipeline

Standalone v1 for weekly topic research:

```powershell
cd pipeline
npm run run
```

If PowerShell blocks `npm.ps1`, use `npm.cmd run run`.

Smoke-test one page/source before a full run:

```powershell
npm.cmd run run -- --niche fix-it --sources youtube --skip-score --skip-queue --no-login-pause
```

For sources that need a browser login, use a timed login window instead of `--no-login-pause`:

```powershell
npm.cmd run run -- --niche fix-it --sources pinterest --skip-score --skip-queue --login-wait-sec 120
```

The browser opens a holding page with source login links, waits for the timer, then starts scraping.
Use `--user-data-dir .browser-profile` to keep the login session for future runs:

```powershell
npm.cmd run run -- --niche fix-it --sources pinterest --skip-score --skip-queue --user-data-dir .browser-profile --login-wait-sec 120
```

Useful filters:

- `--niche fix-it`
- `--sources youtube`
- `--sources reddit,google_trends,pinterest,quora`
- `--login-wait-sec 120`
- `--login-wait-ms 120000`
- `--user-data-dir .browser-profile`
- source aliases: `trends` -> `google_trends`, `yt` -> `youtube`

Scoring/content generation uses `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY` from `pipeline/.env`/environment first. If neither is set, it falls back to the existing Electron app's saved Claude key at `%APPDATA%\nollywood-ai-pipeline\config.json` field `claudeApiKey`. From Codex sandboxed tool runs, AppData access may require an approved/unsandboxed command; normal local terminal runs can read the Electron config directly.

The current safe version scrapes, scores, writes a queue, prepares dry-run image payloads, can run a guarded one-post Higgsfield image generation, writes useful Claude captions, runs post/image QA, and verifies Facebook page context:

- `raw_topics.json`
- `scored_topics.json`
- `posts_queue.json`
- `image_manifest.json`
- `content_manifest.json`
- `weekly_plan.json`
- `facebook_context_checks.json`
- `logs/run_YYYY-MM-DD.log`
- `howto-content.sqlite`

State is stored in the standalone SQLite DB `howto-content.sqlite`. The JSON files are exports/debug snapshots. The DB tracks runs, source pulls, raw topics, topic signals, scored topics, queued posts, image jobs, content jobs, post quality checks, Facebook context checks, Facebook schedule jobs, and events so later stages can resume safely.

Review the queue before image generation or Facebook scheduling:

```powershell
npm.cmd run review -- status
npm.cmd run review -- list --status queued --limit 20
npm.cmd run review -- show --niche fix-it --rank 1
npm.cmd run review -- approve --id 123 --note "ready"
npm.cmd run review -- reject --id 123 --reason "off niche"
npm.cmd run review -- needs-review --id 123 --reason "source/date check"
npm.cmd run review -- auto-flag
```

Review statuses live in the `posts` table and are exported back to `posts_queue.json`. Current queue statuses are `queued`, `review_needed`, `approved`, `rejected`, `image_generating`, `image_done`, `content_generating`, `content_done`, `qa_generating`, `qa_done`, `scheduling`, `scheduled`, `deleted`, `duplicate`, and `failed`. Bulk updates require explicit selectors; updates over 10 posts require `--yes`.

`auto-flag` moves queued posts with current-claim, safety-risk, or high-stakes-advice wording into `review_needed` so they do not flow into image generation without a manual check.

Duplicate checks run before queueing and before Facebook scheduling. Hard repeats of already scheduled/published posts become `duplicate`; softer matches become `review_needed`. Deleted proof/test posts are ignored. You can inspect or backfill fingerprints with:

```powershell
npm.cmd run dedup -- --backfill
npm.cmd run dedup -- --topic "How to stop a toilet from running" --niche fix-it
npm.cmd run dedup -- --id 301
```

Plan the next weekly calendar without mutating state:

```powershell
npm.cmd run weekly -- --dry-run
npm.cmd run weekly -- --dry-run --days 7 --posts-per-page 7
npm.cmd run weekly -- --dry-run --days 1
```

The weekly planner builds a page-by-day calendar. By default it plans 7 days with one daily slot per page: Fix It at 15:00, Cook It at 16:00, Grow It at 17:00, Money it at 18:00, Get Fit at 19:00, Make It at 20:00, Tech It at 21:00, and Look Good at 22:00. Existing scheduled/scheduling posts in the window become `already_scheduled`; empty requested slots are filled from eligible queued posts after duplicate checks. The planner writes `weekly_plan.json` and prints the next commands for each selected post. The planner itself does not run generation or Facebook scheduling.

Run a guarded batch from `weekly_plan.json`:

```powershell
npm.cmd run batch -- --day 2026-07-02 --limit 8
npm.cmd run batch -- --execute --day 2026-07-02 --limit 8
npm.cmd run batch -- --live --day 2026-07-02 --limit 8 --user-data-dir .browser-profile
```

Batch mode is plan-only by default. `--execute` runs the existing stage CLIs for each selected post: approve, Higgsfield image, content generation, QA, Facebook page-context verification, local schedule preparation, and schedule dry-run. `--live` does the same thing plus final Facebook scheduling. The runner processes one post at a time, reuses the same DB-backed image/content/QA/Facebook gates as manual orchestration, and stops the batch on external/session/scheduling-confirmation failures.

Repair policy in batch mode:

- Image QA failures regenerate through Higgsfield without a fixed numeric retry cap while the post stays inside `--post-wall-clock-min`; repeated image failures mutate the image prompt from QA feedback and eventually switch visual strategy.
- Use `--image-retries N` when a fragile candidate should be dumped after a fixed number of image attempts.
- Caption/content QA failures regenerate from QA feedback up to `--caption-retries` times, default `3`, then the post is marked `review_needed` and skipped.
- Posts are never scheduled unless the latest QA row is `passed/pass` for the exact generated image path and caption hash.
- `review_needed` posts with a QA row resume through the repair loop; posts already marked `Batch skipped:` are not auto-approved on rerun.

Prepare image-generation payloads after approval:

```powershell
npm.cmd run review -- approve --niche fix-it --rank 1 --note "ready for image"
npm.cmd run image -- --dry-run --limit 1
```

The image stage only selects `approved` posts by default. In dry-run mode it creates `image_jobs` rows with `status = dry_run`, writes `image_manifest.json`, and creates the expected output folders under `generated_images/<run_id>/<niche>/`.

Live Higgsfield generation is one-post gated while the module is still being proven:

```powershell
npm.cmd run image -- --live --limit 1 --login-wait-sec 240
```

The live path checks the saved Higgsfield session first, opens a timed login window if needed, records `gen_clicked_at`, `credit_cost`, `source_gen_id`, prompt-match download metadata, writes the generated file under `generated_images/<run_id>/<niche>/`, and moves the post to `image_done` only after the downloaded file exists.

Generate useful post copy after the image exists:

```powershell
npm.cmd run content -- --dry-run --id 91
npm.cmd run content -- --generate --id 91
```

The content stage selects `image_done` posts by default. Dry-run mode writes `content_jobs` rows and `content_manifest.json` without calling Claude or changing post status. Generate mode calls Claude, writes a practical caption with intro, tools/materials, 3-5 numbered steps, a safety/pro note, CTA, and hashtags, then validates it before moving the post to `content_done`. If the caption fails the guard, the post returns to `image_done` for a retry.

Run the generic post/image quality guard after content generation:

```powershell
npm.cmd run qa -- --dry-run --id 91
npm.cmd run qa -- --run --id 91
```

The QA stage selects `content_done` posts by default. Dry-run mode records local image/caption checks only. Run mode combines local checks with Claude vision/text review of the generated image, topic, prompt, and caption. Passing posts move to `qa_done`; `review_needed` or `blocked` verdicts move the post to `review_needed` with the QA reason. Facebook scheduling requires a fresh passed QA row whose image path and caption hash still match the post.

Verify Facebook page context before any scheduling:

```powershell
npm.cmd run facebook -- --dry-run --page "Fix It" --user-data-dir .browser-profile
npm.cmd run facebook -- --dry-run --all-pages --user-data-dir .browser-profile
```

If the persistent browser profile is not logged into Facebook yet, add a timed login window:

```powershell
npm.cmd run facebook -- --dry-run --page "Fix It" --user-data-dir .browser-profile --login-wait-sec 180
```

The Facebook context dry-run verifies page context only. It does not create, upload, post, or schedule. It records `facebook_page_context_checks` rows, writes `facebook_context_checks.json`, and saves screenshots under `facebook_context_diagnostics/`. Live scheduling requires a recent `verified` check for the target page before using the existing Content Library posting flow.

Prepare a QA-passed post for Facebook scheduling:

```powershell
npm.cmd run facebook -- --prepare --id 91 --next-slot
npm.cmd run facebook -- --prepare --id 91 --date 2026-06-30 --time 15:00
```

`--prepare` writes `scheduled_date` and `scheduled_time` only after the existing caption passes the useful-content guard and the post has a fresh passed post/image QA check. `--next-slot` uses the default next-day slot from config. It no longer builds placeholder hook/topic copy.

Run the scheduling handoff dry-run:

```powershell
npm.cmd run facebook -- --schedule-dry-run --id 91
```

The schedule dry-run requires a generated image file, a quality-passing caption, a fresh passed post/image QA check, and a recent verified page-context check. It writes a `facebook_schedule_jobs` row with `status = dry_run`; it does not open the Facebook composer or click Schedule.

Live Facebook scheduling is guarded to one post:

```powershell
npm.cmd run facebook -- --live --id 91 --user-data-dir .browser-profile --login-wait-sec 180
```

Live mode re-verifies the target Facebook page context in the same browser session before using the existing engagement/promo image-post uploader. It also refuses thin captions unless `--allow-thin-caption` is passed for a deliberate automation test. It marks the post `scheduled` only after the uploader confirms a matching scheduled row in Content Library.

`raw_topics` merges exact duplicate titles while preserving `sources`, `source_count`, `signal_count`, and per-source `signals`, so Claude can still see cross-source evidence.

Reddit scraping uses `/top/?t=month`, captures title/upvote/comment signals, skips pinned/mod-like posts, and requires at least 100 upvotes by default. Each niche has three primary subreddits and two backups; backups are only opened when primary subreddits do not provide enough usable items.

Google Trends scraping runs two seed keywords per niche against `geo=US` and `date=now 7-d`. It targets Related Queries -> Rising, falls back to Top when Rising is thin, treats `Breakout` as engagement `999`, preserves the seed/section/tab/value metadata, and skips the seed with a warning if Trends does not render.

Pinterest scraping runs three terms per niche. Each term captures search autocomplete suggestions plus the first pin-title results after one scroll pass, using `pinterest_autocomplete` and `pinterest_pins` source labels.

YouTube scraping uses a fresh browser context by default and captures autocomplete only. Each niche runs three seed variations, types each seed slowly with a trailing space, and records `youtube_autocomplete` signals with seed and suggestion position metadata.

Quora scraping runs two topic pages plus two question-search queries per niche. It keeps only clean question titles ending in `?`, uses `quora_topic` and `quora_search` source labels, and treats those titles as hook-writing fuel rather than numeric engagement.

Use `npm.cmd run batch -- --live ...` for weekly live scheduling only after checking the dry selection. The first live scheduled Fix It post (`#91`) proved the browser/scheduler path but used placeholder copy and was later deleted/test-marked; production posts now require content generation plus the passed QA row before scheduling.
