# Nollywood AI Drama Pipeline — Project Knowledge

This file persists operational knowledge across sessions. Read this before making any changes to the codebase.

## What This App Does

Electron desktop app that automates AI-generated Nollywood dramas end-to-end: YouTube research → Gemini analysis → Codex script generation → Higgsfield image/video generation → FFmpeg assembly into a final 4K video.

## Complexity Profile & Failure Risk

Complexity level: **very high**. Treat this as a long-running, stateful production automation robot with an Electron UI, not as a normal desktop CRUD app. The difficult part is not any single module; it is keeping local SQLite state, files on disk, LLM outputs, browser automation, external web UIs, credit spend, verification gates, and FFmpeg assembly aligned across multi-hour runs.

Operational complexity is roughly **8.5/10 for implementation** and **9.5/10 for live runs**. The largest files reflect this coordination burden: `orchestrator.js`, `higgsfield.js`, `cinema-studio-automation.js`, `index.html`, and `script-engine.js` contain most of the hard-won recovery and edge-case logic.

Primary failure points:
- **Higgsfield/Cinema Studio UI automation drift:** duplicate toolbars, wrong Image/Video mode, stale React state, `@` element contamination, hidden upload controls, filechooser quirks, and controls that visually appear set before backend state is actually valid.
- **Credit-burning mistakes:** wrong model, wrong mode, wrong resolution, missing start frame/reference, malformed prompt, inflated credit cost, or stale references can waste paid generation credits. Preserve hard pre-generation gates.
- **State consistency:** SQLite asset rows must match real files. Crashes, partial downloads, duplicate/stale rows, missing files marked `done`, and orphaned remote generations are expected operational hazards.
- **Model-output validity:** Script JSON, outline coverage, outfit IDs, cinematic clip constraints, prompt length, character limits, and structural review results all need validation because LLM output can drift or truncate.
- **Long-run scale:** Prestige/cinematic runs amplify token limits, voice drift, generation time, asset count, retry volume, FFmpeg temp storage, and session/credit exhaustion.
- **Verification blind spots:** Vision and clip verification reduce risk but do not fully replace human judgment for character identity, scene quality, framing, accent drift, prop continuity, or story strength.
- **Partially validated branches:** Cinema Studio 3.5 video branch was syntax-validated but still requires a live one-clip Higgsfield run before trusting toolbar setup, eligibility detection, ledger confirmation, download/recovery, verification, and assembly.

Default engineering posture: make small scoped changes, preserve existing gates, test with the cheapest duration/one-clip path first, and avoid bypassing recovery logic unless the user explicitly accepts the credit and quality risk.

## Current Production Status

2026-06-18 update: the prior bedtime handoff is closed. The current SCWOB production run ("She Chose Wealth Over Blood -- Abuja Changed Her | Nigerian AI Film") has been resumed and is in progress. Treat live terminal logs, SQLite, and project files as the source of truth for exact stage and asset counts. Do not treat the old "resume later" handoff as active. Keep Cinema Studio 3.5 safeguards active: do not spend new scene-image or video credits unless the existing Generate-click, recovery, eligibility, and pre-Generate gates prove it is safe.

2026-06-19 bedtime handoff: SCWOB remains the active production project (`2026-06-15_b904d6af`, title "She Chose Wealth Over Blood — Abuja Changed Her | Nigerian AI Film") at DB stage `scenes-done`. Read SQLite again on resume, but the last confirmed DB snapshot showed 44 `scene_image_cinematic` rows done, 136 `video_clip_cinematic` rows pending, and zero video-start proof (`gen_clicked_at`, `source_gen_id`, `file_path`, `cdn_url`, or done video rows all absent). The live issue is Cinema Studio 3.5 pre-Generate element eligibility for Barrister Tunde (`character_4`): persisted repair attempts were `@barrister_tunde_o1_scwob_0615 = 3` and `@barrister_tunde_o2_scwob_0615 = 3`; `_cinemaFaceIpRecasts.character_4.status` was `eligibility-pending`; pending gate was `cinema-eligibility-failed`; no recast scene-image rows had been tagged yet. Latest code commits before handoff: `f02cefa Harden Face/IP recast differentiators` and `5bd4e04 Raise Cinema element repair retry cap`. On restart, the new 6-attempt cap should continue ordinary delete/recreate/check repair from attempt 4/6 for the failed Tunde elements, not immediately recast from the stale `eligibility-pending` state. If attempts 4-6 do not make all Tunde outfit elements eligible, automatic Face/IP recast is still allowed because video has not started; after recast eligibility passes, only Tunde-containing scene images should be reset/regenerated before video generation. Do not click video Generate until element eligibility and scene-image recast prerequisites pass.

2026-06-19 production restart monitoring update: User restarted the Electron app around 11:10 AM America/Toronto and requested full log monitoring. Process check showed `npm start`, Electron, and renderer processes running from this repo. AppData SQLite was updated at startup, but repo `live-app.out.log` / `live-app.err.log` and `.current-live-*` pointer files were stale from 2026-05-26 and contained old BOTMF output; do not treat those files as live SCWOB logs unless their `LastWriteTime` changes. With no Codex-attached terminal for this app process, monitor production using read-only SQLite snapshots, Electron/process liveness, AppData DB `LastWriteTime`, and any newly discovered fresh log path. First post-restart DB snapshot still matched the bedtime state: `scenes-done`, 44 scene images done, 136 video clips pending, zero video-start proof, Tunde o1/o2 repair attempts at 3/6, `_cinemaFaceIpRecasts.character_4.status = eligibility-pending`, pending gate `cinema-eligibility-failed`, and no recast-tagged scene-image rows yet.

2026-06-19 production monitoring follow-up: By the next DB snapshot after restart, `pending_approval_gate` had cleared and `video_clip_cinematic` asset id 2509 (Ch1 Sc1 line 1) was marked `generating`, while `gen_clicked_at`, `source_gen_id`, `file_path`, and `cdn_url` were still null for all video clips (`started = 0`). Recent `pipeline_events` showed `session_start` at `2026-06-19 15:13:34` UTC and `stage_start` video at `2026-06-19 15:14:06` UTC, but no later asset completion/failure/recast event yet. Interpret this as the video loop entering pre-generation setup, not proof that Higgsfield Generate was clicked. Continue monitoring for: repair attempts moving from 3/6 to 4/6, `_cinemaFaceIpRecasts.character_4.status` changes, recast-tagged scene-image rows, or any first video `gen_clicked_at`/`source_gen_id` proof.

2026-06-19 production monitoring proof: A later DB snapshot at `2026-06-19T15:22:43Z` showed the new 6-attempt repair cap is active: `@barrister_tunde_o1_scwob_0615` advanced from `3` to `4/6` with `updatedAt = 2026-06-19T15:21:54.445Z`, while `@barrister_tunde_o2_scwob_0615` remained at `3/6`. The first video row remained `generating` with `gen_clicked_at/source_gen_id/file_path/cdn_url = null`, so still no video Generate proof. Continue watching for o1 attempt 5/6 or eligible clear, then o2 moving to 4/6, recast trigger at 6/6, or first video generation proof.

2026-06-19 production monitoring proof 2: DB snapshot at `2026-06-19T15:24:54Z` showed `@barrister_tunde_o1_scwob_0615` advanced to `5/6` (`updatedAt = 2026-06-19T15:23:50.481Z`), while `@barrister_tunde_o2_scwob_0615` remained `3/6`. `video_clip_cinematic` id 2509 was still only `generating`; all video proof fields remained null (`started = 0`). App processes were alive/responsive and AppData SQLite `LastWriteTime` continued moving. Continue monitoring for o1 6/6 leading to recast, o1 eligibility clearing its attempts, or o2 beginning repair.

2026-06-19 production monitoring proof 3: DB snapshot at `2026-06-19T15:27:23Z` showed `@barrister_tunde_o1_scwob_0615` reached `6/6` (`updatedAt = 2026-06-19T15:25:54.905Z`), while `@barrister_tunde_o2_scwob_0615` remained `3/6`. At that snapshot `_cinemaFaceIpRecasts.character_4.status` was still the old `eligibility-pending` value and no recast scene-image rows existed yet. Video id 2509 remained `generating` with all Generate proof fields null. Watch the next snapshots closely: expected outcomes are recast state changing to `delete-pending`/`assets-pending`/`elements-pending`, o1 attempts clearing if it becomes eligible, or o2 entering repair.

2026-06-19 production monitoring proof 4: DB snapshot at `2026-06-19T15:29:05Z` confirmed the expected recast transition. `_cinemaFaceIpRecasts.character_4.status` changed to `delete-pending`, `failedElementName = barrister_tunde_o1_scwob_0615`, and `elementNames` contained all three Tunde outfits (`o1/o2/o3`). This means the 6/6 cap correctly moved from ordinary repair into the pre-video Face/IP recast path. At that snapshot, video id 2509 was still only `generating` and all video Generate proof fields were null. Next expected states are deletion of the Higgsfield elements, `assets-pending`, asset archive/regeneration, then `elements-pending` / eligibility re-check.

2026-06-19 production monitoring proof 5: DB snapshot at `2026-06-19T15:31:13Z` showed recast advanced to `assets-pending`. Counts proved local recast reset began: `character_grid` changed to 9 archived / 16 done / 3 pending, `portrait` changed to 3 archived / 7 done / 1 generating. Recent event id 2739 logged `face_ip_recast_description` at `2026-06-19 15:29:39` UTC. Video id 2509 remained only `generating` with all Generate proof fields null. Next expected states: master portrait finishes, outfit portraits/grids regenerate, recast state becomes `elements-pending`, then Tunde elements are recreated and eligibility is checked before any scene-image reset or video Generate.

2026-06-19 production monitoring proof 6: Recast then moved to `elements-pending` with master portrait row done (`portrait_character_4.png`, `gen_clicked_at = 2026-06-19 15:33:03`). The three new Tunde `character_grid` rows still showed `pending`/null file paths in DB, but this is expected while `_runCinematicElementSetup()` generates untracked outfit portrait files before grids. Disk inspection later showed `assets/portraits/portrait_character_4_o2.png` created at 11:42:40 AM local time, proving the browser automation was still advancing through outfit portrait generation even though DB aggregate counts were quiet. Continue watching for `portrait_character_4_o3.png`, then `character_4_o1/o2/o3_grid.png` files and DB grid rows turning done.

2026-06-19 production monitoring proof 7: DB snapshot at `2026-06-19T15:49:21Z` showed fresh recast grid generation had entered tracked state: `character_grid` counts were 9 archived / 16 done / 1 generating / 2 pending, with new row id 2734 (`character_4_o1`) `generating` and rows 2735/2736 (`character_4_o2/o3`) still pending. Disk inspection confirmed all recast portrait inputs now exist: `portrait_character_4.png` (11:34:10 AM local), `portrait_character_4_o2.png` (11:42:40 AM), and `portrait_character_4_o3.png` (11:48:45 AM). No `character_4*_grid.png` files existed yet at that inspection. Video proof was still zero: 136 clips total, `gen_clicked_at/source_gen_id/file_path/cdn_url = null` for all clips, with only video id 2509 marked `generating` as pre-generation orchestration state. Continue monitoring for the three grid files/DB rows, recreated Tunde element names, eligibility re-check, then recast scene-image reset/regeneration before any real video Generate click.

2026-06-19 production monitoring proof 8: DB snapshot at `2026-06-19T15:52:17Z` showed row 2734 (`character_4_o1`) still `generating`, now with `gen_clicked_at = 2026-06-19 15:52:03`, proving the recast o1 grid image generation was submitted. Rows 2735/2736 (`character_4_o2/o3`) remained pending and no `character_4*_grid.png` files had reached disk yet. Electron and Playwright Chromium were alive and responsive with increasing CPU counters. Video proof remained zero for all 136 clips (`gen_clicked_at/source_gen_id/file_path/cdn_url` all absent), so the app is still pre-video despite video row 2509 being marked `generating`.

2026-06-19 production monitoring proof 9: DB snapshot at `2026-06-19T15:54:42Z` showed row 2734 (`character_4_o1`) completed: status `done`, file path `assets/grids/character_4_o1_grid.png`, file exists true; disk LastWriteTime was 11:53:09 AM local. Row 2735 (`character_4_o2`) moved to `generating`; row 2736 (`character_4_o3`) remained pending. Counts became 9 archived / 17 done / 1 generating / 1 pending for `character_grid`. `_cinemaFaceIpRecasts.character_4.status` remained `elements-pending`, as expected while the remaining grids and Higgsfield element recreation are still underway. Video proof remained zero.

2026-06-19 production monitoring proof 10: DB snapshot at `2026-06-19T15:57:00Z` showed row 2735 (`character_4_o2`) still `generating`, now with `gen_clicked_at = 2026-06-19 15:56:16`, proving the recast o2 grid generation was submitted. Disk still had only `character_4_o1_grid.png`; no o2/o3 grid file yet. Row 2736 (`character_4_o3`) remained pending. Video proof remained zero and all processes were alive/responsive.

2026-06-19 production monitoring proof 11: DB snapshot at `2026-06-19T15:59:19Z` showed row 2735 (`character_4_o2`) completed: status `done`, file path `assets/grids/character_4_o2_grid.png`, file exists true; disk LastWriteTime was 11:57:24 AM local. Row 2736 (`character_4_o3`) moved to `generating`, so it is now the final recast grid before Tunde element recreation. `character_grid` counts were 9 archived / 18 done / 1 generating. Video proof remained zero.

2026-06-19 production monitoring proof 12: DB snapshot at `2026-06-19T16:01:34Z` showed row 2736 (`character_4_o3`) still `generating`, now with `gen_clicked_at = 2026-06-19 16:00:33`, proving the recast o3 grid generation was submitted. Disk still showed only o1/o2 grid files at that inspection. Video proof remained zero.

2026-06-19 production monitoring proof 13: DB snapshot at `2026-06-19T16:03:51Z` showed all three recast Tunde grids completed. `character_grid` counts were 9 archived / 19 done, with no active grid rows. New rows 2734/2735/2736 were all `done`, pointed at `assets/grids/character_4_o1_grid.png`, `character_4_o2_grid.png`, and `character_4_o3_grid.png`, and all files existed on disk. Disk LastWriteTimes: o1 11:53:09 AM, o2 11:57:24 AM, o3 12:01:37 PM local. `_cinemaFaceIpRecasts.character_4.status` remained `elements-pending`; next expected work is recreating the three Higgsfield elements from the new portrait/grid pairs, then rerunning eligibility before any scene-image reset/regeneration. Video proof remained zero.

2026-06-19 production monitoring proof 14: DB snapshot at `2026-06-19T16:08:11Z` showed element recreation completed and eligibility re-check began. Fresh recast rows 2734/2735/2736 now have `element_name` populated again as `barrister_tunde_o1_scwob_0615`, `barrister_tunde_o2_scwob_0615`, and `barrister_tunde_o3_scwob_0615`; portrait row 2733 also has the o1 element name. `_cinemaFaceIpRecasts.character_4.status` moved from `elements-pending` to `eligibility-pending` with `updatedAt = 2026-06-19T16:06:58.085Z`, and `projects.updated_at` moved to `2026-06-19 16:07:51`. This proves the recast path reached the eligibility gate after recreating the Tunde elements. No recast scene-image rows existed yet, which is expected until eligibility passes. Video proof remained zero.

2026-06-19 production monitoring proof 15 / current gate: DB snapshot at `2026-06-19T16:10:30Z` showed the recast eligibility re-check failed after recreation. `_cinemaFaceIpRecasts.character_4.status = failed`, reason `face-ip-recast-eligibility-failed`, `updatedAt = 2026-06-19T16:09:21.291Z`, with unresolved elements `barrister_tunde_o1_scwob_0615` and `barrister_tunde_o2_scwob_0615` both `not-eligible`; o3 was not listed unresolved. The app set `pending_approval_gate = cinema-eligibility-failed`, and video row 2509 was reset from `generating` back to `pending`. All 136 video clips are pending and video proof is still zero (`gen_clicked_at/source_gen_id/file_path/cdn_url` absent for every clip). No recast scene-image rows were reset because eligibility did not pass. Current human-facing state is a pre-video eligibility failure gate after a completed Face/IP recast attempt, not a video generation start.

2026-06-19 identity-lock implementation note: Tunde's failed recast exposed outfit-to-outfit identity drift, especially outfit o2. The intended chain is master/o1 portrait from permanent description, o2/o3 outfit portraits from the master portrait plus permanent description and outfit text, then one grid and element per outfit. The code now persists `character.identity_lock` during Face/IP recast, sanitizes over-stylized skin wording such as blue-black/silver into natural dark-brown wording, and injects the compact identity lock into master portrait, outfit portrait, grid, and element description prompts. The current live Electron process was already running before this code change; restart the app before expecting the new identity-lock recast behavior to run.

2026-06-19 hard-persona recast update: if a completed automatic Face/IP recast still fails Higgsfield eligibility (`_cinemaFaceIpRecasts[characterId].status = failed`, reason `face-ip-recast-eligibility-failed`) and video generation has not started, the next repair escalates to `recastMode: hard-persona`. This intentionally abandons the old facial identity instead of adding more markers to the same face: clear old `identity_lock`/`face_ip_identity_lock`, preserve only story-safe anchors (same gender/pronouns, role/name/id, broad age, ethnicity/nationality, body type, and outfit compatibility), generate the new master/o1 portrait from text only (`references: []`), then rebuild outfit portraits, grids, elements, eligibility, and only then recast scene images if eligibility passes. This is still blocked once any video clip has real generation proof.

2026-06-19 production restart after hard-persona commit `cbed2a0`: user restarted prod around 1:22 PM America/Toronto and requested full monitoring. App process proof showed fresh `npm start`/Electron PIDs from this repo and AppData SQLite updated at 1:22 PM. No Codex-attached terminal and no useful fresh project `logs` files were available, so monitor via SQLite, process liveness, AppData DB `LastWriteTime`, and asset files. DB snapshots at `2026-06-19T17:23:02Z`, `17:25:08Z`, and `17:28:18Z` showed `pending_approval_gate` cleared, `stage = scenes-done`, first video row id 2509 marked `generating`, but video proof stayed zero (`gen_clicked_at`, `source_gen_id`, `file_path`, `cdn_url` all null for all 136 video clips). Playwright Chromium launched by the `17:25Z` pulse. Tunde Face/IP recast state was still the prior `failed` / `face-ip-recast-eligibility-failed` state through `17:28Z`; hard-persona transition had not yet appeared. Continue watching for `_cinemaFaceIpRecasts.character_4.recastMode = hard-persona` with `delete-pending`/`assets-pending`, or any first video proof, which should remain blocked until eligibility and recast scene-image prerequisites pass.

2026-06-19 post-close diagnosis after hard-persona restart: user closed the app at the pre-Generate eligibility-repair stage because the terminal log looked wrong. The close was safe and no video credits were spent. Post-close DB snapshot showed `stage = scenes-done`, all 136 `video_clip_cinematic` rows `pending`, and zero video proof (`gen_clicked_at`, `source_gen_id`, `file_path`, `cdn_url`, and done video rows all absent). The first video row had only been marked `generating` as orchestration state and was reset to `pending` on graceful shutdown. The log shows the app opened Cinema Studio 3.5, attached the Ch1 Sc1 start frame, then checked eligibility across all project elements before any Generate click. It found 7 not eligible elements: `sewa_o4`, `mama_yetunde_o1/o2`, `rotimi_o1/o2`, and `barrister_tunde_o1/o2`. Repair processed the global failure list in order, so it attempted `sewa_o4` and then began deleting/recreating `mama_yetunde_o1` before reaching Tunde's persisted failed Face/IP recast state. This ordering is the gap: on restart, a persisted failed Face/IP recast should be prioritized into the hard-persona path before broad unrelated all-element repair. Startup `DB CRITICAL: Locked asset ... file missing` warnings referenced archived locked grid rows from earlier recasts, not active current grid rows; they are noisy/scary and should be downgraded or scoped to active rows only. The `TEMP: Cinema Studio 3.5 prompt preview gate disabled until Verify gate` log is concerning wording but did not bypass the start-frame or element eligibility pre-Generate gates in this run.

2026-06-19 element eligibility detector correction: the live Higgsfield grid shows many usable character cards as just `@name` plus `Character` with a green badge, and no hover `Use` text unless the cursor is exactly over the card. Treat a matched character tile with no explicit status text as eligible/eligible-visual. Only explicit `Not eligible` is a failure, while `Check eligibility` or `Face/IP checking` means click/wait. Do not delete or recreate elements merely because hover `Use` proof was not captured.

2026-06-19 production restart after commit `fefe61d`: user restarted prod around 1:43 PM America/Toronto and requested full monitoring. Process proof showed fresh `npm start`, Electron, and Playwright Chromium PIDs from this repo. No Codex-attached terminal is available, so monitor via SQLite, process liveness, AppData DB `LastWriteTime`, and project asset files. The quiet-tile eligibility fix worked: the app did not continue repairing Sewa/Mama/Rotimi plain `Character` tiles; it reached Tunde's explicit `Not eligible` elements and escalated `_cinemaFaceIpRecasts.character_4` to `recastMode = hard-persona`, `hardPersonaAttempt = 1`. At DB snapshot `2026-06-19T17:51:10Z`, state was `assets-pending`: old Tunde portrait/grid rows archived, new portrait row 2737 `generating`, new grid rows 2738/2739/2740 pending. At `2026-06-19T17:54:52Z`, portrait row 2737 gained `gen_clicked_at`, proving the new hard-persona master portrait was submitted. All 136 `video_clip_cinematic` rows still had zero video proof (`gen_clicked_at`, `source_gen_id`, `file_path`, `cdn_url`, and done rows absent); video row 2509 remained only orchestration-`generating`.

2026-06-19 production monitoring continuation after `fefe61d`: master hard-persona portrait `assets/portraits/portrait_character_4.png` completed at about 1:55 PM local and DB row 2737 is `done`, while `_cinemaFaceIpRecasts.character_4.status` moved to `elements-pending`. The generated master is a new persona but reads slimmer/younger than intended and its scar/tribal-mark anchors are weak. At about 2:04 PM local, `assets/portraits/portrait_character_4_o2.png` appeared on disk before a DB flush; visual inspection showed strong identity drift from the master (younger/slimmer, different face/beard, no useful visible marks). As of DB pulse `2026-06-19T18:09:15Z`, SQLite still showed the three new Tunde `character_grid` rows 2738/2739/2740 as `pending`, no new grid files were present, `pending_approval_gate` was null, and video proof was still zero. The prompt-builder issue is that `_buildFaceIpIdentityLock()` can emit truncated identity clauses such as `long-bri...`, duplicates traits, and lets important body/mark anchors get diluted; future fix should build a compact non-truncated identity lock with complete clauses and front-loaded body/face/mark anchors.

2026-06-19 Face/IP recast scene-row fix: after a character recast reaches scene regeneration, do not run the broad cinematic scene stage by chapter/scene inference alone. Re-query DB and pass exact recast replacement `scene_image_cinematic` row ids into targeted scene regeneration, skip disk recovery for those rows, and keep recursive auto-recovery in the same exact-row scope. If an old active non-target row exists for the same recast scene, fail the DB proof instead of regenerating or recovering from the stale row. Live SCWOB data fix archived stale Ch1 Sc3 row 2516 and left only recast-tagged rows 2741-2744 active/pending, with zero video proof. Reference upload was also hardened to prefer hidden image input with backend proof before any visible Upload click, and the visible fallback must not click broad labels like `FilterViewUpload`.

2026-06-19 recast scene marker recovery gap: a restart while a recast scene row is `generating` can reset it to `pending` and overwrite `error_message` with generic `Reset after app shutdown/crash`, erasing the `face-ip-recast:<characterId>` marker even though `_cinemaFaceIpRecasts[characterId].resetProof` still names the exact replacement row id. This caused SCWOB row 2741 (Ch1 Sc3) to fail the pre-video DB proof as "no active recast-tagged pending scene row" while video proof was still zero. DB crash recovery must preserve existing `face-ip-recast:*` markers, and recast scene resume must restore erased markers from persisted `resetProof` before asserting row scope or regenerating targeted scene images.

2026-06-19 Windows SQLite save lock: live SCWOB restart hit `EPERM: operation not permitted, rename ... nollywood-pipeline.sqlite.tmp -> nollywood-pipeline.sqlite` immediately after startup/video-boundary DB writes. This is a transient Windows file-lock failure on the atomic save path, likely made easier to hit by external monitoring snapshots opening the SQLite file while Electron tried to replace it. `db.save()` now retries the atomic rename on `EPERM`/`EBUSY`/`EACCES`/`ENOTEMPTY` before surfacing a pipeline error. During production monitoring, keep DB polling lower-frequency around app startup and prefer process/mtime pulses between SQLite reads.

2026-06-19 Cinema reference picker root fix: SCWOB recast scene regeneration proved the bottom composer `+` can correctly open the reference/media picker while the next Uploads-tab step still fails with `REFERENCE_PICKER_TAB_NOT_FOUND: no reference picker root`. The picker-open proof recognized a real panel via `role=listbox` / dropdown / overlay selectors (`UploadsElementsImage GenerationsLikedUploadsFilterUpload media`), but the Uploads-tab root finder used a narrower selector set. Keep these selector families aligned, and treat an already-open picker with `Uploads` + `Upload media` visible as Uploads-active instead of resetting browser context.

2026-06-19 Cinema reference picker simplification: after further live proof, do not use modal-root or Uploads-tab recognition as a blocking condition after the bottom composer `+` is clicked. The visible picker can be open and usable while DOM root matching is brittle. Current rule: click the verified bottom `+`, wait 3 seconds, log picker state as diagnostic only, set the hidden image file input directly, then hard-gate on backend upload proof plus selected/attached reference thumbnail before any Generate click. Never click visible `Upload media`, because it can open the native Windows file chooser.

2026-06-20 Cinema video early recovery note: Cinema Studio 3.5 tiles/lifecycle labels can be unreliable after a paid Generate click, while the finished video may already be visible in Asset Library. After credit spend is confirmed, the video wait loop may run bounded quick Asset Library probes at conservative intervals (currently 5/7/9/11 minutes) using the same strict prompt-similarity and dialogue-match checks as timeout recovery. A probe miss is not a failure and must not trigger a retry or another Generate click; it simply continues the normal lifecycle wait. Preserve all pre-Generate gates, and keep the existing full timeout recovery path as the backstop.

2026-06-20 Cinema video early recovery live proof: SCWOB one-clip test validated the bounded Asset Library probe. Clip row 2522 (`ch2_sc1_c2_cinematic`) recorded a paid Generate click at `2026-06-20 05:01:16` UTC, the 5-minute probe opened `higgsfield.ai/asset/video/...`, matched the submitted prompt/dialogue, downloaded `assets/clips/ch2_sc1_c2_cinematic.mp4` at about 1:06 AM local, and DB proof advanced to 11 done / 125 pending with `source_gen_id`, `file_path`, and `cdn_url` populated. User closed the app immediately after the test; the next clip row 2524 remained pending with no `gen_clicked_at`, proving no accidental second paid generation.

2026-06-20 continuation note: resume SCWOB production later from commit `f4e0e75` (`Probe Cinema video assets after confirmed spend`). Live monitoring was paused at `2026-06-20 14:08:38 UTC` while the app was still running. Current DB snapshot: project stage `scenes-done`, no pending gate, `video_clip_cinematic` counts 19 done / 1 generating / 116 pending, proof totals `started=19`, `gen_clicked=19`, `source_gen=19`, `file_or_cdn=19`. Latest completed clip is `assets/clips/ch3_sc1_c3_cinematic.mp4` (row 2533, saved about 10:04 AM local). Active row is 2534 (`ch3_sc1_line10`) with `status=generating` but no `gen_clicked_at`, `source_gen_id`, or `file_path`, so it was still pre-Generate/pre-spend at the pause point. On restart or follow-up, first check whether row 2534 later crossed Generate; if it has a `gen_clicked_at`, monitor bounded Asset Library probes at 5/7/9/11 minutes and normal recovery. If it still has no `gen_clicked_at`, monitor setup through the pre-Generate gates before any spend.

2026-06-20 Cinema Studio refund-state fix: a usage-history pair of `52.5 Spent` plus matching `+52.5 Refunded` for the same Cinema Studio 3.5 submit means the clip is **not recoverable** from Asset Library. Clear submitted metadata (`gen_clicked_at`, `prompt_used`, `credit_cost`, source/CDN/file) and retry cleanly with a `[GEN-REFUNDED]` audit marker. Do not infer a refund merely from a recovery miss; require visible refunded failure state or a matched ledger refund row. Also, `prompt_used` alone is not proof of a paid video submit because it is persisted before Generate; recovery proof is `gen_clicked_at` or legacy `credit_cost + prompt_used`.

2026-06-20 Cinema prompt composer hardening: before typing a Cinema Studio video prompt, clear the composer and verify there are no stale mention chips. Strict `@` chip audit must compare against the full prompt's expected mention names, not only the mention currently being typed, because multi-character prompts can legitimately include other characters later in the prompt. Higgsfield's DOM can duplicate chip nodes, so do not fail on over-counted expected chips; log duplicate counts as warnings. Still reject unexpected chip names and missing expected names. Ordinary Cinema pre-Generate setup failures must retry the same clip autonomously after clearing stale metadata/context; do not pause for human intervention, and do not advance past a missing clip.

2026-06-20 Cinema composer DOM scoping fix: Higgsfield can keep hidden/stale editor nodes mounted after a prior clip. A visually empty prompt composer can still coexist with old `@` mention chips elsewhere in the DOM, so audit/clear/read logic must resolve the active visible bottom Cinema Studio composer, tag it with `data-cinema-prompt-target="typing"`, and inspect only chips inside that composer. Page-wide chips outside the active composer are diagnostic noise only; unexpected visible chips inside the active composer remain a hard pre-Generate failure.

2026-06-18 element-repair safety note: live SCWOB video eligibility repair exposed that truncated Higgsfield element labels can make card-menu deletion ambiguous across sibling outfit elements. Destructive element repair must not delete directly from the grid card by truncated text. The safe flow is: hover the target card, open the card menu, click View, require the Element detail modal to show the exact full element name, require the grid card status to be Not eligible, then click Delete from the confirmed detail modal. If exact modal-name proof is unavailable, stop repair for that element instead of deleting.

2026-06-18 follow-up: Higgsfield eligibility can flip from stale Not eligible to hover `Use`/eligible-visual after the failure list is built. Before deleting/recreating a visible element, repair code must re-check current eligibility. If the card now shows eligible/Use, mark it repaired and skip deletion; do not keep retrying destructive repair from the stale failure status.

2026-06-18 Face/IP recast repair: Cinema Studio video element eligibility repair now has a bounded off-ramp. Failed delete/recreate attempts are persisted in project `settings._cinemaElementRepairAttempts`, keyed by exact element name, so app restarts do not reset the cap. After 6 cumulative failed repair attempts for a character element, the pipeline treats it as Face/IP recast required. Automatic recast is allowed only before video generation starts; if any `video_clip_cinematic` row has `gen_clicked_at`, `source_gen_id`, `file_path`, `cdn_url`, or `done` status, recast is blocked and the existing human eligibility gate is emitted. In the pre-video path, the automation safely deletes all outfit elements for the affected character from Higgsfield first, rewrites the character `physical_description` with a fictional/no-public-figure caveat, persists `script.json` and DB `script_json`, regenerates the master portrait, outfit portraits, grids, and character elements, re-runs eligibility, then archives/regenerates only scene images containing that character and clears pre-video clip metadata tied to those scenes. Do not delete or regenerate video files as part of automatic recast.

## Architecture

- **Main process** (Node.js): `src/main/main.js` — IPC handlers, Electron lifecycle
- **Renderer** (HTML/JS): `src/renderer/index.html` — single-page dashboard UI
- **Preload bridge**: `src/preload/preload.js` — IPC bridge between renderer and main
- **BrowserView**: Embedded Playwright Chromium for Higgsfield automation

### Key Modules

| Module | Path | Purpose |
|--------|------|---------|
| Orchestrator | `src/main/pipeline/orchestrator.js` | Pipeline state machine, stage sequencing, approval gates, research cache, duration presets |
| ScriptEngine | `src/main/pipeline/script-engine.js` | Codex API calls for titles + scripts, research context sanitization, title similarity scoring, `_safeParseScriptJson()` multi-strategy JSON recovery |
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
- API keys (Codex, Gemini)
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

1. **Pre-flight**: Ping Codex + Gemini APIs
2. **Research**: YouTube search → Gemini analysis → cache results (7-day TTL)
3. **Script**: Codex generates title candidates → user approves → Codex generates full screenplay JSON
4. **Portraits**: Higgsfield Nano Banana Pro (Unlimited mode, free) for character reference sheets
5. **Scenes**: Higgsfield image gen with reference chaining (character portraits + previous scene)
6. **Video**: Higgsfield Veo 3.1 Lite — 12 credits/clip, 8s at 720p
7. **Assembly**: FFmpeg trims → branding cards → concat → 4K upscale (lanczos)

## Project State Lifecycle

A story has NO abandon concept — once started, it always resumes until assembly completes. Credits running out just pauses progress; the project waits for the user to come back.

**Stages** (in order): `research-done` → `title-chosen` → `script-done` → `portraits-done` → `scenes-done` → `videos-done` → `assembled`

**Project root folder naming (Session 2026-06-02):**
- New projects are initially created as `YYYY-MM-DD_<8-char-uuid>` because the title is not known during research setup.
- Immediately after title approval, `orchestrator.js::_ensureProjectDirIncludesTitle()` renames the root folder to `YYYY-MM-DD_<8-char-uuid> - <script title>` and updates `projects.project_dir`, `this.state.project.dir`, `project.json`, Higgsfield automation, and the assembler to use the renamed path.
- Windows-illegal filename characters in titles (`<>:"/\|?*` and controls) are sanitized to ` - `. Example UI title `THE MAN I CHOSE OVER GOD | AI Nollywood Short Film` becomes the folder segment `THE MAN I CHOSE OVER GOD - AI Nollywood Short Film`.
- Existing projects with asset rows are not auto-renamed, because absolute asset paths may already be persisted in SQLite. Do not bulk-rename old project roots without also migrating all DB file paths and checking disk files.

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

The research pool is analyzed once and the resulting pattern library (themes, archetypes, settings, tones, audience triggers) is reused across **unlimited stories** until the 7-day TTL expires. Videos are never "consumed" — variety comes from Codex picking different theme combinations each time, plus the title dedup system preventing repetition.

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
- **Tone**: **Per-line, not project-level.** Each `line.tone` in the script JSON (e.g. "Blissful", "Spiteful", "Terrified") is chosen by Codex based on the specific line's emotional beat, not locked for the whole story
- **Setting**: **Per-scene, not project-level.** Each `scene.location` + `scene.location_details` in the script JSON is chosen by Codex based on narrative need — a story can open in a Lagos high-rise, move to a village, visit a palace. The script-prompt includes an explicit clause telling Codex to use the research patterns as a palette, not a constraint (Session 8 fix — previously `_deriveSettingFromPatterns()` picked one setting from research and forced it project-wide, producing village-monoculture output)
- **Research patterns flow to Codex naturally** via the research summary in the system prompt (both title and script generation) — Codex picks settings and tones per-scene/per-line from what the research shows works
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

Character caps (staged only): test 2-3, standard 3-4, long-form 4-6, prestige 6-10.

1/2/5-min presets are kept for test runs when iterating on non-scripting features (Verify Clip, History Recovery, etc.) — they don't get the full structural review pressure because a bad test run only burns ~$0.80 instead of 2000+ credits.

### Prestige Tier — 45-Minute Duration (Session 30N — Implemented)

**Status:** ✅ Fully implemented across two sessions. Session 30N-A: wiring (presets, scaffolding, grading, renderer UI). Session 30N-B: engine (two-phase outline, voice anchors, validation).

**Why it exists:** Minimum production run is 30 minutes. A 45-minute option enables prestige long-form content — ensemble casts, dual B-plots, five-act structure — that the current long-form tier can't support without hitting context limits and quality drift.

**Preset definition (orchestrator.js):**
- Staged: 15 chapters × 3 scenes × 9 lines = 405 lines, ~3240+ credits
- Cinematic: ~245 target clips (2700 seconds ÷ 11), 12-15 chapters (story-driven), ~3000 credits
- Tier string: `'prestige'` via `getDurationTier()`, exported as `TIER_PRESTIGE` constant

**Five-act narrative structure (scaffolding):**
- Act I (ch 1-3): Setup — world + ensemble + dual story engines
- Act II (ch 4-6): Complications — A-plot and B-plots escalate, intersect
- Act III (ch 7-9): Midpoint crisis — major reversal that reframes everything, B-plot collision
- Act IV (ch 10-12): Unraveling — consequences cascade, alliances shift, highest tension
- Act V (ch 13-15): Climax + resolution — all threads converge, both B-plots resolve before main climax
- Ensemble: 6-10 characters with mandatory roles (protagonist, antagonist, 2 confidants, 2+ B-plot leads, 2+ supporting)
- 3+ setup/payoff pairs, dual B-plots (each with own mini-arc), no exposition dumps

**Two-phase outline generation (context limit mitigation) — IMPLEMENTED:**
The existing two-pass story-driven approach (Pass A outline → Pass B chapters) hits output token limits at 15 chapters. Prestige splits Pass A itself:
- Phase A1 (`_generatePrestigeOutline`, ~line 680): Arc skeleton — character bible, five-act beat structure, relationship arcs, setup/payoff pairs, dual B-plot summaries, thematic thesis. max_tokens=8192, ~5K output. Returns `five_act_beats` with 20/40/60/80% act boundaries matching scaffolding.
- Phase A2 (same method, ~line 880): Detailed chapter outlines in batches of 5 (3 calls for 15 chapters). Each batch gets compact character bible (outfits stripped to `outfit_count`) + relevant act beats + previous batch summaries as context. max_tokens=8192, ~5K output per batch.
- Phase B (`_generateStoryDriven` main loop, ~line 395): Each chapter generated independently using combined A1+A2 outline + voice anchors as context.
- Non-prestige path uses `_generateStandardOutline` (~line 542) — the original single-pass outline, unchanged.
- Gate: `tier === 'prestige'` at line ~377. Non-prestige flows through `_generateStandardOutline`.

**Voice anchors (drift mitigation) — IMPLEMENTED:**
`_extractVoiceAnchors()` (~line 972) runs for ALL story-driven scripts (not just prestige). Extracts from outline:
- 2-3 signature phrases per character from `speech_notes` + `speech_style` (with descriptive style mappings for 10 speech styles)
- `TONE_BASELINE` derived from emotional temperature distribution across chapters + story concept
- Injected as `=== VOICE_ANCHORS ===` block into every Phase B chapter prompt, between CHARACTER BIBLE and FULL STORY OUTLINE sections (~200-400 tokens per call)
- Includes drift prevention instruction: characters must never deviate from their voice signature

**Grading:**
- Pass threshold: 80 (staged), 85 (cinematic, +5 bump)
- Grader max_tokens: 16384 (vs 8192 for other tiers)
- Skeleton compression for prestige: strip animation_prompt, tone, location_details, truncate dialogue to first 6 words per line. If compressed skeleton > 40K tokens, split grading into Acts 1-3 (60% weight) + Acts 4-5 (40% weight).
- Rubric adds five-act scoring, dual B-plot assessment, thematic coherence

**Credit math:**
- Cinematic: ~245 clips × 11 = ~2,695 + ~120 scenes × 2 + ~20 portraits × 2 + ~300 buffer = **~3,275 credits**
- Monthly budget (6000 credits): ~1.8 prestige films/month
- Estimated generation time: 8-16 hours for cinematic (operational concern, not a bug)

**Risk mitigations baked into implementation (16 risks identified, Session 30N):**

HIGH:
- R1 (outline token overflow): Two-phase A1→A2→B design above
- R2 (grader skeleton exceeds context): Skeleton compression + split-grading fallback
- R3 (voice drift): Voice anchors above
- R4 (orchestrator grader catch auto-passes): Fix line 1228 — retry once, then hard-fail for prestige (benefits all tiers)

MEDIUM:
- R5 (long-form regression): Prestige branch inserted ABOVE long-form with strict `=== 'prestige'` gating
- R6 (renderer preset desync): Update both PRESET_STRUCTURES objects in index.html
- R7 (Higgsfield session exhaustion): Document 8-16hr expected time, existing checkpoint/resume is adequate. **Update 2026-05-28 live run:** a single Higgsfield/Cinema Studio session stayed active and usable all day while generating scene images (observed ~7h+ continuous run, 53/58 scenes, still uploading/processing references correctly). For future full-auto planning, "losing the session during a same-day run" should not be treated as a primary blocker; keep checkpoint/resume for crash recovery, but session longevity itself is not currently a major concern.
- R8 (verify batch duration): Document 20-30min verify time, optionally bump concurrency to 5
- R9 (auto-split clip_id cascade): Tighten 3-line constraint in prestige cinematic scaffolding
- R10 (five-act language leak): Strict `=== 'prestige'` gating, same as R5

LOW:
- R11 (branding interval): Consider BRANDING_INTERVAL_CLIPS = 20 for prestige (~3.7min vs ~2.5min)
- R12 (FFmpeg 4K 45min): Document ~15-20GB temp disk, ~2-4hr assembly time
- R13 (DB row count): 245 rows fine for SQLite, no action
- R14 (title similarity): Existing issue #10 fix covers this
- R15 (voice anchor cost): ~$0.01-0.02 total, negligible
- R16 (tier string mismatch): TIER_PRESTIGE constant, grep validation in test step

**Implementation split (both complete):**
- Session 30N-A (Tasks 9-12, 15): ✅ Preset definitions, scaffolding, grading rubric, renderer UI — all "wiring" work
- Session 30N-B (Tasks 13-14, 16-17): ✅ Two-phase outline engine, voice anchors, AGENTS.md docs, validation

**Files modified:**
- `src/main/pipeline/orchestrator.js` — DURATION_PRESETS, CINEMATIC_DURATION_PRESETS, getDurationTier, TIER_PRESTIGE constant, grader catch block (Session A)
- `src/main/pipeline/script-engine.js` — _buildStructuralScaffolding (prestige five-act), _buildCinematicScaffolding (prestige constraints), reviewScriptStructure thresholds, _generateStoryDriven (refactored: prestige/standard outline split + Phase B loop), _generateStandardOutline (extracted), _generatePrestigeOutline (new, two-phase A1+A2), _extractVoiceAnchors (new, all story-driven) (Sessions A+B)
- `prompts/structure-review-prompt.txt` — prestige rubric section (Session A)
- `src/renderer/index.html` — duration dropdowns, PRESET_STRUCTURES, CINEMATIC_PRESET_STRUCTURES (Session A)
- `AGENTS.md` — this section (Session B)

**Implementation gotchas discovered:**
- Bash sandbox NTFS mount sync: `node -c` may see stale file versions and report false syntax errors. The Read tool is the source of truth for file completeness.
- Phase A2 compact bible now includes full outfit IDs + context (not just `outfit_count`) — needed for correct `character_outfits` mappings in scene beats.
- Voice anchors use a style descriptor lookup table (10 entries) rather than raw speech_style strings, giving the chapter generator actionable voice guidance rather than just a label.

**Session 30O — Prestige Validation Hardening (8 fixes):**

Round 1 (UI/data fixes):
- **Outline coverage validation** (~line 947): After A2 batches, validates `allChapterOutlines` has exactly chapters 1..totalChapters — checks for missing, duplicate, and out-of-range chapters, and requires `length === totalChapters`. Sorts by chapter_number after validation.
- **Outfit IDs in compact bible** (~line 819): `compactBible` now includes `outfits` array with `outfit_id` + `context` per outfit instead of just `outfit_count`. Enables A2 to assign valid outfit IDs in `character_outfits` scene beat mappings.
- **Prestige tier labels in UI** (index.html lines 1042, 1076, 1363): All three `tierLabel` ternaries now handle `'prestige'` — cinematic summary shows "prestige — 5-act + dual B-plots", review panel shows "Prestige (45 min)". Previously all fell through to "standard — 3-act".
- **Prestige in rubric TIER DEFINITIONS** (structure-review-prompt.txt): Added prestige (45 min, 12-15 chapters, five-act, dual B-plots, VERY HIGH bar) alongside test/standard/long-form.

Round 2 (validation hardening):
- **Phase B chapter number validation** (~line 523): Each call now enforces exactly one chapter returned with `chapter_number === chNum` (corrects mismatches, warns on multi-chapter returns). Final 1..N coverage validation on `allChapters` before return — prevents duplicate/missing chapters from reaching downstream.
- **AUTO-SPLIT placeholder hard-fail** (~line 1429): After oversized clip auto-split, scans all clips for `[AUTO-SPLIT` prefix in `multi_shot_prompt`. If any found, throws with clip IDs instead of warning. Prevents placeholder prompts from reaching Kling and wasting credits.
- **3-character scene limit enforcement** (~line 1377): Promoted from `console.warn` to hard `throw` for cinematic mode. Error message lists offending scenes (chapter + scene number + character count). Kling platform constraint — warn-only was functionally no check at prestige scale.
- **Out-of-range chapter rejection** (outline validation): Added `chapter_number < 1 || > totalChapters` check + explicit `length === totalChapters` guard. A model returning chapters 1-15 plus a bonus chapter 16 now fails validation.

Files changed:
- `src/main/pipeline/script-engine.js` — outline validation (range + length), Phase B per-call + final validation, auto-split hard-fail, 3-char scene enforcement, outfit IDs in compact bible
- `src/renderer/index.html` — three tierLabel ternaries (cinematic, staged, review panel)
- `prompts/structure-review-prompt.txt` — prestige tier definition
- `AGENTS.md` — this section

**Session 30P — Pipeline Stop-Point Mitigations (M1 + M2):**

M1 — Credit-exhaustion pause gate:
- **`getAvailableCredits()`** in higgsfield.js (~line 4066): Pre-generation credit check. Reads Generate button text to detect credit cost without clicking. Returns `{ available, creditCost, throttled }`. Cached 30 seconds. If throttled and button unreadable, flags `available: false` with reason string.
- **Credit pre-check in `_withSessionRetry()`** (orchestrator.js ~line 10674): Before every Higgsfield generation call, checks `getAvailableCredits()`. If `available === false`, emits `'credits-exhausted'` gate with detail object (label, creditCost, throttled, reason). Operator adds credits and clicks Resume. Cache invalidated on resume to force fresh read. Non-blocking on check failure — proceeds to generation if scraping fails.

M2 — Higgsfield preflight health check:
- **`preflightCheck()`** in higgsfield.js (~line 4130): Lightweight session validation. Calls `ensureBrowser()` + navigates to higgsfield.ai + runs `isLoggedIn()` (3-signal check). 15-second timeout via `Promise.race()`. Returns `{ ok, reason }`.
- **Preflight gate** (orchestrator.js, before Stage 3A portraits): Runs for cinematic mode only, after script approval. If preflight fails, emits `'preflight-failed'` gate with reason. On resume, re-runs preflight — throws if still invalid. Saves 8-16 hours of wasted run time on expired sessions.

UI gates:
- `index.html` — Two new gate handlers: `'preflight-failed'` shows session error + fix instructions, `'credits-exhausted'` shows credit status + cost per generation. Both use existing `updateLog()` + stepper pattern.

Design decisions:
- Credit check is best-effort, not authoritative. Higgsfield has no public credit balance API — we read the Generate button text (same regex as existing line 968). If parsing fails, we default to `available: true` to avoid false blocking.
- Preflight reuses existing `isLoggedIn()` code (lines 3991-4064) — no new browser logic.
- Both mitigations are non-breaking: they degrade gracefully to the pre-30P behavior on failure.

Files changed:
- `src/main/automation/higgsfield.js` — getAvailableCredits(), preflightCheck()
- `src/main/pipeline/orchestrator.js` — preflight gate, credit pre-check in _withSessionRetry()
- `src/renderer/index.html` — gate UI handlers for preflight-failed, credits-exhausted
- `AGENTS.md` — this section

**Session 30Q — Element Gate Auto-Verification (M3):**

M3 — Element gate auto-verification:
- The orchestrator auto-verifies element existence in Higgsfield without requiring a human gate.
- Creates a temporary `HiggsfieldElements` instance, calls `invalidateCache()` + `listExistingElements()`.
- Deduplicates expected element names from `cinematicElementNames` values (the map is many-to-one).
- Compares against scraped list using case-insensitive matching.
- **All present → auto-approve**, logs "✓ All N elements verified — auto-approving".
- **Any missing → automated retry**, wait 2 seconds, rerun element setup, and recreate only names still absent from the project Elements modal.
- **Verification failure → automated retry**, not a human `elements-ready` gate.
- Scope boundary: verifies existence only (name in list), not quality (correct image/settings). Quality verification is a separate project.

UI:
- The renderer's legacy `elements-ready` checklist handler may remain for old routes, but cinematic element setup should not emit it as the completion path.

Design decisions:
- Case-insensitive comparison handles Higgsfield's occasional name normalization.
- `invalidateCache()` called before listing to ensure fresh scrape (cache may be stale from element creation).
- `_lastMissingElements` stored on orchestrator instance so gate emit can reference the list.

Files changed:
- `src/main/pipeline/orchestrator.js` — element auto-verification block before gate
- `src/renderer/index.html` — missing elements passed to checklist renderer
- `AGENTS.md` — this section

**Session 30V — Higgsfield Element Creation + Upload Hardening:**

Element creation was reworked for the May 2026 Higgsfield `@` Elements modal UI.

- **Entry point:** Prefer the top-center project `@`/`Elements` control near the project title. The bottom prompt-toolbar `@` control remains fallback only; it is crowded by `+`/reference controls and duplicate toolbar rows, so it is easier to mis-click.
- **Create new:** The actionable control is the circular `+` inside the first `Create new` tile. Clicking only the `Create new` text can select or edit an existing element. If the new-element form opens with a pre-filled `reference-name`, treat it as editing an existing element: close the form and hard-fail before uploading.
- **Upload source mapping:** `@{baseName}_o1_{suffix}` uses the master portrait (`portrait_character_N.png`) plus the `o1` grid (`character_N_o1_grid.png`). Non-default outfits use outfit portraits (`portrait_character_N_o2.png`, etc.) plus matching outfit grids. All element upload paths must resolve inside the current project directory.
- **Upload mechanics:** Direct `setInputFiles()` on hidden `input[type=file]` is unsafe for the Elements form. It can create local-looking DOM state without Higgsfield accepting the file. Use real mouse clicks that trigger a trusted native `filechooser`, then attach files through `chooser.setFiles()`.
- **First image upload:** Click the actual circular `+` inside the large `Upload images` tile. Backend success is visible as `POST /media/batch`, `PUT` to CloudFront/S3, and `POST /media/{id}/upload`.
- **Second image upload:** After the first portrait is attached, the UI changes to a horizontal strip: small `Add more images` tile on the left, preview thumbnail beside it, empty strip space across the rest. The actionable target is still the inner circular `+` inside the small tile. Do not click the strip center or label; it will not fire `filechooser`.
- **Waits:** Wait after each upload because Higgsfield needs time to process the file, render the thumbnail, and create the next `+` control. Current Elements flow uses a longer wait between portrait and grid uploads.
- **Diagnostics:** On upload failure, log DOM diagnostics for visible upload controls, file inputs, preview thumbnails above the name field, current element name value, and a body-text snippet. This distinguishes selector failure from file/path mapping failure.
- **Confirmation:** Save success is not sufficient. Element creation only counts as successful after `@` autocomplete confirms the new element. Missing confirmation should fall into the manual checklist gate.

Files changed:
- `src/main/automation/higgsfield-elements.js` — modal candidate selection, safe `Create new` plus click, trusted filechooser upload path, inner-plus targeting for first/second uploads, upload diagnostics
- `src/main/pipeline/orchestrator.js` — restored-map verification, post-save confirmation hardening, outfit-aware persistence, path guards, final `@` verification
- `AGENTS.md` — this section

**Session 30V-B - Cinema Studio Scene Retry Credit Protection (June 17, 2026):**

Live SCWOB scene-image run exposed a credit-risk timeout path: Cinema Studio could keep an image tile actively generating after the app's 240s poll timeout. The old retry logic attempted Asset Library harvest, then clicked Generate again if harvest missed the result, which could stack duplicate 4-credit image generations while the first one was still in progress.

Rules now documented for future work:
- A timeout after Generate was clicked is not proof that generation failed.
- If a gallery/composer tile still shows active generation (spinner/progress/large blank loading tile), the pipeline must not click Generate again for that scene.
- Active-generation timeout enters wait/harvest mode: progressive waits of 30s, 60s, 90s, then 120s intervals, harvesting between waits.
- If the active generation never becomes recoverable, stop the scene pass and mark the asset failed with an active-generation timeout message. Do not burn another credit retry.
- Asset Library recovery similarity can be flaky for long prompts with chips; recency/prompt-prefix matching may need future hardening, but active spinner proof always overrides retry.

Files changed:
- `src/main/automation/cinema-studio-automation.js` - detects active image-generation tiles before timing out.
- `src/main/pipeline/orchestrator.js` - active-generation timeout branch waits/harvests progressively and blocks duplicate Generate clicks.
- `AGENTS.md` - this section.

**Session 30W — Script Realism + Background Roles Guardrails:**

Problem observed in long cinematic scripts: institutional scenes could become visually/logically thin, e.g. court-related scenes without any judge/lawyer/clerk presence, or legal/medical/business stakes resolved by dialogue alone without visible proof. Adding every functional person as a full character would bloat portraits, elements, promo posts, and the 3-character scene constraint.

Fix:
- Script scaffolding now supports `scene.background_roles`: non-speaking realism roles/crowds such as judge at bench, court clerk, lawyers in gallery, market crowd, church ushers, nurses at station, palace attendants, mourners.
- `background_roles` are environmental only: no dialogue, no portrait, no Higgsfield Element, no promo post, no character_bible entry, and they do **not** count toward the max-3 `characters_present` limit.
- Standard and prestige outline prompts ask for `background_roles` and `props_in_scene` in scene beats when institutional/community realism or procedure requires them.
- Cinematic scaffolding now explicitly requires functional presence for court/hospital/police/church/school/palace/market/funeral/wedding scenes and concrete props/procedure for legal, medical, business, land, school, and police beats.
- Structural review prompt now has a Realism + Procedure check and can emit `realism` / `procedure` issue categories.
- Broader realism guardrails are also enforced in generation/review: plausible time/travel sequence, money/work consequences, phone/WhatsApp/evidence access, social pressure, emotional aftermath, domestic/work texture, class/register differences, and prop continuity.

Design rule for future work: if a role speaks or drives the plot, add it to `character_bible`; if it only makes the location credible, put it in `background_roles`. Do not solve realism by stuffing extra speaking characters into a scene.

Files changed:
- `src/main/pipeline/script-engine.js` — outline schemas/rules, continuation compression, cinematic scaffolding, cinematic review skeleton, reviewer extension
- `prompts/structure-review-prompt.txt` — Realism + Procedure review guidance and issue categories
- `AGENTS.md` — this section

**Session 30X — Script-Generation Repair Layer (June 15, 2026 — Phase 1 Implemented):**

Live 30-minute cinematic run exposed a costly script-stage failure mode. Three full retries of the same `title-chosen` project spent roughly $6 in Claude/API cost and never reached asset generation:

1. Attempt 1 produced a complete script (10 chapters, 135 clips) but failed `_validateScriptCompleteness()` because `ch8_sc5_c4` had 4 `line_refs`.
2. Attempt 2 produced a structurally valid script shape but only 128 clips against target ~164; the 80% minimum is 131, so it missed by 3 clips.
3. Attempt 3 produced 146 clips (clip-count pass) but failed because `ch1_sc7_c3` and `ch5_sc3_c4` each had 4 `line_refs`.

Diagnosis:
- `script-engine.js::generateScript()` validates after all Phase B chapters are generated but before `_sanitizeBlocking()`, `_fixBlockingShotConsistency()`, `_sanitizeKlingClipPrompts()`, disk `script.json`, DB `script_json`, structural review, or the orchestrator's approval/regeneration loop.
- Near-good scripts are discarded before persistence. The existing `MAX_SCRIPT_REGEN` loop in `orchestrator.js` only applies after integrity validation succeeds, so it does not help these failures.
- The hard gates are correct for credit protection; the missing piece is a cheap repair layer before hard fail.

Implementation status:

- **Phase 1 implemented:** structured validation diagnostics, `ScriptValidationError` with draft/diagnostics payload, failed-draft artifact persistence in `orchestrator.js`, and scene-level `kling_clips` repair for oversized `line_refs`.
- **Still planned:** under-target clip-count expansion and per-chapter validation/repair during Phase B generation.

Implementation plan:

1. **Return structured validation diagnostics instead of throwing immediately.**
   - Refactor or wrap `_validateScriptCompleteness()` so cinematic story-driven validation can return `{ ok, errors, stats, oversizedClips, underTarget, overloadedScenes, autoSplitClips }`.
   - Keep a throwing public path for tests/back-compat, but give `generateScript()` a repair-aware path.
   - Preserve existing hard-stop semantics after repair attempts are exhausted.
   - **Implemented:** `_inspectScriptCompleteness()` now returns diagnostics; `_validateScriptCompleteness()` keeps the throwing contract.

2. **Add scene-level `kling_clips` repair for `line_refs.length > 3`.**
   - Detect offending clips by chapter/scene/clip id.
   - For each affected scene, make a small Claude call with the scene JSON, relevant character bible entries, and offending ids.
   - Instruct Claude to preserve `lines`, `blocking`, `characters_present`, `character_outfits`, `background_roles`, `props_in_scene`, location fields, and dialogue text.
   - Rewrite only `scene.kling_clips`.
   - Require sequential coverage of existing line numbers, 1-3 `line_refs` per clip, no gaps/duplicates, real 3-shot `multi_shot_prompt` for every new clip, and no `[AUTO-SPLIT]` placeholders.
   - Replace only the repaired scene's `kling_clips`, then re-run validation.
   - **Implemented:** `_repairOversizedClipLineRefs()` repairs affected scenes and `_validateSceneKlingClipCoverage()` rejects gaps, duplicates, unknown lines, >3 refs, duplicate clip ids, missing real prompts, missing `visual_beat`, non-15s durations, non-3-shot prompts, out-of-order refs, and `[AUTO-SPLIT]`.

3. **Add under-target clip expansion for near misses.**
   - If total clips are below the 80% minimum but at least a configurable near-miss floor (suggested: 70% of target, and always if the deficit is <= 15 clips), do not full-regenerate.
   - Pick lowest-clip chapters/scenes or scenes whose outline `target_clips` were underfilled.
   - Ask Claude to expand selected scenes by adding dialogue lines and matching valid `kling_clips`, while preserving plot continuity and metadata.
   - Bound the repair: max 2 expansion calls, max +10-15 clips per pass, then hard-fail if still below threshold.

4. **Validate each Phase B chapter immediately.**
   - After each chapter call, run cheap chapter-local checks: exactly one chapter, correct `chapter_number`, no >3 character scenes, no 4+ `line_refs`, reasonable clip count vs `chOutline.target_clips`.
   - Repair/regenerate only the current chapter before moving on.
   - This avoids paying for chapters 6-10 after chapter 1 already contains an invalid clip.

5. **Persist failed-but-repairable drafts for forensic/manual recovery.**
   - Before throwing after final repair failure, write `script.failed.json` and `script-validation-failure.json` in the project directory.
   - Do not advance DB stage, do not create assets, and do not mark `script-done`.
   - This preserves paid generation output for inspection or manual/surgical repair.
   - **Implemented:** `ScriptValidationError` carries `draftScript` and `diagnostics`; `orchestrator.js` catches that error type around `generateScript()` and writes both artifacts before rethrowing.

6. **Tighten prompt wording to match validator exactly.**
   - Current cinematic scaffold contains tension between "Each clip covers EXACTLY 3 dialogue lines. Not 1, not 2..." and the later last-clip exception.
   - Replace with validator-aligned language: partition scene lines into sequential groups of at most 3; use 3 whenever available; only the final clip in a scene may contain 1 or 2 lines; never create 4+ `line_refs`.

Testing plan:
- Extend `test/test-script-integrity-guards.js` with a 4-line clip repair case: repaired clips cover all original lines with max 3 refs and real prompts.
- Negative repair-output test added: invalid repair responses (bad duration, missing `visual_beat`, 4+ refs, or wrong shot count) are rejected.
- Add a near-miss clip count case: expansion pass can bring 128/164-style output over the 80% floor without changing title/character bible.
- Add repair exhaustion coverage: still throws and writes failure artifacts.
- Add per-chapter validation coverage: invalid chapter gets repaired before final assembly.
- Use fixture-sized scenes and mocked Claude repair calls for unit tests; do not require live API for regression tests.

Tests run for Phase 1:
- `node test/test-script-integrity-guards.js` — passed
- `node test/test-structural-review-skeleton.js` — passed
- `node test/test-cinematic-silent-dialogue-sanitizer.js` — passed
- `node -c src/main/pipeline/script-engine.js` — passed
- `node -c src/main/pipeline/orchestrator.js` — passed
- `node test/test-cinematic-asset-flow.js` — failed on existing asset-row adoption assertion (`dialogue clip row should be adopted and tagged`); this path is unrelated to script repair but should be investigated separately.

**Session 30Y — Live-Run Cinematic Prompt Target Repair (June 15, 2026):**

Context: After Session 30X let the live 30-minute cinematic run reach the script approval gate, the structural reviewer flagged prompt-level risks that did not justify another full script regeneration: character `@` refs used as possessive locations (for example `@amara's apartment`) and Shot 2/3 hard camera targets pointing at a non-speaking character. The original caveat came from Kling 3.0, while the live run uses Cinema Studio 3.5 / Seedance 2.0; because prompt preview is currently bypassed for Cinema Studio 3.5 and clip re-generation is expensive, the mitigation is deterministic runtime repair rather than human preview.

Implementation:
- Added `orchestrator.js::_repairCinematicShotTargets(prompt, clipId, elemMap)`.
- Hooked it into `_runCinematicVideoStage()` after existing element resolution, bare-name fixes, dialogue `@` stripping, and dialogue sanitizer; before rules engine, grounding prefix, final sanitizer, `db.markAssetGenerating()`, and `generateClip()`.
- Repair is intentionally narrow:
  - de-tags possessive place phrases such as `@amara_o1_xxxx_0615's apartment` to `Amara's apartment`;
  - only in Shot 2/3, retargets hard visual commands (`CUT TO @other`, `CLOSE-UP ON @other`, `MEDIUM ON @other`, `CAMERA FINDS @other`, `PUSH IN ON @other`) when the target differs from the shot's dialogue speaker;
  - leaves Shot 1 multi-character establishing prompts untouched;
  - leaves softer non-target references untouched;
  - does not edit dialogue quotes.
- Logs each repair with `[SHOT-TARGET-REPAIR]` so the live terminal shows what was changed.

Regression coverage:
- `test/test-cinematic-shot-target-repair.js` verifies possessive-location de-tagging, Shot 2 hard-target retargeting, Shot 1 preservation, dialogue preservation, and soft-reference preservation.
- Re-ran `test/test-cinematic-silent-dialogue-sanitizer.js`, `test/test-script-integrity-guards.js`, and `node -c src/main/pipeline/orchestrator.js`.

Operational note:
- This protects prompts compiled after the app process restarts. It does not change an already-running Electron process. For a live run stopped at script approval, restart Electron before approving if this mitigation must apply to the current project.

Operational rule until implemented:
- Do not keep retrying full script generation after repeated near-miss cinematic validation failures. Stop after 2-3 failures and implement/trigger surgical repair, because no Higgsfield credits are at risk yet but API cost accumulates quickly.

**Session 30R — Batch Prompt-Preview Mode (M4):**

M4 — Batch prompt-preview gate:
- Replaces the per-clip prompt-preview gate with a single batch review.
- **Two-phase clip processing**: Phase 1 runs all prompt transforms (vision blocking, posture correction, rules engine, grounding prefix) and collects final prompts into `batchPreviewData[]` and `cachedFinalPrompts{}`. Phase 2 generates only approved clips using cached prompts.
- After Phase 1, emits a single `'prompt-preview-batch'` gate with all clip data (clipId, label, prompt, startFramePath, duration).
- Operator reviews all prompts at once in a paginated grid (20 per page).
- **Approve All** (default): generates every pending clip.
- **Selective approval**: toggle individual clips off, only approved clips generate.
- **Stop**: cancels the entire generation run (no credits burned).
- Phase 2 generation loop: uses `cachedClipGenData{}` for all generation parameters, includes session-expired recovery, retry logic, and per-clip review gate.
- Rejected clips counted as `batchRejected` in final progress summary.

UI:
- `index.html` — new `batch-preview-panel` with purple (#8b5cf6) theme:
  - Paginated card grid: start frame thumbnail, clip label, duration, truncated prompt (click to expand).
  - Toggle selection per card (checkbox visual).
  - Select All / Deselect All buttons.
  - Approve Selected (count) / Stop buttons.
  - Page navigation (Prev/Next with page label).
- New IPC: `approvePromptPreviewBatch(decision)` — accepts 'stop', 'approve', or `{ approved: [clipId, ...] }`.

Design decisions:
- Two-phase approach avoids duplicating 750 lines of transform code. Phase 1 reuses the existing loop with a `continue` after collection; Phase 2 is a dedicated generation-only loop.
- `cachedClipGenData` stores all per-clip references (clipAsset, outputPath, etc.) to avoid re-querying in Phase 2.
- Phase 2 has its own simplified error handling (session-expired recovery + single retry). Timeout recovery sweeps are omitted to keep batch generation moving fast.
- All clips selected by default — operator deselects the ones that look wrong.

Files changed:
- `src/main/pipeline/orchestrator.js` — batch collection in Phase 1, batch gate, Phase 2 generation loop, `approvePromptPreviewBatch()` method
- `src/renderer/index.html` — batch preview panel HTML, JS functions, gate handler
- `src/main/main.js` — IPC handle for `approve-prompt-preview-batch`
- `src/preload/preload.js` — preload binding for `approvePromptPreviewBatch`
- `AGENTS.md` — this section

### Cinematic — story-driven video model (Kling default, Cinema Studio 3.5 optional)

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

**Credit estimation shifts from line-based to clip-based.** The start screen shows estimated clips and credits derived from target duration, not from a fixed grid formula. The script prompt tells Codex the target clip count and lets the story distribute scenes/lines/characters freely within that budget.

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
2. **Grader prompt** (`prompts/structure-review-prompt.txt`): Low-temperature (0.2) Codex call with a point-scored rubric. Returns JSON `{score, pass, issues[], strengths[], summary}`. ~$0.05-0.10 per review.
3. **Pass thresholds:** test ≥50, standard ≥60, long-form ≥70, prestige ≥80. Cinematic mode gets +5 across all tiers. Prestige has the highest bar because a bad 45-min script wastes ~3000 credits.
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

**Cinematic story-driven structure:** scenes per chapter, lines per scene, and character count are all unlimited (story-driven). The only fixed constraints are: exactly 3 shots per cinematic clip, max 3 characters per scene, ≤9 words per dialogue sentence, and the total clip count derived from duration target ÷ 11 seconds. See "Duration Presets → Cinematic" section above for full budget math. Kling 3.0 remains the default video engine; Cinema Studio 3.5 is selectable via `settings.cinematicVideoEngine`.

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
- Orchestrator: new `_runCinematicLocationSetup()` (extracts unique `location_element_hint` values from script, generates empty location images as reference images for scene gen) + `_runCinematicSceneImageStage()` (per scene: resolves @location + @character refs, builds blocking, generates via Cinema Studio 2.0)
- Element-setup stage now runs character element creation + location image generation in sequence
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
- Script prompt: new `{{CINEMATIC_SCAFFOLDING}}` placeholder. When `generator_mode = 'cinematic'`, Codex receives detailed authoring requirements for `scene.blocking` (frame-left/center/right with character references), `scene.location_element_hint` (snake_case location key), `scene.background_roles` (non-speaking realism roles/crowds), `scene.props_in_scene` (Chekhov's-gun/procedure array), and `scene.kling_clips` (multi-shot prompt array using Kling's bracketed dialogue syntax). Staged mode gets an empty string — no change to existing behavior.
- Structural review rubric: `CINEMATIC_RUBRIC_EXTENSION` injected when mode is cinematic. Adds scoring dimensions for blocking completeness, kling clip coherence, element-hint discipline, props-as-elements, plus deduction-only checks for realism/background population and cinematic-specific critical failure modes. Cinematic mode thresholds bumped +5 across all tiers (test=55, standard=65, long-form=75).
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
3. Open `projects/<project-id>/script.json` — scenes should have `blocking`, `location_element_hint`, `background_roles`, `props_in_scene`, and `kling_clips` fields populated
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

Image automation UI drift note (2026-06-15): Nano Banana Pro may expose image aspect/resolution only as visible chip/dropdown controls (`9:16`, `2K`) rather than native `<select>` elements. `generateImage()` must actively set and confirm the visible controls, use native selects only as a fallback when available, and hard-fail before Generate if aspect or resolution cannot be confirmed.

Temporary live UI inspection mode (2026-06-15): set `HIGGSFIELD_BROWSER_INSPECT=1` before clicking Continue to open the app-owned headed Playwright browser and suspend before any pipeline stage or asset mutation. It opens Nano Banana, Assets, Veo, and Cinema Studio inspection tabs, writes `ui-inspection/higgsfield-ui-snapshot_*.json` plus screenshots under the project folder, and exposes remote debugging on `HIGGSFIELD_DEBUG_PORT` (default `9223`). Resume exits inspection mode; restart without the env var to run production.

Live inspection findings (2026-06-15): Nano Banana quality dropdown option labels are concatenated with entitlement text (`1KUnlimited`, `2KUnlimited`, `4K`), so automation must match resolution options by prefix rather than exact text. Always press Escape before opening a toolbar dropdown because a previously open menu can leave option buttons visible near the toolbar and confuse control discovery. The old Veo URL (`/create/video`) now lands on the unified `/generate` Cinema Studio surface in the inspected session; treat staged Veo and Cinema Studio setup as suspect until their current toolbar flows are separately revalidated.

Portrait provider-miss retry (2026-06-15): A live Nano Banana portrait run can submit successfully, capture a job id, then never materialize in API polling, History/CDN, Asset Library recovery, or the local output path before the 420s timeout. Treat that as a retryable Higgsfield-side provider miss only when `generateImage()` marks `retryableProviderMiss`, no `detectedCdnUrl` is present, and the expected local file does not exist. The portrait stage resets and requeues that same asset up to 2 times, logging `provider_miss_retry`, then hard-fails after the retry budget. Do not apply this to pre-generation settings failures, NSFW/session/cancel errors, or any case where recovery found a CDN/local file.

Each project has a single `aspect_ratio` column (migration 007), chosen at Start Research time and **locked once generation begins** (setter throws if any project_assets rows exist). MVP supports `16:9` (YouTube long-form, default) and `9:16` (Shorts / TikTok / Reels). Portrait and outfit-portrait image generations follow the project/global aspect ratio unless a stage explicitly documents an override.

**How it threads through the pipeline:**

- **UI:** Aspect dropdown sits next to the Duration dropdown on both pool + fresh-start cards. Resume card shows a badge (e.g. "18/18 assets complete · 9:16 (vertical)")
- **Automation (image):** `generateImage({..., aspectRatio})` — the Nano Banana Pro page has a native `<select>` (12 options, wrapped in a custom dark popup). The caller-supplied `aspectRatio` is authoritative for portraits, outfit portraits, and scenes; it comes from the project/global aspect ratio chosen at project start unless a specific stage intentionally overrides it. Image automation must hard-fail before Generate if aspect or resolution cannot be confirmed.
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
- Shown to Codex as "EXISTING TITLES IN THIS SPACE (DO NOT COPY OR PARAPHRASE)"

### Layer 4 — Research Context Sanitization
- `buildScriptResearchContext()`: Individual video story structures (setup/conflict/climax) are NOT passed to Codex — removed entirely
- All pattern entries run through `sanitizePatternEntry()` which strips plot-summary-like text
- `looksLikePlotSummary()` detects narrative indicators (action verbs, "A/The [person] [verb]" patterns)
- Short abstract entries (≤60 chars, no narrative indicators) pass through unchanged
- Long/narrative entries get truncated to first clause boundary or first 4 significant words
- Both `buildResearchSummary()` and `buildScriptResearchContext()` are sanitized

**Important**: Raw research data in the electron-store cache is NOT sanitized — it retains full Gemini analysis for UI display and debugging. Sanitization happens at the point of injection to Codex's API only.

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
- **Solution:** Before building the Higgsfield prompt, send the location image + scene context to Codex API (vision) and ask it to propose spatially-grounded blocking. The refined blocking references actual objects in the image ("behind the grill, arms folded," "leaning on the counter frame-right") instead of abstract frame positions.
- **Method:** `_refineBlockingWithVision(locationImagePath, scene, characters)` in `orchestrator.js`. Takes the location PNG (base64), scene emotional context + characters, returns a refined prompt string with @mentions + spatial descriptions. Falls back to original script blocking on API failure.
- **Placement:** Inside `_runCinematicSceneImageStage()` per-scene loop, AFTER resolving `locInfo` and `characters`, BEFORE calling `cinema.generateSceneImage()`. The refined blocking text replaces the raw `characters` array's position strings.
- **Prompt design:** System prompt instructs Codex to: (1) describe spatial anchors in the location image, (2) propose character positions that use those anchors, (3) output @mention names with environment-relative positions, (4) never use generic frame-left/center/right language. Single-character scenes get intimate framing; multi-character scenes get dynamic spatial relationships.
- **Cost:** One Codex API call per scene (~$0.01-0.03 with vision) vs 2 Higgsfield credits ($0.20+) per generation. The quality uplift is worth 10x the cost.
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
- Cost notes: Cinematic Cameras = 2 credits/image, Soul Cinema = 0.125 credits. Cinema Studio 3.5 video cost varies by settings; May 2026 walkthrough observed `15s + 480p + 9:16` at `52.5` credits. Do not use the image-mode `>10 credits` safety gate for Cinema Studio 3.5 video; use the dedicated Cinema video pre-gen guard instead.

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

Codex's script responses (especially at 90+ lines) can be truncated or malformed. `_safeParseScriptJson()` in script-engine.js provides 6-strategy progressive recovery: direct parse → regex extraction → trailing comma fix → bracket closing → unescaped quote fix → truncation to last complete element. Helper methods: `_closeUnclosedBrackets()`, `_fixUnescapedQuotes()`, `_truncateToLastComplete()`. The `max_tokens` is set to 16384 to minimize truncation in the first place.

**Session 30N fixes (5 critical):**
1. `_closeUnclosedBrackets` — rewrote to use ordered nesting stack (old code closed `]` before `}` regardless of nesting order)
2. `_fixUnescapedQuotes` — added `\n\r` to boundary char set (newlines at end-of-line were treated as inner quotes)
3. `reviewScriptStructure` — grader parse failures now return `pass:false` instead of silently auto-passing with score 65
4. `_sanitizeKlingClipPrompts` bare-name @-prefix — now skips matches inside dialogue quote ranges
5. `_sanitizeKlingClipPrompts` dual-speaker strip — collect-then-apply pattern (modifying string mid-iteration with stateful regex corrupted lastIndex)

**Known remaining issue:** Orchestrator line ~1228 has its own try/catch that auto-passes (`score:65, pass:true`) when `reviewScriptStructure()` throws an exception (network error, API timeout). Fix 3 handles the case where the call succeeds but returns bad JSON; the orchestrator catch handles the case where the entire call fails. Planned fix (Session 30N prestige implementation): retry once before fallback, hard-fail for prestige tier.

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

The LLM (Codex script generator) sometimes produces garbled continuity tags where the tag text is interleaved with the scene description (e.g., `(Continuity: Using Image Prompt [Line 1] as rs slightly parted...`). The sanitizer:
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

## Agreement Modal Auto-Dismissal (kling-automation.js)

**Problem:** After re-login to Higgsfield, a full-screen "Media upload agreement" overlay appears (`fixed inset-0 z-[1000]`) that blocks ALL pointer events on the page. The overlay is skipped by `_dismissPromoAd()` (which filters out viewport-sized elements), causing generation failures when clicks intended for multi-shot toggle or other controls get intercepted by the invisible modal.

**Observed trigger:** ch5_sc3_c3 (clip 64) failed twice — the modal appeared after session recreation and intercepted the multi-shot toggle click mid-animation, leaving the page in an inconsistent state.

**Fix:** `_dismissAgreementModal()` — new handler added to the dismissal chain in `_dismissAdsWithPatience()`. Runs BEFORE `_dismissPromoAd()` to clear blocking overlays before they can intercept clicks.

**Detection strategy:**
- Scans for `fixed`/`absolute` positioned overlays with `z-index >= 1000` (browser modal range)
- Checks for text content: "Media upload agreement" or "I agree, continue" (case-insensitive substring match)
- Identifies the agree button (highest-confidence match: contains "agree" or "continue" text, small button-like element, positioned bottom-right of modal)

**Button click:** Uses real mouse click on the agree button. Modal closes, pointer events resume normal.

**Execution order in `_dismissAdsWithPatience()`:**
```
1. _dismissAgreementModal()   ← NEW: full-screen blocking overlays
2. _dismissPromoAd() × 5      ← existing: smaller promo panels
```

**Impact:** Eliminates modal-interception failures during clip generation. No credit waste (modal appears after page is interactive, before generation starts). Negligible latency (<100ms detection + click).

## Failed Clip Backfill Pass (orchestrator.js)

**Problem:** When the main video generation loop finishes with `failed > 0`, those clips remain failed. Transient failures (agreement modals, browser crashes, ad interception) could recover if retried with a fresh context, but no automatic backfill existed. Users had to manually reset failed clips via script or run the entire pipeline again.

**Fix:** After the main loop completes (line ~6838), a new `_backfillFailedClips()` pass sweeps the DB for all clips marked `failed` in the current project. For each failed clip:

1. **Disk check:** Scans the output directory for the expected file (matches clip ID or asset basename). If file exists and is >10KB, mark it `done` immediately (manual intervention recovered it).
2. **Fresh retry:** If no file found, reset clip to `pending` and retry with a completely fresh browser context (separate from the main loop context to isolate transient issues).
3. **Approval prep:** Successfully recovered clips are logged with filename + details and shown for user approval (not auto-approved to preserve safety gate).

**Execution:** Only runs when `failed > 0` after main loop. Prevents needing a full pipeline restart for individual transient failures. Most common recovery: agreement modal intercepted a retry, disk file appeared from prior successful generation.

**Performance:** ~10-30s per failed clip (new context spawn + generation wait). Applied only to clips that failed, not all 150.

**DB state:**
- Backfilled clips marked `done` with `recovered_from_backfill: true` metadata (audit trail)
- Re-tried clips follow normal CDN-recovery-first path if generation succeeds
- Pipeline stage remains `videos-done` after backfill (no stage regression)

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

### 3-Stage Recovery with Progressive Waits (orchestrator.js) — Session 27
**Problem:** ch8_sc5_c1 double-timed out (480s × 2). Both generated videos existed in Kling's Asset library but recovery missed them — the first recovery ran too early (videos still generating), and after retry timeout there was NO second recovery attempt. Pipeline marked as failed and moved on, wasting 42 credits.

**Root cause:** Single recovery attempt after first timeout, then re-gen with no recovery after retry timeout. Videos that take >480s+120s to appear in Kling's asset library were permanently lost.

**Fix:** 3-stage progressive recovery before marking failed:
1. Gen 1 timeout → wait 120s → recovery (6 tiles, 92%)
2. No match → wait 120s → **second recovery** (6 tiles, 92%) — NEW
3. Still no match → retry gen
4. Retry timeout → wait 180s → **final recovery** (6 tiles, 88%) — NEW
5. Still no match → mark failed

Total wait time before failure: ~7 minutes of recovery windows. Videos that complete in Kling's queue during any of these windows are caught. The second recovery (step 2) is the key addition — it catches videos that were still generating when the first recovery ran, without burning credits on an unnecessary re-gen.

### Recovery SESSION_EXPIRED Detection (kling-automation.js, orchestrator.js) — Session 27-28
**Problem:** When recovery navigates to `higgsfield.ai/asset/video` and finds zero video tiles (empty page / "Project Not Found"), it means the user is not logged in. Previously recovery returned `null` (no match), which caused the orchestrator to re-generate — wasting credits on a gen that would also fail due to no session.

**Fix (Session 27):** `recoverTimedOutClip()` now throws `SESSION_EXPIRED` when zero video tiles are found after 4 polling attempts. The post-timeout recovery catch blocks (`recoveryErr` and `finalRecErr`) re-throw `SESSION_EXPIRED` to bubble up to the outer catch which pauses the pipeline.

**Fix (Session 28 — two additional bugs):**
1. **Pre-gen recovery catch swallowed SESSION_EXPIRED.** The pre-gen recovery path (when `gen_clicked_at` is set) had its own catch block at ~line 6202 that logged "will re-generate" without checking for SESSION_EXPIRED. This catch block sits OUTSIDE the main try/catch (line ~6610) that contains the SESSION_EXPIRED handler, so `throw` would escape the for-loop entirely. Fix: handle SESSION_EXPIRED inline in the pre-gen recovery catch with the same pause-wait-retry logic (pause, emit `session-expired`, relaunch browser, wait for Resume, `i--; continue`).
2. **Recovery prompt mismatch — 74% on exact matches.** Pre-gen recovery compared `clipDef.multi_shot_prompt` (original script prompt) against the Kling tile prompt. But the actual prompt submitted to Kling included the CHARACTER POSITIONS preamble (vision-blocking injection), shot reconciliation, posture fixes, and dialogue sanitization — all applied after the script prompt. Result: 74% Dice coefficient on prompts that should be identical. Fix: recovery now reads `existingAsset.prompt_used` (the actual prompt stored by `markAssetGenerating` before clicking Generate) and uses that for comparison. Similarity jumps from ~74% to near-100% on true matches. Falls back to `clipDef.multi_shot_prompt` only when `prompt_used` is unavailable.

**Architecture of SESSION_EXPIRED handling across all three catch blocks:**
- **Pre-gen recovery catch** (line ~6202): inline pause-wait-retry (can't throw — outside the main try/catch)
- **Post-timeout recovery catch** (line ~6830): re-throws to outer catch (inside the main try/catch)
- **Outer generation catch** (line ~6690): pause pipeline, relaunch browser, wait for user Resume, `i--; continue`

### Vision-Refined Blocking — Bare Character Names (orchestrator.js)
**Problem:** Codex Vision API returns blocking text with bare character names ("toward son_emeka") without `@` prefix. These don't become @-mention pills in Higgsfield.

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
If the count matches (all elements stored in DB), open the browser, navigate to the Cinema Studio project, and verify the stored element names through the project Elements modal. Do not use `_verifyElementsViaAtButton()` for setup existence checks; the composer autocomplete can false-negative. If any are missing from the modal, clear the map and fall through. Only runs on DB-restored resumes (`restoredFromDb=true`), not during the current run where elements were just created.

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
  1. Calls `_rewriteCharacterDescription(char)` — Codex rewrites `full_prompt_description` with more fictional/stylized traits while keeping ethnicity, wardrobe, and story role
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

**Problem:** The `generateScript()` method used a single API call with `max_tokens: 16384`. For 30-minute cinematic scripts (10 chapters × 3 scenes × 9 lines with blocking, kling_clips, image/animation prompts), one chapter uses ~12K tokens. A full 10-chapter script needs ~120K tokens — far beyond the 16384 limit. Codex would generate 1 chapter, hit the limit, and the truncation recovery would silently close the JSON with just 1 chapter. The pipeline then processed only 3 scenes instead of 30.

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

**Dependency chain:** portrait → character_grid → element → location_image → scene_image (uses vision blocking) → video_clip (uses scene as start frame + blocking). Vision-refined blocking is the ground truth because it's based on what Codex Vision actually saw in the location image (same image used as Kling start frame).

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
- Formula: `ceil(words / 2.5) + (shotTransitions × 0.5) + 1.0` (buffer) — updated from words/2.0+1.5 after observing 3-4s dead air on clips where Kling filled excess time with phantom animations
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

**Fix:** `_generateEarlySEO(projectId, projectDir)` fires as background promise after script approval. Non-blocking — portrait generation proceeds in parallel. Generates YouTube + Facebook metadata via Codex, persists to DB, writes output files. If it fails, publish stage can still generate on demand.

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

Data from first production run. Formula: `ceil(words / 2.5) + (transitions × 0.5) + 1.0` (recalibrated from words/2.0+1.5)

| Clip | Words | Per-Shot Words | Shots | Script | Effective | Result | Prompt Snippet |
|------|-------|----------------|-------|--------|-----------|--------|----------------|
| ch1_sc1_c1 | 19 | 9/6/7 | 3 | 10s | 12s | ✓ Perfect lip sync, all dialogue delivered | S1: "She burned the rice again this morning." S2: "Twelve years married. Still burning rice." S3: "I was rushing. The children needed—" |
| ch1_sc1_c2 | 20 | 7/7/6 | 3 | 10s | 12s | ✓ Perfect lip sync | S1: "You see? Always an excuse. Always." S2: "A good wife wakes before the children." S3: "Exactly. My mother understands these things." |
| ch1_sc1_c3 | 20 | 8/5/7 | 3 | 10s | 12s | ⚠ Lip sync wonky on Shot 3 (5 words + heavy action: "prayer beads clicking, eyes cold and satisfied" + slow push-in). Voice delivered but lips didn't match well. Short dialogue competing with dense action. | S1: "You are right. I will do better." S2: "She says that every Sunday." S3: "Prayer will help her remember her place." |
| ch1_sc2_c1 | 21 | 8/11/7 | 3 | 10s | 13s | ⚡ Shots 1-2 lip-synced, Shot 3 narrated over action (jaw tightens, push-in). Dramatically works as inner monologue — "He humiliated you in front of everyone" felt like unspoken thought. Acceptable. | S1: "Ada. Ada, stop walking. Talk to me." S2: "I know exactly how he is. That is the problem." S3: "He humiliated you in front of everyone." |
| ch1_sc2_c2 | 25 | 9/6/10 | 3 | 10s | 14s | ⚠ Shots 1-2 lip-synced. Shot 3 (5 words): voice delivered but lip sync didn't match. Short dialogue line in final shot. | S1: "He was joking. You know how he is." S2: "I am fine, Ngozi. Leave it." S3: "Every marriage has its difficulties." |
| ch1_sc2_c3 | 26 | 8/7/11 | 3 | 10s | 15s | [REDO] ⚠ Shots 1-2 perfect (static camera). Shot 3 (11 words, ECU + slow push-in): transition/expression/camera perfect, lip sync broken. Camera movement + dialogue = split attention. | S1: "Ada. When last did you laugh? Real laugh?" S2: "Do not start this today. Please." S3: "Something is wrong. I can see it on your face." |
| ch1_sc3_c1 | 21 | 8/6/7 | 3 | 10s | 14s | [REDO] ⚠ S1 ✓ perfect, S3 ✓ perfect. S2 WRONG CHARACTER — Ngozi's line delivered by Ada. All static camera. 3-char scene. Blocking conflict: text says Ngozi closest to camera but scene image shows Ada closest. Double @ref in S3 (@emeka + @adaeze) worked fine — visually distinct (male vs female). **Fixed by vision verification (Session 24).** | S1: "Ngozi! You are still here. Good to see you." S2: "Emeka. We were just talking." S3: "Ada, the car is ready. Let us go." |
| ch1_sc3_c2 | 20 | 5/8/8 | 3 | 10s | 13s | [REDO] ⚠ S1 ✓ perfect, S2 unknown (push-in risk). S3: **dialogue replaced entirely** — scripted "She is always busy. You know how it is." became "ok ok good bye". Kling interpreted "already turning away" action as departure cue and generated contextually fitting but wrong dialogue. Static camera on S3 but action verb ("turning away") competed with dialogue. Blocking now correct (vision verified). | S1: "Yes. I am coming." S2: "I will call you this week, Ada." S3: "She is always busy. You know how it is." |
| ch1_sc4_c1 | 20 | 7/6/7 | 3 | 10s | 13s | ✓ All 3 shots delivered perfectly — dialogue, lip sync, camera, expressions all correct. BUT **American accent** instead of Nigerian English. Voice tone binding issue on elements, not a prompt problem. S3 had slow push-in + dialogue yet lip sync worked — 2-char car interior with minimal body movement may reduce competing action. | S1: "You were looking sad again in there." S2: "I was not. I was smiling." S3: "A dead smile. People notice these things." |
| ch1_sc4_c2 | 18 | 8/8/2 | 3 | 10s | 12s | ✓ Perfect. All 3 shots correct — lip sync, dialogue, expressions. S3: ECU + slow push-in + only 2 words ("I understand") — worked flawlessly. Seated car interior = push-in safe even with ECU and ultra-short dialogue. Confirms: minimal body movement negates the push-in risk. | S1: "I am sorry. I did not mean to—" S2: "You embarrass me when you look like that." S3: "I understand." |
| ch1_sc5_c1 | ~20 | ~7/7/6 | 3 | 10s | 13s | [REDO] ⚠ S1-S2 fine. S3: complex physical action + dialogue — "wait I dropped something" delivered, "what now we are going" + gesture toward dash, car starts. Ada doesn't get her reaction line, no narration, no lip sync. She picks item from car floor, hands on lap, cut. Physical choreography consumed the animation budget. | S1-S3: (car interior, driver/passenger scene with manual blocking swap) |
| ch2_sc1_c1 | ~20 | ~7/7/6 | 3 | 10s | 15s | ✓ All 3 shots perfect. Split-screen composition preserved — no panel merging, no morphing. Shot scale (closeup/medium) obeyed. Lip sync intact including S3 (push-in + subtle facial action "eyes down, hands pressing"). Ifeoma pronunciation off (expected TTS limitation). | S1-S3: (split-screen bedroom, Ada at vanity, Emeka standing) |
| ch2_sc1_c2 | ~20 | ~7/6/7 | 3 | 10s | 15s | [REDO] ⚠ S1-S2 ✓. S3: push-in + "turns slightly toward door" + dialogue "I'll handle it" — lip sync crashed. Accent flipped to American. Even minimal physical action in S3 with push-in = failure. | S1: "You cannot manage simple money." S2: "I am asking for our daughter." S3: "I will handle it. Stop bringing this to me every morning." |
| ch2_sc1_c3 | ~20 | ~7/6/7 | 3 | 10s | 13s | [REDO] ⚠ S1-S2 ✓. S3: physical action executed (opened drawer, reached in, cut) but dialogue "Yes. We are done." never delivered. Two complex physical actions in dialogue shot consumed animation budget. Drawer IS in scene image (grounded). No morphs. Split-screen preserved. | S1: "You said that last week. And the week before." S2: "My phone is ringing. We are done here." S3: "Yes. We are done." |
| ch2_sc2_c1 | 24 | 10/9/5 | 3 | 10s | 15s | [REDO] ⚠ S1-S2 ✓ (both static). S3: push-in + facial action + 5 words — lip sync doesn't match on "Since when." Short dialogue + push-in = consistent failure. | S1: "Ada. Talk to me. You look like you have not slept." S2: "I am fine. Just tired. The house does not run itself." S3: "Tired. You are always tired. Since when?" |
| ch2_sc2_c2 | 18 | 5/9/4 | 3 | 10s | 12s | [REDO] ⚠ S1-S2 ✓ (both static). S3: push-in + facial expression + 7 words — lip sync fell apart on "Lagos people talk too much." | S1: "Ngozi. Please. Not today." S2: "I heard something. About Emeka. From Chioma's cousin." S3: "People talk. Lagos people talk too much." |
| ch2_sc2_c3 | 22 | 7/7/8 | 3 | 10s | 15s | ✓ Lip sync + dialogue delivered across all 3 shots including S3. S3 had INSERT→PULL BACK camera change + prop (paper) + dialogue — lip sync survived. BUT prop duplication: one paper became two. INSERT shot may reset animation state, avoiding temporal degradation. | S1: "Ada. This is not gossip. I am your friend." S2: "Then be my friend and leave it alone." S3: "Fine. But take this. His name is Tunde Afolabi." |
| ch2_sc3_c1 | ~15 | ~5/5/1 | 3 | 10s | 13s | ✓ All 3 shots perfect. Single character scene — no attribution ambiguity. S2 had push-in + dialogue and delivered. Solo character may negate push-in lip sync degradation. | S1: "Barrister Tunde Afolabi. What do you know, Ngozi?" S2: "Nothing is wrong. Nothing is wrong with my home." S3: "Nothing." |
| ch2_sc4_c1 | 22 | 7/8/7 | 3 | 10s | 15s | ✓ All 3 shots perfect. All static cameras, minimal grounded actions (stirring, pencil). Adult/child pairing = no attribution confusion. | S1: "Mummy. Why is Daddy always angry?" S2: "Daddy is not angry. He is just busy. Men get tired." S3: "He does not look tired. He looks angry." |
| ch2_sc4_c2 | 14 | 6/7/0 | 3 | 10s | 11s | ✓ S1 static + dialogue perfect. S2 push-in + dialogue on single character framing — delivered. S3 no dialogue: INSERT on spoon hand → tilt up to face, perfectly executed. Camera movement without dialogue = safe. | S1: "Ifeoma. Focus on your homework, my love." S2: "Mummy. I do not want to marry someone like Daddy." S3: (no dialogue — visual only) |
| ch2_sc5_c1 | 29 | 9/10/10 | 3 | 10s | 15s | [REDO] ⚠ S1-S2 delivered. S3: dialogue delivered but off-screen — Kling cut to INSERT of hands on bedpost instead of showing face. 29 words total high for 15s (~2 words/sec). Single character, not attention-split — model ran out of visual budget. | S1: "I said handle it. I do not repeat myself." S2: "The account must be clean before Friday. You hear me?" S3: "Nobody will find anything. I have made sure of that." |
| ch2_sc6_c1 | 22 | 6/8/8 | 3 | 10s | 14s | [REDO] ⚠ S1-S2 delivered. S3: ECU on eyes — dialogue delivered off-screen because framing excluded the mouth. Kling can't lip sync what it can't show. Single char. New rule: ECU on eyes + dialogue = voiceover at best. | S1: "Clean. He said clean the account." S2: "What account? He never told me about any account." S3: "Who is he talking to at this hour?" |
| ch2_sc7_c1 | 22 | 6/8/2 | 3 | 12s | 12s | ✓ All dialogue delivered with lip sync, mouth visible. S2 push-in + dialogue worked (single char). S3 ECU on face (not just eyes) = lip sync intact. Phantom props: paper + drawer hallucinated but didn't compete with dialogue. 2-word S3 delivered cleanly. | S1: "Abuja Grand Prestige Hotel. November the fourteenth." S2: "He was in Port Harcourt. He told me Port Harcourt." S3: "He lied." |
| ch3_sc1_c1 | 20 | 6/7/7 | 3 | 10s | 13s | ✓ All 3 shots perfect. All static, two characters well-separated (foreground/mid-ground), minimal body actions. | S1: "Ada, relax. It is just a party." S2: "Emeka said he might come tonight." S3: "So? You are allowed to be here too." |
| ch3_sc1_c2 | 21 | 7/6/8 | 3 | 10s | 13s | [REDO] ⚠ S1 ✓ (static). S2 push-in on single char framing in multi-char scene — delivered. S3: static CU + 8 words — lip sync fell apart. Push-in in S2 may have depleted budget for S3 even though S3 was static. | S1: "You know it is never that simple." S2: "Tonight, let it be simple. Come." S3: "Wait. Ada. Wait — do not look left." |
| ch3_sc2_c1 | 20 | 7/6/7 | 3 | 10s | 14s | [REDO] ⚠ S1-S2 ✓ (both static). S3: push-in + dialogue + multi-char — lip sync fell apart. Pattern holds. | S1: "You always look good in white, Emeka." S2: "And you always know what to say." S3: "I mean it. You belong in rooms like this." |
| ch3_sc2_c2 | 20 | 8/5/7 | 3 | 10s | 13s | ✓ All 3 shots perfect lip sync. All static. Minor hand morphing on Chidinma — cosmetic only. | S1: "We both do. That is why I chose you." S2: "Chosen. That is a big word." S3: "Do not ruin the night, Chidinma." |
| ch3_sc3_c1 | 20 | 6/7/7 | 3 | 10s | 13s | ✓ All dialogue delivered. All static. 3-char scene — visually distinct, well-separated. S3: Kling added its own insert shot of Ada after Emeka's gesture — creative improvisation, dialogue still landed. | S1: "Adaeze. I did not expect you here." S2: "Ngozi invited me. Is that a problem?" S3: "Of course not. Come, meet someone." |
| ch3_sc3_c2 | 18 | 7/6/5 | 3 | 10s | 12s | ✓ All 3 shots perfect. All static, 3-char scene. Light word density. | S1: "This is Chidinma Obi. My business associate." S2: "Mrs. Okafor. I have heard so much." S3: "Have you. How interesting." |
| ch3_sc3_c3 | 19 | 6/6/7 | 3 | 10s | 13s | [REDO] ⚠ S1 ✓. S3: ECU on eyes — dialogue "Yes. I know exactly who he is." not delivered at all (dropped entirely, not even voiceover). Silent reaction shot only. Kling also repositioned Chidinma from standing to seated — blocking drift in 3-char scene. | S1: "Chidinma handles our Port Harcourt contracts." S2: "Your husband is a very brilliant man." S3: "Yes. I know exactly who he is." |
| ch3_sc4_c1 | ~20 | ?/?/? | 3 | 10s | ~13s | [REDO] ⚠ ALL STATIC multi-char — S3 dialogue completely ignored. No narration, no lip sync. Transition to S3 executed but dialogue dropped. FIRST all-static multi-char failure — breaks the "all-static = safe" rule. | S3 dialogue dropped entirely |
| ch3_sc4_c2 | 22 | ?/?/? | 3 | 10s | 15s | [REDO] ⚠ S2 slow push-in in multi-char scene. S3: dialogue REPLACED — Kling fabricated "I will move" instead of scripted line. Worse than lip sync failure — model substituted its own words. Second dialogue-replaced instance. | S3: Kling said "I will move" instead of scripted dialogue |
| ch3_sc4_c3 | 20 | 10/4/6 | 3 | 10s | 14s | ✓ All dialogue lip synced well. All static. S3 INSERT→CU static — INSERT cut likely reset animation state. Phantom prop: "folded paper receipt" morphed out of thin air (not in scene image). | S1: "I do not know why. I just — I kept it." S2: "What is it? Show me." S3: "A hotel receipt. From his jacket." |
| ch3_sc4_c4 | 8 | 8 | 1 | 10s | 11s | ✓ Perfect. Single shot, static, wide, 8 words. Name mispronunciation (constant). Phantom prop: paper/receipt from thin air (continuity ref, not in scene image). | S1: "Ada. You need to call Tunde tonight." |
| ch3_sc5_c1 | 24 | 8/7/9 | 3 | 10s | 15s | ⚠ Kling understood phone call context — added phone audio filter to Ngozi's off-screen dialogue (S1, S3). Single char in frame (Tunde). S2: lip sync fell off on "It is past ten. What happened?" (7 words, static, single char — should have been safe). Visual-state fix confirmed: "jacket off, sleeves rolled" stripped by 3rd Vision pass. | S1: "Tunde. It is Ngozi. I need your help." S2: "Ngozi. It is past ten. What happened?" S3: "My friend. Her husband — his name is Emeka Okafor." |
| ch3_sc5_c2 | 19 | 4/7/8 | 3 | 10s | 13s | ⚠ Phone call handled well again. S1-S2 ✓. S3: ECU + slow push-in on single char — mouth visibly moving but dialogue delivered off-screen. ECU too tight for lip sync to read visually even with mouth partially visible. Push-in on single char still safe (no merge/morph). | S1: "Say that name again." S2: "Emeka Okafor. He is abusing her, Tunde." S3: "I know that name. I know it very well." |
| ch3_sc5_c3 | 22 | 7/9/6 | 3 | 10s | 14s | ⚠ Phone call context maintained. S1 ✓ (Ngozi off-screen). S2: Tunde's lip sync fell off on "this will get complicated" — 9 words, static, medium, single char, should have been safe. Third clip in this phone scene where Tunde's on-screen lip sync breaks. Phone-to-ear pose or speaker alternation may be a factor. S3 ✓ (Ngozi off-screen, CU on Tunde's reaction). | S1: "Can you help her or not?" S2: "I can. But Ngozi — this will get complicated." S3: "Complicated is better than what she has now." |
| ch3_sc5_c4 | 24 | 6/7/11 | 3 | 12s | 15s | [REDO] ⚠ Phone call context maintained. S1-S2 ✓. S3: ECU + very slow push-in + action ("lowers the phone") + dialogue + phantom prop text — WARDROBE MORPH: Tunde changed from dark suit to white traditional outfit mid-clip. Lip sync fell apart. S3 overloaded: camera move + action + dialogue + prop ref. NEW failure mode: character appearance drift under heavy S3 load. | S1: "Bring her to my office. Tomorrow morning." S2: "We will be there. Thank you, Tunde." S3: "This woman has no idea what her husband has done." |
| ch4_sc1_c1 | 19 | 6/7/6 | 3 | 10s | 13s | ⚠ S1-S2 ✓ (both static). S3: slow push-in + dialogue + multi-char — lip sync fell off on "I will try." Pattern holds. | S1: "Thank you for coming, Mrs. Okafor." S2: "Ngozi said you could help me." S3: "I will try. Tell me about your finances." |
| ch4_sc1_c2 | 17 | 4/7/6 | 3 | 10s | 12s | ⚠ S1-S2 ✓ (both static). Shot directions followed 100%. S3: slow push-in + CU + dialogue + multi-char — lip sync fell off slightly on "He said it was easier his way." Pattern holds. | S1: "My husband handles everything." S2: "Do you have a joint account with him?" S3: "He said it was easier his way." |
| ch4_sc1_c3 | 20 | 6/7/7 | 3 | 10s | 14s | [REDO] ⚠ S1-S2 ✓ (both static). S3: slow push-in + dialogue + multi-char — dialogue DROPPED entirely. Only push-in and shot direction executed, no dialogue at all. Worse than lip sync failure. | S1: "Is your name on any property document?" S2: "The house? I assumed it was both of us." S3: "You assumed. But you have never checked." |
| ch4_sc2_c1 | 20 | 6/7/7 | 3 | 10s | 13s | ✓ All static, multi-char. S3 lip sync ~98% accurate. All-static rule holds. | S1: "You have legal options, Mrs. Okafor." S2: "I am not looking for a divorce." S3: "I did not say divorce. I said options." |
| ch4_sc2_c2 | 20 | 6/7/7 | 3 | 10s | 12s | ⚠ S1 ✓ (static). S2: Kling improvised INSERT shot of card being extended — dialogue delivered off-screen over insert. S3: push-in + CU + action + dialogue + multi-char — lip sync survived. Failure shifted to S2 instead of S3. | S1: "I just want it to stop." S2: "Then take my card. Think about it." S3: "What if thinking makes things worse?" |
| ch4_sc3_c1 | 11 | 0/0/11 | 3 | 8s | 8s | [REDO] ⚠ Single char (Tunde). S1-S2 non-dialogue reaction shots — clean, no gibberish. S3: slow push-in + CU + single char — lip sync fell off. Only dialogue in the entire clip. Contradicts "single char push-in = safe" — may be pose-specific (leaning forward, looking down at documents). | S3: "She does not even know her own name is in here." |
| ch4_sc4_c1 | 13 | 3/7/3 | 3 | 10s | 10s | [REDO] ⚠ S1-S2 ✓. S3: slow push-in + action ("takes a slow sip of whiskey") + dialogue + multi-char — clip ended on the whiskey sip, dialogue never delivered. Action consumed remaining budget entirely. | S1: "You are late." S2: "I was with Ngozi. I told you this morning." S3: "Ngozi. Always Ngozi." |
| ch4_sc4_c2 | 20 | 6/6/8 | 3 | 10s | 13s | [REDO] ⚠ ALL STATIC multi-char. S1-S2 ✓. S3: CU on Adaeze, static — Kling improvised mug-drinking action (mug visible in scene image), consumed S3 entirely, dialogue dropped. Shot direction was subtle facial acting ("jaw is set") but Kling animated the prop instead. NEW: Kling prop improvisation overriding shot direction. | S1: "We had lunch. That is all." S2: "Lunch does not take six hours, Adaeze." S3: "We talked. Time passed. I am home now." |
| ch4_sc4_c3 | 10 | 2/3/5 | 3 | 10s | 10s | ✓ No lip sync issues. Very low word count (~1 word/sec). Emeka stood up in S1 matching shot direction despite being seated in scene image. Body language on point. 3rd Vision pass fired but guardrail violation (verb count +1 in S1) caused fallback to original prompt. | S1: "Come here." S2: "Emeka, I am tired." S3: "I said come here." |
| ch4_sc5_c1 | 17 | 4/5/8 | 3 | 10s | 11s | ✓ S3 push-in + CU + multi-char — lip sync survived. Physical confrontation (grabbed her arm) executed well. Phantom prop: handbag morphed out of thin air then dropped to floor (not in scene image). S3 dialogue delivered despite push-in — possible exception to multi-char push-in rule when word count is low and action is intense. | S1: "Where were you really?" S2: "Let go of me." S3: "You do not give me orders in my house." |
| ch4_sc5_c2 | 7 | ?/?/7 | 3 | 10s | 11s | [REDO] ⚠ S3: ECU + slow push-in on Adaeze + multi-char scene + 7 words "I am not afraid of you, Emeka" — lip sync failed. Pattern holds: S3 push-in + dialogue + multi-char = near-certain failure. Camera movement killed delivery. | S3: "I am not afraid of you, Emeka." |
| ch4_sc6_c1 | 9 | ?/?/9 | 3 | 10s | 12s | [REDO] ⚠ Hallway scene: S1 WIDE (Ifeoma + Mama Okafor, static) ✓, S2 CU on Mama Okafor (static) ✓, S3 CU on Ifeoma (static) — dialogue "But she is in there alone with him" (9 words) never delivered. PROP IMPROVISATION: Kling conjured an off-shoulder pink bag out of nowhere despite backpack being referenced in character portrait/grid but NOT in scene image. No bag was visible in the start frame. Kling substituted its own prop interpretation for scene context, consuming dialogue budget. Props in character descriptions don't translate to scene; props must be baked into location prompts. | S1: "What happened?" S2: "He came for her. In the morning." S3: "But she is in there alone with him." |
| ch4_sc6_c2 | 22 | 7/7/8 | 3 | 10s | 13s | ✓ Same hallway, Ifeoma + Mama Okafor. S1 WIDE static (7 words), S2 CU on Ifeoma slow push-in + turn + dialogue "That is not an answer, Grandma" (7 words) — LANDED (single-char push-in works when isolated), S3 CU on Mama Okafor static "Forget what you heard. Go. Now." (8 words) — minor lip sync fail on "Go. Now." Staccato phrasing may be hard for Kling. | S1: (7 words) S2: "That is not an answer, Grandma" S3: "Forget what you heard. Go. Now." |
| ch4_sc7_c1 | 17 | 6/4/7 | 3 | 10s | 12s | ⚠ Bedroom scene, Ifeoma at desk, Adaeze on bed. All static cameras. S1 WIDE static Adaeze speaks (6 words), S2 CU on Ifeoma static "I heard you, Mummy" (4 words) — single word failure "Mummy" dropped. Trailing word cut. S3 CU on Adaeze static (7 words) — landed. | S1: (6 words) S2: "I heard you, Mummy" S3: (7 words) |
| ch4_sc7_c2 | 14 | 6/6/7 | 3 | 10s | 13s | [REDO] ⚠ Same bedroom continuation. S1 WIDE static, Ifeoma delivers "Mummy. Why do you stay?" (6 words) — dialogue delivered but stiff/static character, no lip sync on WIDE (face too small). S2 ECU on Adaeze slow push-in, "Ifeoma —" (1 word) — no tears animated, stiff. S3 CU on Ifeoma static "You do not have to answer" (7 words) — FAILED, "reaches out" direction caused big arm raise, dialogue dropped. | S1: "Mummy. Why do you stay?" S2: "Ifeoma —" S3: "You do not have to answer" |
| ch4_sc8_c1 | 55 | 0/5/0 | 3 | 8s | 10s | ✓ Bathroom, single character Adaeze. S1 WIDE static no dialogue — clean. S2 MEDIUM static "Mummy. Why do you stay?" (5 words) — landed clean. S3 ECU slow push-in, no dialogue, just visual — clean. Textbook safe setup: dialogue on MEDIUM static, camera movement reserved for non-dialogue shot. Single character on dialogue eliminates multi-char merge risk. | S2: "Mummy. Why do you stay." |
| ch5_sc1_c1 | 56 | 6/8/8 | 3 | 12s | 14s | [REDO] ⚠ Ngozi's apartment, Tunde + Ngozi multi-char scene. S1 WIDE ESTABLISHING static, Tunde faces camera "Ngozi, sit down. This is serious." (6 words) — lip sync WORKED because Tunde's face visible to camera on WIDE. Proves WIDE ≠ automatic failure; face visibility is the constraint, not shot size. S2 MEDIUM static on Ngozi "You are scaring me, Tunde. Just talk." (8 words) — landed. S3 CU on Tunde slow push-in "Emeka has a shell company. Fake construction subsidiary." (8 words) — lip sync FAILED, push-in killed dialogue delivery despite face visible and single-char isolation. Push-in failure in single-char S3 contradicts ch4_sc8_c1 where single-char S3 push-in was clean. Difference: ch4_sc8_c1 had no dialogue on push-in shot, ch5_sc1_c1 had 8 words on push-in. Word count on single-char push-in may have ceiling. | S1: "Ngozi, sit down. This is serious." S2: "You are scaring me, Tunde. Just talk." S3: "Emeka has a shell company. Fake construction subsidiary." |
| ch5_sc1_c2 | 23 | 6/7/10 | 3 | 10s | 13s | [REDO] ⚠ Same apartment continuation, Tunde + Ngozi multi-char. S1 WIDE static Ngozi "Fake? What does that mean exactly?" (6 words) — face visible, landed. S2 MEDIUM static Tunde "He has been laundering money. Government contracts." (7 words) — lip sync failed on "government contracts", gesture direction "taps documents firmly with two fingers" ate dialogue budget. S3 MEDIUM static Ngozi "Okay. Emeka is a criminal. We knew he was bad." (10 words) — lip sync failed, "jaw tightens, bitter laugh escaping" body language ate budget. Pattern observed: directed gestures/actions in S2-S3 compete with lip sync. | S1: "Fake? What does that mean exactly?" S2: "He has been laundering money. Government contracts." S3: "Okay. Emeka is a criminal. We knew he was bad." |
| ch5_sc1_c3 | 23 | 8/7/8 | 3 | 12s | 14s | [REDO] ⚠ Same apartment continuation. S1 WIDE static Tunde "Ngozi. Adaeze's signature is on seven filings." (8 words) — face visible, landed. S2 ECU static Ngozi "Her signature? She signed for his fraud?" (7 words) — lip sync failed on "her signature", facial expression direction ("face drains, eyes widening in horror") competed with dialogue. S3 CU slow push-in Tunde "She did not sign. Someone signed for her." (8 words) — LANDED. Push-in with minimal body direction ("eyes hold steady") worked. Insight: push-in succeeds when body language is minimal/static despite camera movement. | S1: "Ngozi. Adaeze's signature is on seven filings." S2: "Her signature? She signed for his fraud?" S3: "She did not sign. Someone signed for her." |
| ch5_sc2_c1 | 21 | 9/6/6 | 3 | 10s | 13s | [REDO] ⚠ Ngozi's apartment, Adaeze on sofa, Ngozi by window. All static. S1 WIDE ESTABLISHING static Ngozi "Ada. I need you to look at something." (9 words) — lip sync failed on "something", Ngozi's face turned away from camera. S2 MEDIUM static Adaeze "You called me urgently. What happened?" (6 words) — pronunciation issue "urgently" became "urgencently" (TTS issue). S3 MEDIUM static Ngozi "Tunde brought documents. About Emeka's company." (6 words) — lip sync failed, "turns slightly toward Adaeze" direction may have eaten budget. Face position matters more than camera angle for lip sync — dialogue fails when speaking character's face turned away even in static shot. | S1: "Ada. I need you to look at something." S2: "You called me urgently. What happened?" S3: "Tunde brought documents. About Emeka's company." |
| ch5_sc2_c2 | 18 | 5/5/8 | 3 | 10s | 12s | [REDO] ⚠ Same apartment continuation. S1 WIDE slow push-in, Adaeze leaning forward, two chars. "What kind of documents, Ngozi?" (5 words) — Kling morphed documents into her hands (prop improvisation) but dialogue LANDED despite push-in. S2 CU static Ngozi "Company filings. Fraud filings. Look at page three." (8 words) — no issues, clean. S3 ECU static Adaeze "That is my name. That is my signature." (9 words) — dialogue NEVER DELIVERED. "Face goes pale, lips barely moving" direction implicitly suppressed lip sync. NEW category: shot directions describing suppressed emotional states can contradict lip sync animation requirements, causing dialogue dropout. | S1: "What kind of documents, Ngozi?" S2: "Company filings. Fraud filings. Look at page three." S3: "That is my name. That is my signature." |
| ch5_sc2_c3 | 23 | 9/8/10 | 3 | 10s | 13s | [REDO] ⚠ Same apartment continuation. S1 WIDE static Chidinma "I thought you would be different. I thought —" (9 words + trail off) — landed clean. S2 MEDIUM on Emeka static "You thought wrong. We are not doing this." (8 words) — landed clean. S3 ECU on Chidinma slow push-in "Do I mean nothing to you? Nothing at all?" (10 words) — gibberish at 12s instead of dialogue, clip ended at 14s. Push-in + tears + emotional direction ("tears streaming, voice breaking") corrupted output. New pattern: emotional action directions (crying, laughter, vocal emotion) in S3 push-in shots degrade dialogue quality even when lip sync nominally "works". | S1: "I thought you would be different. I thought —" S2: "You thought wrong. We are not doing this." S3: "Do I mean nothing to you? Nothing at all?" |
| ch5_sc3_c1 | 19 | 4/6/9 | 3 | 10s | 12s | ✓ Emeka's office, Chidinma + Emeka. All static. S1 WIDE static Chidinma "Emeka. I am pregnant." (4 words) — no issues. S2 MEDIUM on Emeka static "Close the door behind you first." (6 words) — no issues (dialogue-scene mismatch noted: no door context in scene image, characters already positioned at desk). S3 CU on Chidinma static "Did you hear what I said to you?" (9 words) — 95% accurate, clean delivery. All static + few words = reliable. Blocking consistency: static camera protects dialogue even with multi-character scenes when shot scales and word counts are balanced. | S1: "Emeka. I am pregnant." S2: "Close the door behind you first." S3: "Did you hear what I said to you?" |
| ch5_sc3_c2 | 21 | 5/8/8 | 3 | 10s | 13s | ✓ Same office continuation. All static. S1 WIDE static Emeka "I heard you. Handle it." (5 words) — clean despite arms crossing + Chidinma stepping forward. S2 CU on Chidinma static "Handle it? That is all you can say?" (8 words) — clean despite "mouth drops open" direction. S3 MEDIUM on Emeka static "This is not the time for this, Chidinma." (8 words) — clean despite paper straightening + not looking up. All shots landed with micro delay on S3 only (1-2 frame slip visible but dialogue intact). Inconsistent with earlier clips (ch5_sc2_c2 where idle posture actions killed dialogue). Pattern emerging: ACTIVE intentional body actions (arms crossing, opening mouth, not looking up) execute cleanly even in multi-char dialogue shots; PASSIVE emotional states ("face goes pale", "tears streaming") degrade lip sync. Action quality and intention may matter more than action type. | S1: "I heard you. Handle it." S2: "Handle it? That is all you can say?" S3: "This is not the time for this, Chidinma." |
| ch5_sc3_c3 | 26 | ~9/~9/~8 | 3 | 11s→15s | 15s | ✓ Same office, Chidinma stands, Emeka sits. All static camera. S1 WIDE static — lip sync PERFECT on wide. S2 MEDIUM static — lip sync PERFECT. S3 ECU static — lip sync PERFECT. All three shot scales delivered clean dialogue with zero competition: no push-in, no emotional state directions, no gestures. Duration bumped from 11s to 15s gave comfortable pacing for 26 words. Key insight: when ALL animation budget goes to lip sync (static camera + no competing body/emotion directions), every shot scale works — WIDE, MEDIUM, ECU all deliver equally. This is the cleanest 3-for-3 in the dataset. | S1–S3: dialogue TBD (perfect delivery across all shots) |

| ch5_sc4_c1 | 23 | 9/10/6 | 3 | 10s | 14s | ⚠ Same office, positions FLIPPED vs ch5_sc3 (continuity violation — 180° rule broken between scene images). All static camera. S1 WIDE ESTABLISHING static Emeka "You knew what this was from the beginning." (9 words) — lip sync fine, face visible. S2 CU on Chidinma static "You do not get to say that to me." (10 words) — lip sync slightly off. "Jaw tightens, low fury rising in her eyes" direction competed with mouth animation — jaw-clenching is lip-sync-suppressing. S3 MEDIUM on Emeka static "Take the envelope. Solve the problem." (6 words) — "Take the envelope" lip-synced, "Solve the problem" delivered but NO lip sync. "Slides envelope forward with one finger" prop interaction ate remaining budget. Envelope baked into start frame = no prop morphing (props-in-scene rule validated). Pattern: even static camera can't fully protect lip sync when jaw-suppressing or prop-interaction directions compete. | S1: "You knew what this was from the beginning." S2: "You do not get to say that to me." S3: "Take the envelope. Solve the problem." |

| ch5_sc5_c1 | 22 | 8/6/8 | 3 | 10s | 13s | ✓ Tunde's law office, Adaeze seated center-left, Tunde standing right by window in profile. All static camera. S1 WIDE ESTABLISHING static Tunde "Thank you for coming, Adaeze. Sit, please." (8 words) — clean despite Tunde in three-quarter/profile angle. Face visible enough for lip sync. S2 MEDIUM on Adaeze static "Ngozi told me what you found." (6 words) — clean, hands over documents but no directed interaction. S3 MEDIUM on Tunde static "I need you to understand the full picture." (8 words) — 90% accurate, minor slip. "Removes glasses briefly, puts them back on" two-part prop interaction caused slight budget competition but didn't kill delivery. Glasses interaction lighter than expected — perhaps because glasses are a face-adjacent prop so animation stays in the lip sync zone. | S1: "Thank you for coming, Adaeze. Sit, please." S2: "Ngozi told me what you found." S3: "I need you to understand the full picture." |
| ch5_sc5_c2 | 27 | 8/8/10 | 3 | 10s | 15s | [REDO] ⚠ Same law office continuation. S1 WIDE static Adaeze "My name is on fraud documents. I understand." (8 words) — clean, stares at documents, no competing action. S2 CU on Tunde static "If EFCC reaches your name before we act —" (8 words) — clean, eyes direct, minimal body direction. S3 CU on Adaeze SLOW PUSH-IN "They will arrest me. For something I did not do." (10 words) — lip sync FELL APART entirely, mouth doesn't match dialogue. "Face drains, the full horror of it landing" = passive emotional state direction + push-in = total lip sync failure. PATTERN CONFIRMED: push-in + passive emotional state direction ("face drains/goes pale/tears streaming") on dialogue shot = near-certain lip sync destruction. This is now ch5_sc2_c3 (gibberish), ch5_sc2_c2 ("lips barely moving"), and ch5_sc5_c2 — three consecutive examples of the same failure mode. Multi-step prop note from ch5_sc5_c1: Kling only executed first half of "removes glasses, puts back on" — truncated multi-step directions. | S1: "My name is on fraud documents. I understand." S2: "If EFCC reaches your name before we act —" S3: "They will arrest me. For something I did not do." |
| ch5_sc4_c2 | 25 | 9/3/7 | 3 | 11s | 12s | [REDO] ⚠ Same office continuation. All static camera. S1 WIDE static Chidinma "I am not your problem to solve, Emeka." (9 words) — picks up envelope and holds it out, lip sync WORKED despite prop interaction. Prompt said "envelope" but start frame has papers on desk — Kling substituted nearest visible prop (papers for envelope). No morph because similar prop already present. S2 CU on Chidinma static "Keep your money." (3 words) — places paper back on desk, lip sync WORKED. Short line + existing prop substitution = clean. S3 MEDIUM on Emeka static "Close the door on your way out." (7 words) — DIALOGUE CROSS-CONTAMINATION: Emeka repeated Chidinma's S2 line ("Keep your money") instead of delivering his own. NEW failure category: speaker-assignment confusion. Back-to-back character cuts with short lines may cause Kling to lose track of which dialogue belongs to which character. Prop substitution: Kling used existing papers on desk instead of conjuring an envelope — similar visible props get repurposed rather than morphed. Prop interactions with substituted props didn't kill lip sync. | S1: "I am not your problem to solve, Emeka." S2: "Keep your money." S3: "Close the door on your way out." |

| ch5_sc5_c3 | 22 | 9/5/7 | 3 | 10s | 13s | [REDO] ⚠ Same law office. All static camera. S1 WIDE static Tunde "Yes. Unless you cooperate with investigators first." (9 words) — nods while speaking, clean delivery. Nod is face-adjacent, doesn't compete. S2 MEDIUM static Adaeze "Cooperate. Against my own husband." (5 words) — "Cooperate" landed, "against my own husband" fell apart. "Exhales a short bitter breath, eyes dropping to the floor" — exhale animation + eyes-away-from-camera competed with second half of dialogue. Eyes dropping = face turning away = lip sync loss on remaining words. S3 CU static Tunde "He made you a suspect, Adaeze. Not me." (7 words) — lip sync fell off entirely. Tunde in profile position from start frame (gaze directed outward through window) — CU on profile character = mouth partially occluded even at close range. Face visibility rule confirmed again: profile angle defeats CU. Also "voice firms with quiet compassion" is an unactionable vocal quality direction. | S1: "Yes. Unless you cooperate with investigators first." S2: "Cooperate. Against my own husband." S3: "He made you a suspect, Adaeze. Not me." |

| ch5_sc5_c4 | 17 | 6/6/4 | 3 | 10s | 11s | ✓ Same law office. S1 WIDE static Adaeze "What else must I do?" (6 words) — 100% lip sync, "straightens slightly" is light non-competing gesture. S2 MEDIUM static Tunde "File for legal separation. Today if possible." (6 words) — 90% lip sync. "Turns slightly from window toward her" = body rotation ate minor budget but improved face visibility (profile → three-quarter). Trade-off: turning toward camera helps lip sync even though the turn itself costs budget. S3 ECU on Adaeze SLOW PUSH-IN "Separation. After twelve years." (4 words) — 85% lip sync despite push-in + "eyes close then open — hollow" emotional direction. SURVIVED because only 4 words. Compare: ch5_sc5_c2 S3 (10 words, same combo) = total failure. ch5_sc2_c3 S3 (10 words) = gibberish. Pattern refinement: push-in + emotional state + dialogue fails at high word counts (8+) but can partially survive at very low word counts (≤4). Word count is a mitigating factor for budget competition. | S1: "What else must I do?" S2: "File for legal separation. Today if possible." S3: "Separation. After twelve years." |

| ch5_sc5_c5 | 22 | 8/9/5 | 3 | 10s | 13s | ⚠ Same law office. All static camera. S1 WIDE static Tunde "It creates distance from his assets legally." (8 words) — 80% lip sync, profile angle degraded but didn't kill delivery. Consistent: profile = ~80% ceiling on WIDE. S2 CU on Adaeze static "I am trapped. He trapped me without my knowing." (9 words) — Kling REFRAMED the CU onto the papers on the desk instead of Adaeze. She's out of focus, only bottom jaw visible, but still delivered the line through visible jaw. NEW issue: Kling may reframe CU shots toward objects mentioned in scene preamble ("fraud documents open on the desk") rather than following the character-target in shot direction. "Hands press flat against her knees" body direction may have also pulled camera lower. S3 MEDIUM static Tunde "There is one more thing." (5 words) — 60% lip sync. "Pauses and looks at her directly" = pause ate time budget, profile→three-quarter turn insufficient for clean delivery. Even short lines (5 words) struggle when starting from profile position. | S1: "It creates distance from his assets legally." S2: "I am trapped. He trapped me without my knowing." S3: "There is one more thing." |

| ch5_sc5_c6 | 21 | 6/7/8 | 3 | 11s | 12s | ✓ Same law office, chapter-ending reveal. S1 WIDE SLOW PUSH-IN Adaeze "What more can there be?" (6 words) — 90% lip sync. Push-in + "utterly exhausted" emotional state survived with only 6 words. Word-count mitigation confirmed: ≤6 words can survive push-in + emotional combo. "Photograph lies on desk" = phantom prop (not in start frame). S2 CU on Tunde static "She is not just his girlfriend." (7 words) — 90% lip sync. Profile angle held up better here. "Watches her face" direction may have pulled him slightly toward camera. S3 ECU on Adaeze static, Tunde speaking OFF-SCREEN "She is his business partner in the fraud." (8 words) — 90% lip sync. NEW: Kling generated the described photograph content as an overlay — "emeka and chidinma at government ministry signing documents" rendered as picture-in-picture insert of husband signing papers. Kling interpreted photograph description as visual instruction and composited it into the ECU reaction shot. Off-screen dialogue delivery (speaker not on camera) works well — lip sync is audio-only, no mouth animation needed. | S1: "What more can there be?" S2: "She is not just his girlfriend." S3: "She is his business partner in the fraud." |

| ch6_sc1_c1 | 24 | 8/8/7 | 3 | 10s | 14s | ⚠ Pastor's church office, 3 characters: Adaeze center facing away, Pastor behind desk, Emeka left partially visible from behind. S1 WIDE ESTABLISHING static Emeka "Pastor, I brought her here for guidance." (8 words) — 98% lip sync despite being "partially visible from behind." Kling may have rotated him enough, or WIDE gave sufficient room. S2 MEDIUM on Pastor static "A wise husband seeks counsel. God is pleased." (8 words) — 98%, "opens hands over Bible" gentle gesture didn't compete. S3 MEDIUM on Pastor SLOW PUSH-IN "Adaeze, a virtuous wife is a crown." (7 words) — 60% lip sync. Shot direction FAILED: "turns gaze toward left of frame" was IGNORED, Pastor stayed facing camera. Despite staying camera-facing (which should help), push-in still degraded to 60% on 7 words. Confirms push-in costs budget regardless of face angle. Gaze direction ignored = Kling prioritized push-in animation over gaze turn. | S1: "Pastor, I brought her here for guidance." S2: "A wise husband seeks counsel. God is pleased." S3: "Adaeze, a virtuous wife is a crown." |

| ch6_sc1_c2 | 23 | 8/8/7 | 3 | 10s | 14s | ⚠ Same pastor's office, 3 characters. S1 WIDE static Pastor "Submission is not weakness. It is holy strength." (8 words) — 98%, camera-facing behind desk, clean. S2 MEDIUM on Emeka static "She has been pulling away, Pastor. From me." (8 words) — 98%, "shifts forward, expression wounded and performative" didn't degrade. Despite starting from behind/partial visibility, MEDIUM reframe caught his face. S3 MEDIUM on Pastor SLOW PUSH-IN "Sister Adaeze, is there something troubling you?" (7 words) — lip sync good until "...something troubling you" (approx word 5-6). PROGRESSIVE BUDGET DEPLETION confirmed: push-in eats lip sync budget over time — early words survive, later words fail. Nearly identical to ch6_sc1_c1 S3 (60% on 7 words with push-in). Push-in tax is time-based, not instant. | S1: "Submission is not weakness. It is holy strength." S2: "She has been pulling away, Pastor. From me." S3: "Sister Adaeze, is there something troubling you?" |

| ch6_sc1_c3 | 25 | 8/7/9 | 3 | 11s | 14s | [REDO] ⚠ Same pastor's office, 3 characters. S1 WIDE static Adaeze "Yes, Pastor. There is something troubling me." (8 words) — 95% lip sync. Adaeze facing AWAY from camera but "lifts chin slowly" gave enough face visibility. Body language of person speaking animated well, mouth moving visible even from back-angle. Kling can animate speech from partial-rear view when chin/jaw are visible. S2 CU on Adaeze SLOW PUSH-IN "I am afraid inside my own home." (7 words) — 98% lip sync. Push-in SUCCEEDED here despite 7 words — contradicts progressive depletion pattern. Possible factors: continuation cut from same character (S1→S2 momentum), minimal competing direction ("grip tightening" is subtle hand action). S3 CU on Emeka static "Ada — do not embarrass us in this place." (9 words) — lip sync FAILED, mouth doesn't match lines. Emeka starting from behind/partial visibility, CU reframe insufficient for proper face orientation in 3-character scene. | S1: "Yes, Pastor. There is something troubling me." S2: "I am afraid inside my own home." S3: "Ada — do not embarrass us in this place." |

| ch6_sc2_c1 | 24 | 9/7/8 | 3 | 11s | 15s | [REDO] ⚠ Pastor's office, Emeka gone, 2 characters. Adaeze left facing desk (good camera angle), Pastor right behind desk. S1 WIDE static Adaeze "Pastor, he hits me. Not with his hands always." (9 words) — 98%, closest to camera, clean. S2 CU on Adaeze SLOW PUSH-IN "With silence. With shame. With his eyes." (7 words) — good until "with silence" (word 2-3). EARLY push-in breakdown. Possible cause: staccato sentence structure (three short phrases with periods/pauses) disrupts lip sync rhythm during push-in. Each micro-stop between phrases breaks Kling's momentum more than a flowing sentence would. S3 MEDIUM on Pastor static "Sister, every marriage has its seasons of trial." (8 words) — FAILED despite static camera. "Shifts in chair, fingers tightening, rehearsed warmth cracking" = multiple competing micro-actions (body shift + finger action + emotional expression) overwhelmed lip sync budget even without push-in. Confirms: stacking multiple body/emotion directions on one shot kills lip sync regardless of camera movement. | S1: "Pastor, he hits me. Not with his hands always." S2: "With silence. With shame. With his eyes." S3: "Sister, every marriage has its seasons of trial." |

| ch6_sc2_c2 | 17 | 9/8/0 | 3 | 11s | 11s | [REDO] ⚠ Same pastor's office, 2 characters. S1 WIDE static Pastor "Prayer and patience — God honors a faithful wife." (9 words) — no issues, clean from behind desk. S2 CU on Adaeze static "Pastor, does God want me to disappear?" (8 words) — started good, fell apart at "...want me to disappear?" (word 5-6). UNEXPECTED: static camera, CU, face-stabilizing direction ("utterly still, eyes locked"), no competing actions — should have been clean. Possible cause: "soft devastating" accent direction may trigger emotional expression animation that overrides "utterly still" instruction. Or late-shot budget depletion even on static. Anomalous failure. S3 CU on Pastor SLOW PUSH-IN, NO DIALOGUE — pure reaction shot. "Mouth opens, nothing comes out, eyes drop to Bible." Body language on point. Push-in + no dialogue = full animation budget for visual performance. Confirms: push-in is safe when no lip sync required. | S1: "Prayer and patience — God honors a faithful wife." S2: "Pastor, does God want me to disappear?" S3: (silence — reaction only) |

| ch6_sc3_c1 | 26 | 7/10/9 | 3 | 10s | 14s | ✓ Church corridor, 2 characters, all static camera. Obinna seated left closest to camera, Pastor standing in doorway right. S1 WIDE static 98%, S2 MEDIUM static 98%, S3 MEDIUM static 98%. Perfect 3-for-3. No push-in, no heavy emotional/body directions, both characters face-visible. "Slightly startled, composure reassembling" (S2) and "eyes steady" (S3) are light enough to not compete. Textbook clean clip: static camera + face-visible + minimal competing directions = reliable lip sync across all shot scales. | S1: "Pastor. I was waiting out here." S2: "Brother Obinna. I did not know you were here." S3: "The walls in this corridor are very thin." |

| ch6_sc3_c2 | 24 | 9/7/10 | 3 | 11s | 15s | [REDO] ⚠ Same corridor. S1 WIDE static Obinna "Did my brother put you up to this?" (9 words) — 98%, clean. S2 MEDIUM on Pastor static — WRONG SPEAKER delivered the line. Pastor spoke but camera/dialogue was correctly assigned. S3 CU on Obinna SLOW PUSH-IN — DIALOGUE CROSS-CONTAMINATION: Pastor delivered Obinna's line instead. Camera was on Obinna (seated) but Pastor's voice continued from S2. Second instance of speaker-assignment confusion (first: ch5_sc4_c2). Pattern: when S2→S3 switches speakers, Kling sometimes keeps the S2 speaker's voice going into S3 regardless of the shot direction's character target. Multi-element reference in shot direction may confuse Kling about who is speaking. "Jaw tightens" lip-sync-suppressing direction on S3 was moot since wrong speaker delivered. | S1: "Did my brother put you up to this?" S2: "The church counsels all troubled marriages —" S3: "He called you before she even agreed to come." |

| ch6_sc4_c1 | 24 | 9/7/8 | 3 | 11s | 14s | ⚠ Single character — Chidinma alone in apartment. S1 MEDIUM static "He gave me money to make it go away." (9 words) — 98%, head slightly bowed, clean. S2 CU SLOW PUSH-IN "Like I am something to be managed." (7 words) — 98% until "managed" which got pronunciation-mangled by TTS. Single-character push-in survived (consistent with earlier single-char push-in safety). NEW: word pronunciation failure — "managed" mangled, similar to "urgently"→"urgencently" (ch5_sc2_c1). Upstream work: difficult-word replacement pass before generation. S3 ECU static "EFCC Whistleblower Hotline — I have information." (7 words) — lip sync degraded. "Jaw is set" = lip-sync-suppressing jaw direction (3rd instance: ch5_sc4_c1, ch6_sc2_c1, now this). "EFCC" acronym may also be hard for TTS. | S1: "He gave me money to make it go away." S2: "Like I am something to be managed." S3: "EFCC Whistleblower Hotline — I have information." |

| ch6_sc5_c1 | 26 | 8/8/10 | 3 | 10s | 15s | ⚠ Ngozi's apartment, 2 characters. S1 WIDE static Adaeze "I spoke, Ngozi. In front of the pastor." (8 words) — 98%, closest to camera, clean. S2 MEDIUM static Ngozi "You spoke? Ada, what did you say?" (8 words) — 80%. "Leans further forward, eyes wide, urgency in whole body" = stacked body directions degraded static shot. 3rd instance of direction-stacking killing static shots (ch6_sc2_c1, ch5_sc5_c3, now this). S3 MEDIUM SLOW PUSH-IN Adaeze "I told him I am afraid in my own home." (10 words) — 90%. Push-in SURVIVED 10 words because zero competing directions: "hands still in lap" (explicit non-action) + "states it plainly" (no physical animation). KEY REFINEMENT: push-in tax scales with competing direction count, not fixed. Push-in + zero directions = ~90% even at 10 words. Push-in + emotional state = total failure. Push-in alone ≠ automatic failure. | S1: "I spoke, Ngozi. In front of the pastor." S2: "You spoke? Ada, what did you say?" S3: "I told him I am afraid in my own home." |

| ch6_sc5_c2 | 24 | 7/8/9 | 3 | 10s | 14s | [REDO] ⚠ Same apartment. S1 WIDE static Ngozi "Jesus. And what did the pastor say?" (7 words) — NO LIP SYNC. "Hand goes to mouth briefly" + cup visible in start frame = Kling interpreted gesture as drinking tea, line became narration/voiceover. Prop-interaction-overrides-dialogue: hand-to-mouth + visible cup = physical action wins over speech. S2 CU static Adaeze "He said nothing. He had no answer." (8 words) — 98%, "small sad smile crosses lips" didn't compete. S3 CU SLOW PUSH-IN Ngozi "Ada. I am so proud of you right now." (9 words) — 98%. Push-in + emotional DESCRIPTION ("eyes bright, fierce, emotional") survived. CONFIRMED: emotional descriptions ≠ emotional state animations. Descriptions don't compete; animation directives ("face drains", "tears streaming") do. DURATION ISSUE: all dialogue done by 10-11s, clip runs to 14s. Extra 3-4s = Kling filled with phantom animations (morphing hands, mouth wiping). Formula `words/2.0` too conservative — actual delivery rate ~2.5-3 wps. Upstream: recalibrate duration formula. | S1: "Jesus. And what did the pastor say?" S2: "He said nothing. He had no answer." S3: "Ada. I am so proud of you right now." |

| ch6_sc5_c3 | 25 | 7/8/10 | 3 | 11s | 12s | ✓ Same apartment. Duration formula fix applied (12s vs old 15s). S1 WIDE static Adaeze "I want to cooperate with Tunde's investigation." (7 words) — 90%, "hands pressing flat on knees" body action or face angle toward Ngozi slightly off-camera. S2 MEDIUM static Ngozi "Are you sure? Once you do this —" (8 words) — 98%, "leans back slightly" is light. S3 CU SLOW PUSH-IN Adaeze "I know. I am terrified of what he will do." (10 words) — 90%. Push-in + 10 words + emotional DESCRIPTION ("fear and resolve living in the same face") survived. 3rd confirmation: emotional descriptions don't compete with push-in lip sync. Descriptions ≠ state animations. | S1: "I want to cooperate with Tunde's investigation." S2: "Are you sure? Once you do this —" S3: "I know. I am terrified of what he will do." |

| ch6_sc6_c1 | 22 | 8/9/5 | 3 | 10s | 11s | [REDO] ⚠ Re-generated after recovery false positive (original matched wrong clip at 86%). S1 WIDE static Ngozi "Whatever happens, you do not face it alone." (8 words) — 98%, clean. S2 CU static Adaeze "I have been alone for a long time, Ngozi." (9 words) — 98%, clean. S3 MEDIUM SLOW PUSH-IN Ngozi "Not anymore. Not from today." (5 words) — DIALOGUE NEVER REACHED. Ngozi holding cup in start frame → Kling animated cup-setting-down action, filled entire shot, cut before dialogue. Props-in-hand in start frame = Kling prioritizes prop animation over speech. Same pattern as ch6_sc5_c2 S1 (hand-to-mouth + cup = voiceover). Upstream: characters holding objects in start frame are dialogue-hostile when the shot direction implies any interaction. | S1: "Whatever happens, you do not face it alone." S2: "I have been alone for a long time, Ngozi." S3: "Not anymore. Not from today." |

| ch6_sc6_c2 | 12 | 5/6/1 | 3 | 12s | 12s | ✓ Same apartment. S1 WIDE static Adaeze "Unknown number. Should I answer?" (5 words) — 98%. Phone materialized on lap (not in start frame but prompt mentioned "phone on knee buzzing"). Small prop morph worked — phone on lap is subtle enough. S2 MEDIUM static Ngozi "Answer it. We are done hiding." (6 words) — 90%, "jaw set" direction dipped it slightly (4th instance of jaw directions competing). S3 CU SLOW PUSH-IN Adaeze "Hello?" (1 word) — 98%. Phone-to-ear prop interaction + push-in + 1 word = trivially safe. Ultra-short dialogue survives any combination of competing directions. | S1: "Unknown number. Should I answer?" S2: "Answer it. We are done hiding." S3: "Hello?" |

| ch7_sc1_c1 | 18 | 9/4/5 | 3 | 10s | ~10s | ✓ Lagos café, Adaeze + Chidinma. S1 WIDE static 9 words — 98%. S2 CU static 4 words — 98%. S3 CU PUSH-IN + "jaw tightens" + 5 words — 85%. Low word count (5) saved S3 despite push-in + jaw direction (confirmed lip-sync suppressor). Supports ≤5 words surviving any competing direction combo. No [REDO] — 85% is serviceable. | S1: (9 words) S2: (4 words) S3: (5 words + jaw tightens) |

| ch8_sc5_c1 | 27 | 8/9/10 | 3 | 10s | 12s | ✓ Okafor bedroom, Emeka + Mama Okafor. RECOVERED via asset library after double timeout + SESSION_EXPIRED fix + prompt_used matching fix. S1 98% — phantom prop: hangers morphed into wardrobe (not in scene image). S2 95%. S3 89% — 10 words, slight dip but serviceable. All shots delivered. No [REDO]. | S1: "Where is she? Where did she go?" S2: "I did not know she was leaving, Emeka." S3: "You were here. You were in this house." |

| ch10_sc9_c1 | 14 | 3/4/7 | 3 | 12s | 12s | ✓ FINAL CLIP. Same bedroom, Adaeze alone at vanity. SINGLE CHAR. Series finale — mirror scene. S1 MEDIUM static "hands flat on surface" (pose) + "looks at herself in mirror" + "I see you." (3 words) — 98%. Trivially safe. S2 CU slow push-in "reflection in mirror" (mirror framing) + "eyes are full — not of tears, but of recognition" (description) + "I always saw you." (4 words) — 98%. Mirror reflection framing confirmed reliable (2nd success). ≤4 words + push-in + single char = bulletproof. S3 ECU static "direct to camera" (fourth wall break) + "slow private smile" (pose, not laughter) + "holds her own gaze" + "You are still here. That is enough." (7 words) — 98%. Direct-to-camera framing worked — Kling understood the instruction. Smile = pose (coexists with speech), consistent with pattern. Perfect 3-for-3 sweep on the final clip. Single char + low word counts + descriptions only = the template for reliable delivery. **OBSERVATION 150/150 COMPLETE.** | S1: "I see you." S2: "I always saw you." S3: "You are still here. That is enough." |

| ch10_sc8_c2 | 11 | 6/3/2 | 3 | 10s | 10s | ✓ Same bedroom, Adaeze alone at vanity. SINGLE CHAR. S1 MEDIUM static "looking at reflection, hand raised slightly" (pose) + "I am not hiding anything anymore." (6 words) — 98%. S2 ECU INSERT on hand static "slides wedding band off finger" (accessory removal) + "Not even myself." (3 words) — voiceover delivery (no mouth visible), dialogue fine. VISUAL ARTIFACT: ring removal caused finger morphing — Kling can't cleanly animate removing a worn accessory. She holds a ring but still wears one on the finger (duplication). Kling handles props picked up/set down but REMOVING WORN ACCESSORIES (ring, glasses, necklace) requires modifying character appearance mid-shot which it can't do. Accessory stays rendered + duplicate appears in hand. Cosmetic issue, dramatic intent reads. S3 CU slow push-in "places ring in drawer" + "closes drawer" + "looks up at reflection" + "smiles" (4 sequential actions) + "Goodbye, Emeka." (2 words) — 98%. 2 words = trivially safe. Single char absorbed all choreography. | S1: "I am not hiding anything anymore." S2: "Not even myself." S3: "Goodbye, Emeka." |

| ch10_sc8_c1 | 18 | 6/6/6 | 3 | 10s | 10s | ✓ Bedroom at night, Adaeze alone at vanity. SINGLE CHAR. S1 MEDIUM static "hands resting on surface" (pose) + "It is empty now. The drawer." (6 words) — 98%. Facing away toward mirror but dialogue delivered. S2 CU static "in the mirror reflection" (mirror framing) + "opens vanity drawer" (prop interaction) + "Everything I hid. Gone. As evidence." (6 words) — 98%. Mirror reflection framing worked — Kling understood the instruction. Drawer opening didn't compete at 6 words on single char. S3 CU slow push-in "eyes settle on reflection" (eye direction) + "Good. Let it serve its purpose." (6 words) — 98%. Single char push-in safe. Perfect 3-for-3. Single char + balanced 6/6/6 word counts = reliable sweep. | S1: "It is empty now. The drawer." S2: "Everything I hid. Gone. As evidence." S3: "Good. Let it serve its purpose." |

| ch10_sc7_c1 | 24 | 9/6/9 | 3 | 10s | 12s | [REDO] ⚠ Same apartment kitchen, new scene image. Adaeze at stove facing away, Ifeoma on box facing her. S1 MEDIUM static "glancing back toward daughter" (eye direction/partial turn) + "Do not wait as long as I did." (9 words) — 98%. Adaeze facing away but "glancing back" gave enough turn for delivery. S2 CU static Ifeoma "face goes serious then gap-toothed smile breaks through" (facial transitions) + "I will not, Mummy. I promise." (6 words) — 98%. Facial expression transitions in lip sync zone coexist with speech. S3 CU static Adaeze profile "she laughs — full and free" (laughter animation) + "Good. Now help me carry these to the door." (9 words) — DIALOGUE NEVER DELIVERED. Laughter consumed entire shot budget. NEW PATTERN: laughter ≠ smile. Laughing is a MACRO facial animation that directly conflicts with lip sync — mouth doing laughter can't simultaneously do speech. "She laughs" = competing animation (like "jaw tightens", "tears streaming"). "She smiles" = pose/state (coexists with speech). Profile angle compounded the failure. Upstream: never pair "laughs"/"laughing"/"laughter" with dialogue in the same shot. Replace with "a warm smile" or move laughter to a non-dialogue reaction shot. | S1: "Do not wait as long as I did." S2: "I will not, Mummy. I promise." S3: "Good. Now help me carry these to the door." |

| ch10_sc6_c2 | 21 | 6/11/4 | 3 | 10s | 11s | ✓ Same kitchen. S1 MEDIUM static "She is. I am very lucky." (6 words) — 98%. S2 CU static Ifeoma "looks up, completely earnest" (eye direction/description) + "Mummy. I want to be like you when I grow up." (11 words) — 98%. 11 words on static CU survived cleanly — static + no competing directions handles high word counts. Confirms 11-word dips are push-in specific, not a general CU ceiling. S3 ECU slow push-in Adaeze "she stops" (cessation) + "looks at her daughter" (head turn) + "Be better. Be louder." (4 words) — 95%. ≤4 words but minor dip — "stops" (cessation from stove activity) + head turn = two micro-actions that cost small tax even at 4 words. Still clean. | S1: "She is. I am very lucky." S2: "Mummy. I want to be like you when I grow up." S3: "Be better. Be louder." |

| ch10_sc6_c1 | 21 | 5/6/10 | 3 | 10s | 10s | ✓ New apartment kitchen, Adaeze (foreground at stove) + Ifeoma (background near boxes). Food business scene. S1 WIDE ESTABLISHING static "spooning food" (action on non-speaker) + "Mummy, how many orders today?" (5 words) — 98%. S2 CU static Adaeze "counts quickly in her head" (internal/ambient) + "small pleased smile" (facial) + "Twelve. Aunty Ngozi sent three more." (6 words) — 89%. Unexpected dip — "counts in head" may have triggered visible thinking animation, or stove-area hand activity from start frame carried into CU. 6 words should be trivially safe on static CU. Anomalous. S3 CU static Ifeoma "she grins" (facial) + "She is your best customer. And your best friend." (10 words) — 95%. Minor background→CU tax. | S1: "Mummy, how many orders today?" S2: "Twelve. Aunty Ngozi sent three more." S3: "She is your best customer. And your best friend." |

| ch10_sc5_c1 | 22 | 5/6/11 | 3 | 10s | 11s | ⚠ Same park, new scene image (Ifeoma seated on bench foreground, Mama standing behind near tree). S1 MEDIUM static "looking ahead" (eye direction) + "She is strong, my mummy." (5 words) — 98%. S2 CU static Mama Okafor "eyes are wet but steady" (description) + "Yes. Stronger than I ever knew." (6 words) — 95%. NEW FAILURE MODE: Mama delivered lines against her PORTRAIT BACKGROUND instead of park scene. Kling rendered her against her character reference image rather than maintaining scene environment. CU on background character may cause Kling to pull from portrait/grid reference when reframe distance is large enough. Dialogue delivered but visual continuity broken — cosmetically jarring. S3 CU slow push-in Ifeoma "young face is certain" (description) + "I want to be like her when I grow up." (11 words) — 90%. Push-in + description + 11 words = expected 90%. 11 words is just past the comfort zone for push-in even with description only (10 words = 98% in ch9_sc6_c3, 11 words = 90% here). | S1: "She is strong, my mummy." S2: "Yes. Stronger than I ever knew." S3: "I want to be like her when I grow up." |

| ch10_sc4_c2 | 25 | 8/8/9 | 3 | 10s | 12s | ⚠ Same park bench. S1 MEDIUM static Ifeoma "looking up with clear direct eyes" (eye direction/description) + "Grandma. Why did you not help Mummy before?" (8 words) — 98%. S2 CU slow push-in Mama Okafor "eyes drop" (eye direction) + "chin trembles slightly" (facial micro-movement in lip sync zone) + "Because I was afraid too, my child." (8 words) — 89%. Push-in + chin tremble + 8 words = expected dip. Chin tremble is face-adjacent micro-movement — borderline between ambient and competing. Kling seated the kid on the bench during this shot (cross-clip blocking progression — she was standing in start frame). S3 CU static Mama Okafor "lifts her eyes" (eye direction) + "Your mother taught me fear is not an excuse." (9 words) — 95%. Continuous framing from S2 (same character), no reframe. Minor dip at 9 words. CROSS-CLIP BLOCKING: Kling naturally transitioned Ifeoma from standing to seated across clips — confirms pipeline needs progressive scene images when dialogue/scene progression implies position changes. | S1: "Grandma. Why did you not help Mummy before?" S2: "Because I was afraid too, my child." S3: "Your mother taught me fear is not an excuse." |

| ch10_sc4_c1 | 22 | 6/9/7 | 3 | 10s | 11s | ⚠ Lagos park, Mama Okafor (foreground on bench) + Ifeoma (standing beside her). Gift scene. S1 WIDE ESTABLISHING static "small wrapped gift in lap" + "I brought you something. Open it." (6 words) — 98%. Kling morphed Bible into Mama's hand and animated handoff to Ifeoma — prop materialization + giving action triggered by dialogue "Open it." Improvised choreography aligned with dialogue intent. S2 CU static Ifeoma "holds Bible open, tracing name inside cover" (prop interaction) + "My name is inside. You wrote it yourself." (9 words) — 80%. Bible already in hand from S1 handoff but tracing action competed with 9 words. Prop interaction + dialogue = budget competition confirmed again. S3 CU static Mama Okafor "face is softer" (description) + "Every young woman needs her own Bible." (7 words) — 90%. Minor dip on clean static — possibly residual budget depletion from S2's heavy prop choreography carrying across shots. Serviceable, no [REDO] but S2 at 80% is borderline. | S1: "I brought you something. Open it." S2: "My name is inside. You wrote it yourself." S3: "Every young woman needs her own Bible." |

| ch10_sc3_c2 | 22 | 8/7/7 | 3 | 10s | 11s | ✓ Same apartment. S1 MEDIUM static "both settled" (stillness) + "Whatever my brother did. That is not her." (8 words) — 98%. S2 CU static Adaeze "small nod" (ambient) + "something like peace" (description) + "Good. She needs good men around her." (7 words) — 95%. Minor dip, possibly nod or scene noise. S3 CU static Obinna "he stands" (redundant — already standing in start frame) + "Thank you, Adaeze. For all of it." (7 words) — 95%. "He stands" may have caused slight repositioning attempt despite already standing. "Adaeze" in dialogue did NOT trigger character cut (2nd confirmation that mid-sentence names are safe). | S1: "Whatever my brother did. That is not her." S2: "Good. She needs good men around her." S3: "Thank you, Adaeze. For all of it." |

| ch10_sc3_c1 | 26 | 7/10/9 | 3 | 10s | 12s | [REDO] ⚠ Same apartment, new scene image (Adaeze seated on floor, Obinna standing by stove). S1 MEDIUM static "arms at sides" (pose) + "Obinna. You are welcome in Ifeoma's life." (7 words) — 98%. S2 CU static Adaeze "eyes are steady" (description) + "If you want to be. That door is open." (10 words) — 90%. Unexpected dip on clean static CU — 10 words may push CU comfort zone, or staccato two-sentence structure ate time budget. S3 CU slow push-in Obinna "lifts his head" (macro body movement) + "She is my niece. I will not abandon her." (9 words) — DIALOGUE NEVER DELIVERED. "Lifts his head" = head-down to head-up is a full face repositioning at CU, not ambient. Combined with push-in + background→CU reframe = budget consumed before dialogue. PATTERN: "lifts head"/"raises head" is a MACRO movement distinct from "nods once" (ambient). Starting head-down means the face must be completely repositioned in frame at CU — significant animation cost. Especially dangerous on background characters where CU reframe is already taxing. Upstream: treat head-lift/raise as macro body movement, not ambient. Replace with description ("his gaze rises") or pose ("head now lifted") for dialogue shots. | S1: "Obinna. You are welcome in Ifeoma's life." S2: "If you want to be. That door is open." S3: "She is my niece. I will not abandon her." |

| ch10_sc2_c3 | 20 | 6/7/7 | 3 | 10s | 10s | ✓ Same apartment. S1 MEDIUM static "both still" (stillness) + "I pity him. He had everything." (6 words) — 98%. S2 CU slow push-in Adaeze "eyes settle, no bitterness — only clarity" (description) + "He had everything and chose fear." (7 words) — 98%. Push-in + description = safe. S3 CU static Obinna "eyes fill" (emotional state) + "nods once, slowly" (ambient) + "I am proud of you, Adaeze. Truly." (7 words) — 98%. Emotional state + ambient action didn't compete on static CU. "Adaeze" in dialogue did NOT trigger character cut (contrast ch9_sc3_c3 "Mama" cut) — name embedded mid-sentence rather than at clause boundary may prevent Kling from treating it as a reframe cue. | S1: "I pity him. He had everything." S2: "He had everything and chose fear." S3: "I am proud of you, Adaeze. Truly." |

| ch10_sc2_c2 | 16 | 5/5/6 | 3 | 10s | 10s | ✓ Same apartment. S1 MEDIUM static "standing still" (stillness) + "I am testifying. Against Emeka." (5 words) — 98%. S2 CU static Adaeze "expression does not shift" (stillness/description) + "I know. Tunde told me." (5 words) — 98%. S3 CU slow push-in Obinna "eyes searching" (description) + "Do you hate him? My brother?" (6 words) — 98%. Push-in + description + 6 words = safe, consistent. | S1: "I am testifying. Against Emeka." S2: "I know. Tunde told me." S3: "Do you hate him? My brother?" |

| ch10_sc2_c1 | 22 | 7/5/10 | 3 | 10s | 11s | ✓ New apartment, Adaeze (foreground crouching) + Obinna (background standing by stove). S1 WIDE ESTABLISHING static "posture uncertain" (description) + "Adaeze. I hope I am not disturbing." (7 words) — 98%. S2 MEDIUM static Adaeze "looks up toward him" (eye direction) + "Obinna. Come in. Sit down." (5 words) — 98%. DIALOGUE-BLOCKING CONFLICT: "Come in. Sit down." but Obinna already inside standing by stove. Acceptable ONLY if next clip's scene image shows Obinna seated (cross-clip blocking progression). Dialogue in clip N can drive blocking change in clip N+1 — legitimate cinematic technique, but pipeline must handle it deliberately by generating progressive scene images across clips in the same scene when dialogue implies position transitions. S3 CU static Obinna "steps forward" (macro body movement) + "jaw set" (pose) + "eyes earnest" (description) + "I wanted to tell you myself. Before you heard elsewhere." (10 words) — 98%. "Steps forward" macro movement didn't compete at 10 words on static CU. | S1: "Adaeze. I hope I am not disturbing." S2: "Obinna. Come in. Sit down." S3: "I wanted to tell you myself. Before you heard elsewhere." |

| ch10_sc1_c3 | 19 | 7/7/5 | 3 | 10s | 10s | [REDO] ⚠ Same apartment, 3rd clip on same start frame. SCENE-SETTING POSTURE MISMATCH: "now standing close together" but Ngozi still crouching in start frame (new posture fix should catch this). S1 MEDIUM static "gesturing toward the back" (body direction) + "I painted the bedroom myself. Yellow." (7 words) — 98%. S2 CU static Ngozi "tilts her head" (ambient) + "Ada, you look different. Something is different." (7 words) — 98%. S3 ECU slow push-in Adaeze "eyes are calm, settled, certain" (description) + "I feel like myself. Finally." (5 words) — DIALOGUE NEVER DELIVERED. Adaeze is background + profile angle in start frame. ECU requires massive reframe from background-profile to face-filling extreme close-up. ≤5 words should override but didn't — ECU on background-profile character = reframe cost exceeds budget. PATTERN UPGRADED: background→CU = minor tax (~95%), but background-profile→ECU = budget killer. The profile angle compounds the reframe distance. CU can handle background characters; ECU cannot when the character is also in profile. Upstream: never assign ECU to a character who is both background AND profile in start frame — use CU max, or ensure an intermediate shot reframes them first. | S1: "I painted the bedroom myself. Yellow." S2: "Ada, you look different. Something is different." S3: "I feel like myself. Finally." |

| ch10_sc1_c2 | 18 | 6/8/4 | 3 | 10s | 10s | ✓ Same apartment. S1 WIDE static "They are beautiful. Thank you, Ngozi." (6 words) — 98%. S2 MEDIUM static Ngozi "eyes sweep the room" (eye direction) + "Look at this place. It is yours." (8 words) — 98%. S3 CU slow push-in Ngozi "eyes shining" (description) + "Every corner. Yours alone." (4 words) — 98%. ≤4 words overrides push-in, clean. | S1: "They are beautiful. Thank you, Ngozi." S2: "Look at this place. It is yours." S3: "Every corner. Yours alone." |

| ch10_sc1_c1 | 23 | 6/7/10 | 3 | 10s | 11s | [REDO] ⚠ New apartment, Adaeze (background at stove) + Ngozi (foreground crouching over box). Moving-in scene. DIALOGUE-SCENE MISMATCH: "Come inside. Stop crying at my door." implies Ngozi arriving at the door, but scene image has her already inside unpacking boxes. Dialogue blocking intent ignored at scene composition stage. S1 WIDE ESTABLISHING static "looking up" (eye direction) + "Ada. You actually did it." (6 words) — 98%. S2 MEDIUM slow push-in Adaeze "smile breaks wider" (facial animation, borderline) + "Come inside. Stop crying at my door." (7 words) — 98%. Smile animation didn't compete — facial expressions in the lip sync zone may coexist with speech rather than competing. Push-in + 7 words survived. S3 CU static Ngozi "glances up" (eye direction) + "These are for you. First flowers in your own home." (10 words) — DIALOGUE NEVER DELIVERED. Ngozi holding flowers = prop-in-hand ate entire budget. Same pattern as ch6_sc5_c2 (cup), ch6_sc6_c1 (cup). Props-in-hand during dialogue = Kling prioritizes prop animation over speech. Upstream: dialogue-aware scene blocking needed (Option A expanded) — dialogue cues like "come inside" / "at my door" should drive character positioning in scene image generation. | S1: "Ada. You actually did it." S2: "Come inside. Stop crying at my door." S3: "These are for you. First flowers in your own home." |

| ch9_sc7_c1 | 3 | 3/0/0 | 3 | 12s | 12s | ✓ Law office corridor, Adaeze alone, walking toward glass exit. Single char, back-to-camera throughout. S1 WIDE slow push-in from behind "Someone sees me." (3 words) — voiceover delivery, back-to-camera, lip sync unmeasurable but dialogue delivered. 3 words = trivially safe as VO. S2 MEDIUM slow push-in from behind, no dialogue — pure cinematic walking shot, no issues. S3 ECU INSERT on hand/phone, no dialogue — Kling improvised its own choreography: added phone-to-ear while walking (not in prompt), then INSERT of phone screen, then decline action. PHONE UI ERROR: Kling pressed green button to decline instead of red. Kling doesn't understand phone UI conventions (green=accept, red=decline). Multi-step choreography (screen lights → number shows → hover → decline → dark → hand drops) partially executed with Kling's own reordering. Confirms: multi-step INSERT directions get reinterpreted/truncated, Kling improvises its own sequence. Minor visual error, dramatic intent landed. | S1: "Someone sees me." S2: (no dialogue) S3: (no dialogue — phone decline action) |

| ch9_sc6_c3 | 20 | 8/2/10 | 3 | 10s | 10s | ✓ Same law office. S1 MEDIUM static Adaeze "sits straight" (pose) + "I am not ready for anything new." (8 words) — 98%. S2 CU static Tunde "nods once" (ambient) + "I know." (2 words) — 98%, trivially safe. S3 ECU slow push-in Tunde "eyes are steady and warm behind the glasses" (description) + "I just wanted you to know someone sees you." (10 words) — 98%. STRONG CONFIRMATION: ECU + push-in + 10 words + multi-char = 98% when direction is pure description with zero competing animations. Push-in tax is almost entirely driven by competing body/emotion animations, NOT by push-in itself. Push-in + description = effectively free. This is now confirmed at 9 words (ch9_sc6_c2), 10 words (this clip), and 10 words (ch6_sc5_c1) all at 90-98%. | S1: "I am not ready for anything new." S2: "I know." S3: "I just wanted you to know someone sees you." |

| ch9_sc6_c2 | 24 | 6/9/9 | 3 | 10s | 11s | ⚠ Same law office. S1 MEDIUM static Tunde "leans back slightly" (ambient) + "Completely. The EFCC has your statement." (6 words) — back-of-head delivery. Tunde faces window in start frame, MEDIUM didn't reframe him toward camera. Body language implies speech but lip sync unmeasurable. Same pattern as EFCC corridor clips (ch8_sc1-sc2). "Leans back slightly" didn't turn him. Upstream: when character faces away in start frame, shot direction needs explicit turn directive (e.g. "turns from window"). S3 proves this works — Tunde turned around to look at Adaeze when delivering his line. Cinematography rules (line 2118-2126) already specify "no back-to-camera on dialogue" — the implementation gap is that the shot direction generator doesn't inject turn directives when blocking has the speaker facing away. Fix: validate speaker facing angle at shot direction generation, auto-inject turn if needed. S2 CU static Adaeze "looks at the closed file, then at him" (eye direction) + "I do not know how to thank you." (9 words) — 98%. S3 MEDIUM slow push-in Tunde "he means it — no performance" (description) + "You did the hard part. You walked in." (9 words) — 98%. SURPRISE: push-in + 9 words + multi-char = 98%. Zero competing directions + description only = push-in survived at higher word count. Confirms push-in + pure description (no body/emotion animation) = safe even at 9 words in multi-char. | S1: "Completely. The EFCC has your statement." S2: "I do not know how to thank you." S3: "You did the hard part. You walked in." |

| ch9_sc6_c1 | 18 | 7/5/6 | 3 | 10s | 10s | ✓ Tunde's law office, Adaeze (foreground at desk) + Tunde (background at window). Case resolution scene. S1 WIDE ESTABLISHING static "hands folded" (pose) + "You said my name was cleared." (7 words) — 98%. S2 MEDIUM static Tunde "nods slowly" (ambient) + "Confirmed. The signatures were forgeries." (5 words) — 98%. "Forgeries" survived TTS cleanly. S3 CU slow push-in Adaeze "something in her face releases" (description) + "So I am free. Completely free." (6 words) — 90%. Push-in + description + 6 words = expected ~95% but dipped to 90%. Possible cause: staccato sentence structure (two short phrases with period break) causing micro-pause that eats time budget during push-in. Or push-in started early. Serviceable, no [REDO]. | S1: "You said my name was cleared." S2: "Confirmed. The signatures were forgeries." S3: "So I am free. Completely free." |

| ch9_sc5_c1 | 24 | 6/5/7+6 | 3 | 10s | 12s | ⚠ Same apartment, Ifeoma (background) + Adaeze (foreground). S1 MEDIUM static both still + "I was scared, Mummy. Every night." (6 words) — 98%. S2 CU static Adaeze "sits still" (stillness) + "eyes closing briefly" (light facial) + "I know, baby. I know." (5 words) — 98%. S3 CU on Ifeoma + slow push-in on Adaeze — DUAL SPEAKER SHOT: Ifeoma "Are we going back to that house?" (7 words) then Adaeze "No. We are never going back." (6 words). SURPRISE: worked. Kling stayed on Ifeoma CU for both lines — Ifeoma delivered her line with lip sync, then Adaeze's response played as off-screen voice over Ifeoma's reaction face. No mid-shot reframe attempted. Cinematically effective (daughter's face while mother answers). But unpredictable — dual-speaker shot success depends on Kling choosing to stay on first speaker rather than attempting reframe/cross-contamination. Rule 11 (one speaker per shot) still stands as the safe upstream rule — this success is an anomaly not a pattern. | S1: "I was scared, Mummy. Every night." S2: "I know, baby. I know." S3: "Are we going back to that house?" / "No. We are never going back." |

| ch9_sc4_c2 | 24 | 9/4/11 | 3 | 10s | 11s | ✓ Same apartment, Ifeoma (background) + Adaeze (foreground). S1 MEDIUM slow push-in Adaeze "she sits still" (stillness) + "He did things he should not have done." (9 words) — 98%. Push-in + stillness = safe, confirmed again. Adaeze foreground = minimal reframe. S2 CU static Ifeoma "searches her mother's face" (description) + "Mummy. Are you okay?" (4 words) — 95%. Background→CU reframe survived with minor dip. CONTRAST with ch9_sc4_c1 S3 where background→CU dialogue dropped entirely — difference: c1 had "TV light plays across face" (lighting animation directive) + 7 words, c2 has pure description + 4 words. Background→CU reframe = small tax (~95%) not budget killer. c1 S3 dropout likely caused by lighting animation directive eating budget, not reframe distance. Pattern candidate (extreme reframe = budget killer) DOWNGRADED. S3 ECU static Adaeze "eyes are wet" (emotional state) + "For the first time in a long time — yes." (11 words) — 89%. ECU + 11 words + emotional state = expected dip. Adaeze foreground = minimal ECU reframe. 11 words is heavy for ECU even without push-in. Serviceable, no [REDO]. | S1: "He did things he should not have done." S2: "Mummy. Are you okay?" S3: "For the first time in a long time — yes." |

| ch9_sc4_c1 | 18 | 6/5/7 | 3 | 10s | 10s | [REDO] ⚠ Ngozi's apartment, Ifeoma (background near archway) + Adaeze (foreground on sofa). TV news scene. S1 WIDE ESTABLISHING static "eyes on the TV" (eye direction) + "That is Daddy on the television." (6 words) — 98%, safe. S2 MEDIUM static Adaeze "sits still" (stillness) + "gaze lifting toward Ifeoma" (eye direction) + "Yes, my love. It is." (5 words) — 95%, minor dip on clean static, unexplained. S3 CU static Ifeoma "TV light plays across her young face — confusion, not tears" (description/lighting) + "Why are those men holding him?" (7 words) — DIALOGUE NEVER DELIVERED. No lip sync, nothing. Static CU, 7 words, no competing body directions — should have been trivially safe. Possible causes: (1) Ifeoma far background in start frame, CU reframe = massive jump that ate budget; (2) "TV light plays across her young face" interpreted as lighting animation directive, budget spent on light effect; (3) duration exhaustion — S1+S2 ran long, S3's 3s window insufficient. NEW PATTERN CANDIDATE: extreme reframe distance (background→CU) may cost budget similar to push-in. Characters positioned far from camera in start frame may need MEDIUM first, not direct CU jump. | S1: "That is Daddy on the television." S2: "Yes, my love. It is." S3: "Why are those men holding him?" |

| ch9_sc3_c3 | 29 | 9/9/11 | 3 | 10s | 13s | ⚠ Same apartment, Adaeze + Mama Okafor. S1 MEDIUM static Mama Okafor "she stills" (stillness) + "He is my son. I chose my son." (9 words) — 98%, stillness directive safe. S2 CU slow push-in Mama Okafor "eyes finally fill" (emotional state animation) + "does not wipe them" (non-action stillness reinforcement) + "I am sorry, my daughter. I failed you." (9 words) — 90%. Push-in + emotional state + 9 words = expected dip. Stillness reinforcement ("does not wipe") may have limited damage vs total failure seen in similar combos. Serviceable. S3 MEDIUM static Adaeze "exhales slowly" (ambient) + "something in her posture releases" (description) + "I cannot forgive you today, Mama. But you can sit." (11 words) — 98% on Adaeze's portion but NEW FAILURE MODE: dialogue-triggered character cut. "Mama" in dialogue caused Kling to reframe to Mama Okafor mid-shot — Mama delivered "But you can sit" instead of Adaeze. Kling interpreted the name mention as a visual cue to cut to the referenced character. PATTERN: when Character A's dialogue contains Character B's name/title, Kling may reframe to B and transfer remaining dialogue. Upstream: avoid character names in dialogue when speaker must stay on screen, or front-load the name ("Mama, I cannot forgive you today. But you can sit.") so the cut happens before the important line. | S1: "He is my son. I chose my son." S2: "I am sorry, my daughter. I failed you." S3: "I cannot forgive you today, Mama. But you can sit." |

| ch9_sc3_c2 | 17 | 2/10/5 | 3 | 10s | 10s | ✓ Same apartment front door → living room, Adaeze + Mama Okafor. CONTINUITY ISSUE: start frame has Mama Okafor standing at kitchen doorway, but scene preamble says "now seated on the sofa" — position jump between start frame and prompt. Kling reconciled it (scores survived). S1 WIDE static Adaeze "Come in." (2 words) — 98%, trivially safe. S2 MEDIUM static Mama Okafor "does not look up at first" (starting pose) + "voice comes from somewhere deep" (unactionable vocal direction) + "I saw it. For years, I saw it." (10 words) — 98%, staccato structure didn't hurt on static. S3 CU static Adaeze "face does not break — it holds" (stillness/description) + "And you said nothing." (5 words) — 95%, minor unexplained dip on clean static CU with low words. Possibly multi-char budget split or angle. All static + descriptions only = reliable even with continuity mismatch in blocking. Upstream note: CHARACTER POSITIONS preamble should match scene preamble blocking — standing vs seated conflict creates unnecessary risk. | S1: "Come in." S2: "I saw it. For years, I saw it." S3: "And you said nothing." |

| ch9_sc3_c1 | 20 | 5/8/8 | 3 | 10s | ~11s | [REDO] ⚠ Ngozi's apartment front door, Adaeze + Mama Okafor. S1 WIDE ESTABLISHING static Mama Okafor "Adaeze. I came alone." (5 words) — 98%, safe zone. S2 MEDIUM static Adaeze "grip on door frame tightens slightly" (state animation on environmental prop) + "Mama. What are you doing here?" (7 words) — 98%, door frame interaction didn't compete (environmental prop, not held). S3 CU slow push-in Mama Okafor "prayer beads turn slowly in fingers" (prop manipulation) + "I am not here to fight. Please." (8 words) — FACE NOT FULLY VISIBLE. Half of Mama's face showing, hands with prayer beads against the wall. Kling tried to satisfy push-in + prop manipulation + lip sync and compromised by sacrificing face visibility to show prayer beads. Engine prioritized prop over lip sync when demands conflict. Push-in + prop interaction + CU = too many competing demands even with hand-level (non-face-occluding) prop. PATTERN: when animation demands exceed budget, Kling resolves by reframing away from face to show the competing element (props, hands), destroying lip sync visibility rather than degrading it. | S1: "Adaeze. I came alone." S2: "Mama. What are you doing here?" S3: "I am not here to fight. Please." |

| ch9_sc2_c2 | 20 | 6/7/7 | 3 | 10s | 11s | ✓ Same EFCC witness room. S1 MEDIUM static "looks down, then back up" (eye direction) + 6 words — 98%. S2 CU slow push-in Tunde "leans forward slightly, still" (stillness) + 7 words — 98%. Push-in + stillness = safe confirmed again. S3 ECU static Chidinma "jaw sets" (pose) + 7 words — 98%. Perfect 3-for-3. NOTE: sudden portrait image flash at end of dialogue — Kling visual artifact in dead air after dialogue completes. Duration formula working (dialogue done, excess time filled with artifact). Cosmetic only. | S1: "I believed him. I believed everything." S2: "The subsidiary names — did he choose them?" S3: "All of them. I was just the signature." |

| ch9_sc2_c1 | 24 | 9/8/7 | 3 | 10s | 12s | ✓ EFCC witness room, Chidinma + Tunde. All static, descriptions only. S1 WIDE ESTABLISHING static 9 words — 98%. S2 MEDIUM static Tunde "meets her eyes" (eye direction) + 8 words — 98%. S3 CU static Chidinma "large eyes are clear" (description) + 7 words — 98%. Perfect 3-for-3. Template: 2-char all-static + descriptions only + balanced words = 98% sweep even in multi-char. | S1: "I signed what he put in front of me." S2: "Did he tell you what the documents were?" S3: "He said it was routine. Business paperwork." |

| ch9_sc1_c3 | 18 | 7/4/7 | 3 | 10s | 10s | ⚠ Same office, Emeka being led out. S1 MEDIUM static "cranes neck back" (body movement) + 7 words — 98%. S2 CU static Tunde "does not move" (stillness) + 4 words — 90%. ANOMALY: ≤4 words should be universal safe zone but dipped to 90%. Possibly scene-specific: Tunde seated behind desk with Emeka being led out in background = background movement splitting budget even on CU. Or Tunde's angle/position in this start frame. S3 ECU slow push-in Emeka "rage and fear collide behind his eyes" (description) + 7 words — 95%. Better than expected for multi-char push-in. Description = safe even with push-in. S2/S3 scores inverted from prediction. | S1: "She sent you. Adaeze sent you here." S2: "She saved herself." S3: "I will destroy her. I swear it." |

| ch9_sc1_c2 | 19 | 7/7/5 | 3 | 10s | 10s | ⚠ Same office, 4 chars. All static. S1 WIDE static 7 words — 98%. S2 MEDIUM static Emeka "shoulders tighten" (subtle) + "eyes scanning" (eye direction) + 7 words — 98%. S3 CU static Tunde "opens warrant folder slightly" (prop interaction) + 5 words — 89%. Prop interaction on CU dipped despite low word count and static camera. Folder opening = hand movement near desk level, not face-occluding, but still cost budget in multi-char scene. Multi-char S3 dip pattern continues (89% baseline). No [REDO]. | S1: "Your lawyer has been notified. Step forward." S2: "This is a mistake. A terrible mistake." S3: "Sixteen forged documents say otherwise." |

| ch9_sc1_c1 | 23 | 9/6/8 | 3 | 10s | 12s | ⚠ Construction office, Emeka + Tunde + 2 police officers (4 chars in frame). Arrest scene. S1 WIDE ESTABLISHING static 9 words — 98%. S2 MEDIUM static Tunde "meets gaze without flinching" (description) + 6 words — 95%. S3 CU slow push-in on Emeka "jaw works" (animation) + "eyes darting" (eye direction) + 8 words — 89%. Push-in + jaw animation + multi-char scene = expected dip. CU isolated Emeka but officers in background still split some budget. Serviceable, no [REDO]. | S1: "What is this? Do you know who I am?" S2: "Emeka Okafor. You are under arrest." S3: "I want my lawyer. Call my lawyer now." |

| ch8_sc7_c3 | 16 | 4/6/6 | 3 | 11s | 11s | ⚠ Same office, phone call. Single char. S1 MEDIUM static phone pickup + 4 words — 98%. ≤4 words safe. S2 CU static "face goes very still" + "blood drains" (emotional state) + 6 words — 98%. Single char absorbed the emotional state direction. S3 ECU on face static "phone lowers slightly from ear" + "eyes are empty" + "does not move" + 6 words — 70%. Phone-near-face at ECU: phone lowering from ear passes through mouth zone, physically occluding lip sync. Also conflicting directions: "does not move" vs "phone lowers." NEW pattern: prop movement near face at ECU = lip sync occlusion. Distinct from prop-in-hand (safe) — it's the spatial proximity to mouth that matters. Chapter cliffhanger line — Tier 3, depends on audio clarity. | S1: "Hello? Yes. Speaking." S2: "What warrant? Say that again." S3: "Tomorrow morning. They are coming tomorrow." |

| ch8_sc7_c2 | 17 | 8/9/0 | 2 | 10s | 10s | ✓ Same executive office, Emeka alone. 2 dialogue lines + INSERT. S1 CU slow push-in "eyes on papers" (eye direction) + 8 words — 98%. Single char push-in safe. S2 ECU on EYES static + 9 words — 98%. SURPRISE: ECU-on-eyes + dialogue WORKED. Contradicts ch2_sc6_c1 and ch3_sc3_c3 where ECU-on-eyes dropped dialogue. Possible factor: single char (no attribution confusion), or Kling pulled framing slightly wider to include mouth. Need to verify if actual framing matched prompt or if Kling auto-adjusted. S3 INSERT on phone — phone lighting up, vibrating, ringing all executed perfectly. INSERT = reliable for prop/action beats. | S1: "Adaeze does not have the stomach for this." S2: "She has never fought back. Not once." S3: (no dialogue — phone rings) |

| ch8_sc7_c1 | 23 | 9/7/7 | 3 | 10s | 12s | ✓ Executive office at night, Emeka alone. Single char, all static. S1 WIDE ESTABLISHING static 9 words — 98%. Half-face shadow didn't affect lip sync. S2 CU static "jaw working" + 7 words — 98%. "Jaw working" didn't compete — single char budget absorbed it. S3 MEDIUM static "leans back, arms crossing" + 7 words — 98%. Macro body movement on single char = safe (consistent). Perfect 3-for-3. | S1: "She will not do this. She cannot do this." S2: "Twelve years. Twelve years I gave her." S3: "She will come back. They always come back." |

| ch8_sc6_c4 | 17 | 3/8/7 | 3 | 10s | 10s | ✓ Same living room, emotional climax. S1 WIDE static 3 words — 98%. ≤4 word universal safe zone. S2 CU static Obinna "eyes are wet" (description) + 8 words — 98%. S3 ECU slow push-in Mama Okafor "hand rises to cover her mouth" + "eyes close" + 7 words — 98%. SURPRISE: hand-to-mouth + push-in + eyes-closing + dialogue = predicted high-risk triple threat, but all landed perfectly. Hand-over-mouth executed cleanly without suppressing lip sync. Possible factor: hand covers mouth AFTER dialogue delivery (sequential not concurrent), or Kling animated speech first then hand movement. Contradicts ch6_sc5_c2 pattern (hand-to-mouth + cup = voiceover). Difference may be: no prop in hand (bare hand vs cup), or action sequencing. | S1: "Stop. Stop talking." S2: "You have to know, Mama. All of it." S3: "What have I helped him become?" |

| ch8_sc6_c3 | 24 | 8/8/8 | 3 | 10s | 12s | ✓ Same living room. Single-char framing (Obinna) all 3 shots. ALL STATIC. S1 MEDIUM static 8 words — 98%. S2 CU static "exhales" (ambient) + 8 words — 98%. S3 MEDIUM static "says it plainly" (description) + 8 words — 98%. Perfect 3-for-3. Template clip: single char + all static + balanced words (8/8/8) + descriptions only = 98% across the board. | S1: "He made her a criminal without her knowing." S2: "There is a woman. She was pregnant, Mama." S3: "He told her to get rid of it." |

| ch8_sc6_c2 | 24 | 7/9/8 | 3 | 10s | 11s | ✓ Same living room. S1 WIDE static 7 words — 98%. S2 CU static Mama Okafor "small eyes flash" (description) + 9 words — 95%. S3 CU slow push-in Obinna "does not flinch" (stillness) + "gentle eyes are resolute" (description) + 8 words — 95%. Push-in + stillness = safe confirmed again. TTS issue: "documents" read as "docsuments" — add to difficult-word dictionary. No [REDO] — mispronunciation is minor. | S1: "Emeka has been laundering money, Mama." S2: "You do not say such things about your brother." S3: "He forged Adaeze's name on the documents." |

| ch8_sc6_c1 | 23 | 9/6/8 | 3 | 10s | 11s | ✓ Okafor living room, Obinna + Mama Okafor. All static. S1 WIDE ESTABLISHING static 9 words — 98%. Both chars well-separated, face-visible. S2 CU static Mama Okafor "thin lips press tighter" + 6 words — 95%. Lip-pressing direction read as starting pose, didn't fully suppress lip sync. S3 CU static Obinna "eyes holding hers" (eye direction) + 8 words — 90%. Slight S3 dip on clean static — consistent with scene-specific noise pattern seen in other office/living room scenes. Serviceable, no [REDO]. | S1: "Mama. You need to hear this from me." S2: "Whatever Adaeze has done, this family—" S3: "This is not about Adaeze. Listen to me." |

| ch8_sc5_c3 | 24 | 8/9/7 | 3 | 10s | 12s | ✓ Same Okafor bedroom, Emeka speaks all 3 shots. S1 WIDE static "turning toward door" + 8 words — 98%. Departure action in S1 safe (not S3). S2 CU static "jaw is set" (pose) + "eyes cutting past her" (eye direction) + 9 words — 98%. Both safe categories confirmed. S3 MEDIUM static at doorway "pauses without turning back" + 7 words — 90%. Slight dip possibly from partial face visibility if angled toward door. Serviceable, no [REDO]. | S1: "Do not say that to me. Not today." S2: "You never see anything. You never hear anything." S3: "That is the problem with this family." |

| ch8_sc5_c2 | 23 | 8/8/7 | 3 | 10s | 10s | ✓ Same Okafor bedroom. S1 WIDE static 8 words — 98%. S2 CU slow push-in on Emeka single-char framing + "eyes are wide" (description) + 8 words — 95%. Push-in + description = safe, consistent. S3 CU static Mama Okafor + "something flickers in her eyes" (description) + 7 words — 90%. Slight dip unexplained on clean static CU. Serviceable, no [REDO]. | S1: "I saw nothing. I heard nothing." S2: "She took Ifeoma. She took my daughter." S3: "Ifeoma is her daughter too, Emeka." |

| ch8_sc4_c2 | 18 | 8/4/6 | 3 | 11s | 11s | ✓ Same office, single char. S1 MEDIUM static "tears envelope, pulls papers" + 8 words — 98%. Kling self-generated paper on table for him to grab. Paper morphing as it opens (expected). Grabbed while talking — multi-step choreography didn't compete on single char. S2 ECU SLOW PUSH-IN + "jaw tightens" + emotional state crack + 4 words — 98%. ≤4 words overrides push-in + jaw + emotional state even on ECU. Universal safe zone confirmed again. S3 CU static "reaches for phone, dials" + 6 words — 98%. Kling self-generated phone on table, he picks up + dials while delivering lines. Phantom prop materialization worked cleanly for both paper and phone. Props baked in would prevent morphing artifacts but Kling can improvise when needed on single char. | S1: "What is this? Who sent this envelope?" S2: "Legal separation. Legal. Separation." S3: "Adaeze. Adaeze, pick up this phone." |

| ch8_sc4_c1 | 24 | 9/7/8 | 3 | 10s | 12s | ⚠ Executive office, Emeka alone. PHONE CALL but NO PHONE in start frame — hands flat on desk. Upstream: phone call scenes need phone baked into scene image + held in start frame. Intersection of props-in-location + phone call handling rules. SINGLE CHAR, ALL STATIC. S1 WIDE static 9 words — 98%. No phone visible, Kling just had him speak to camera. S2 CU static "jaw tight" + 7 words — 95%. Jaw direction dipped it slightly, consistent with jaw tax pattern. S3 MEDIUM static "assistant's hand enters frame" + 8 words — 89%. Third-party hand entering frame + envelope placement distracted from dialogue delivery. Serviceable, no [REDO]. | S1: "Tell them the delivery is delayed. I said delayed." S2: "I do not care what Alhaji thinks." S3: "Call me back when it is sorted." |

| ch8_sc3_c1 | 22 | 7/8/7 | 3 | 10s | 11s | ✓ Same interview room, post-interview. CONTINUITY: blocking flipped from previous clips — Adaeze now far-side, Tunde near-side/doorway. Same Cinema Studio issue. S1 WIDE static Tunde 7 words — 98%. Tunde foreground this time (closest to camera, face visible). S2 CU static "exhales slowly" (ambient) + 8 words — 98%. S3 MEDIUM SLOW PUSH-IN + "eyes hold something unspoken" (description, not animation) + 7 words — 98%. Push-in + description = safe. Consistent with pattern: descriptions don't compete with lip sync. | S1: "You did well in there. Very well." S2: "I just told the truth. That is all." S3: "The truth was enough. It always is." |

| ch8_sc2_c3 | 20 | 7/9/4 | 3 | 10s | 10s | [REDO] ⚠ Same interview room. S1 MEDIUM SLOW PUSH-IN "hands flat on table" + 7 words — back-of-head shot, dialogue delivered but lip sync unmeasurable. 4th consecutive back-of-head in this room. S2 CU SLOW PUSH-IN CONTINUING + 9 words — profile, lips moving, 90%. Continuous push-in from S1. S3 ECU static 4 words — NO DIALOGUE DELIVERED. No lip sync, no voiceover, nothing. 4 words should be trivially safe. Possible cause: continuous push-in across S1→S2 depleted animation/dialogue budget entirely, leaving nothing for S3. Or duration ran out. "I am not afraid anymore" — the emotional climax line — dropped. Must redo. | S1: "He controlled every account. Every naira." S2: "I was afraid for a very long time." S3: "I am not afraid anymore." |

| ch8_sc2_c2 | 23 | 7/8/8 | 3 | 11s | 12s | ✓ Same interview room. Evidence presentation scene. S1 MEDIUM static "sits still" + 7 words — delivered back-of-head/profile. Lip sync unmeasurable but dialogue plays. S2 INSERT→CU hybrid + 8 words — over-the-shoulder, face out of focus, lips moving 98%. Camera focused on desk as she opens folder revealing 2 diamond earrings. Evidence-focused framing = dramatic B-roll with voiceover-like delivery. S3 CU static "glances down" + 8 words — holds receipt forward, receipt covers moving mouth as she delivers line. Very dramatic — props become storytelling device, lip sync physically hidden but dialogue fully delivered. Entire clip functions as evidence-presentation drama where focus is on objects not mouth. Effective even without visible lip sync. | S1: "I have evidence. I brought it today." S2: "This earring. I found it in his car." S3: "This receipt. I found it in his jacket." |

| ch8_sc2_c1 | 17 | 5/6/6 | 3 | 10s | 10s | ✓ EFCC interview room. S1 WIDE ESTABLISHING static Adaeze 5 words — back to camera again (3rd consecutive WIDE with speaker facing away). Dialogue delivered as body language + voiceover, lip sync unmeasurable. Reinforces rule: WIDE = blocking/atmosphere only, move dialogue to CU/MEDIUM. S2 CU static 6 words — 98%. S3 ECU static 6 words — 89%. Slight S3 dip on clean static ECU — no competing directions, low words. Possibly ECU-specific: extreme close framing makes minor lip sync imperfections more noticeable. Serviceable, no [REDO]. | S1: "My name is Adaeze Okafor." S2: "I did not sign those documents." S3: "My husband forged my signature. Many times." |

| ch8_sc1_c2 | 20 | 8/9/3 | 3 | 10s | 10s | ✓ Same EFCC corridor. S1 WIDE static Adaeze on bench 8 words — line delivered but back of head to camera. Body language/head movement implies speech but lip sync unmeasurable (mouth not visible). Reinforces blocking rule: speaking char must face camera. Vision reported "facing slightly left toward the man" = away from camera. S2 CU static Tunde "jaw is firm" (pose) + 9 words — 95%. S3 ECU SLOW PUSH-IN + "eyes stop trembling" (emotional transition) + 3 words — 98%. ≤3 words overrides all competing directions. | S1: "My name is on those documents, Tunde." S2: "That is why we are here. To fix that." S3: "I am ready." |

| ch8_sc1_c1 | 25 | 9/9/7 | 3 | 10s | 12s | ✓ EFCC corridor, Adaeze + Tunde. S1 WIDE ESTABLISHING static Tunde speaking from background 9 words — 98% but face too far/small to accurately judge lip sync. Score reflects "dialogue delivered" not "mouth matched." WIDE background speaker lip sync is face-size dependent — unmeasurable at distance. S2 CU SLOW PUSH-IN + "jaw set, lips pressed together" + 9 words — 98%. SURPRISE: "lips pressed" didn't suppress lip sync. Kling likely reads it as starting state (pressed BEFORE speech) then releases into dialogue. Distinct from concurrent mouth-closing directions. "Jaw set" also didn't tax here — possibly because it's a static pose description not an animation. S3 MEDIUM static 7 words — 98%. | S1: "We walk in together. You do not stop." S2: "What if they ask me things I cannot answer?" S3: "Answer only what you know. Nothing more." |

| ch7_sc5_c3 | 38 | 5/6/27 | 5 | 12s | 15s | [REDO] ⚠ Same law office, phone call. S1 MEDIUM static Ngozi off-screen 5 words — phone filter expected. S2 CU static Tunde 6 words — should be fine. S3 ECU SLOW PUSH-IN + 27 WORDS in single shot — line was delivered but lip sync couldn't keep up. 27 words at 2.5w/s = 10.8s in a 4s window. Confirmed: word density ceiling exceeded. Needs restructuring: S3 should be its own clip broken into 3 shot directions. **Upstream rule: per-shot word count ceiling ~10 words.** EFCC appears again. | S1: "Forty-eight hours for what?" S2: "Adaeze must give a formal statement." S3: "If she does not walk into the EFCC office tomorrow, they will come to her door. And Emeka will make sure she looks guilty when they do." |

| ch7_sc5_c2 | 23 | 8/6/9 | 3 | 10s | 10s | ✓ Same law office, phone call. SINGLE CHAR (Tunde on screen). S1 MEDIUM static "lowers phone, pauses, redials" (3-step choreography) + 8 words — 98%. Multi-step phone actions didn't compete on single char. S2 CU static — NGOZI'S DIALOGUE with phone filter effect. Off-screen caller got phone audio filter. KEY: `[@ngozi_towwf_0421]` speaker tag on Tunde's shot = Kling treated as off-screen voice. Confirms phone call rule: off-screen caller MUST have own speaker tag, never tagged to on-screen char. Compare ch6_sc6_c3 failure (wrong speaker tag). S3 CU SLOW PUSH-IN + "sets his jaw" + 8 words — 90%. Jaw direction + push-in + 8 words = consistent ~90% tax on single char. | S1: "Ngozi. I need to tell you something." S2: "Tunde, you are scaring me." S3: "The case is accelerating. We have forty-eight hours." |

| ch7_sc5_c1 | 24 | 9/6/9 | 3 | 10s | 11s | ✓ Law office, Tunde alone, phone call. SINGLE CHAR. S1 WIDE static phone-to-ear 9 words — 98%. S2 MEDIUM static "pulls phone from ear, eyes scanning file" + 6 words — 98%. BUT phone+fingers morphed into paper/folders as he opened them. Props-in-hand + new prop interaction = prop morphing. Phone disappeared, reappeared in S3. Kling can't maintain prop across shots when hands interact with different objects. S3 CU SLOW PUSH-IN + "expression shifts professional to alarmed" (emotional state transition) + 9 words — 90%. Single char push-in safe but state transition cost ~8%. Serviceable, no [REDO]. | S1: "Yes. Yes, I received the tip this afternoon." S2: "It matches my case files exactly." S3: "The EFCC is moving faster than I expected." |

| ch7_sc4_c2 | 16 | 6/7/3 | 3 | 11s | 11s | ✓ Same office. ALL STATIC. S1 MEDIUM static Emeka "straightens up" + 6 words — 98%. Obinna was sitting (start frame position). S2 MEDIUM static Obinna "hand on door" + 7 words — 98%. Kling moved Obinna from seated to door between shots — interpolated scene description spatial transition implicitly. Good behavior. S3 ECU PROFILE on half of Obinna's face + 3 words — 98%. Very dramatic half-face framing. ≤3 words overrode profile penalty AND broke the office scene S3 dip streak (90/90/89→98). Confirms ≤4 word threshold is the universal override. | S1: "You will regret this, Obinna." S2: "You are not our father, Emeka." S3: "You never were." |

| ch7_sc4_c1 | 21 | 8/9/4 | 3 | 10s | 10s | ⚠ CONTINUITY: Same office but blocking flipped from previous clips — Obinna now seated behind desk, Emeka standing. Also Emeka in "white lab coat" instead of white traditional Igbo outfit. Scene image generation baked in the error; Vision verification correctly reported what it saw but can't fix upstream. Same issue as ch5_sc3/sc4 position flips. ALL STATIC. S1 WIDE static 8 words — 98%. S2 CU static 9 words — 98%. S3 CU static "shoulders drop" + 4 words — 89%. Third consecutive S3 dip (90%, 90%, 89%) on clean static shots in this office scene. Pattern: this start frame/location produces consistent S3 degradation regardless of prompt complexity. Possibly Kling fatigue on 3rd shot in this specific scene image, or something about the office lighting/composition. Not prompt-fixable. Serviceable, no [REDO]. | S1: "You side with her, you are out." S2: "Out of this company. Out of this family." S3: "Then I am out." |

| ch7_sc3_c3 | 21 | 8/6/7 | 3 | 10s | 10s | ✓ Same office. S1 MEDIUM static "takes step forward, chin up" + 8 words — 98%. Brief macro-movement (single step) didn't compete. S2 CU SLOW PUSH-IN + "sits still" + 6 words — 98%. **Push-in + explicit stillness directive = safe.** "Sits still" cancels push-in competition — Kling dedicates full budget to lip sync when no body animation is requested. New pattern. S3 CU static "eyes harden" + 7 words — 90%. Second unexplained 90% dip on clean static in this scene — possibly scene-specific Kling noise for this start frame. Serviceable, no [REDO]. | S1: "I have been silent too long about this." S2: "Silent? You eat from my table." S3: "This is not about your table." |

| ch7_sc3_c2 | 18 | 8/4/6 | 3 | 10s | 10s | ✓ Same office. ALL STATIC. S1 MEDIUM static Emeka "unfolds arm, waves dismissively" + 8 words — 98%. Single gesture + dialogue = safe. S2 CU static Obinna 4 words — 98%. "Jaw is set" = static pose description. S3 CU static Emeka 6 words — 90%. Slight dip unexplained — all static, low words, description not animation. Possibly "cold contemptuous" vocal delivery complexity or Kling noise. 90% serviceable, no [REDO]. | S1: "That is between me and my wife." S2: "She was shaking, Emeka." S3: "Women shake. It means nothing." |

| ch7_sc3_c1 | 26 | 11/3/12 | 3 | 10s | 12s | ⚠ Construction office, Obinna + Emeka. ALL STATIC. S1 WIDE ESTABLISHING static Obinna 11 words — 98%. S2 CU static Emeka 3 words — 98%. "Eyes slide" = eye direction (confirmed safe). S3 MEDIUM static Obinna 12 words — DIDN'T GET A CHANCE. Clip ran out of time. Word density issue: S1=11w/3s (3.7w/s), S3=12w/3s (4w/s) — both exceed Kling's ~2.5w/s delivery rate. S2 only 3w/4s but spare time didn't carry over. **CANDIDATE FOR CLIP SPLITTING OR INSERT CONVERSION:** Two fix options: (A) Split S1+S2 / S3+next into two gens — more credits but guaranteed delivery. (B) Convert S2 to INSERT (B-roll of desk/documents/lamp) with Emeka's 3 words as voiceover. INSERT relieves BOTH animation budget AND temporal pressure — Kling doesn't need to time-sync lip movement on INSERT, so dialogue breathes more naturally across the full clip. S1's 11 words can bleed into INSERT window, S3 gets clean runway. **Upstream rule:** when total word count is high + unevenly distributed, convert the lightest-dialogue shot to INSERT. S2 (3 words) was the obvious candidate here. INSERT is credit-neutral (still one gen) vs. splitting (two gens). | S1: "You did not hear me knock because I did not." S2: "Close the door, Obinna." S3: "What you did at that church session — I was there." |

| ch7_sc2_c3 | 27 | 7/7/13 | 4 | 11s | 13s | ✓ Same café. S1 WIDE static 7 words — 98%. S2 CU SLOW PUSH-IN + "looks up from folder" + 7 words — 98%. "Looks up" behaved like eye direction (safe), not head movement. S3 CU "static then slow push-in" + "eyes fill but do not spill" (emotional state) + "voice breaks then steadies" (vocal direction) + 13 words — 85%. Better than predicted for heavily loaded shot. "Static then push-in" = partial push-in tax — camera static during early words, push-in only on back half. Partial push-in = partial budget cost. 85% serviceable, no [REDO]. | S1: "He planned this from the beginning." S2: "Why are you helping me, Chidinma?" S3: "He threw money at me like I was nothing. And I am not nothing." |

| ch7_sc2_c2 | 21 | 8/8/5 | 3 | 10s | 11s | ✓ Same café. S1 MEDIUM SLOW PUSH-IN Adaeze + "hand trembles slightly" + 8 words — 98%. SURPRISE: push-in + physical action + 8 words in multi-char = 98%. "Hand trembles slightly" behaves like ambient/description, not competing animation — too subtle to consume budget. S2 CU static Chidinma 8 words — 98%. "EFCC" acronym survived but "investigates" became "investigation" — TTS simplified verb conjugation to noun form. Add to difficult-word dictionary: verb→noun substitutions. S3 MEDIUM static Chidinma "holds up two fingers, ticking them off" + 5 words — 98%. Specific choreographed action + low word count = safe. | S1: "Why would he put my name on this?" S2: "If EFCC investigates, he needs someone to blame." S3: "You. Me. Both of us." |

| ch7_sc2_c1 | 17 | 6/4/7 | 3 | 10s | ~10s | ✓ Same café, documents scene. ALL STATIC. S1 WIDE static Chidinma 6 words — 98%. Physical action ("pressing page flat") on Adaeze (non-speaker) = no competition. S2 CU static Adaeze 4 words — 98%. "Face draining of color" = emotional state animation BUT ≤4 words saved it. Confirms ≤4 word threshold overrides even state animations. S3 CU static Chidinma 7 words — 98%. "Calm, confirming, merciless" = descriptions, no budget cost. | S1: "Your name. On every fraudulent filing." S2: "I never signed anything." S3: "He forged it. All of it." |

| ch7_sc1_c3 | 22 | 8/6/6 | 3 | 10s | ~10s | ✓ Same café. S1 MEDIUM static Chidinma slides folder + 8 words — 98%. Folder grounded in start frame, prop interaction safe. S2 INSERT on folder/hands + 6 words — dialogue delivered as voiceover over insert (no face visible). BUT direction reversed: folder slid toward Chidinma instead of toward Adaeze, and prop substituted folder→envelope. Direction reversal + prop substitution on INSERT. S3 CU SLOW PUSH-IN Adaeze + "eyes drop to folder, then rise slowly" + 6 words — 98%. SURPRISE: multi-step eye direction did NOT compete with lip sync. **Eye directions = descriptions, not state animations** — they don't consume animation budget. Distinct from body directions ("turns toward") and emotional state animations ("jaw tightens") which do compete. | S1: "I am not here to ask your forgiveness." S2: "I am here because of this." S3: "What is inside that folder?" |

| ch7_sc1_c2 | 15 | 7/5/3 | 3 | 10s | ~10s | ✓ Same café. ALL STATIC, no push-in anywhere. S1 WIDE static Chidinma 7 words — 98%. S2 CU static Adaeze 5 words — 98%. S3 CU static Chidinma 3 words — 98%. Clean sweep. "Eyes flash" = description (no budget cost), "holds gaze without blinking" = static pose (no budget cost). Template clip for reliable delivery: all static + low word counts + zero competing directions = 98% across the board. | S1: "Because he lied to both of us." S2: "You knew he was married." S3: "Yes. I did." |

| ch6_sc6_c3 | 17 | 8/0/9 | 2 | 11s | 11s | [REDO] ⚠ Same apartment. PHONE CALL with off-screen Chidinma. S1 WIDE static Adaeze on screen — Chidinma's dialogue "My name is Chidinma. We need to meet." (8 words) assigned to Adaeze's shot. Adaeze DELIVERED CHIDINMA'S LINE (wrong speaker). "Color draining, eyes widening" emotional state direction present but moot since wrong speaker delivered. S2 ECU on eyes, no dialogue — pure reaction, fine. S3 CU PUSH-IN Adaeze "Your husband is going to destroy both of us." (9 words) — Adaeze delivered this too. PHONE CALL HANDLING FAILED because prompt structure was wrong. Compare ch3_sc5_c1-c4 where phone calls worked: in those clips, on-screen character (Tunde) had his OWN dialogue, and off-screen caller (Ngozi) had separate dialogue tags. Here, Chidinma's dialogue was tagged to Adaeze's shot direction, so Kling assigned it to whoever was on camera. Upstream: phone call scenes need separate speaker handling — on-screen char gets reaction directions, off-screen voice gets its own dialogue tag with no character on screen. | S1: "My name is Chidinma. We need to meet." S2: (silence — reaction) S3: "Your husband is going to destroy both of us." |

**Emerging patterns (updated Session 28, 150 clips — OBSERVATION GATHERING COMPLETE):**
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
- **INSERT shots as strategic budget relief.** INSERT = B-roll cutaway (hands, props, objects) with dialogue delivered as voiceover. Zero lip sync budget consumed. Maintains 3-shot pacing while giving the other 2 shots more animation budget. Real drama technique: close-up of hands signing papers while character speaks off-screen. **Upstream strategy:** When a scene has heavy demands (props, actions, emotional beats, push-in), deliberately assign one shot as INSERT to offload pressure. Constraint: keep INSERT directions spatially simple — "close-up on the folder on the table" not "folder sliding across toward @character" (Kling reversed direction + substituted prop in ch7_sc1_c3). Don't ask spatial relationships in a shot with no character anchor.
- **Eye directions are descriptions, not state animations.** "Eyes drop to folder, then rise slowly" did NOT compete with lip sync (ch7_sc1_c3 S3: push-in + eye direction + 6 words = 98%). Distinct from body directions ("turns toward") and emotional states ("jaw tightens") which DO compete. Safe to include in dialogue shots.
- **≤4 words is the universal safe zone.** Overrides push-in, jaw directions, emotional state animations, ECU, profile angle — anything. Confirmed across ch7_sc1_c1 (5w/85%), ch7_sc2_c1 (4w/98% with "face draining"), ch7_sc4_c2 (3w/98% ECU profile), ch8_sc4_c2 (4w/98% with push-in+jaw+emotional).
- **Push-in + explicit stillness directive = safe.** "Sits still" / "does not move" cancels push-in competition. ch7_sc3_c3 S2: push-in + "sits still" + 6 words = 98%. Kling dedicates full budget to lip sync when no body animation requested.
- **"Static then push-in" (delayed push-in) reduces tax.** Camera static during early words, push-in only on back half = partial budget cost. ch7_sc2_c3 S3: 13 words + emotional state + delayed push-in = 85% (better than predicted).
- **Subtle/ambient physical actions don't compete.** "Hand trembles slightly" (ch7_sc2_c2), "shifts slightly" (ch7_sc3_c1), single gestures = safe. Distinct from deliberate macro-movements ("turns toward", "sets cup down") which do compete. Intensity threshold: micro-movements safe, choreographed macro-movements not.
- **Static pose descriptions ≠ state animations.** "Jaw is firm" / "lips pressed" / "jaw is set" (pose before speech) didn't suppress lip sync. "Jaw tightens" / "face drains" (concurrent animation) did. Poses = starting state, animations = competing action.
- **Per-shot word density ceiling ~3 words/sec.** ch7_sc3_c1: S1=11w/3s (3.7w/s) and S3=12w/3s (4w/s) both exceeded delivery rate. S3 never got a chance. Fix: INSERT conversion or clip splitting.
- **WIDE background speaker = unmeasurable lip sync.** Face too small/far to judge. Score reflects "dialogue delivered" not "mouth matched." Strategically useful — WIDE doesn't need precise sync.
- **WIDE with speaker facing away = voiceover delivery.** Back-of-head to camera means dialogue plays as body language + narration. 4 instances in EFCC corridor (ch8_sc1-sc2). Upstream fix: WIDE = blocking/atmosphere only, all dialogue on CU/MEDIUM.
- **Phone filter effect works when speaker tag is correct.** Off-screen caller with own `[@speaker_tag]` = Kling applies phone audio filter. 3 confirmed successes (ch3_sc5, ch7_sc5_c2, ch7_sc5_c3). Failure when off-screen caller's dialogue tagged to on-screen character (ch6_sc6_c3).
- **Continuous push-in across shots depletes total budget.** ch8_sc2_c3: S1 push-in → S2 push-in continuing → S3 static = S3 dialogue dropped entirely. Each shot's push-in consumes cumulative budget.
- **Single char can improvise props cleanly.** ch8_sc4_c2: Kling self-generated paper and phone on table. Full budget on one character allows prop generation + choreography + lip sync simultaneously. Multi-char prop improvisation is where problems occur.
- **Third-party elements in single-char scenes split attention.** ch8_sc4_c1 S3: "assistant's hand enters frame" dipped to 89%. Even in single-char, foreign elements introduce attention splitting.
- **Single-char scenes get full Kling rendering budget.** Across 11+ single-char clips, nearly all deliver 98/98/98% sweeps. Push-in safe, jaw directions safe, macro body movements safe, ECU-on-eyes safe (ch8_sc7_c2: 98% with 9 words on eyes-only framing — contradicts multi-char ECU-on-eyes failures). Multi-char clips baseline at 98/95/90% even all-static. The budget split is the root variable: single char = lip sync + body + camera + props all coexist; multi-char = budget divided, S3 (last in temporal queue) gets the remainder. **Upstream implication:** when a scene has heavy demands (emotional beats, push-in, prop interaction), structure as single-char shots with the other character off-screen or in reaction-only INSERT shots, rather than cramming both into every frame.
- **Hand-to-mouth without held prop = safe.** ch8_sc6_c4 S3: ECU push-in + "hand rises to cover mouth" + "eyes close" + 7 words = 98%. Contradicts ch6_sc5_c2 (hand-to-mouth + cup = voiceover). Difference: bare hand (no prop) and likely sequential execution (speech → hand raise) vs concurrent prop interaction.
- **"documents" TTS mangling.** ch8_sc6_c2: "documents" read as "docsuments". Add to difficult-word dictionary alongside "urgently"→"urgencently", "managed" mangled.

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
> 11. **ONE speaker per shot direction.** Never place two `[@speaker]` dialogue tags in a single shot. Kling cannot handle mid-shot speaker switches — it causes dialogue cross-contamination (wrong speaker delivers line), mid-shot character cuts, or one line dropping entirely. If two characters must speak in the same time window, split into two shots or two clips. Observed failures: ch5_sc4_c2 (speaker-assignment confusion), ch6_sc3_c2 (wrong speaker carried from S2→S3), ch9_sc3_c3 (character name in dialogue triggered mid-shot cut), ch9_sc5_c1 S3 (dual-speaker + mid-shot reframe + push-in). **Upstream implementation:** script generation must enforce max 1 `[@speaker]` tag per shot direction. If the scriptwriter generates a shot with 2 speakers, the pipeline should auto-split into two shots or flag for restructuring.

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
  - **Option A: Dialogue-aware scene image generation (EXPANDED Session 28)** — Extract spatial/environmental AND blocking cues from dialogue lines and feed them as constraints to the scene image prompt. This goes beyond prop/spatial elements — dialogue implies character positioning. Examples: "Come inside. Stop crying at my door." = one character should be at the threshold/door, NOT already inside unpacking (ch10_sc1_c1); "Close the door behind you" = character should be near a visible door; "hand me that file" = file should be visible on a surface. Dialogue contains blocking intent that the scene composition stage must respect. Implementation: before scene image generation, parse ALL dialogue in the scene for spatial/positional cues ("come in," "sit down," "stand up," "at my door," "across the table"), extract implied character positions and spatial relationships, and feed these as blocking constraints to the scene image prompt. The scene image should visually match the dramatic beat the dialogue describes. More invasive change but solves the root cause — dialogue and blocking are generated from the same dramatic intent.
  - **Option B: Post-image dialogue reconciliation (recommended)** — After scene image is generated, run a Vision pass that reads the image + dialogue together and flags lines referencing things not visible in the scene. Flagged lines get rewritten to preserve the dramatic beat while matching visual context (e.g., "Close the door behind you first" → "Sit down. We need to talk about this carefully."). Fits existing pipeline pattern — same concept as shot direction reconciliation applied one level up. Less invasive.
  - **Option C: Bidirectional** — Both A and B together. Belt and suspenders.
  - **Example:** ch5_sc3_c1 — "Close the door behind you first" but scene image shows both characters already at the desk with no door context.
  - **Cross-clip blocking progression (Session 28, ch10_sc2_c1):** Dialogue that implies position transitions ("Come in. Sit down.", "Stand up.", "Leave.") can be valid if the NEXT clip's scene image reflects the change — clip N dialogue drives clip N+1 blocking. This is legitimate cinematic grammar (character says "sit down," next cut shows them seated). But the pipeline must support it deliberately: (a) detect dialogue-implied blocking transitions at script stage, (b) generate progressive scene images per-clip when transitions occur (clip c1 = standing, clip c2 = seated), (c) validate that the next clip's start frame matches the transition. If progressive scene images aren't supported, the simpler fix is Option B — rewrite dialogue to match static blocking. Currently the pipeline uses one scene image per scene for all clips, so blocking transitions within a scene create contradictions. **Additional example (ch10_sc4_c2):** Ifeoma stands in c1 start frame, but Kling naturally seats her during c2 — the scene progressed but the start frame didn't. If c2 had a progressive scene image with Ifeoma seated on the bench, blocking would be consistent.
  - **Implementation timing:** After 150-clip observation gathering is complete.
- **Difficult-word replacement pass** — Pre-generation pass that scans dialogue for words Kling's TTS consistently mangles or mispronounces. Build a dictionary of problem words → simpler synonyms and auto-swap before prompt submission. Known problem words so far: "urgently"→"urgencently" (ch5_sc2_c1), "managed" mangled (ch6_sc4_c1), acronyms like "EFCC" (ch6_sc4_c1). Also flag: complex consonant clusters, multi-syllable words with unusual stress patterns, abbreviations/acronyms. Implementation: lightweight LLM pass or regex dictionary applied to dialogue lines before injection into multi-shot prompts. Timing: after 150-clip run, accumulate full problem-word list from observations.

### Full Automation Analysis — Script-Approved to Final Output (Session 28, 150 clips)

**Goal:** Once the script is approved by the human, can the pipeline run to completion without human intervention? What are the hard gates, what can be automated, and what verification exists vs what's missing?

**Current verification inventory by stage:**

| Stage | Prompt Stored | Prompt-to-Output Match | Human Gate | Automated Scoring | Gap |
|-------|:---:|:---:|:---:|:---:|-----|
| Portrait Gen | ✅ `prompt_used` | ❌ No vision check | ✅ Portrait approval | Partial (NSFW only) | No vision verification that portrait matches character description |
| Grid Gen | ✅ `prompt_used` | ❌ No validation | ❌ None | Partial (dimensions, file size) | No human approval, no vision check, no character consistency validation |
| Scene Image Gen | ✅ `prompt_used` | ❌ No vision check vs prompt | ✅ Scene approval | ❌ None | No automated check that scene contains correct characters/setting/props |
| Video Clip Gen | ✅ `prompt_used` | ✅ Recovery matching (Dice) | ✅ Accept/review/reject | ✅ Gemini ClipVerifier (3-tier) | Only stage with meaningful automated quality scoring |

**What's needed per stage for full automation:**

**1. Portrait Gen — currently has human gate**
- Add: Vision verification that portrait matches character bible description (skin tone, age, gender, clothing, hairstyle)
- Add: Face consistency scoring across multiple portrait generations for the same character
- Automated gate: Accept if vision match ≥ 90%, flag for human review if 70-90%, auto-reject + regenerate if < 70%
- Risk of full auto: Medium. Wrong face/wrong character is catastrophic downstream — every grid, scene, and clip inherits the error. **Recommend: keep human gate for v1, automate for v2 after confidence builds.**

**2. Grid Gen — currently has NO gate**
- Add: Vision verification that grid maintains face consistency with approved portrait
- Add: Multi-angle coverage check (front, profile, 3/4 — all present?)
- Add: Human approval gate (currently missing entirely — grids auto-pass)
- Risk of full auto: High. Grid is the character reference for ALL downstream generation. Bad grid = bad everything. **Recommend: add human gate first, then automate with vision scoring.**

**3. Scene Image Gen — currently has human gate**
- Add: Vision verification that scene contains the correct characters (match against portraits/grids)
- Add: Vision check that scene setting matches location prompt (indoor/outdoor, time of day, props present)
- Add: Blocking validation — characters positioned where the script expects them (using dialogue-aware blocking from Option A)
- Add: Cross-scene continuity check (same character looks the same across scenes)
- Automated gate: Accept if all checks pass, flag for review if any fail
- Risk of full auto: Medium-high. Wrong characters in scene or wrong setting cascades to clips. **Recommend: automate with vision + keep human gate as override for v1.**

**4. Video Clip Gen — already has automated scoring (Gemini ClipVerifier)**
- Existing: Gemini multimodal scoring (accept/review/reject), max 3 redo iterations
- Add: Lip sync accuracy scoring (automated, not manual observation)
- Add: Prompt-to-output verification — does the clip contain the right characters, right setting, right shot scales?
- Add: Rules engine based on 150-clip observations — pre-generation validation that catches known failure patterns BEFORE burning Kling credits (push-in + emotional state + dialogue = auto-reject the prompt, fix first)
- Risk of full auto: Low-medium. Clips are the most expensive stage (Kling credits) but already have the best verification. **Recommend: enhance existing ClipVerifier + add pre-generation rules engine.**

**Non-negotiable hard gates (must remain human-in-the-loop):**

1. **Script approval** — Creative decisions about story, dialogue, pacing. Cannot be automated.
2. **Portrait approval (v1)** — Character identity is the foundation. Wrong face cascades everywhere. Keep human gate until vision-based face consistency scoring is proven reliable.
3. **Final cut review** — Even with perfect individual clips, the assembled sequence needs editorial judgment: pacing, emotional arc, continuity between clips. Human review of assembled scenes before export.

**Gates that CAN be automated (with sufficient verification):**

1. **Grid generation** — Once portrait is approved, grid is mechanical (same face, multiple angles). Vision scoring for face consistency can automate this.
2. **Scene image generation** — With vision verification (correct characters + setting + blocking), can be auto-approved if all checks pass, with human review only on flagged failures.
3. **Individual clip generation** — Already partially automated via ClipVerifier. Enhance with pre-gen rules engine + lip sync scoring for full automation.

**Pre-generation rules engine (NEW — biggest automation win):**
Before submitting ANY prompt to Kling, validate it against the 150-clip observation rules:
- Max 1 speaker per shot direction
- No laughter/laughing + dialogue in same shot
- No push-in + emotional state animation + dialogue (>6 words)
- No ECU on background-profile characters
- No "lifts head"/"raises head" macro movement + dialogue on push-in shots
- No props-in-hand + dialogue (unless ≤4 words)
- Word count ceiling per shot (~10 words for push-in, ~12 for static)
- Speaker must face camera (no back-to-camera dialogue)
- No worn accessory removal in dialogue shots

If the prompt violates any rule, auto-fix (simplify direction, remove competing animation, split shot) BEFORE submitting to Kling. This prevents burning credits on prompts that will fail based on known patterns.

**Pros of full automation (post script-approval):**
- Speed: 150 clips could generate in hours instead of days of manual review
- Consistency: rules engine applies the same quality bar to every clip
- Scale: can process multiple productions simultaneously
- Credit efficiency: pre-gen rules prevent known-failure prompts from burning Kling credits

**Cons of full automation:**
- Edge cases: the 150-clip dataset doesn't cover every possible failure mode
- Creative judgment: some "failures" are actually dramatic (off-screen voiceover, Kling improvisation)
- Cascading errors: automated approval at portrait/grid stage can propagate wrong-face through entire production
- Over-correction: aggressive rules engine might reject prompts that would have worked, making the output too conservative

**Recommended automation roadmap:**
- **Phase 1 (now):** Implement pre-gen rules engine + upstream fixes. Keep all human gates.
- **Phase 2:** Add vision verification at portrait/grid/scene stages. Automate grid approval. Scene approval becomes human-override-only (auto-approve if vision passes).
- **Phase 3:** Remove portrait human gate (vision + face consistency scoring proven). Full auto from script-approval to assembled clips, with human review only at final cut.

### REDO Strategy — Credit-Conscious Selective Regeneration

**Constraint:** Kling credits are limited. Cannot blindly redo all 39 [REDO]-tagged clips. Must fix upstream prompt generation code FIRST, then selectively redo only the clips where the fix would actually change the outcome.

**Sequence:** Finish 150-clip observations → implement prompt-level code fixes → re-categorize 39 clips → redo only Tier 1 with fixed prompts.

**Priority tiers (what to redo vs. let go):**

| Tier | Verdict | Failure types | Examples |
|------|---------|---------------|----------|
| **Tier 1 — Must redo** | Unwatchable, breaks story | Accent flip (American instead of Nigerian), dialogue fabricated/replaced by Kling, dialogue dropped entirely, wrong speaker delivered lines, cross-contamination S2→S3 | ch3_sc4_c2 (Kling said "I will move" instead of scripted line), ch6_sc3_c2 (pastor spoke instead of correct character) |
| **Tier 2 — Let go** | Acceptable, viewer won't notice | Morphing artifacts in dead air (mitigated by duration formula), minor lip sync degradation (80-85%), prop substitution (paper vs envelope), phantom hand animations | ch5_sc4_c2 (paper instead of envelope), ch6_sc5_c2 (morphing hands in dead air) |
| **Tier 3 — Case-by-case** | Depends on scene importance | S3 lip sync at 60-70%, partial delivery | Emotional climax scenes = redo; transitional scenes = let go |

**Prompt-level code fixes required BEFORE any redo (changes to prompt builder, not manual edits):**

1. **Strip push-in from S3** when dialogue + multi-char present — code rule in shot direction generator
2. **Replace emotional state animations with descriptions** — "jaw tightens" → "tension visible in his expression" (description doesn't consume animation budget, state animation does)
3. **No ECU-on-eyes with dialogue** — if shot has dialogue requiring visible mouth, ECU must frame mouth, not just eyes
4. **No physical actions + dialogue in same shot** — split into: action shot (no dialogue) → dialogue shot (no action), or move action to non-dialogue shot
5. **Multi-element direction splitting** — one direction per visual element, not "turns to her while setting down the cup"
6. **Phone call scene handling** — dedicated prompt template for phone conversations (phone filter effect, one-sided framing)
7. **Difficult-word dictionary** — regex/LLM swap of known problem words before prompt injection
8. **WIDE = blocking/atmosphere only, CU/MEDIUM = dialogue delivery** — WIDE ESTABLISHING shots should never carry primary dialogue. WIDE serves as scene-setting (spatial relationships, ambient body animation like natural swaying/breathing/shifting). All dialogue must be delivered on CU or MEDIUM where lip sync is visible and measurable. If WIDE has dialogue, it functions as unmeasurable voiceover with body language — acceptable but not ideal. Shot direction generator should assign dialogue only to CU/MEDIUM shots. WIDE slots become budget-free atmosphere zones. Works with INSERT strategy: WIDE (ambient) → CU (dialogue) → CU (dialogue), or CU → INSERT (voiceover B-roll) → CU.
9. **Per-shot word count ceiling (~10 words)** — any single shot direction exceeding ~10 words auto-flags the clip for splitting. 27 words in one shot (ch7_sc5_c3 S3) is impossible to deliver. When flagged, restructure the overloaded shot into its own clip with 3 shot directions (static→INSERT→push-in). Code change: count words per shot in prompt builder, flag/split when threshold exceeded.
9. **Explicit hand assignment for dual-prop interactions** — when a character holds a prop (phone, cup, etc.) AND interacts with another object (folder, document), assign each to a specific hand: "right hand holds phone to ear, left hand flips through folders." Without explicit assignment, Kling merges both actions into one hand and morphs the prop (ch7_sc5_c1: phone morphed into folders). Code change: detect held-prop + object-interaction in same shot direction, auto-split by hand in prompt builder.

**Each fix is a code change in the prompt builder** — not a per-clip manual edit. Once implemented, the redo script (`scripts/redo-cinematic-clips.js`) regenerates clips through the fixed pipeline automatically. The point of fixing upstream first: same prompt inputs that caused the failure won't be sent again.

**After implementing fixes, re-triage the 39 [REDO] clips:**
- For each clip, check: does the upstream fix address THIS clip's specific failure?
- If yes AND Tier 1 → redo
- If yes AND Tier 3 + important scene → redo
- If fix doesn't address the failure (e.g., Kling randomness) → skip, not worth the credits
- Estimate total credit cost before executing batch redo

### Session 29 — Pre-Generation Rules Engine Implementation + REDO Re-Categorization

**Status:** ✅ Rules engine implemented in `_validateAndFixPromptRules()` at orchestrator.js. 9 auto-fix rules + 2 informational rules. Hooked into `_runCinematicVideoStage` after all 3 vision passes + sanitization, before prompt preview gate.

**Architecture:** Pure synchronous method (no API calls, no Vision). Takes `(prompt, verifiedPositions, clipDef, clipId)`, returns `{ prompt, fixes[] }`. Non-destructive passthrough when no rules violated. Each fix logged with rule number and explanation.

**Rules implemented:**

| Rule | Type | What it does |
|------|------|-------------|
| R1 | Flag | Max 1 `[@speaker]` per shot — flags dual-speaker shots for manual review |
| R2 | Auto-fix | Laughter/laughing + dialogue → replaces with "warm smile"/"smiling warmly" |
| R3 | Auto-fix | Push-in + emotional state animation + dialogue >6 words → strips emotional animation |
| R4 | Auto-fix | ECU on background+profile character → downgrades to CU |
| R5 | Auto-fix | "lifts head"/"raises head" + push-in + dialogue → "gaze rises" |
| R6 | Auto-fix | Props-in-hand + dialogue >4 words → strips prop interaction |
| R7 | Flag | Per-shot word count ceiling (10 push-in, 12 static) — warns when exceeded |
| R8 | Auto-fix | Speaker faces away from camera → injects "turns slightly toward camera" (CU/MEDIUM only) |
| R9 | Auto-fix | Worn accessory removal in dialogue shots → strips the removal phrase |
| R10 | Already impl | Scene-setting line posture correction — verified working at `_injectVisionBlocking` ~line 4407 |
| R11 | Info | Dialogue-aware blocking — flags spatial cues ("come in", "sit down", "close the door") |

**Key design decisions:**
- Emotional state ANIMATIONS (compete with lip sync): "face drains", "jaw tightens", "tears streaming", "chin trembles", "eyes fill", etc.
- Emotional DESCRIPTIONS (safe, don't compete): "eyes are steady", "jaw is set", "face is calm", "expression does not shift"
- ≤4 words is the universal safe zone — overrides ANY competing direction combination
- ≤6 words is the push-in+emotion safe zone — Rule 3 only fires above 6 words
- Rule 6 (props) uses ≤4 word threshold since props-in-hand is a strong budget competitor
- Rule 8 only injects turn for CU/MEDIUM — WIDE+facing-away is acceptable as voiceover

**Hook point:** After posture fix block, before prompt preview gate. Prompt flow:
1. `_injectVisionBlocking()` — rewrites preamble + posture verbs (including scene-setting line)
2. `_reconcileShotDirectionsWithImage()` — 3rd Vision pass, fixes physically impossible actions + visual-state contradictions
3. Sanitization — @-ref cleanup, bare name fix, curly quotes, dialogue @-strip
4. Posture fix — last-chance Shot 1 posture correction
5. **NEW: `_validateAndFixPromptRules()`** — rules engine
6. Prompt preview gate — user sees the final prompt

**REDO Re-Categorization (45 clips analyzed against implemented rules):**

**Tier 1 — REDO with fixed prompt (fix would change outcome): 24 clips**

| Clip | Failure | Rule(s) that fix it | Expected improvement |
|------|---------|---------------------|---------------------|
| ch1_sc2_c3 | S3: ECU+push-in+11w lip sync broken | R7 flags 11w exceeds 10w push-in ceiling | Warning only — needs manual dialogue trim |
| ch2_sc1_c3 | S3: physical action consumed budget, dialogue dropped | R6 strips prop interaction ("opened drawer, reached in") | High — stripping drawer interaction frees lip sync budget |
| ch2_sc2_c1 | S3: push-in+facial action+5w lip sync fail | R3 would strip emotional animation if >6w; 5w is safe zone — **not fixable by rules** | Low — move to Tier 2 |
| ch2_sc2_c2 | S3: push-in+facial expression+7w | R3 strips emotional animation (push-in+emotion+7w>6) | High — stripping emotion frees push-in budget |
| ch3_sc3_c3 | S3: ECU on eyes, dialogue dropped entirely | R4 downgrades ECU→CU if background+profile | Medium — depends on char position; ECU-on-eyes is the core issue |
| ch3_sc4_c2 | S3: dialogue REPLACED by Kling fabrication | R7 flags word count; not directly fixable | Low — Kling randomness, move to Tier 2 |
| ch3_sc5_c4 | S3: ECU+push-in+action+prop+wardrobe morph | R6 strips "lowers the phone" prop action; R3 strips emotional if present | Medium — reduces S3 load |
| ch4_sc1_c3 | S3: push-in+multi-char, dialogue DROPPED | R7 flags 7w on push-in (under ceiling but close) | Low — push-in+multi-char is the root cause, not prompt-fixable |
| ch4_sc4_c1 | S3: push-in+action ("whiskey sip")+dialogue | R6 strips "takes a slow sip of whiskey" prop action | High — stripping whiskey action frees dialogue budget |
| ch4_sc4_c2 | S3: Kling improvised mug-drinking, dialogue dropped | Not directly fixable — Kling improvised from scene image props | Low — move to Tier 2 |
| ch4_sc5_c2 | S3: ECU+push-in+7w multi-char, lip sync failed | R7 flags 7w on push-in; R4 if background+profile | Medium — word count is at ceiling |
| ch4_sc7_c2 | S3: "reaches out" macro movement, dialogue dropped | R6 strips prop/body interaction (macro arm raise) | High — stripping reach-out frees budget |
| ch5_sc1_c1 | S3: push-in+8w single-char, lip sync failed | R7 flags 8w on push-in (under 10w ceiling but single-char push-in at 8w is borderline) | Low — borderline, may not help |
| ch5_sc1_c2 | S2: gesture ate budget; S3: jaw tightens+bitter laugh+10w | R2 replaces "bitter laugh" with smile; R3 strips "jaw tightens" on 10w; R6 strips "taps documents" | High — multiple fixes address multiple failure shots |
| ch5_sc1_c3 | S2: "face drains, eyes widening in horror"+7w | R3 strips "face drains" emotional animation (push-in is ECU static, but emotion is the competitor) | High — stripping emotional animation is the key fix |
| ch5_sc2_c1 | S1: face turned away; S3: "turns slightly toward Adaeze" | R8 injects "turns toward camera" for facing-away speaker | Medium — S1 facing-away is the fixable issue |
| ch5_sc2_c2 | S3: "face goes pale, lips barely moving"+9w | R3 strips "face goes pale" and "lips barely moving" | High — directly addresses the failure cause |
| ch5_sc2_c3 | S3: push-in+"tears streaming, voice breaking"+10w | R3 strips "tears streaming" + "voice breaking"; R7 flags 10w at ceiling | High — emotional animation stripping is key |
| ch5_sc4_c2 | S3: dialogue cross-contamination (wrong speaker) | R1 would flag if dual-speaker; but this is speaker-assignment confusion, not dual-speaker | Low — not prompt-fixable, move to Tier 2 |
| ch5_sc5_c2 | S3: push-in+"face drains, full horror"+10w | R3 strips "face drains" + "full horror"; R7 flags 10w at ceiling | High — exact pattern Rule 3 targets |
| ch5_sc5_c3 | S2: "exhales a short bitter breath, eyes dropping"+5w; S3: profile speaker | R8 injects turn directive for S3 profile speaker | Medium — S3 profile is fixable |
| ch6_sc1_c3 | S3: Emeka behind/partial visibility, CU reframe failed | R8 injects turn directive if facing away | Medium — depends on verified position |
| ch6_sc2_c1 | S3: stacked micro-actions ("shifts, fingers tightening, warmth cracking")+8w | R3 strips competing emotional/body animations | High — direction stacking is the cause |
| ch6_sc2_c2 | S2: anomalous failure (clean static CU) | Not prompt-fixable — anomalous Kling behavior | Low — move to Tier 2 |
| ch6_sc3_c2 | S2-S3: wrong speaker (dialogue cross-contamination) | Not prompt-fixable — Kling speaker-assignment confusion | Low — move to Tier 2 |
| ch6_sc5_c2 | S1: hand-to-mouth+cup = prop improvisation | Not directly fixable — prop in start frame, not in prompt | Low — move to Tier 2 |
| ch6_sc6_c1 | S3: cup-in-hand, Kling animated cup-setting-down | Not directly fixable — prop in start frame | Low — move to Tier 2 |
| ch6_sc6_c3 | Phone call: wrong speaker tag structure | Not fixable by rules engine — prompt structure issue at script stage | Low — separate phone-call-template fix needed |
| ch7_sc5_c3 | S3: 27 words in single shot | R7 flags 27w exceeding 10w ceiling | Flag only — needs clip restructuring, not auto-fixable |
| ch8_sc2_c3 | S3: continuous push-in S1→S2 depleted budget | Not prompt-fixable — cross-shot budget depletion | Low — move to Tier 2 |
| ch9_sc3_c1 | S3: push-in+prop manipulation ("prayer beads")+8w | R6 strips "prayer beads turn slowly in fingers" prop manipulation | High — stripping prop interaction frees budget |
| ch9_sc4_c1 | S3: "TV light plays across face" interpreted as lighting animation | Strip lighting direction (edge case — not yet covered by rules but similar to R3) | Medium — close to Rule 3 territory |
| ch10_sc1_c1 | S3: props-in-hand (flowers), dialogue never delivered | R6 strips prop interaction if >4 words (10w) | High — directly addresses failure |
| ch10_sc1_c3 | S3: ECU on background+profile character | R4 downgrades ECU→CU | High — directly addresses failure |
| ch10_sc3_c1 | S3: "lifts his head"+push-in+9w, dialogue never delivered | R5 replaces "lifts head" with "gaze rises" | High — directly addresses failure |
| ch10_sc7_c1 | S3: laughter animation+dialogue, dialogue never delivered | R2 replaces "she laughs — full and free" with warm smile | High — directly addresses failure |

**Final Tier 1 (fix would change outcome) — 19 clips:**
ch2_sc1_c3, ch2_sc2_c2, ch3_sc5_c4, ch4_sc4_c1, ch4_sc7_c2, ch5_sc1_c2, ch5_sc1_c3, ch5_sc2_c1, ch5_sc2_c2, ch5_sc2_c3, ch5_sc5_c2, ch5_sc5_c3, ch6_sc1_c3, ch6_sc2_c1, ch9_sc3_c1, ch10_sc1_c1, ch10_sc1_c3, ch10_sc3_c1, ch10_sc7_c1

**Tier 2 (fix wouldn't help — Kling randomness, speaker confusion, start-frame props, or anomalous): 18 clips:**
ch1_sc3_c2 (departure verb — not covered), ch1_sc5_c1 (physical choreography — too complex for rules), ch2_sc1_c2 (accent flip — not prompt-fixable), ch2_sc2_c1 (5w safe zone, push-in is root cause), ch2_sc5_c1 (29w density — flag only), ch2_sc6_c1 (ECU on eyes — may still fail at CU), ch3_sc1_c2 (S2 push-in depleted S3 — cross-shot), ch3_sc2_c1 (push-in+multi-char root cause), ch3_sc3_c3 (ECU on eyes), ch3_sc4_c1 (all-static outlier — anomalous), ch3_sc4_c2 (Kling fabrication), ch4_sc3_c1 (single-char push-in anomaly), ch4_sc4_c2 (Kling prop improvisation from scene image), ch4_sc6_c1 (Kling prop improvisation from character portrait), ch5_sc4_c2 (speaker confusion), ch6_sc2_c2 (anomalous), ch6_sc3_c2 (speaker confusion), ch6_sc5_c2 (start-frame prop), ch6_sc6_c1 (start-frame prop), ch6_sc6_c3 (phone call template), ch7_sc5_c3 (27w — needs restructuring), ch8_sc2_c3 (cross-shot depletion), ch9_sc4_c1 (lighting direction edge case), ch4_sc1_c3 (push-in+multi-char root), ch4_sc5_c2 (push-in+multi-char), ch5_sc1_c1 (borderline word count)

**Estimated redo cost:** 19 Tier 1 clips × ~11 credits = ~209 credits. Verification calls: ~$0.38 (19 × $0.02). Total: ~210 credits + <$1 API costs.

**Recommendation:** Redo Tier 1 clips first. Review results. If Rules Engine improves >70% of Tier 1 clips, consider expanding to Tier 2 clips with minor prompt tweaks.

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

**WebP-in-PNG handling:** Cinema Studio saves scene images with `.png` extension but WebP content. The verification detects actual format from file magic bytes (first 12 bytes: PNG `89504E47`, JPEG `FFD8FF`, WebP `RIFF....WEBP`) and converts WebP→JPEG via ffmpeg before sending to Codex Vision API.

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

**Fix: `_reconcileShotDirectionsWithImage(sceneImagePath, verifiedPositions, prompt, imageData, mimeType)`** — 3rd Vision pass, per-clip. Sends the scene image + verified character positions + full shot directions to Codex Vision. Checks for TWO types of problems: (A) physically impossible actions given character positions, and (B) visual-state contradictions — wardrobe, props, or appearance described in shot directions that contradict what's visible in the scene image (the start frame). Kling cannot change wardrobe or conjure props not in the start frame. For visual-state contradictions, the fix is always STRIP (remove the contradicting phrase) — never invent a replacement. Runs ONLY when the 2nd Vision pass made corrections (corrections > 0).

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

**KNOWN GAP — Scene-setting line posture contradiction (Session 28, clip ch9_sc3_c2):**
The scene-setting line (the text between CHARACTER POSITIONS and Shot 1, e.g. "Inside Ngozi's apartment living room, mama_okafor now seated on the sofa, adaeze standing nearby") is NOT checked for posture/position contradictions against the start frame. All three vision passes miss it:
- **Pass 1** (`_analyzeStartFrame`/`_verifyBlockingWithSceneImage`): Builds CHARACTER POSITIONS from image — correctly identifies postures. Does NOT touch the scene-setting line.
- **Pass 2** (`_injectVisionBlocking`): Posture verb correction at ~line 4372 only scans **Shot 1 body text** via regex `(Shot\s*1\s*\([^)]*\)\s*:\s*)(.*?)`. The scene-setting line sits BEFORE Shot 1, outside this match.
- **Pass 3** (`_reconcileShotDirectionsWithImage`): Checks "each shot's directions" — the scene-setting line isn't a shot direction. The SPATIAL POSITION examples only show shot-level contradictions. Vision may or may not flag it, and even if it does, the reasoning-stripping logic preserves the scene-setting line as-is (extracted verbatim, never modified).
**Root cause:** The scene-setting line is written by the scriptwriter before the scene image exists. Vision corrects CHARACTER POSITIONS and shot directions but the scene-setting line passes through untouched.
**Observed failure:** ch9_sc3_c2 — start frame has Mama Okafor standing at kitchen doorway, but scene-setting line says "mama_okafor now seated on the sofa." Kling had to reconcile standing→seated, creating a continuity jump. Scores survived (98/98/95) but the position contradiction is a reliability risk.
**Fix needed:** Extend posture verb correction in `_injectVisionBlocking` (~line 4372) to also scan the scene-setting line (text between CHARACTER POSITIONS preamble and Shot 1) for posture mismatches against vision-verified positions. Same regex-based fix as Shot 1 posture correction — find `@name seated/standing/sitting` patterns in scene-setting line and correct to match vision truth.

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

### Session 30 — Assembly Gate, Redo Recovery, Prompt Grounding, Script Engine Roadmap

**Assembly Integrity Gate (orchestrator.js):**
Hard gate before FFmpeg assembly. Checks: (1) every clip of the expected type is status=done — throws with clip names if any pending/failed, (2) every done clip has its file present on disk — catches stale DB entries where .mp4 was deleted/moved/soft-deleted. Both throw immediately with identifying info. Prevents partial or broken assemblies.

**Redo Recovery Widened (orchestrator.js, db.js):**
- Pre-stage recovery block now catches `scenes-done` in addition to `verified`/`assembled`. Fixes edge case: previous restart successfully set stage to `scenes-done` but crashed on `db.runSqlDirect()` (which didn't exist) before clearing `gen_clicked_at`. Second restart saw `scenes-done` (not in the old `['verified','assembled']` filter), skipped recovery, and stale `gen_clicked_at` caused asset recovery instead of fresh generation.
- `db.runSqlDirect()` replaced with new exported `db.clearAssetGenerationMeta(assetId)` — clears `gen_clicked_at`, `prompt_used`, `cdn_url`.

**Production Grounding (orchestrator.js):**
Every Kling `multi_shot_prompt` now gets:
- **Prefix:** `Nigerian drama — Nollywood drama set in Nigeria, Nigerian cast, Nigerian accent all through. SFX: add appropriate sfx to dramatic lines. Score: add dramatic score.`
- **Suffix:** `NO SUBTITLES.`
Injected after rules engine, before prompt preview gate. Idempotent — won't duplicate on re-runs. Anchors Kling in the production's creative identity so it never drifts to generic/Western defaults.

**check-rejections.js utility:**
Read-only DB inspector. Shows all rejected and pending clips with status, file path, gen_clicked_at. Uses sql.js snapshot (in-memory, no writes to disk). Safe to run while app is live. Usage: `node check-rejections.js`

---

### Script Engine Improvement Roadmap (Future Changes to `script-engine.js`)

Observations from the 150-clip production run. The rules engine (orchestrator.js) catches these at video gen time, but moving them upstream into the script engine's cinematic scaffolding would produce cleaner prompts from the start.

**A. Upstream Rules — Move from Rules Engine to Script Scaffolding**

| # | Issue | Current fix (rules engine) | Proposed script engine change |
|---|-------|---------------------------|-------------------------------|
| A1 | Dual-speaker shot directions | R1 flags 2+ `[@speaker]` in Shot 2/3 | Add to `_sanitizeKlingClipPrompts`: detect and strip second speaker ref from Shot 2/3 at script time |
| A2 | Laughter + dialogue collision | R2 replaces "laughing" with "warm smile" | Scaffolding instruction: "Never describe a character laughing while delivering dialogue — use 'warm smile' or 'grinning'. Laughter and lip-sync compete for the same rendering budget." |
| A3 | Push-in + emotion + long dialogue | R3 strips emotional animation when >6 words | Scaffolding budget note: "Push-in camera movement, emotional state animations, and dialogue compete for Kling's rendering budget. Push-in shots: keep dialogue ≤6 words, no concurrent emotional animations. Long lines (8+ words): use static camera." |
| A4 | Props-in-hand + dialogue | R6 strips prop interaction when >4 words | Scaffolding: "Characters should not interact with held props during dialogue shots unless dialogue is ≤4 words. Prop interactions and lip-sync compete for rendering budget." |
| A5 | No word count awareness | R7 flags shots exceeding 10/12 word ceiling | Scaffolding: "Dialogue per shot: aim for 8-10 words on static shots, 6-8 words on push-in shots. Kling drops trailing words beyond ~12 words in a single shot." |
| A6 | Speaker facing away | R8 injects turn directive | Scaffolding: "If a character's blocking describes them facing away from camera, their first dialogue shot MUST include a turn — 'turns to face camera' or 'turns over shoulder'. Kling cannot animate lip-sync on the back of a head." |

**B. Scene Continuity Across Multiple Clips (Same Scene)**

Current limitation: one scene image per scene, shared by all clips in that scene. When dialogue implies position transitions ("Come in. Sit down.", "Stand up.", "Leave."), later clips inherit the same start frame — creating contradictions where the character has already moved in the previous clip but the start frame shows the original position.

**Observed failures:**
- ch10_sc2_c1: "Come inside. Stop crying at my door." — but scene image shows character already inside
- ch10_sc4_c2: Ifeoma stands in c1 start frame, Kling naturally seats her during c2 — scene progressed but start frame didn't
- ch9_sc3_c2: Scene-setting says "seated on the sofa" but start frame shows standing at doorway

**Proposed solutions (from Session 28 analysis):**
1. **Progressive scene images per clip** — detect dialogue-implied blocking transitions at script stage (verbs: "come in", "sit down", "stand up", "leave", "walk to"), generate per-clip scene images when transitions occur (c1=standing, c2=seated). Most accurate but most expensive (extra scene image generations).
2. **Dialogue-to-blocking reconciliation** — post-image Vision pass reads scene image + dialogue, flags lines referencing states not visible. Rewrites dialogue to match visual context ("Close the door behind you" → "Sit down. We need to talk."). Less invasive, fits existing pipeline pattern.
3. **Script-level continuity annotations** — script engine marks clips that imply blocking transitions with `blocking_transition: { character: "@ada", from: "standing", to: "seated" }`. Pipeline uses these to decide whether to generate progressive scene images or rewrite dialogue.

**C. Shot Direction Sentence Length Cap**

Observed: long shot directions (20+ words) cause Kling to either ignore parts of the direction or deprioritize lip-sync. Shot directions should be concise instructions, not prose descriptions.

**Proposed rules:**
- Shot direction body (excluding dialogue tag): max 15 words. If more is needed, split the detail into the scene-setting line or a continuity note.
- Camera + subject + action in that order: "MEDIUM SHOT on @emeka, static. He spreads his hands wide." (11 words) — not "As the camera holds on Emeka in a medium shot, he slowly spreads his hands wide while looking toward the window with growing concern." (24 words)
- Overflow strategy: when a shot direction exceeds 15 words, split into: (a) essential camera + subject + primary action in the shot direction, (b) atmospheric/secondary detail moved to scene-setting line or blocking notes

**D. Dynamic Scenes — Movement Progression Across Clips**

Kling treats each clip independently — it doesn't know what happened in the previous clip. When a scene involves physical progression (character walks across room, gradually becomes more agitated, transitions from standing to seated), each clip's shot directions must explicitly re-state the current physical state rather than assuming continuity from the previous clip.

**Proposed scaffolding additions:**
- "Each clip is rendered independently by Kling with no memory of previous clips. Shot 1 of every clip must re-establish the current physical state of all characters — do not assume Kling remembers what happened in the previous clip."
- "For scenes with physical progression (character moves, sits, stands, enters/exits), each clip's CHARACTER POSITIONS preamble and Shot 1 must reflect the state AT THE START OF THAT CLIP, not the start of the scene. If a character sat down in clip 2, clip 3's blocking should describe them as seated."
- "Movement within a clip is fine (character stands up in Shot 2). Movement ACROSS clips requires explicit re-establishment in the next clip's blocking."

**E. Structured SFX/Score Hints (Future)**

Currently using blanket grounding prefix ("add appropriate SFX", "add dramatic score"). Future enhancement: per-clip structured fields in the script JSON schema.

```json
{
  "clip_id": "ch3_sc3_c1",
  "sfx_hint": "door slam, glass breaking",
  "score_hint": "tension rising, strings crescendo",
  "multi_shot_prompt": "..."
}
```

Script engine would author these per clip based on dramatic context. Orchestrator would inject them into the prompt alongside the grounding prefix. Not needed now — blanket approach works — but gives finer control for productions that need specific sound design.

**F. Subtitle Suppression at Script Level**

Currently `NO SUBTITLES.` is appended as a suffix by the orchestrator. If Kling consistently ignores the suffix position, move into the scaffolding template so it's baked into every `multi_shot_prompt` Codex writes: "Do NOT include subtitle text, caption overlays, or on-screen text of any kind."

**G. Difficult-Word Replacement Dictionary**

Pre-generation pass scanning dialogue for words Kling's TTS consistently mangles. Known problem words: "urgently"→"urgencently", "managed"→mangled, acronyms like "EFCC", verb→noun substitutions ("investigates"→"investigation"). Implementation: regex dictionary or lightweight LLM pass applied to dialogue lines before prompt injection. Build dictionary incrementally from production observations.

### Multi-Outfit Character System (Planned — Not Yet Implemented)

**Problem:** Characters currently have one visual identity across the entire video. In a 20-30 minute drama spanning days/locations, characters realistically change clothes — a corporate scene vs. a home scene vs. a night scene. One fixed element per character produces visual monotony and breaks believability.

**Design Decision: Element = Character + Outfit**

Each Higgsfield element represents a character in ONE outfit. A character with 3 outfits across the story gets 3 separate elements. The script writes a single `@character_name` reference; the orchestrator swaps it for the correct outfit-specific element at generation time.

**Element Naming Format (recommended):**

```
@{baseName}_o{N}_{suffix}
```

- `{baseName}` = character's `element_name_hint` (e.g. `ada`, `mama_adaeze`)
- `o{N}` = outfit number (o1, o2, o3...)
- `{suffix}` = existing project suffix (e.g. `bpdr_0419`)
- Full examples: `@ada_o1_bpdr_0419`, `@ada_o2_bpdr_0419`, `@mama_adaeze_o1_bpdr_0419`

Outfit 1 is the default/primary outfit. If a character only has 1 outfit, the `_o1_` segment is still included for consistency.

**Rationale for `_o{N}` over descriptive names:** Element names have practical UI length limits in Higgsfield (~30 chars before truncation). Descriptive names like `@ada_formal_business_bpdr_0419` exceed that. The outfit description lives in the script data — the element name only needs to be a unique, parseable key.

**Script Engine Schema Changes:**

Character bible gets an `outfits` array:
```json
{
  "id": "ada_okonkwo",
  "element_name_hint": "ada",
  "description_label": "Ada Okonkwo",
  "full_prompt_description": "...(physical features, face, build — EXCLUDES clothing)...",
  "outfits": [
    {
      "outfit_id": "o1",
      "description": "Corporate Lagos — navy fitted power suit, gold stud earrings, straight shoulder-length wig, nude heels",
      "context": "Office scenes, corporate meetings, public appearances"
    },
    {
      "outfit_id": "o2",
      "description": "At home — coral ankara wrapper tied at the waist, matching head tie, bare feet, no makeup",
      "context": "Home scenes, private moments, morning/evening"
    }
  ],
  "speech_style": "sharp",
  "speech_notes": "..."
}
```

Each scene declares which outfit each character wears:
```json
{
  "scene_number": 3,
  "characters_present": ["ada", "emeka"],
  "character_outfits": {
    "ada": "o2",
    "emeka": "o1"
  }
}
```

**Note:** `full_prompt_description` describes PHYSICAL FEATURES ONLY (face, build, skin tone, hair texture, distinguishing marks). Clothing moves to the `outfits` array. This separation ensures face identity is preserved across outfit changes.

**Portrait Generation Flow:**

1. **Master portrait (outfit 1):** Generated from `full_prompt_description` + `outfits[0].description`. This is the identity anchor — the face that all subsequent outfit portraits must match.
2. **Outfit N portrait:** Generated using master portrait AS REFERENCE IMAGE + prompt: `"Same person as the reference. [full_prompt_description]. Now wearing: [outfits[N].description]. Same face, same build, different clothing. Photorealistic, studio lighting."` The reference image ensures face consistency across outfits.
3. **Grid per outfit:** Each outfit portrait → its own 4-column reference grid (same `_generateCharacterGrid` logic, just operating on the outfit-specific portrait).
4. **Element per outfit:** Each grid → its own Higgsfield element with name `@{baseName}_o{N}_{suffix}`.

**Orchestrator @Reference Swap (generation-time):**

The script and all prompt templates use bare `@character_name` references (e.g. `@ada`). At scene image generation time and video clip generation time, the orchestrator:

1. Looks up the scene's `character_outfits` mapping
2. Resolves `@ada` → `@ada_o2_bpdr_0419` based on the outfit declared for that scene
3. Performs the replacement in: blocking prompts, scene image prompts, kling_clip multi_shot_prompt, CHARACTER POSITIONS preamble

This swap happens in the same transform pipeline as the existing `cinematicElementNames` map resolution — it's an extension of the existing `@baseName → @suffixedName` replacement logic.

**`cinematicElementNames` Map Extension:**

Currently maps: `baseName → suffixedName`, `@baseName → suffixedName`

New mapping adds per-scene resolution:
```javascript
// Existing (global lookup):
cinematicElementNames['ada'] = 'ada_o1_bpdr_0419'; // default outfit

// New (per-scene resolution in prompt transform):
// getElementNameForScene(characterHint, scene) checks scene.character_outfits
// and returns the correct outfit-specific element name
```

**Credit Impact:**

Per additional outfit: +1 portrait gen (~1 credit via Nano Banana Pro) + 1 grid gen (~1 credit) + 1 element creation (free). For a typical 10-character drama:
- Conservative (2 outfits for 3 main characters): +3 portraits + 3 grids = ~6 extra credits
- Full (2-3 outfits for 6 characters): +8 portraits + 8 grids = ~16 extra credits

**Implementation Plan (ordered by dependency):**

```
Phase 1: Script Schema + Scaffolding (no runtime changes)
├── 1a. Update character_bible schema: split full_prompt_description into 
│       physical_description (face/build) + outfits[] array
├── 1b. Add character_outfits field to scene schema in outline + chapter prompts
├── 1c. Update _buildCinematicScaffolding with outfit authoring rules
├── 1d. Update _validateScriptCompleteness: warn if outfits[] missing or
│       character_outfits not declared per scene
└── 1e. Update outline prompt: instruct Codex to assign outfits based on
        narrative context (time of day, location type, social setting)

Phase 2: Portrait + Grid Generation (orchestrator.js)
├── 2a. Modify portrait stage: generate master portrait from physical_description
│       + outfit[0].description
├── 2b. Add outfit portrait loop: for each additional outfit, generate portrait
│       using master as reference image + outfit[N].description
├── 2c. New asset type: 'portrait_outfit' (or extend existing portrait with
│       outfit_id metadata)
├── 2d. Modify grid stage: generate one grid per character/outfit pair
├── 2e. New asset type: 'character_grid_outfit' (or extend existing grid with
│       outfit_id metadata)
└── 2f. Update insertExpectedAssets to create portrait + grid rows per outfit

Phase 3: Element Creation (orchestrator.js)
├── 3a. Element creation loop: one element per character/outfit with naming
│       format @{baseName}_o{N}_{suffix}
├── 3b. Update cinematicElementNames map to index by outfit:
│       'ada_o1' → 'ada_o1_bpdr_0419', 'ada_o2' → 'ada_o2_bpdr_0419'
├── 3c. Update 3-layer idempotency gate to handle N elements per character
└── 3d. Update @ button verification to check all outfit elements

Phase 4: Prompt Transform — @Reference Swap (orchestrator.js)
├── 4a. Add getOutfitElementName(characterHint, scene) helper
├── 4b. Update scene image prompt transform: resolve @character → @character_oN
│       based on scene.character_outfits
├── 4c. Update video clip prompt transform (same logic, kling_clip level)
├── 4d. Update CHARACTER POSITIONS preamble injection to use outfit-specific refs
└── 4e. Update vision blocking verification to recognise outfit-specific names

Phase 5: Resume + Recovery
├── 5a. Extend DB asset schema: outfit_id column on portrait + grid assets
├── 5b. Update portrait resume/recovery to handle multiple portraits per character
├── 5c. Update element resume: restore full outfit-aware cinematicElementNames map
└── 5d. Update check-rejections.js utility to display outfit info
```

**Backward Compatibility:**

- Scripts without `outfits[]` in character_bible continue to work as-is (single outfit, `_o1_` naming applied by default)
- The `character_outfits` field on scenes is optional — if missing, outfit 1 is assumed for all characters
- Migration: existing projects with elements named `@ada_bpdr_0419` (no `_o{N}_`) are treated as outfit 1

**Open Questions:**

1. How many outfits per character is practical? Recommend cap at 3 (one formal/public, one private/home, one occasion-specific). More than 3 increases credit cost and element count without proportional storytelling benefit.
2. Should the outline or the chapter generator decide outfits? Recommend: outline declares available outfits in character_bible, chapter generator assigns per scene via `character_outfits`. The outline knows the full story; the chapter knows the specific scene context.
3. Higgsfield element limit per project? Untested beyond 12 elements. A 10-character × 3 outfit drama = 30 elements. Need empirical testing.

### Session 30d-f Summary (Bug Fixes + Story Treatment Layer)

**Session 30d** — P1/P2 bug fixes from code review:
- P1: Cinematic clip row duplication — adopt-orphan logic + stale cleanup
- P1: Settings update using staged structure for cinematic — passes generatorMode
- P2: Title dedup scoped to current research pool
- P2: Verify redo cap throws instead of silently proceeding
- recordProducedTitle uniqueness guard
- getActiveProjectStatus cinematic asset type mapping
- Script completeness hard-fail thresholds (chapters < 50%, clips < 50%)

**Session 30e** — Story treatment layer (script-engine.js):
- Outline enrichment: speech_style, speech_notes, relationship_arcs, scene_purpose, power_shift, emotional_temperature, power_holder_start/end
- Chapter enrichment: emotional_state per scene, visual_beat per clip, proverbial/spiritual 12-word exception
- Cinematic scaffolding: AI-safe visual storytelling section, emotional rhythm/breathing room, cultural dialogue cadence
- Soft validation for new fields in _validateScriptCompleteness

**Session 30f** — Research → script storytelling pipeline:
- Per-video Gemini analysis: relationship_dynamics, emotional_pacing, power_dynamics, visual_storytelling_moments, speech_patterns
- Cross-video pattern extraction: relationship_patterns, emotional_arc_patterns, power_shift_patterns, effective_visual_beats, dialogue_voice_patterns
- buildScriptResearchContext wiring: all new patterns passed to outline + chapter generation

**Session 30g** — Multi-outfit character system (full implementation):
- Script engine (script-engine.js):
  - Outline schema: `physical_description` (permanent features) + `outfits[]` array (outfit_id, description, context) replaces `full_prompt_description`
  - Scene beats: `character_outfits` mapping per scene (char_id → outfit_id)
  - Outfit rules in RULES section: min 1 outfit, protagonists 2-4, sequential o1/o2/o3
  - Chapter prompt: Rule 11 requiring `character_outfits` in generated scenes, no mid-scene outfit changes
  - Cinematic scaffolding: MULTI-OUTFIT CHARACTER SYSTEM section explaining downstream flow
- Orchestrator (orchestrator.js):
  - Portrait generation: backward-compatible `charDescription` using physical_description + o1 outfit if no full_prompt_description
  - Outfit portrait sub-loop: generates portraits for o2, o3... using master portrait as face reference
  - Grid generation: iterates over `gridUnits` (character × outfit pairs) instead of characters
  - Element creation: builds `pending` from gridUnits, element name format: `@{baseName}_o{N}_{suffix}` for multi-outfit, `@{baseName}_{suffix}` for legacy
  - `_outfitElements` map: `[baseName][outfitId] → elementName` for precise outfit resolution
  - Scene image @reference resolution: outfit-aware via `scene.character_outfits` + `_outfitElements`
  - Video stage @reference resolution: outfit-aware via `characterOutfits` passed through allKlingClips
  - Bare character name auto-fix: outfit-aware resolution
- Backward compatibility: scripts without `outfits[]` array continue working unchanged (single element per character)

**Session 30h** — Vision verification — fully automated quality gates (Automation Roadmap Phase 2):
- New file: `src/main/verify/imageVerifier.js` — ImageVerifier class
  - `verifyPortrait(portraitPath, character, { passThreshold = 80 })` — checks gender, age, skin tone, build, hair, clothing, overall impression against character bible. Weighted scoring (gender/skin_tone 3x, overall 2x).
  - `verifyGrid(gridPath, portraitPath, character, { passThreshold = 75 })` — multi-image comparison against approved portrait. Checks face consistency (3x weight), angle coverage, layout quality, clothing consistency, identity stability.
  - `verifySceneImage(scenePath, opts, { passThreshold = 70 })` — checks character presence (3x weight), character identity, setting match, blocking positions, composition. Forced fail if character_presence < 50. Supports portrait reference images.
  - Shared infrastructure: image loading, mime detection from magic bytes, webp→jpeg conversion via ffmpeg, Codex Vision API calls (single + multi-image), JSON parsing, configurable thresholds
  - `verifyLocationImage(locationPath, location, { passThreshold = 70 })` — checks no people present (3x weight — critical, forced fail if <50), description match (2x), mood/setting (1.5x), composition (1x). Locations must be completely empty backgrounds.
  - Single pass/fail verdict (no review tier). Returns `{ score, issues[], verdict, details }`. Fallback = 'pass' (non-blocking).
- Orchestrator wiring — **eliminates human approval gates**:
  - Portrait stage: vision verification after generation. Auto-reject + regenerate up to 4 retries. Human gate ONLY if retry cap exhausted (_portraitVerifyExhausted). Otherwise auto-proceeds to grid stage.
  - Grid stage: vision verification after generation + dimension check. Auto-reject within 4-attempt retry loop (MAX_GRID_ATTEMPTS = 4). Auto-proceeds.
  - Location stage: vision verification after generation + orientation fix. Auto-reject within 4-attempt retry loop (MAX_LOC_ATTEMPTS = 4). Locations-ready approval gate removed — auto-proceeds.
  - Scene image stage: vision verification after generation. Auto-reject within 3-attempt retry loop. All scene approval gates removed — auto-proceeds to video stage.
  - Resume re-gates: replaced with auto-proceed logging (scenes passed verification during generation).
  - Dialogue triage gate: conditional auto-proceed when all clips have dialogue (silent count = 0). Gate only fires for legacy scripts with silent clips needing user decision.
  - Manual fallback gate preserved: fires only when Cinema Studio automation itself fails (UI reliability issue, not quality).
  - All verification is non-blocking on error (API errors, missing keys) — returns 'pass' so pipeline continues.
- Thresholds (single pass/fail): Portrait ≥80, Grid ≥75, Location ≥70, Scene ≥70. Retry caps: Portrait 4, Grid 4, Location 4, Scene 3.
- Crash resilience (filesystem = source of truth):
  - Migration 017: `vision_score`, `vision_verdict`, `vision_retries`, `vision_issues`, `vision_verified_at` columns on `project_assets`
  - `db.saveVisionResult(assetId, { score, verdict, issues, retries })` — persisted immediately after verification API call
  - `db.incrementVisionRetries(assetId)` / `db.getVisionRetries(assetId)` — replaces in-memory retry counters
  - `db.reconcileWithFilesystem(projectId)` — scans all assets: file exists on disk → mark done; file missing but DB says done → reset to pending
  - `_persistCinematicMaps(projectId)` — writes `cinematicElementNames`, `_outfitElements`, `cinematicLocations` to `projects.settings` JSON
  - `_restoreCinematicMaps(projectId)` — rebuilds in-memory maps from DB settings on resume, validates paths against disk
  - Resume path: calls `_restoreCinematicMaps` + `reconcileWithFilesystem` before any stage logic runs
  - Principle: local file on disk is the ultimate source of truth. DB is an index that gets reconciled against reality on every resume.
- Cultural grounding (location authenticity):
  - `CULTURAL_GROUNDING` map (module-level constant) keyed by nationality ('Nigerian')
  - Contains: `prompt_suffix`, `interior_markers`, `exterior_markers`, `forbidden` elements, `verify_instruction`
  - `_buildLocationPrompt` injects interior/exterior cultural markers based on location text detection (regex for room/kitchen/etc → interior, else exterior)
  - `verifyLocationImage` receives `culturalContext` + `forbiddenElements` — checks for out-of-place Western elements (CNN, European portraits, non-African art). `cultural_authenticity` weighted 2.5x, forced fail if score < 40.
  - Prevents: Nigerian living room with CNN on TV, European portraits on walls, IKEA furniture, non-African architecture

**Session 30j** — Asset recovery: CDN capture + file integrity checks:
- CDN URL capture for all generated assets (enables re-download instead of re-generate on crash):
  - `character_grid`: passes `onGenClicked` callback to `_generateCharacterGrid`, captures `genMeta.cdnUrl` via `db.markAssetCdnUrl()`
  - `location_image`: passes `onGenClicked` via generateImage options, captures `genMeta.cdnUrl`
  - `scene_image_cinematic`: already had `onGenClicked`, added `result.cdnUrl` capture
  - Pattern: `db.markAssetGenClicked(assetId, creditCost)` fires on generation button click (marks credit spent), `db.markAssetCdnUrl(assetId, url)` fires when CDN URL is available from result metadata
- File integrity check in `reconcileWithFilesystem`:
  - MIN_FILE_SIZES: images (portrait, grid, location, scene) > 1KB, videos > 10KB
  - Files below minimum size treated as corrupt — deleted from disk and status reset to pending
  - Runs before normal recovery/invalidation logic — catches partial downloads from crash mid-write
  - Prevents pipeline from treating a 0-byte or truncated file as "done"
- CDN capture on error paths (timeout recovery):
  - Grid outer catch (~line 3700): captures `e.detectedCdnUrl` before markAssetFailed
  - Location outer catch (~line 4506): captures `e.detectedCdnUrl` before markAssetFailed
  - Scene outer catch (~line 6696): captures `e.detectedCdnUrl` before markAssetFailed
  - Pattern matches portrait + video stages which already had this — ensures timeout-but-completed generations can be re-downloaded on resume instead of re-generated

**IMPORTANT: Locations are NOT Higgsfield elements.**
Locations are reference images — generated empty backgrounds (no people) that get attached
via the + button → "Image Generations" picker at scene-gen time. Only characters have
@element names in Cinema Studio. The `element_name` column on `location_image` DB rows is
repurposed as a location identifier/hint (the snake_case key from `location_element_hint`
in the script). The field `location_element_hint` in scripts is a naming convention only —
it does NOT correspond to a Higgsfield element. `createLocationElement()` in
`higgsfield-elements.js` is deprecated and unused.

**Asset locking — vision certification = permanent lock:**
- Once an asset passes vision verification at its threshold, it is permanently locked
  (`locked_at` timestamp set). Locked assets are NEVER reset to pending by
  `reconcileWithFilesystem` or any other mechanism — even if the file is missing
  (that's a critical error requiring manual intervention, not auto-regen).
- Lock propagation (upstream): when an asset is certified, all its upstream
  dependencies are also locked — they produced a verified-good result.
  - portrait certified (≥80) → lock portrait
  - grid certified (≥75) → lock grid + its portrait
  - scene_image certified (≥70) → lock scene + its location_image + character grids + portraits
- Exception: `video_clip_cinematic` is NEVER locked. Kling video gen is non-deterministic;
  clips can always be redone at the verify stage from a stable, locked scene image.
- Asset dependency chain (correct):
  - portrait → character_grid → @element (Playwright UI step) → scene_image_cinematic → video_clip_cinematic
  - location_image → scene_image_cinematic (as reference image, not an element)
- `reconcileWithFilesystem` behavior with locking:
  - `locked_at IS NOT NULL` → skip entirely (never invalidate)
  - `locked_at IS NULL` + file missing → reset to pending
  - `video_clip_cinematic` → always eligible for reset regardless of any state
- Migration 018: adds `locked_at` column to `project_assets`
- `db.lockAsset(assetId)` — sets locked_at = now
- `db.lockUpstream(assetId, projectId)` — locks all upstream deps based on asset type + matching keys

**Scene blocking — cinematography rules (Session 30j):**
- `_refineBlockingWithVision` now receives scene dialogue + 180-degree rule guidance
- Dialogue context: the scene's `kling_clips[].dialogue` lines are extracted and fed to Vision
  so blocking reflects who is speaking to whom (speaker faces listener, eyelines cross naturally)
- 180-degree rule: once a character is placed left/right of their scene partner, they must
  stay on that side for all scenes at the same location. The previous scene image (continuity ref)
  enforces this visually, and the prompt explicitly states the rule.
- This makes blocking more cinematic: characters don't just occupy space, they relate to each
  other through spatial relationships informed by the dialogue and standard film grammar.

**180-degree rule at shot direction level (Session 30j):**
- Problem: close-up shots often show characters looking the wrong direction (e.g., @ama should
  look RIGHT toward @frank based on spatial positions, but the shot has her gazing left)
- Fix: `_injectVisionBlocking` now derives eyeline/gaze directions from vision-refined positions
- Parses horizontal position (left/center/right) from each character's blocking text
- Calculates gaze direction: character looks TOWARD the "center of mass" of scene partners
- Injects EYELINES section into the CHARACTER POSITIONS preamble (lives in header, NOT inside
  shot directions — so no conflict with one-@element-per-shot-direction rule)
- Output format: `EYELINES (180° rule — gaze direction for close-ups): @ama gazes RIGHT; @frank gazes LEFT.`
- Only activates for multi-character scenes (≥2 unique characters)
- Budget-aware: preserved in both normal and tight preamble rebuilds

**Video generation — duration and timing (Session 30j):**
- Fixed 15s duration for ALL Kling clips. Duration alone doesn't degrade lip sync.
- No timing brackets in shot headers: "Shot 1 (CU, push-in):" NOT "Shot 1 (CU, push-in, 0-3s):"
- Let the video model decide pacing across 3 shots based on dialogue length and action.
- Legacy timing brackets stripped at runtime (regex in orchestrator before vision blocking).
- HARD RULES preserved: exactly 3 shots per clip, every shot MUST have at least 1 dialogue line.
- Smart duration calculator removed — no more variable durations based on word count.
- Shot format: `Shot N (CAMERA_TYPE, movement):` — camera info only, no timing.

**Shorts Scheduler — Facebook Reels repurposing (Session 30j):**
- Standalone module: `src/main/shorts/` — NOT part of the pipeline. Dedicated Electron tab.
- Purpose: repurpose completed project clips into 30-day Facebook Reel calendar.
- Flow: select project → curate clips → FFmpeg assemble → generate SEO → Playwright upload
- Clips are already 9:16; same watermark overlay as long-form (`branding 916.fw.png`).
- REDO backups excluded via naming convention (`*_redo_backup_*`).
- Clip selection modes: `standalone_impact` (ranked by engagement potential) or `chronological`.
- Shorts: 2-6 clips combined per reel (~60s target, 30-90s range).
- SEO: dialogue-driven hooks, auto-generated hashtags, CTA ("Follow for next episode").
- Playwright: Facebook Professional Dashboard → Content → Scheduled → Create → Reel.
  One upload per navigation cycle; confirm done → tagged in DB → persist.
- DB: `shorts` table (migration 019) + `projects.repurposed_at` column.
- Architecture: `ShortsController` (index.js) → `ShortsScheduler` + `FacebookUploader`.
- IPC-ready: controller methods map to `ipcMain.handle('shorts:*')` calls.

**Database Auto-Backup System (Session 30M):**
- Location: `AppData/Roaming/nollywood-ai-pipeline/backups/`
- Filename format: `nollywood-pipeline_YYYY-MM-DD_HH-MM-SS_<tag>.sqlite`
- `db.backup(tag)`: saves current DB state, prunes old backups per tag category.
- Automatic triggers (no manual action needed):
  - `startup` — on app init, before migrations/recovery run
  - `shutdown` — on app close, after final save
  - `auto` — every 30 minutes during runtime (timer via `startAutoBackup()`)
  - `pre-<stageName>` — before each pipeline stage via `runStage()` (covers research, portraits, scene_images, locations, cinematic_scenes, video_clips, assembly)
  - `pre-upload` — before Facebook upload session starts
  - `pre-assembly` — before shorts assembly begins
- Rolling pruning: `auto` keeps last 5, all other tags keep last 10.
- `db.restoreBackup(filename)`: creates safety backup first, then restores. Caller must re-init DB after.
- `db.listBackups()`: returns all backups sorted newest-first with tag, date, size.
- `fix-shorts-status.js`: creates `pre-fix` backup before any status changes.
- Functions exported: `backup`, `startAutoBackup`, `stopAutoBackup`, `listBackups`, `restoreBackup`.

**Pipeline Progress Stats with ETA (Session 30M):**
- All major pipeline stages emit rich progress events with `elapsed`, `eta`, `generated`, `skipped`, `failed` fields.
- ETA pattern: `startTime` + `genCount` counter → `perItem = elapsed / genCount` → `remaining = perItem * (total - current)`.
- Renderer: `formatETA()` and `formatElapsed()` helpers, `updateGenProgress(current, total, extra)` accepts extra fields.
- Progress text uses `<pre>` for multi-line clip labels.
- Assembly progress: weighted progress bar (0-60% processing, 70% concat, 85% upscale, 100% done).
- Stages covered: portraits, scene images, cinematic locations, cinematic scenes, video clips (Kling + Veo), final assembly (FFmpeg).

**Facebook Uploader — Login Wait + Popup Dismissal (Session 30M):**
- `_waitForLogin()`: navigates to facebook.com, polls for logged-in indicators every 3s, waits up to 3 min for login + 2FA.
- `_dismissPopups()`: auto-dismisses FB overlays (keyboard shortcuts, cookie consent, notification prompts, banners) before every click action.
  - Uses `page.locator()`/`getByText()` — NOT `page.$()` (which silently fails on Playwright text selectors).
  - Recursive: dismissing one popup re-checks for another underneath.
  - Escape fallback for unknown dialogs, but protects reel wizard dialogs (Create reel, Edit reel, Reel settings, etc.).
  - IMPORTANT: No generic `[role="dialog"] [aria-label="Close"]` handler — it closes the Create Reel wizard.
- Timeout increases: CLICK_TIMEOUT 20s, POST_CLICK_SETTLE 4s, POST_NAV_SETTLE 6s, POST_SCHEDULE_CONFIRM 15s.

**Facebook Uploader — Selectors + Flow Rewrite (Session 30M):**
- SELECTORS rewritten to match May 2026 Professional Dashboard Content Library UI.
- `scheduleReel()`: 12-step flow via direct Content Library URL (`?filter=SCHEDULED`).
- `_clickSchedulingOptions()`: multi-strategy click on "Scheduling options / Publish now" row.
- `_clickFinalSchedule()`: exact-match "Schedule" button via `getByRole`/`text-is`, excludes "Schedule for later"/"Scheduling options".
- `_setScheduleDate()` / `_setScheduleTime()`: 3-tier strategy — aria-label inputs → value-scan all inputs for date/time pattern → label text click.
- `_uploadVideo()`: uses `setInputFiles()` on `input[type="file"]` directly — no filechooser event, no Windows file picker modal.
- Debug screenshot saved after opening scheduling panel for diagnosis.
- Upload order: `ORDER BY short_number ASC` — short_001 uploads first, matches earliest scheduled date.


**Facebook Reels UI drift (live diagnostic 2026-06-03):**
- Shorts/Reels no longer use the old `Next -> description -> Next -> Reel settings -> Scheduling options row` wizard after upload.
- Current live flow mirrors Promo/Engagement composer scheduling:
  ```text
  Content Library -> Create dropdown -> Reel
  Reel composer opens with caption field + uploaded media preview
  upload video
  enter caption in "Describe your reel..."
  bottom Schedule button opens Scheduling options modal
  set Date and Time in the modal
  Schedule for later applies date/time
  bottom Schedule post submits
  confirmation should return to Content Library Scheduled tab / scheduled row
  ```
- Keep Reel-specific upload (`input[type=file]` / `setInputFiles`) and exact `Reel` menu selection, but use the composer-style schedule modal and final `Schedule post` button. Do not click old `Next` buttons unless Facebook explicitly returns to the old wizard.
- Live upload behavior: clicking exact `Reel` can immediately open the native file chooser. Arm `page.waitForEvent('filechooser')` before clicking `Reel`; if it fires, set the video file from that chooser and skip searching for a later upload input. If no chooser fires, fall back to video-capable file inputs, then the visible Reel upload drop zone. Upload readiness must wait for real composer markers such as `Uploaded media`, `safe to publish`, caption + Schedule controls plus a real `video` or selected file input; do not treat missing spinner or unrelated page images as upload complete.
- Failure mode seen 2026-06-03: after `+ Create`, `_dismissPopups()` can misclassify the Create menu as an unknown dialog and press Escape, closing `Post / Story / Reel / Bulk upload reels` before Step 3. Protect Create-menu text from Escape dismissal, and do not run popup dismissal immediately before clicking `Reel`.
- Failure mode seen 2026-06-03: Facebook can successfully schedule the Reel and return to Scheduled tab, but the automation may miss confirmation because scheduled rows use truncated captions and `Scheduled - Tomorrow at 6:00 PM` text instead of a stable success toast. Confirmation should accept a matching caption row or a Scheduled-tab row-count increase over the pre-submit baseline. Before uploading, check for an already-scheduled matching caption so a DB `upload_failed` row caused by missed confirmation recovers without creating another duplicate. During one upload session, exclude rows that just failed from immediate retry; retryable `upload_failed` is for a fresh user-triggered upload pass.
- Confirmation hardening: after clicking `Schedule post`, do not rely on the current SPA DOM or re-clicking the already-selected Scheduled tab. Hard navigate back to `professional_dashboard/content/content_library/?filter=SCHEDULED`, wait for Content Library readiness, then inspect actual scheduled post rows. Prefer caption-prefix row matching; use row-count increase only as a fallback after this hard reload. Pre-upload recovery must use the same hard-reloaded row matcher so a missed confirmation can mark the short scheduled without creating another Reel.

**Shorts Status: `upload_failed` (Session 30M):**
- Upload errors now set status to `upload_failed` (not generic `failed`).
- `failed` is reserved for SEO generation failures (description/hashtags generation).
- `upload_failed` = Playwright/Facebook upload error (retryable via Upload All).
- `getNextPendingUpload()` picks up both `seo_done` and `upload_failed` — clicking "Upload All" auto-retries failed uploads.
- "Upload All" button enabled whenever `seo_done + upload_failed > 0`.
- Plan Calendar button/controls disabled once any shorts are assembled — prevents re-planning from orphaning assembled files.
- Data migration: `node fix-failed-to-upload-failed.js` renames existing `failed` → `upload_failed`.

**Facebook Uploader — Dynamic Readiness Wait + Retry (Session 30M):**
- `_waitForPageReady()`: adapted from Kling automation's DYNAMIC READINESS WAIT pattern.
  - Polls 4 indicators: Content Library heading, Create button, tab bar, no spinner.
  - Threshold: ≥75% must pass. Buffer: 10% of elapsed time.
  - Replaces fixed `POST_NAV_SETTLE` delay after Content Library navigation.
- `_retryStep(stepName, fn, maxRetries, baseDelay)`: retry wrapper with linear backoff.
  - Default: 2 attempts (1 try + 1 retry), 3s base delay (3s → 6s).
  - Dismisses popups between retries.
  - Wrapped steps: 2 (Create), 3 (Reel select), 8 (Scheduling options), 11 (Schedule for later).

**waitForGeneration — 3-Layer Detection Rewrite (Session 30M):**
- **Bug fixed**: Layer 2 snapshoted History URLs AFTER Layer 1 failed (45s in), so the
  completed image was in the "initial" baseline and never detected as "new." Now the
  pre-gen snapshot is taken BEFORE Layer 1 runs.
- **Layer 2 History refresh**: re-clicks History tab every 30s to force Higgsfield's SPA
  to update the DOM.
- **Layer 2 stall detection**: if no changes for 60s (no new URLs, no count change, no
  status transition), bails to Layer 3 instead of waiting for the full 7-minute timeout.
- **Layer 3** (new): `_recoverCdnUrlFromAssets(submittedPrompt, type)` — lightweight Asset
  library scan. Navigates to `/asset/image`, checks first 4 tiles by prompt match (60%
  similarity via `_promptSimilarity`), extracts CDN URL from detail page. No context
  recreate, no download — returns URL for the existing `downloadLatestResult` flow.
  Falls back cleanly on failure.

**Higgsfield API Polling — Consecutive 404 Bail-out (Session 30M):**
- `_pollJobCompletion()`: tracks consecutive 404 responses from the job polling endpoint.
- After 15 consecutive 404s (~45s), throws `API_ENDPOINT_DEAD` — a non-fatal error that
  lets `waitForGeneration()` fall through to Layer 2 (CDN URL diffing in History tab).
- **Bug fixed**: previously, a dead API endpoint would waste 7 minutes (full IMAGE_GEN_TIMEOUT_MS)
  polling 404s before Layer 2 could detect the completed image. Now bails in ~45s.
- Counter resets on non-404 errors (transient issues) and on successful polls.

**Publish Tab — standalone + custom thumbnail (Session 30j):**
- Publish is now a standalone tab (like Shorts) — accessible at any time.
- Eligible projects: any project with scene images generated (not just fully completed).
- Two thumbnail modes:
  - **Scene-based**: existing flow — pick scene image → title card → composite
  - **Custom close-up**: generate portrait of main character via @element → title card → composite
- Custom thumbnail: `generateCustomKeyArt()` in ThumbnailGenerator uses tight close-up prompt
  with @element reference for face consistency via Nano Banana Pro.
- Character picker: `getCharactersForThumbnail()` returns characters sorted by dialogue count.
  User selects from dropdown.
- Expression auto-suggest: `suggestExpression()` analyzes script tone markers, maps to
  thumbnail-friendly expressions (e.g., most frequent dramatic tone → "fierce defiant").
  User can override.
- `PublishController` (publish/index.js): IPC-ready controller with `getProjects()`,
  `getCharacters()`, `suggestExpression()`, `generateSceneThumbnail()`,
  `generateCustomThumbnail()`, `generateSEO()`.
- Session wait: `_ensureLoggedIn()` + `_waitForLogin()` added to ThumbnailGenerator.
  Detects SESSION_EXPIRED, relaunches browser to higgsfield.ai, polls `isLoggedIn()`
  every 10s for up to 10 min. No more wasted retries on dead sessions.

**Session 30k — Publish UI wiring + Facebook uploader wait times:**

Publish tab UI — full custom thumbnail mode:
- Thumbnail tab has "Scene-based" / "Custom Close-up" toggle buttons
- Custom mode shows: character dropdown (sorted by dialogue count) + expression input
  (auto-suggested from script tone, user can override)
- Scene scoring deferred: `loadSceneCandidates()` only fires when scene-based mode is
  active. Was previously auto-firing on project load regardless of selected mode.
- Project dropdown format: `projectId — Title` for clear identification
- Dropdown `onchange` → `switchPublishProject(id)` → `loadPublishProject(id)` sets
  `_standalonePublishProjectId` — all publish operations target the selected project
- Eligibility: any project with scene images on disk (scene images = elements exist)
- IPC: `get-publish-characters` → `getPublishCharacters()` returns characters + suggested
  expression. `generate-custom-thumbnail` → `generateCustomThumbnail(options)` with full
  browser launch/login check, @element close-up gen, title card, composite, auto-resolve.
- Preload: `getPublishCharacters()`, `generateCustomThumbnail(options)` exposed

Shorts tab UI — full wiring:
- Header button "Shorts" (orange) opens dedicated view
- Project dropdown: `projectId — Title` for completed projects with video clips
- Plan controls: mode (best clips / chronological), posts/day, "Plan + Assemble + SEO"
- Calendar table: #, date, time, duration, status (color-coded)
- Upload controls: Launch Browser → Upload Next (one at a time) → Close Browser
- IPC: shorts:getProjects, shorts:getStatus, shorts:plan, shorts:startUpload,
  shorts:uploadNext, shorts:closeUpload
- Preload: 6 methods wired to ShortsController
- Main.js: lazy-initialized ShortsController with all 6 handlers

@element autocomplete in generateImage (higgsfield.js):
- Reuses `parsePromptSegments` from kling-automation.js (no wheel reinvention)
- Detects @element references in prompt → segments into plain text + {at: name}
- Plain text typed at 25ms/char, @elements typed at 80ms/char with autocomplete:
  type '@' → wait 400ms → type name at 80ms/char → wait 1500ms for dropdown → Enter
- Same timings as the proven Kling video gen workflow
- Ensures @ follows whitespace (autocomplete only triggers after space/newline)
- Retry with 2000ms extra wait if dropdown not detected
- Enables custom thumbnail's @element reference to properly bind the character

Facebook uploader — proper wait times (facebook-uploader.js):
- Named timeout constants used throughout `scheduleReel()`:
  - `POST_NAV_SETTLE` (4s) — after navigation/page loads
  - `POST_CLICK_SETTLE` (3s) — after standard UI clicks
  - `POST_UPLOAD_SETTLE` (15s) — after upload-to-next transition
  - `POST_SCHEDULE_CONFIRM` (10s) — wait for schedule confirmation
  - `UPLOAD_TIMEOUT` (180s) — max wait for video processing
  - `DESCRIPTION_TYPE_DELAY` (15ms/key) — anti-bot keystroke pacing
- `_waitForUploadProcessing()`: polls every 3s for Next button enabled or progress bar
  gone (max 3min). Video uploads need time to transcode/thumbnail on FB side.
- `_waitForScheduleConfirmation()`: polls every 2s for success toast, Scheduled tab
  becoming active, or URL returning to content page. Falls back after 10s.
- `_enterDescription()` uses `DESCRIPTION_TYPE_DELAY` to avoid FB anti-bot detection.

**Session 30L — Shorts planner rework + bugfixes:**

Shorts planner — real durations + calendar-aware grouping:
- `_probeClipDurations()`: ffprobe every clip upfront before planning (falls back to
  ffmpeg stderr parsing, then 10s fallback constant)
- Calendar-driven grouping: total clip duration ÷ calendar days = target per short.
  Clamped between MIN_SHORT_DURATION (30s) and MAX_SHORT_DURATION (90s).
- Posts/day computed automatically: total shorts ÷ calendar days. Not a user input.
- Start date defaults to tomorrow (never today — today is already gone for scheduling).
  If shorts already exist for the project, starts from day after last scheduled date.
- Calendar days defaults to remaining days in current month (e.g. May 1 → 30 days).
- Stats returned: totalClips, totalDuration, totalShorts, targetPerShort, postsPerDay,
  startDate, endDate, calendarDays.

Shorts tab — 3-phase flow with persistence:
- **Plan Calendar** button: probes durations, computes groups, fills schedule table,
  persists to DB with status `planned`. Plan survives app restarts.
- **Assemble + SEO** button (enabled after plan): reads planned shorts from DB, runs
  FFmpeg sequentially, generates SEO via Codex API, updates each row to `seo_done`.
  Resumable — skips already-assembled shorts.
- **Upload** controls: reads `seo_done` shorts, Playwright uploads one at a time.
- Previous single "Plan + Assemble + SEO" button replaced with two-step flow so user
  can review calendar before committing to FFmpeg + API batch.
- `savePlan()`: clears previous `planned` rows, inserts new plan. Doesn't touch
  assembled/scheduled shorts.
- `updateShortAssembled()`: updates existing row with file_path, duration, SEO data.
- `getPlannedShorts()`: returns `planned` status rows for assembly.

Shorts eligibility — clip-based, not completion-based:
- `getEligibleProjects()` now shows any project with cinematic clips done (not just
  `completed_at IS NOT NULL`). Projects at publish gate already have all clips ready.
- Subquery wraps the clip_count computation to avoid HAVING-without-GROUP-BY error.

DB module fixes:
- `queryAll`, `queryOne`, `runSql` now exported from db.js for modules needing custom SQL.
- ShortsScheduler + ShortsController import db singleton directly instead of broken
  `this.db.queryAll()` pattern (db exports functions, not methods on an object).

Pipeline lifecycle fix:
- `completeProject()` moved to right after assembly finishes (before publish stage).
  Assembly = end of production. Publish/shorts are distribution, not production.
  Previously set after publish gate approval, blocking shorts for projects at publish.

Upload consolidation:
- Replaced 3-button flow (Launch Browser / Upload Next / Close Session) with single
  "Upload All to Facebook" button. `uploadAll()` launches Playwright, loops all
  `seo_done` shorts, schedules each on Facebook, closes browser in `finally` block.
- Upload button disabled until all shorts are assembled (no `planned` rows remain).

Full persistence:
- All plan/assembly/upload state persisted in `shorts` table with status lifecycle:
  `planned` → `assembled` → `seo_done` → `scheduled`/`failed`.
- `getStatus()` reconstructs stats entirely from DB (totalDuration, dates, clipCount,
  postsPerDay). No in-memory state — everything rebuilt from DB on tab open.
- Button states driven by DB status counts (plan exists? all assembled? etc.)

Assembly progress with ETA:
- ShortsController accepts `onProgress` callback, emits progress events per short.
- `main.js` passes callback that sends `shorts-progress` IPC events via
  `mainWindow.webContents.send()`. Preload exposes `onShortsProgress` listener.
- Renderer shows real-time "Assembling X/Y — ETA Xm Xs" during assembly.
- ETA computed from elapsed time / completed count to project remaining time.
- Upload phase also emits progress per short with scheduledDate and success/error.

N+1 query optimization:
- `assembleShorts()` loads all cinematic clip assets once into a Map at the start,
  instead of calling `db.getAssets()` inside the per-short loop.

Pipeline progress stats with ETA (all major stages):
- Every major generation stage now emits rich progress events: `elapsed`, `eta`,
  `generated`, `skipped`, `failed`, `label`/`clipLabel`, `done`.
- Stages enhanced: portraits, scenes (staged), cinematic-locations, cinematic-scenes,
  cinematic-video (Kling clips), staged video clips, final assembly (FFmpeg).
- ETA computed from elapsed time / completed count to project remaining time.
- Assembly progress shows per-step detail: "Normalizing clip X/Y — ETA Xm Xs",
  "Concatenating clips... (Xm elapsed)", "Upscaling to 4K...", "Complete! (Xm Ys)".
- Renderer `updateGenProgress()` accepts optional extra data and displays inline.
- Progress text element changed from `<p>` to `<pre>` for multi-line support
  (shows clip labels/IDs below the counter).
- `formatETA()` and `formatElapsed()` helpers for human-readable time strings.

Facebook uploader — login wait + timing fixes:
- `_waitForLogin()` added to `launch()`: navigates to facebook.com, polls for
  logged-in indicators (profile avatar, notifications, messenger icons in nav).
- If not already logged in, waits up to 3 minutes (LOGIN_WAIT_TIMEOUT) for user
  to complete login + 2FA manually. Polls every 3s with elapsed/remaining logs.
- Auto-proceeds once any logged-in indicator is detected.
- Increased timeouts: CLICK_TIMEOUT 15→20s, POST_CLICK_SETTLE 3→4s,
  POST_NAV_SETTLE 4→6s, POST_SCHEDULE_CONFIRM 10→15s.
- Upload flow emits `logging_in` progress status before `launch()` returns.

Aspect ratio threading (from session 30k, completed session 30M):
- Orchestrator's `generateThumbnail()` and `generateCustomThumbnail()` now read
  `project.aspect_ratio` and pass it to ThumbnailGenerator. All 3 thumbnail stages
  (key art, title card, composite) generate in the project's configured orientation.
- Bug fix (30M): `compositeThumbnail()` had hard-coded `'16:9'` in both its
  `generateImage()` calls. Added `aspectRatio` parameter to method signature
  (default `'16:9'`), both callers (`generateThumbnail`, `generateCustomThumbnail`)
  now pass the project's aspect ratio through.

Composite placement options (session 30M):
- 7 placements: `lower-third`, `upper-third`, `left-side`, `right-side`,
  `bottom-bar`, `split-diagonal`, `auto`
- Each has specific prompt instructions anchoring text to a region and keeping
  character faces clear. All include "Do NOT cover or obscure character faces."
- `left-side` / `right-side`: text in 35-40% lateral strip, opposite side clear
- `bottom-bar`: narrow cinematic strip in bottom 15-20% (movie poster style)
- `split-diagonal`: text on a diagonal across the bottom-left corner
- `auto`: text in area with most negative space, away from faces

Publish aspect ratio override (session 30M):
- Dropdown in Publish tab: "Project Default" | "16:9 Landscape" | "9:16 Portrait"
- Overrides global `project.aspect_ratio` for thumbnail gen only (all 3 stages)
- Passed as `options.aspectRatioOverride` through renderer → IPC → orchestrator
- Both `generateThumbnail()` and `generateCustomThumbnail()` in orchestrator use
  `options.aspectRatioOverride || project.aspect_ratio || '16:9'`
- Preview box aspect-ratio CSS updates dynamically on dropdown change

Credit usage stats (session 30M):
- Pipeline Complete screen shows per-type credit breakdown widget
- `getProjectCreditUsage(projectId)` in db.js aggregates `credit_cost` from `project_assets`
- IPC: `get-project-credit-usage` → `db.getProjectCreditUsage(projectId)`
- Renderer: `loadCreditStats(projectId)` called on `pipeline-complete` event
- Widget: inline card with per-type rows (portraits, scenes, video, thumbnails) showing
  generation count + credit sum. Total at bottom. Color-coded: green=free, yellow=paid.

Thumbnail credit tracking (session 30M):
- ThumbnailGenerator constructor accepts `onCreditUsed(creditCost, stage)` callback
- New `_genImage(opts, stage)` wrapper — injects `onGenClicked` into every
  `automation.generateImage()` call and fires `onCreditUsed` with stage label
- Stage labels: `key-art`, `title-card`, `composite`, `custom-closeup`
- Orchestrator's `generateThumbnail()` and `generateCustomThumbnail()` pass
  `onCreditUsed` that inserts lightweight `thumbnail` type asset rows into
  `project_assets` with `credit_cost` and `prompt_used = 'thumbnail-<stage>'`
- These rows are picked up by `getProjectCreditUsage()` and shown in the widget

---

## Session 30N: Script Engine Review

**Commit script:** `commit-session30N.ps1`

**Task:** Thorough review of `src/main/pipeline/script-engine.js` — the Codex API integration
that generates titles and screenplays. Review scope: prompt quality, JSON parsing resilience,
error handling, structural grading, cinematic vs staged mode divergence, duration preset
compliance, and any bugs or improvement opportunities discovered during review.

---

## TODO: Cinema Studio 3.5 Video Engine Branch (Session 30W Planning, May 2026)

Goal: keep the existing cinematic pipeline and add Cinema Studio 3.5 as a selectable video-generation branch only. Reuse the cinematic script, scene images, Higgsfield elements, batch prompt preview, DB asset rows, retry/resume, verify, download/recovery, and assembly wherever possible.

**Implementation status (Session 30W partial):**
- The home/research UI now treats `Cinematic` as the neutral story-driven mode. The video engine is selected separately via `Video: Kling 3.0` or `Video: Cinema Studio 3.5`.
- Default remains `kling`, preserving existing production behavior unless the user explicitly selects Cinema Studio 3.5 before project start.
- The engine choice is stored on the project settings as `settings.cinematicVideoEngine`.
- The global project aspect ratio (`projects.aspect_ratio`, selected on home) must control both video engines. Kling derives final clip aspect from the project scene/start frame; Cinema Studio 3.5 receives the same aspect explicitly and sets its toolbar to `16:9` or `9:16` before Generate.
- Cinema Studio 3.5 video must reuse the same persisted Higgsfield Cinema Studio project context as the cinematic scene/image path. Navigate to `https://higgsfield.ai/cinema-studio?cinematic-project-id=<higgsfield_cinema_project_id>` first, then switch to Video -> Cinema Studio 3.5 and continue generation. Kling 3.0 has no Higgsfield project selection.
- `_runCinematicVideoStage()` reads that stored setting at video stage time and instantiates either `KlingAutomation` or `CinemaVideoAutomation`.
- Both engines share the same orchestrator contract: `generateClip()` and `recoverTimedOutClip()`. Downstream DB rows, prompt preview, clip review, verify, and assembly continue to use `video_clip_cinematic`.
- Added `cinema-eligibility-failed` gate for Cinema Studio scene/element eligibility pauses. Human fixes the asset or eligibility state, approves the gate, and the same clip is retried.
- Added `src/main/automation/cinema-video-automation.js` for Cinema Studio 3.5 setup/upload/eligibility/generate logic. It reuses Kling recovery/download patterns where practical, but uses Cinema-specific upload, eligibility, Generate safety, and credit-ledger confirmation.
- Cinema Studio 3.5 video setup is an active setter pass, not a passive confirmation pass. Each run opens/sets the top controls (`Genre: General`, `Style: Auto`, `Camera: Auto`) and bottom controls (`Cinema Studio 3.5`, `15s`, `480p`, project aspect). Audio is the exception: click only when it reads `Off`, then verify it settled to `On`, because clicking while already `On` toggles it off.
- Live UI re-check (May 2026): CS 3.5 can load as `8s`, `1080p`, `Auto`, `Off`. Duration is a `Duration` dialog with a slider, not a text option; set it by dragging the slider to max and verify the toolbar says `15s`. Resolution opens a `Resolution` listbox (`480p`, `720p`, `1080p`); select `480p` and verify the Generate button cost drops to `52.5` at `15s`. Aspect is a normal option dialog (`Auto`, `1:1`, `3:4`, `9:16`, `4:3`, `16:9`, `21:9`). Genre opens a Genre panel with `General`; Style opens a Style Settings panel with Auto columns and `Manual Style · Off`; Camera opens a Camera Settings panel with Auto camera/lens/aperture.
- Live 1-minute CS 3.5 run has validated toolbar setup, start-frame upload/eligibility, `@` element eligibility, accidental Generate blocking during prompt typing, intentional Generate, credit ledger label/cost, 5-7 minute generation timing, and Asset Library recovery. Full verify + assembly still need a complete multi-clip pass before this branch is considered production-hardened.

**Session 30W live-test findings (May 26-30, 2026):**
- **Scene/start-frame upload eligibility is usually auto-triggered by Higgsfield, but can require a manual nudge.** The automation should upload through the `+` scene-image picker, identify only the newly uploaded card by new `img.src`, hover the card because status text can be hover-revealed, and progressively wait for Higgsfield to move through `pending`/`checking` to `Eligible`. If hovering the uploaded scene image card reveals `Check eligibility` instead of `Checking content`, click that card-local `Check eligibility` control once, then fall back into the normal `Checking content` -> `Eligible` wait. Do not bypass this by assuming a visible composer thumbnail is enough; the safe path is upload -> eligibility status -> select eligible image card -> verify composer thumbnail.
- **Scene eligibility timing is variable.** Observed settles ranged from about 10s to 60s+, and a later live clip sat in `checking` for 279s before becoming `Eligible`. The UI can sit on `pending` while the upload/backend catches up. Use a long wait with one extension near 90% of the current timeout instead of failing at the old 180s cliff. Current intent: new-card wait about 180s with extension, eligibility wait about 420s with extension up to about 10 minutes.
- **Element eligibility is different from scene eligibility.** In Cinema Studio 3.5 video mode, prefer the mid-screen project `Elements`/`@` control under the project title for the eligibility picker; the bottom-toolbar `@` remains fallback only. For elements only, `Check eligibility` is a real required click when shown; after each element is confirmed eligible/`Use`, close/reopen the picker for the next element. Do not use the left sidebar `My Elements` section for this workflow.
- **Prompt typing can fire accidental Generate requests.** During `@` autocomplete and prompt insertion, arm the Cinema safety guard: a focused Generate-button shield plus a network kill switch that aborts `POST https://fnf.higgsfield.ai/jobs/v2/cinematic_studio_video_3_5`. Disarm only for the intentional Generate click. Restore Enter-based autocomplete for element mentions; do not replace it with mouse fishing.
- **Fake silent dialogue must be normalized before approval.** LLMs can create contradictory prompt blocks such as `Mouth does not open. Total silence.` followed by `[@character, speaking in a silent accent]: "..."`. This is not valid dialogue and can cause lip-motion/subtitle nonsense. Runtime `RULE0` in `orchestrator.js::_validateAndFixPromptRules()` runs **after** vision blocking injection, shot-direction reconciliation, @/outfit sanitization, and posture correction, but **before** grounding prefix and prompt-preview approval. It converts fake silent dialogue (`"..."`, punctuation-only/empty text, `silence`, `no dialogue`, `speaking in a silent...`) to the canonical marker: `[@character_id has no dialogue]`. Regression test: `test/test-cinematic-silent-dialogue-sanitizer.js`.
- **Generate confirmation requires two signals.** UI `Processing`/`Generating` proves Higgsfield accepted the click visually, but it is not enough to persist credit spend. A new credit row must also appear in History: `Cinematic Studio 3.5 Video`, action `Spent`, cost matching the button (`52.5 credits` for `15s/480p/9:16` in the live test), timestamp near the click. Only after the ledger row is confirmed should `onGenClicked(creditCost)` persist spend.
- **Low-credit toast can block the intended Generate click.** Higgsfield may show a bottom-right toast reading `Credits are running low! Over 90% already used` with an `Upgrade` button and a close `x`. It is not an insufficient-credit gate, but it can physically overlap/intercept the Cinema Generate button. Before the intentional Generate click, dismiss only this specific toast by text, re-read the Generate button box, and verify `document.elementFromPoint(clickX, clickY)` resolves to the Generate button before disarming safety blockers. Do not click the Upgrade button and do not use broad close-button hunting.
- **Resume must not erase submitted-clip recovery metadata.** The pre-stage pending redo sweep may clear metadata for true fresh-redo clips, but it must preserve pending clips with `gen_clicked_at`, or legacy `credit_cost + prompt_used`, because those indicate an already-submitted generation that should recover from Asset Library instead of spending again. This exact bug caused `ch7_sc4_c4` to skip recovery and start pre-gen after startup cleared `gen_clicked_at` on all pending clips.
- **Pause/resume must recovery-check submitted clips before Generate.** Credit ledger rows are only a Generate-click confirmation baseline; they do **not** attribute a spend/refund to a specific clip. Clip-level recovery eligibility is `video_clip_cinematic.status != done` plus `gen_clicked_at` and `prompt_used`. After any pause/resume, Cinema Studio 3.5 must fresh-read the DB row by `kling_clip_id` and attempt Asset Library recovery before any new Generate click. This guards cases where one visible tile failed/refunded, a retry successfully generated later, the pipeline paused, and resume would otherwise regenerate the same clip. The orchestrator has a final pre-Generate recovery guard for Cinema Studio 3.5 using the fresh DB row, so stale in-memory `existingClips` cannot bypass recovery.
- **Cinema failed/refunded auto-recovery pause:** After a Cinema Studio 3.5 clip fails/refunds, retries once, and still fails, the orchestrator no longer waits indefinitely for manual Resume. It preserves `gen_clicked_at` + `prompt_used`, emits a short `cinema-clip-failed-auto-recovery` pause, waits 5 seconds, then auto-resumes the same clip so the pre-Generate recovery guard runs Asset Library recovery first. Manual pauses remain for session expiry, cost/credit confirmation failures, and eligibility failures that require human UI action.
- **Higgsfield verification/not-submitted submit gate:** Higgsfield may replace the normal app UI with a white `Verification Required` page containing `Slide right to secure your access` after unusual activity/bot detection. Automation must not try to solve this slider. Detect the page text, emit the `higgsfield-verification-required` gate, hide Pause/show Resume, and wait for the operator to complete the challenge manually in the browser. For Cinema Studio 3.5, if the challenge appears after the intended Generate click, treat it as not submitted/no spend, stop ledger polling, keep the current page state intact, and after Resume continue inside `_generateAndDownload()` at fresh usage baseline -> intentional Generate click -> ledger confirmation. If the challenge is missed but the click produces no Processing/Generating state and no new ledger row, classify it as `not_submitted`, capture diagnostics, wait briefly, and retry only the submit slice in-place (baseline -> click -> confirm), capped at a small number of attempts. Do not unwind to full clip setup/prompt typing unless the page state is lost. Cinema Studio 3.5 setup preserves this error code instead of wrapping it as a normal `[PRE-GEN]` failure.
- **Credit ledger parser live-confirmed.** The History page redirects to `https://higgsfield.ai/me/settings/usage?scope=personal` and renders real table rows: `52.5 credits | Cinematic Studio 3.5 Video | Spent | May 27, 202612:38 AM`. The parser must read `tr`/`td` cells, match `Cinematic Studio 3.5 Video`, ignore `Refunded`, and normalize missing date/time spacing (`202612:38` -> `2026 12:38`). Live confirmation at 1:33 AM: baseline captured 10 Cinema rows and matched the new 1:32 AM spend from `table-cells`.
- **Ambiguous accepted state is not safe to retry.** If UI shows `Processing`/`Generating` but the ledger row does not appear within the confirmation window, do not throw a normal safe-to-retry `[PRE-GEN]` error. Log the ambiguous state and continue waiting/downloading/recovering to avoid a possible double-spend.
- **Completion wait must be longer than Kling assumptions.** A Cinema Studio 3.5 15s/480p clip took roughly 5-7 minutes. After Generate confirmation, wait progressively for completion; do not launch asset recovery too early. Do not save a visible current-page `video[src]` directly as proof of completion: on June 1, 2026 the direct UI source path saw a changed CloudFront video and saved existing `ch7_sc4_c3` bytes as `ch7_sc4_c4`. The safe path is ledger-confirmed Generate -> mandatory completion wait -> Asset Library recovery.
- **Cinema video wait optimization uses UI lifecycle only as a recovery trigger.** After ledger-confirmed Generate, poll the current UI lifecycle roughly once per minute while keeping the 12-minute hard fallback. `Processing`/`Generating` means keep waiting. Visible `Failed` + `Credits refunded` means a refunded failure, skip Asset Library recovery and retry once. If no active/failure label is visible and media tiles are visible after a 4-minute minimum, require two consecutive settled polls before starting Asset Library recovery early. This reduces normal 5-7 minute generations without reintroducing unsafe current-page downloads.
- **June 2 live timing validation:** `ch8_sc4_c3` confirmed the optimization works conservatively. Generate clicked at 23:09:57, ledger confirmed at 23:10:34, UI remained `Processing`/`Generating` through 480s, then settled at 540s and 600s. The branch waited the 30s indexing grace, started Asset Library recovery at 23:21:04, and downloaded the correct matching clip at 23:21:23. Compared with the old 12-minute wait plus 120s grace, this saved roughly 3m30s on a clip that did not finish especially early. The recovery still required 98% prompt similarity and 3/3 dialogue match.
- **Asset recovery works for CS 3.5 video and must verify dialogue identity.** Recovered clips appear under `https://higgsfield.ai/asset/video`; prompt-similarity recovery found generated clips at 98-99% similarity and downloaded them successfully. For Cinema Studio, prompt similarity alone is not enough when adjacent clips share scene/characters. Recovery must also require the copied asset prompt to contain the submitted dialogue lines before downloading/persisting. Recovery is a fallback for missed UI download/completion, not proof that a second Generate should be attempted.
- **Credit ledger label is not Kling.** The correct live History rows read `Cinematic Studio 3.5 Video` with `Spent` or `Refunded`. Do not match or log `Kling` rows in the Cinema branch. Regression test: `test/test-cinema-video-ledger.js`.
- **May 30 multi-clip Cinema Studio validation:** A live resumed run from 42 existing clips successfully generated and recovered multiple consecutive Cinema Studio 3.5 clips (`ch5_sc2_c3`, `ch5_sc2_c4`, `ch5_sc3_c1`, then progressed into `ch5_sc4_c1`). For each successful submitted clip, the observed safe sequence was: start frame upload -> scene card `checking` -> `eligible` -> select/attach start frame -> element eligibility cache hits -> prompt typing with endpoint blocker armed -> several accidental `POST /jobs/v2/cinematic_studio_video_3_5` requests blocked during `@` mention resolution -> prompt completion sentinel confirmed -> 10s endpoint quiet period -> credit ledger baseline captured -> exactly one intentional Generate click -> UI Processing accepted -> matching `52.5 credits` Cinema Studio spend row confirmed. Normal UI completion still timed out at 720s, then the designed 120s grace period ran and Asset Library recovery found the matching newest video tile at 98% similarity, downloaded the `.mp4`, persisted the local file, auto-approved clip review, and advanced to the next clip. This confirms the intended post-timeout behavior is recovery/persist/advance, not retrying Generate.
- **May 31 prompt leak hardening:** A live run exposed Claude shot-reconcile analysis prose leaking into the final Cinema video prompt (`STEP 2`, `SHOT-BY-SHOT ANALYSIS`, `PROPS IN HAND contradiction`, markdown headings) before Generate was clicked. The contaminated pending `ch6_sc1_c1` row had `prompt_used` set but `gen_clicked_at = NULL`, so it was safe to clear generation metadata and regenerate fresh. The orchestrator now runs a final sanitize/re-sanitize pass after rules + grounding and before prompt preview/DB persistence/browser typing. It strips only obvious Vision/meta lines, preserves the normal prompt shape (`Nigerian drama` prefix, `CHARACTER POSITIONS`, optional scene setting, `Shot 1..3`, dialogue, `NO SUBTITLES.`), and logs only counts/marker classes removed, never the full prompt. This protects credit flow without adding a hard-stop gate or leaking the prompt into UI/terminal logs.

1. **Scope:** Do not create a new pipeline mode, provider framework, DB table, prompt system, or assembly path at first. Branch only where cinematic video clips are submitted to Higgsfield.

2. **Setting:** Add one project setting, defaulting to the current behavior:
   ```js
   settings.cinematicVideoEngine = 'kling' | 'cinema-studio-3.5'
   ```

3. **Cinema Studio 3.5 setup:** Navigate to `https://higgsfield.ai/cinema-studio?cinematic-project-id=<higgsfield_cinema_project_id>`, ensure Video mode, and actively set every required control before each Generate attempt:
   ```text
   Genre: General
   Style: Auto
   Camera: Auto
   Cinema Studio 3.5
   15s
   480p
   project aspect (`16:9` or `9:16`)
   Sound/Audio On
   ```
   Observed Generate button cost at these settings: `52.5` credits.

4. **Scene/start image upload:** Use the **`+` symbol on the video input tile**, not the `@` button. Flow:
   ```text
   + symbol -> upload window -> Uploads -> Upload media -> trusted filechooser -> local DB file
   ```
   Source of truth remains `project_assets.file_path`.

5. **Scene image eligibility:** Do not read global page text. Before upload, capture visible asset `img.src` values. After upload, find the new Higgsfield card by the new CDN image URL and read eligibility only inside that card. Parse in this order:
   ```text
   Not eligible
   Checking / pending
   Check eligibility
   Eligible
   ```
   Higgsfield usually auto-triggers the scene-image eligibility check after upload. If the hovered uploaded card exposes `Check eligibility`, click that card-local control once and return to the normal `Checking` -> `Eligible` wait. `Eligible` continues. `Not eligible`, timeout, or unknown pauses the pipeline. Do not mark the original scene asset failed. Use long progressive waits because the visible card can remain `pending` while the backend catches up.

6. **Element eligibility entry point:** Use only the **`@` symbol next to Sound/Audio On**. Flow:
   ```text
   @ symbol -> Elements tab -> element card
   ```
   Ignore sidebar `Elements`, Assets, and project element management surfaces for this workflow.

7. **Element eligibility behavior:** Element status is persistent once checked. For each required element:
   ```text
   already visually eligible -> continue
   already Not eligible -> pause
   Check eligibility -> click once -> wait
   ```
   Current Cinema Studio 3.5 no longer exposes stable `Eligible` / `Not eligible` text for elements. In-progress review can render as `Face/IP check`, `Face/IP checking`, `Checking content...`, or `Checking`. Final eligible proof is visual: hover the element image tile and require the `Use` button plus the small green bottom-left badge/logo on that same tile. Use a generous timeout, about `180s` per element, polling for:
   ```text
   Face/IP check / Face/IP checking / Checking
   Use + green bottom-left badge/logo
   Not eligible
   Check eligibility
   ```
  If an element is not eligible and must be deleted/recreated, the card action menu is hover-only. First scroll/center the exact element card inside the modal, hover the image tile until the `Use` button/checkbox/three-dot controls render, then click the actual visible three-dot button on that tile. Do not use a guessed lower-right coordinate: bottom-row cards can place the popover offscreen or miss the menu, producing repeated `Delete menu item not found` failures.

8. **Eligibility pause gate:** Add one pause gate if no existing gate fits:
   ```text
   cinema-eligibility-failed
   ```
   Payload shape:
   ```js
   {
     assetKind: 'scene-image' | 'element',
     failedAssets: [
       { name, filePath, clipId, status, reason }
     ]
   }
   ```

9. **Generation branch:** Keep Kling unchanged:
   ```text
   cinematicVideoEngine === 'kling' -> existing cinematic Kling path
   cinematicVideoEngine === 'cinema-studio-3.5' -> Cinema Studio setup/upload/eligibility/generate path
   ```

10. **Credit ledger confirmation:** Reuse the proven baseline/read/history pattern from Kling, but match Cinema-specific rows only. Open `https://higgsfield.ai/me/settings/credits-usage`, scroll to History, capture baseline rows, close tab, read Generate button cost, click Generate once, reopen credit usage, and confirm a new Cinema Studio spend row. UI `Processing`/`Generating` is required as an acceptance signal but does not replace the ledger row for persisted credit spend.

11. **Cinema Studio credit row matching:** First test must confirm the exact ledger label for Cinema Studio 3.5. Expected matching fields:
   ```text
   Cinematic Studio 3.5 Video
   Spent
   52.5 credits (or Generate button cost)
   cost ~= Generate button cost
   timestamp near click
   ```
   Do not hardcode Kling text in the Cinema branch.

12. **Pre-generate safety:** Before clicking Generate, verify toolbar settings, parse the Generate button cost, capture credit ledger baseline, then click Generate exactly once. If neither UI `Processing`/`Generating` nor a matching ledger row appears, throw a `[PRE-GEN]` error and treat it as safe to retry. If UI accepted but ledger is missing, treat it as ambiguous and do not retry automatically; continue to completion wait/recovery to avoid double-spending.

13. **Post-click flow:** After both UI acceptance and ledger spend are confirmed, mark generation submitted/clicked, wait for the generated video, download it if it appears in the current UI, and fall back to asset recovery on timeout. Expect 5-7+ minutes for a 15s/480p Cinema Studio 3.5 clip.

14. **Asset recovery:** Cinema Studio 3.5 outputs do appear under `https://higgsfield.ai/asset/video`. Reuse/adapt Kling recovery: open newest video tiles, compare prompt, download matching clip. A live recovery matched at 99% similarity and downloaded successfully. Recovery should run after a generous completion wait, not immediately after submit.

15. **Downstream verification:** Confirm Cinema Studio clips work with existing clip review, verify flow, FFmpeg assembly, and 480p-to-4K upscale. Add normalization only if FFmpeg concat/upscale fails.

16. **Regression tests:** Confirm existing Kling cinematic remains unchanged, staged/Veo remains untouched, and run a 1-minute Cinema Studio 3.5 test first. Test `+` scene upload, scoped scene eligibility, `@` element eligibility, not-eligible pause, ledger confirmation, download/recovery, verify, and assembly.

## Standalone Promo Character Spotlights (Session 2026-06-02)

Standalone Promo posts live in the Promo tab and reuse existing Publish + Engagement surfaces instead of inventing separate social machinery.

- **Post rows:** Promo uses `social_posts` with `post_type = 'standalone_character_spotlight'`. Engagement helpers must filter their own post types so Promo rows do not appear in normal engagement counts, copy generation, or scheduling.
- **Planning:** One planned Facebook post per unique speaking character. The planned post count is determined by the number of unique characters, not by a fixed 1/2/3/4 engagement window.
- **Schedule:** Default happy path is one post per day at 10:00, outside the normal engagement type 1/2/3/4 timing window.
- **Aspect ratio:** Promo image generation must use the project aspect ratio from project settings. Do not hardcode 9:16 except as a display example or fallback.
- **Image workflow:** Reuse Publish standalone thumbnail generation semantics:
  ```text
  character element portrait/key art -> title card -> composite with both images as references
  ```
  Output paths are per character under the project `output/promo/<character_id>/` folder:
  ```text
  key-art-custom.png
  title-card.png
  title-card.json
  thumbnail-custom.png
  ```
  Promo title cards use the character full name as the top line and the cleaned script title as the bottom line, for example `Itohan Omonuwa` over `Blood of the Marketplace`. Strip production suffixes such as `— Full Nigerian AI Animated Folktale (3 characters)` from the displayed script title. `title-card.json` records the expected title-card spec; if it is missing or mismatched, regenerate `title-card.png` even when the image file already exists. If `key-art-custom.png` and a matching `title-card.png` already exist and are non-trivial files, `Generate Images` should reuse them and continue directly to `thumbnail-custom.png` composite.
- **Composite safety:** Composite must attach the existing key art and title card as the two reference images before clicking Generate. If reference upload fails before Generate, do not run Asset Library recovery because no new generation was submitted; retry composite from a fresh context instead. This applies to both Publish standalone thumbnails and Promo character spotlights. Composite Asset Library recovery is only valid for a submitted generation/timeout, and must use strict prompt comparison because generic composite prompts can weakly match older assets.
- **Higgsfield fresh-page upload drift:** On the current Nano Banana Pro fresh image page, reference upload may show `totalSlots: 0` with one bare `input[type=file]` whose `accept` attribute is empty or not explicitly `image/*`. Promo composite opts into accepting this bare input while Publish defaults stay strict. The upload routine must still use trusted click/filechooser handling and abort before Generate if the backend upload is not confirmed.
- **Fresh-page image accept values:** Higgsfield may expose the bare fresh-page reference input as `accept=".jpg,.jpeg,.png,.webp"` instead of `image/*`. Treat common image extensions as valid image accept values in the strict path. Do not fall back to raw `setInputFiles()`; the trusted click/filechooser path must still fire and backend upload must still be confirmed before Generate.
- **Image generation fetch-failure toast:** Nano Banana Pro can show a visible toast reading `Something went wrong: Failed to fetch` after the intended Generate click. When this appears with no job UUID/new history item, treat it as a retryable server/fetch failure, not as a submitted generation to recover from Asset Library. Retry from a fresh context through the existing server-failure retry path.
- **Composite face protection:** Publish/Promo composite prompts must explicitly protect the full face/head silhouette. Title text, shadows, rule lines, glow, gradients, or text boxes must not overlap eyes, nose, mouth, cheeks, forehead, chin, hair/headwrap, neck, or any face boundary. If the requested placement conflicts with the face, the prompt should tell Higgsfield to ignore the requested placement and use the clearest negative-space area.
- **Composite prompt-match acceptance:** Publish/Promo composites must not accept a direct CDN/latest-history download on prompt similarity alone. Before saving `thumbnail-custom.png`, the composite path must use the Higgsfield Asset Library detail page to compare the submitted composite prompt with the asset's actual prompt (currently >=85%) and download only the matching asset. The detail page often truncates the PROMPT card; click the PROMPT-section `See all` control, then wait for the prompt text to stop changing before reading `.attribute-text-value` or body text. A portrait-only/key-art tile can share enough words with a generic composite prompt to pass loose matching, so missing prompt metadata or low similarity is a retryable composite failure, not a usable thumbnail.
- **Copy:** Captions should be spoiler-free "meet the case/cast" copy based on character description and role, never a plot reveal.
- **Scheduling:** After images and copy are ready, schedule through the existing Engagement Playwright/Facebook flow using the Promo rows and media paths.

**Facebook image-post UI drift (live diagnostic 2026-06-02):**
The Social/Promo image-post scheduler now opens a full-page composer at:
```text
https://www.facebook.com/post/create
```
Do not expect the old small `Create post` dialog or the old `Next -> Scheduling options` wizard for image posts. Current live flow:
```text
Professional dashboard -> Content Library -> Scheduled -> Create dropdown -> Post
caption textbox visible immediately
Add photos or videos drop zone visible immediately
bottom Schedule button opens Scheduling options modal
modal has Date and Time text inputs
Schedule for later button applies the date/time and closes the modal
bottom Schedule post button submits the scheduled post
```
Captured live selectors/labels:
```text
caption: role="textbox", placeholder "What's on your mind, Fayehun?"
media: role="button", text "Add photos or videos or drag and drop"
schedule: bottom role="button", text "Schedule"
date input value example: "Jun 2, 2026"
time input value example: "3:09 PM"
modal submit: role="button", aria/text "Schedule for later"
final submit: bottom role="button", aria/text "Schedule post"
confirmation: Content Library scheduled row appears, e.g. caption text plus "Scheduled · Today at 3:45 PM"; do not rely on a toast
```
Keep Shorts/Reels on their separate wizard path; this drift note applies to image posts scheduled by `social-facebook-uploader.js`.

**Social image composer off-screen action bar (live 2026-06-04):**
Facebook can keep the bottom `Schedule` / `Post` action bar below the visible area in the left full-page composer pane even when the preview is visible on the right. For Engagement image posts, scroll the real left composer scroll container to the bottom before clicking `Schedule`; do not rely on document scroll alone. After clicking `Schedule`, verify the `Scheduling options` modal is visible before setting date/time.
Do not fork custom Date/Time picker logic in the Engagement uploader. Engagement image posts should reuse the inherited Shorts scheduling helpers (`_setScopedScheduleDate()` / `_setScopedScheduleTime()` from `src/main/shorts/facebook-uploader.js`), which already handle Facebook's current Date/Time controls by input scan plus `getByText('Date'/'Time')` keyboard entry.

## Higgsfield `/generate` UI Drift — Live 2026-06-16

Live inspection confirmed Higgsfield moved Cinema Studio project URLs from:
```text
/cinema-studio?cinematic-project-id=<uuid>
```
to:
```text
/generate?projectId=<uuid>
```
Automation should navigate with `projectId` while still accepting the old `cinematic-project-id` query param for backward compatibility. New project creation now opens a `New project` modal; fill the name field, click `Create`, then persist the `projectId` from the resulting URL.

Project creation is a hard gate before element setup. The New Project name field must be filled with trusted keyboard input when possible, then automation must wait for the `Create` button to become enabled, click it, wait for `/generate?projectId=<uuid>`, persist `settings.higgsfield_cinema_project_id`, explicitly navigate to that project URL, and let it settle before any element existence/list checks. Do not continue into element checks after a project setup warning; if project creation, persistence, or project URL verification fails, stop with a `[PROJECT GATE]` error. This prevents element checks from running on `/generate`, stale pages, or half-created modal state.

Element creation upload tiles can render slightly after the `New Element` form and category controls are visible. Do not do a one-shot scan for `Upload media`. Poll the active `New Element` dialog for the large right-side upload tile, matching either `Upload media`, `Drag & drop`, or `click to upload`, and click the inner plus/SVG when present. After each portrait/grid upload, require the picker flow to complete and the element-form preview count to increase before continuing. For character elements, both portrait and matching grid previews must be confirmed before clicking `Create`.

For the current project `New Element` upload picker, do not rely on the native Windows file chooser. Live runs showed the same upload tile sometimes opens a chooser and sometimes times out waiting for `filechooser`, even though the picker is valid. Use the active Uploads picker dialog's image-capable `input[type=file]` with `setInputFiles()`, then keep the downstream proof gates: wait for upload settling, select/enable `Add to Element`, click it, and require the element-form preview count to increase. This note is specific to the element picker; Cinema Studio scene-image upload already has a hidden-input fallback, while Cinema Studio 3.5 video start-frame upload still needs review because it currently relies on native `filechooser`.

Element management on project pages is now reached from the top-center project `Elements` control, which may render as a non-button element. Do not rely only on `button` / `[role=button]`. The real Elements modal is a large open dialog containing modal-only signals such as `My Elements`, `Show subfolders elements`, `All Pinned`, `Create Element`, or `New Element`. The project page body itself also contains `Elements` / `My Elements`; body-text checks alone false-positive and prevent the modal from being opened.

Element card text can render as combined labels such as:
```text
Check eligibility@codex_elem_test_0615Character
@codex_elem_test_0615 Character
```
Normalize scraped names by extracting the `@name`, stripping leading `@`, and removing trailing type suffixes (`Character`, `Location`, `Prop`) before comparing. Deduplicate normalized names and ignore utility labels such as `Check eligibility`.

The composer `@name` autocomplete path is currently not reliable as an existence gate. In live testing, Image mode + Cinematic Cameras accepted typed text into the Lexical prompt and opened a tiny `[role=listbox]`, but the listbox stayed empty even though the element existed. Use the Elements modal/list scrape as the source of truth for "element exists"; keep composer mention checks diagnostic only.

Element setup must not fall through to human creation. If the stage reaches the element-ready gate with missing names, wait 2 seconds, re-open/scrape the project Elements modal, and recreate only the names still absent from that modal. Repeat until every expected character element is accounted for. The old `Elements Ready` human click is not an acceptable completion path for this gate; a browser/page failure should restart/resume into the same automated retry loop rather than proceed on user authority.

On resume, a persisted `pending_approval_gate: "elements-ready"` is stale/reconstructible. Clear it in the generic resume handler so the pipeline reaches `elements-setup` and re-runs the automated modal-proof retry loop. Do not re-enter `waitForApproval('elements-ready')` for cinematic element setup.

Location orientation must be visually checked, not only by PNG width/height. A file can have the correct canvas dimensions while the scene content is rotated sideways. `verifyLocationImage()` should score `upright_orientation` and force-fail sideways/upside-down/90-degree-rotated content so `_runCinematicLocationSetup()` deletes the bad file and retries within the existing location retry loop.

Location prompts must use subtype-specific Nigerian grounding. Office/law-firm/workplace locations should get Nigerian professional workplace markers, not `Nigerian home interior`, or Higgsfield can render a split image with an office on one side and a home interior on the other. `verifyLocationImage()` should also score `coherent_single_space` and force-fail hard vertical seams or unrelated merged spaces so the normal location retry loop regenerates them.

Police station / civic facility interiors need indoor civic/security grounding, not Nigerian street/exterior markers. Empty-location prompt building should strip people/crowd clauses such as `crowded` and `officers behind the counter` before appending the hard no-people rule. `coherent_single_space` should fail stacked indoor/exterior panel images, including police-station-interior above street-exterior splits.

Important distinction: this limitation applies only to the pre-flight existence/listing gate. Actual scene-image and video prompt construction still must resolve character/location references through Higgsfield's `@` autocomplete so the prompt receives real element reference chips/UUIDs. The current prompt typing code intentionally types `@`, pauses, then types the full element name slowly and hard-fails if the exact autocomplete option cannot be selected. Do not replace generation prompt `@` references with plain text.

Cinema Studio prompt autocomplete can render an empty dropdown/listbox shell before element options arrive. Treat `hasListbox=true` with `optionCount=0` as a wait/repair state, not as a selectable dropdown. Poll for visible `role=option` / `role=menuitem` entries, then select the exact element; if options never populate, remove only the unresolved raw `@name`, refocus the textbox, retype slower, and keep the pre-generation hard gate.

Resolved Higgsfield `@` chips still expose their label in the prompt editor's `textContent`. Do not use a plain regex over textbox text to detect unresolved raw mentions. Use DOM context from `_inspectPromptMentionDom()` and fail only when the `@name` lives in a normal text node without a chip-like/contenteditable=false ancestor.

After a scene reference upload, Higgsfield can drift aspect/resolution back to a stale duplicate toolbar row (observed `9:16` set, then Phase 2 read `3:4` / `1K`). Toolbar state and aspect clicking should prefer the row containing `Cinematic Cameras`, then read/repair aspect with readback before Phase 2. A scene that fails all generation attempts should stop the current pass so the bounded retry/fallback focuses on the missing scene instead of marching onward.

Cinema Studio image references no longer prove attachment by showing a thumbnail on the `+` button. The current image UI shows the reference above the prompt textarea. For scene image generation, require backend upload proof plus a visible composer thumbnail above/near the textarea. Do not type temporary image-reference diagnostics; typed image-reference checks can resolve in the UI while Playwright/DOM chip detection false-negatives. Real character/location prompt `@` resolution remains required only for actual prompt construction.

Element existence authority order: project Elements modal proof is source of truth. Open that modal from the top-center project `@`/`Elements` control first, and use the bottom prompt-toolbar `@` only as fallback. Valid persisted modal proof can skip setup verification on resume. Do not type `@character_name` as a setup/existence diagnostic; that path is obsolete and can false-negative even when the modal lists every element. Real scene prompt chip resolution remains a pre-Generate hard gate. When modal proof reports all expected names present, persist `_cinematicElementsModalProof` in project settings with project id, count, names, timestamp, and source. If anything claims setup elements are missing, re-run the project Elements modal proof before recreating anything.

Higgsfield can render duplicate overlapping image composers/toolbars at the same Y coordinate. One row may be the active Cinematic Cameras row while a stale row still shows controls such as `Soul 2.0`, `3:4`, `2k`, `Color transfer`. Toolbar state reads must not mix the active model from one row with aspect/resolution/grid from the stale row. Read aspect/resolution/grid only from controls to the right of the selected active model button. Live verification after the fix:
```text
_readToolbarState() -> image, cinematic-cameras, 16:9, 2K, 1x1, cost 2
_setupToolbarSequence('9:16') -> image, cinematic-cameras, 9:16, 4K, 1x1, cost 4
```
Update 2026-06-16: duplicate rows can share the exact same Y coordinate and overlapping X coordinates. Y-band grouping and "before next same-Y model" x-windows are not sufficient, because stale `Nano Banana Pro` can start inside the active `Cinematic Cameras` model button's x-range. Use ancestor/panel grouping instead. The active Cinematic panel text includes `Cinematic Cameras 16:9/9:16 2K/4K 1x1`, while stale Nano panels include `Nano Banana Pro ... Unlimited`; stale video panels include `Cinema Studio 3.5`, `1080p`, `8s`, etc. `_readToolbarState()` and `_setAspectRatio()` should read/click buttons whose ancestor panel includes `Cinematic Cameras` and excludes `Nano Banana`, `Cinema Studio 3.5`, `1080p`, `720p`, `8s`, and `15s`. Live test project `65526eef-52d2-4f13-9c32-29558273ee41` verified readback: before aspect repair `image/cinematic-cameras/16:9/2K/1x1/cost 2`; after `_setAspectRatio('9:16')`: `image/cinematic-cameras/9:16/2K/1x1/cost 2`.

Live verification for element existence after the fix:
```text
project page modal open before: false
listExistingElements() opened the real project Elements modal
scraped exactly: codex_elem_test_0615
elementExists('codex_elem_test_0615') === true
modal closed afterward
```

Live reference-image upload check for Cinema Studio image generation:
```text
Current coded path: + reference picker -> Uploads tab -> visible Upload media DOM click
Result: filechooser timeout; visible tile click did not fire a chooser

Hidden file input fallback test:
input[type=file] accept=image/jpeg,image/jpg,image/png,image/webp,image/heic,image/heif
setInputFiles(local image) produced backend proof:
POST /media/batch 200
PUT CloudFront/S3 200
POST /media/<id>/upload 200
new uploaded tile appeared
clicking the new tile showed "Added to prompt box"
_checkSceneReferenceAttached() -> { attached: true, method: "img-left-of-textbox" }
```
If patching this path, prefer the visible trusted-click/filechooser path first when it works, then fall back to the hidden image file input only when it produces backend upload proof and a selectable new tile. Do not continue to Generate without both backend proof and `_checkSceneReferenceAttached()`.

Update 2026-06-17: Cinema Studio scene-image Asset Library recovery is post-submit only. A timeout before proven Generate click can come from stale transparent picker overlays, textbox focus, upload proof, composer-thumbnail proof, or prompt typing; do not search the Asset Library for an image that was never submitted. The orchestrator now tracks per-attempt Generate-click proof via `onGenClicked` and refreshes the same scene asset row for persisted `gen_clicked_at` before recovery. If neither proof exists, skip recovery and retry setup cleanly. Typed `@element` existence diagnostics are obsolete for scene-image setup; use the project Elements modal/persisted modal proof for existence and reserve typed `@element` resolution for actual prompt construction. Typed image-reference diagnostics are obsolete for both scene-image and video start-frame proof.

Update 2026-06-17 live production run: the scene-image final reference-thumbnail check was too geometry-strict after prompt typing. The attached location thumbnail can sit above/near the prompt textarea, not only left of it or below 45% viewport height. `_checkSceneReferenceAttached()` now accepts thumbnail-sized `https/blob/data:image` Higgs/CDN images in a broader composer-relative band and reports nearby candidates on failure. A 2s post-prompt settle wait was added before the final check. Live result: Ch1 scene generation passed `Reference still attached and backend-confirmed`, clicked Generate, and submitted at 4 credits. If this exact final thumbnail check fails again despite backend proof and immediate post-upload thumbnail proof, remove the final post-prompt thumbnail re-check and keep backend proof as the source of truth.

Update 2026-06-17 scene verification retry: successful scene-to-next-scene transitions already reset the Cinema Studio browser context, and thrown automation failures already reset before retry. The missing path was downloaded scene image -> Claude scene verification fail -> retry same scene. That `continue` skipped the catch/reset path and reused dirty composer/picker state, causing toolbar readback drift such as `aspect=null, res=null, grid=null` on the regeneration attempt. `_runCinematicSceneImageStage()` now calls `cinema.resetFormForNextGeneration()` with a short cooldown before retrying a scene after vision rejection.

**Cinema Studio 3.5 video reference + eligibility drift (live 2026-06-16):**
Video clip generation uses a different reference path from image generation. In Video mode, the start-frame/reference upload opens from the small `+` References button immediately left of the `@` button in the bottom Cinema Studio 3.5 composer. Inside the picker, click the inner `+` above `Upload media`; then keep the picker open and wait through the full upload/content-review lifecycle before selecting the settled uploaded tile. Do not treat first tile visibility as enough, because the tile can remain in `Uploading...` / `Checking content...` and multiple older tiles can share proxied image URLs.

Current verified video reference flow:
```text
Video mode -> References + -> Uploads picker -> Upload media + -> filechooser
wait for Uploading... / Checking content... to clear
select the visible settled uploaded tile
confirm composer thumbnail attached
```
The hard proof for the attached start frame is upload/content-review completion plus the visible composer thumbnail. Do not type temporary image-reference diagnostics for video start-frame proof.
After the start frame is added, the composer reference tile count should be at least 1. After real prompt typing, distinct element mentions should increase the same above-prompt tile count; the final pre-Generate proof is `1 + distinct valid element references`.

Cinema Studio video element eligibility no longer exposes stable `Eligible` / `Not eligible` text. The current live card lifecycle is:
```text
Check eligibility -> Face/IP checking -> small badge / Use state
```
Use the card-local lifecycle only. If `Check eligibility` is visible, click it and wait through `Face/IP check` / `Face/IP checking`. The ready state is hover-revealed `Use` plus the small green bottom-left badge/logo on the tile. Do not run temporary typed `@character` diagnostics after eligibility; the UI can resolve for a human while Playwright misreads it. For actual video prompts, element attachment is proven by real prompt typing plus the composer reference tile-count gate before Generate. Do not apply this video-only eligibility check to Cinema Studio image generation.

Update 2026-06-18 Cinema video not-eligible repair:
- `Not eligible` remains the dominant status even when the hover proof also contains `Use`; `Use` can be a card action affordance and must not override an explicit failure label.
- Cinema video pre-Generate setup now treats not-eligible elements as repairable before any human gate: clear stale eligibility cache, open the project Elements picker, exact-match the element card, use the card-local three-dot menu to delete it, recreate the character element from the local portrait + grid image pair, and run `Check eligibility` again.
- The repair loop is bounded at 6 attempts per failed element and only exits as successful when the element re-check returns `eligible`. Higgsfield can sometimes mark the same portrait/grid pair eligible after several delete/recreate cycles, so the cap must be high enough to absorb UI/Face-IP flakiness while still preventing an infinite loop. If a local portrait/grid pair is missing, or the element remains not eligible after the cap, the existing `cinema-eligibility-failed` human gate is still emitted with the unresolved names. No Generate click is allowed during this repair loop.
- On restart, a persisted `cinema-eligibility-failed` gate is reconstructible and should be cleared by the generic resume path. The video stage must re-run eligibility and automated repair rather than re-entering the old human wait before the repair code can execute.

Update 2026-06-18 Face/IP recast hardening:
- The first automatic Face/IP recast must do more than append the no-public-figure caveat. It now rewrites/persists the character physical description with stronger permanent differentiators: scars, asymmetry, distinctive facial geometry, hairline/beard shape, and respectful/culturally plausible facial or tribal marks when appropriate.
- A recast that reaches eligibility re-check and still fails is persisted as `failed`, not resumable `eligibility-pending`. Restart must not keep recreating the same character elements from the same rejected portrait/grid set.
- If one outfit element recast fails for a character, sibling outfit elements for that character are marked unresolved in the same repair pass instead of starting another delete/recreate loop from the same failed assets.

Update 2026-06-19 Face/IP recast resume gap:
- Live SCWOB restart after a partial Barrister Tunde recast proved a missing stage boundary: the project resumed at `scenes-done`, entered video, skipped four missing recast scene images, and began pre-Generate setup even though DB rows `face-ip-recast:character_4` were still pending. No video Generate proof existed (`gen_clicked_at/source/file/cdn` all zero), so the app was stopped and the video boundary was patched.
- Before cinematic video setup now runs, the orchestrator checks persisted `_cinemaFaceIpRecasts` plus active `scene_image_cinematic.error_message = face-ip-recast:<characterId>` rows. If video has not started, it regenerates the exact tagged scene rows, proves DB reset/regeneration, clears stale pre-video clip metadata only for clips tied to those scenes, marks the recast complete, then continues. If any video proof already exists, automatic recast is blocked and human review is required.
- `_runCinematicVideoStage()` also fail-closes if any active recast-tagged scene row lacks a ready local image. Recast scenes must never be silently skipped when assembling the clip list.

Live no-Generate verification after the fix:
```text
start-frame dry-run: waited through Checking content..., selected settled tile, thumbnail attached
element dry-run: opened project Elements panel, observed eligible-visual/Use and persisted eligible without typed diagnostic
```

Update 2026-06-17 coded video element flow:
- `HiggsfieldElements.createCharacterElement()` is the source of truth for element creation and requires two images for character elements: portrait + grid. The current UI path hard-fails if fewer than 2 previews are present before Create.
- The coded creation flow now opens the mid-screen project Elements button, clicks the `New Element` plus tile, uploads both images via trusted filechooser, confirms `2/2` previews, and creates the element.
- The coded video eligibility flow must not decide the picker is open from ordinary page text (`My Elements` in the left sidebar plus project `Elements` under the title). Picker detection now requires a real modal/picker container.
- Live sample result: a fake element made from two UI screenshots was created successfully but remained in `Check eligibility` until timeout, which is expected invalid test material rather than picker failure. The same coded eligibility method against known valid `@codex_elem_test_0615` opened the project Elements panel, detected hover/badge `Use`, and returned `eligible`.

Update 2026-06-17 coded Cinema video pre-Generate checks:
- Start-frame reference upload passed through the coded path: References `+` -> `Upload media` -> filechooser -> `checking` -> `eligible` -> select settled card -> composer thumbnail proof. Picker reset/retry also passed: after forcibly closing the picker mid-setup, `_attachStartFrameFromLocalUpload()` reopened the picker and attached a new eligible reference.
- Credit-cost parsing passed on discounted button text. Current DOM text can flatten the crossed-out original price into `GENERATE9052.5` with text parts `["GENERATE", "90", "52.5"]`; `_parseGenerateCreditCost()` correctly returns `52.5`, not `90`.
- Ledger baseline read is allowed to return zero Cinema Studio rows. In the sample account/project, `_readCinemaCreditLedger()` opened the credits usage page and returned `0` rows; this is still a valid baseline signature set (`[]`) before Generate.
- Generate safety guard hardening: an explicit accidental click/Enter test originally reached the Cinema submit endpoint, which the route blocker aborted before any UI generation state appeared. The DOM guard now also stores/restores `disabled`, sets Generate buttons disabled while locked, and blocks coordinate-based pointer/click events inside Generate button rects. Retest result: endpoint block count stayed `0`, Generate buttons were locked/disabled, shield was present, and no generation UI state appeared.

Cinema Studio 3.5 video toolbar drift (live 2026-06-16):
```text
active row before setup: Cinema Studio 3.5 / 9:16 / 480p / 8s / 1/4 / On, cost 28
duration control is a Radix slider: role=slider, aria-valuemin=4, aria-valuemax=15
the slider thumb itself is only ~4px wide; drag the wider parent track, not the thumb box
active row after setup: Cinema Studio 3.5 / 9:16 / 480p / 15s / 1/4 / On, cost 52.5
```
Higgsfield can render a stale overlapping video toolbar at the same Y coordinate (`Kling 2.6 / 16:9 / 5s / On`). Video toolbar helpers must prefer the active bottom row whose compact container contains `Cinema Studio 3.5`; otherwise duration/aspect/audio reads can bind to stale Kling controls. Keep the no-Generate toolbar verification before resuming long production runs when Higgsfield UI changes.

Update 2026-06-17 cinematic element alias gap:
Higgsfield's prompt editor rewrites resolved `@element_name` chips into internal UUID-like IDs such as `@db445e9f-...`; that is normal and means the element pill resolved. The actual failure mode is human/display aliases that remain plain prose around otherwise-correct element pills. Example: `@sewa_o1_scwob_0615` resolved to a UUID, but nearby text still said "behind Tunde" because the prompt sanitizer knew `barrister_tunde` and `barrister_tunde_o1_scwob_0615`, not the human alias `Tunde`.

Scene-image prompt construction must carry per-character aliases from the script bible into Cinema Studio automation: `element_name_hint`, canonical element name, description-label names, title+first-name variants, first name, surname, and role/display variants where available. Apply aliases longest-first in position text, lighting text, and the final pre-generation gate, converting aliases into structured `{ at: canonical_element_name }` segments so Higgsfield creates real element pills. Also canonicalize persisted `scene_image_cinematic.prompt_used.blocking` so recovery/debug metadata stores outfit-specific element names (`@barrister_tunde_o1_scwob_0615`) instead of script-original bare names (`@barrister_tunde`). Existing completed image files do not need regeneration solely for metadata contamination; metadata repair is safe only while the Electron app is closed or after coordinating with its in-memory SQLite state.

Update 2026-06-17 failed/refunded scene-image tiles:
Higgsfield scene-image grid tiles labeled `Failed` + `Credits refunded` are terminal failed generations, not active generations. Do not classify blank failed/refunded tiles as active just because they have SVGs and no large image. Detect them as `GEN-FAILED-REFUNDED`, skip harvest/wait loops, reset the composer, and retry the same scene automatically. `Failed` without refund text is still terminal (`GEN-FAILED-UNKNOWN`) and should retry automatically with a stronger warning. The cinematic scene-image stage must not emit the `cinematic-manual-scene-images` / `scene-images-ready` human gate for these failures; manual scene-image generation is deprecated as a regression path. Missing scenes now stay in an automated recovery loop with bounded backoff, then hard-error if the automation exhausts its recovery budget.

Update 2026-06-18 stale failed/refunded tile differentiation:
Before clicking Generate, scene-image polling must snapshot visible failed/refunded tiles as stale baseline state using stable fingerprint counts, not raw `x:y:w:h` rectangles. Grid coordinates shift as new tiles appear, so rectangle-only keys can misclassify a previous failed/refunded tile as the current attempt and trigger an unsafe retry while a new tile is still spinning. During polling, active/spinning generation tiles override failed/refunded detection: keep waiting while a spinner is visible, and only treat failure as current if the failed/refunded fingerprint count increases beyond the pre-Generate snapshot. Same-prompt generic failed tiles are differentiated by count, so a second identical failure is still actionable while the original old tile remains ignored.

Update 2026-06-18 scene-image Asset Library recovery prompt matching:
Cinema Studio scene-image recovery must compare against the exact prompt captured from the composer immediately before Generate, not rebuilt fragments from `blocking.notes`, `frame_left`, `frame_center`, or `frame_right`. The exact prompt is persisted into `scene_image_cinematic.prompt_used.prompt` before/at Generate so active-generation waits, timeout harvest, and restart recovery all use the same text Higgsfield stored in the asset detail. The asset detail PROMPT card often truncates; recovery must click the PROMPT-section `See all` control when present, then wait for `.attribute-text-value`/body prompt text to stabilize before computing similarity. Recovery should check a broader recent-tile window before declaring no match. A pending scene with `gen_clicked_at` must attempt Asset Library recovery with the stored exact prompt before any new Generate click, or a completed server-side image can be missed and credits wasted. If a pending/active-timeout prior submission does not match yet, defer and retry recovery in the normal missing-scene cycle rather than immediately burning new credits.

Legacy scene-image rows from before exact prompt persistence may have only JSON recovery metadata in `prompt_used` (`blocking`, `vision_refined_characters`, `scene_prop_contract`) and no `.prompt`. Do not compare that raw JSON blob against the Higgsfield asset PROMPT text. Reconstruct a prompt-shaped recovery target from the legacy characters, blocking notes, and prop contract, use a lower legacy threshold, and still defer instead of regenerating if no confident match is found. Higgsfield may render the same element as `@element_name`, a visible chip, a raw UUID, or `<<<uuid>>>`; prompt normalization must collapse those forms to the same element token before similarity scoring.

Update 2026-06-17 scene reference attachment restart drift:
After restart, a failed scene can resume correctly and still fail before Generate if the Cinema Studio reference picker drifts: backend media upload proof (`/media/batch`, CloudFront/S3 `PUT`, `/media/{id}/upload`) only proves the image exists in Higgsfield media, not that it is attached to the current composer. Scene-image reference upload must prove three separate states before any Generate click: the composer reference picker is actually open, clicking the newly uploaded tile returns an `Added to prompt box` style confirmation, and `_checkSceneReferenceAttached()` sees a composer thumbnail. A collapsed textbox (`0x0`) is `REFERENCE_COMPOSER_LOST`, a retryable setup drift. Retry/reset the composer automatically; do not human-gate and do not continue to Generate on upload proof alone.

Update 2026-06-18 reference picker `+` drift:
The scene-image reference `+` opener worked through 28 scene images, then failed after restart because the duplicated/stale Cinema Studio toolbar state changed which tiny SVG button lived at the old coordinate. A clicked `+` at the same coordinate can create only a tiny/irrelevant popover or no picker at all. Do not retry the same `+` coordinate after `REFERENCE_PICKER_NOT_OPEN`. The upload flow now ranks composer-local `+` candidates, marks failed center coordinates bad, restores pointer-events, and tries the next candidate until `_readReferencePickerState()` proves the real picker is open. Continue only after picker proof; otherwise reset and retry the scene setup.

Update 2026-06-19 Cinema Studio reference `+` picker proof:
The bottom composer `+` immediately left of `@` can correctly open the Uploads picker while automation still reports `REFERENCE_PICKER_NOT_OPEN`. The failure mode is a false-negative detector: Higgsfield may flatten picker labels into concatenated DOM text such as `UploadsElementsImage GenerationsVideo GenerationsLiked...`, so word-boundary checks like `\bUploads\b` miss an open picker. Picker proof for both scene-image references and video start-frame uploads must normalize compact text, require the real large Uploads picker panel, and require `Upload media` before setting any file input. Do not use the top-right project `Upload` button for composer references. Do not click the visible `Upload media` card if it opens a native Windows file chooser; the current safe path is: bottom References `+` -> Uploads tab -> prove large picker with compact text -> set the hidden image file input -> wait for backend/uploaded-tile proof -> select the tile -> prove composer thumbnail. This applies to scene generation and video pre-Generate start-frame setup.

Update 2026-06-18 element existence dependency proof:
Scene generation depends on Higgsfield project Elements actually existing; this is a hard dependency, not a quick diagnostic. Restored/resumed element verification and post-setup element proof now use `HiggsfieldElements.confirmExistingElements()` with a 60s active polling window. The confirmation opens the project Elements modal, scrapes visible cards, scrolls the modal/list, accumulates normalized names across scroll positions, and only proceeds when every expected element name is confirmed. Persisted modal proof is useful history but does not replace the live dependency check after restart. The restored-project path and scene-image stage start both run the 60s active overlay clearance after the Higgsfield project page/context is visible, before touching Elements/Cinema controls.

Update 2026-06-17 browser viewport fit:
Do not force the headed Higgsfield/Cinema Studio browser to `1920x1080` without checking the real desktop. On Windows DPI scaling, title bars/taskbars mean a hardcoded outer window can render partially off-screen, which then makes bottom/right controls visually clipped and x/y-based toolbar detection unreliable. `_ensureMinimumViewport()` must cap bounds to `screen.availWidth` / `screen.availHeight`, set `left: 0, top: 0`, log final inner/outer/bounds geometry, and verify composer controls after resize/scroll. Control-detection code should use x/y only after narrowing to the active composer/toolbar context.

Update 2026-06-17 Seedance overlay + visible composer proof:
Cinema Studio can show Seedance promo overlays (`30 Days Unlimited Seedance`, `Switch to Seedance`, `Try Seedance`) over the composer. These overlays must be closed before toolbar/reference interaction; Escape alone may not clear the smaller lower-right promo. Also, Higgsfield may keep hidden stale `[role="textbox"]` nodes at `0x0` while the real visible composer is present. Composer/proof logic must choose a visible nonzero textbox or visible `Describe the scene...` composer surface, preferably semantic textbox first, and only then anchor reference `+` clicks and picker validation. A picker that shows `Uploads` / `Upload media` is valid even if hidden stale textbox nodes still exist elsewhere in the DOM.

Update 2026-06-17 Seedance + AI Director overlay variants:
Higgsfield can stack newer blockers over Cinema Studio 3.5: a right-side `AI Director` drawer (`How can i help you today?`), a `Chats` drawer (`No messages yet. Say something!`, `Close chat`), and Seedance promo cards inside/over the right side (`SWITCH TO SEEDANCE`, `Try Seedance`, `Better quality generations`) or lower-right composer area (`TRY UNLIMITED`, `Get unlimited access to the most powerful video model`, `Try Unlimited Seedance`). It can also show a full-screen Seedance offer modal with dark blurred backdrop (`30 DAYS UNLIMITED SEEDANCE`, `Get Unlimited Access Offer`). Dismiss by matching these specific texts first, then clicking only the close/X control inside that same container. Never click CTA buttons like `Try Seedance`, `Try Unlimited Seedance`, or `Get Unlimited Access Offer`. The thin top banner (`UNLOCK 30 DAYS OF UNLIMITED SEEDANCE`) is harmless, has no close control, and must not be treated as a blocking overlay. Run this targeted dismissal before video setup controls, start-frame/reference picker opening, element eligibility picker opening, prompt textbox focus, and Generate click-point preflight. Add a short render-settle wait before scanning because these promos can appear a beat after the composer loads, then wait again after each close before continuing. Pipeline actions must only proceed after a final blocker scan returns clean and a final render-settle wait completes. Close all layers before proceeding: Seedance cards/modal first when present, then side drawers such as `AI Director` or `Chats`, because drawers change control rendering and can keep composer/toolbar geometry shifted even after a promo card is gone. Do not hold during API preflight or before the browser is visible; the 60-second overlay-clearance hold starts only after the Higgsfield project page has been opened/navigated, before the next Elements/Cinema control action. During that hold the automation actively sweeps and closes overlays repeatedly, then resumes pipeline actions only after the hold window elapses.

Update 2026-06-17 Cinema Studio 3.5 video setup:
The in-project Video composer defaults to `Cinema Studio 3.5 Auto 1080p 8s 1/4 Off`. The automation must explicitly set duration with the slider (`8s` to `15s`), resolution via the `480p/720p/1080p` menu, aspect via the `Auto/1:1/3:4/9:16/4:3/16:9/21:9` menu, and audio from `Off` to `On`. The Style panel currently reports `Style Settings` plus `Manual Style · Off`; avoid exact separator matching because encoding can vary. The Camera panel reports section labels on separate lines (`CAMERA`, `LENS`, `APERTURE`) followed by `Auto`, so confirmation must tolerate newline-separated labels. The Video `+` opens the media picker with `Uploads`, `Image Generations`, `Video Generations`, `Upload media`, and eligibility checks; the adjacent `@` opens the Elements picker.
Update 2026-06-23 protected-reference element rebuild archive guard:
Protected-reference element refresh must rebuild Higgsfield elements from active/current local assets only. Archived Face/IP recast rows can keep the same `element_name` as the current character/outfit, so repair-spec lookup must ignore `status = archived` rows and reject any file path under `.archive`. Archive rows may be used only as metadata hints to infer the character/outfit key; they must never provide the portrait/grid image sent to Higgsfield. For SCWOB, Barrister Tunde current rebuild sources are the main files (`assets/portraits/portrait_character_4.png` and `assets/grids/character_4_o1/o2/o3_grid.png`), while older `.archive/*faceip_recast*` rows are failed eligibility history.
Update 2026-06-23 protected-reference element refresh bubble:
Protected-reference Generate blocks in Cinema Studio video should enter a persisted, isolated element-refresh bubble before any further video setup. The bubble resumes from `_cinemaProtectedReferenceRebuild`, checks that the Higgsfield session is alive and waits for login/resume if needed, deletes/proves absent all managed elements first, then recreates all managed elements with the same names, then re-runs eligibility. For element-management work inside this bubble, use the top project `@`/`Elements` modal helper first; the bottom composer `@` beside the reference `+` is visually elusive and should be fallback only. This project Elements modal is valid for delete, recreate, modal proof, and eligibility card checks; it is not a substitute for real prompt mention resolution before Generate. Close the Elements modal with its visible top-right X before any retry; do not rely on click-away because the grid behind the controls can play/select videos. A single picker/open/delete UI miss should retry the same element with page refresh before failing the bubble, and transient picker failures should not consume the protected-reference rebuild attempt counter. If delete/create/proof already completed and only the eligibility checker failed with transient picker errors such as `Composer @ element button not found`, resume at eligibility checking rather than deleting/recreating all elements again. SCWOB data fix on 2026-06-23 moved `_cinemaProtectedReferenceRebuild` from stale `create-all-pending` to `eligibility-pending` with 19 recreated/proven names, preserving `attempts = 1/2`.
Follow-up 2026-06-23: eligibility-only resume must enter the same protected-reference browser bubble before `confirmExistingElements()`; otherwise `automation.page` can be null and modal proof can falsely report every element as missing. Treat modal-open failures such as `Cannot read properties of null (reading 'evaluate')` as transient UI and pause without falling into delete-all. If a restart already caused a partial delete after proof, recreate only the missing element(s) from active local portrait/grid assets, then re-run modal proof and eligibility. SCWOB data fix after the partial delete moved `_cinemaProtectedReferenceRebuild` back to `eligibility-pending`, kept `attempts = 2/2`, and marked only `@alhaja_ronke_o1_scwob_0615` for missing-only recreate; backup: `nollywood-pipeline_pre_protected_ref_missing_only_2026-06-23T21-39-45-898Z.sqlite`.
