# Nollywood AI Pipeline - Setup Guide

## Prerequisites

1. **Node.js 18+** - Download from https://nodejs.org
2. **FFmpeg** - Download from https://ffmpeg.org/download.html
   - Windows: extract to `C:\ffmpeg\bin\` or add to your system PATH
   - Linux/Mac: install via your package manager (`brew install ffmpeg` / `apt install ffmpeg`)
3. **Claude API Key** - Get from https://console.anthropic.com
4. **Gemini API Key** (recommended) - Get from https://aistudio.google.com/apikey
   - Powers the YouTube video analysis in the Research stage
   - Without it, the app falls back to browser-based Google AI Studio (slower, requires you to be logged in)
5. **Higgsfield AI Account** - Sign up at https://higgsfield.ai
   - Image generation uses Nano Banana Pro (free with Unlimited mode)
   - Video generation uses Veo 3.1 Lite (12 credits per 8s clip — budget ~1032 credits per full movie)

## Installation

Open a terminal in this directory and run:

```bash
npm run setup
```

This installs all dependencies and downloads the Playwright Chromium browser used for Higgsfield automation.

## First Run

```bash
npm start
```

### On First Launch:

1. Click **Settings** (gear icon, top-right)
2. Paste your **Claude API key**
3. Paste your **Gemini API key** (optional but recommended — speeds up research 10x)
4. Choose a **Projects directory** (where generated assets and final videos are saved)
5. Click **Save**
6. Click **Test API Keys** to verify both connections show green checkmarks

### Before Running a Story:

1. The right panel shows a built-in browser view
2. **Log into Higgsfield AI** in that browser panel — your session cookies persist between runs. If a session expires mid-generation, the pipeline pauses and shows a Resume button. Log in again in the browser panel, then click Resume — your cookies are automatically synced to the automation engine.
3. If using Gemini browser mode (no API key), also log into **Google AI Studio**

## How the Pipeline Works

This is a **research-first** pipeline — no manual story concept is needed. The app discovers what's working on YouTube and generates original content informed by market data.

### Starting a Run

The launcher adapts to your current state:

- **Research pool available**: A large green card appears showing how many source videos are unused. Pick a duration from the dropdown embedded in the card, then click anywhere on the card to begin. A "Start Fresh Research Instead" option sits below if you want to discard the pool and search again.
- **No pool / pool exhausted**: A "Ready to Create" card appears. Pick a duration and click **Start Research** to fetch fresh YouTube trends.
- **Story in progress**: A "Continue: [Title]" card appears showing your current stage and asset progress. Click it to resume exactly where you left off.

The app auto-calculates the story structure based on your duration choice:
- 5 min: 3 chapters x 3 scenes x 5 lines = 45 clips (~540 credits)
- 10 min: 6 chapters x 3 scenes x 5 lines = 90 clips (~1080 credits)

### Pipeline Stages

| # | Stage | What Happens | Time | Approval? |
|---|-------|-------------|------|-----------|
| 0 | Pre-flight | Pings Claude + Gemini APIs, fails fast if keys are invalid | ~5s | No |
| 1 | Research | YouTube search for top AI Nollywood content + Gemini analysis of winning patterns | 2-5 min | Yes |
| 2 | Script | Research-informed title candidates + full screenplay with character bible | 1-3 min | Yes (title + script) |
| 3a | Portraits | Character reference sheets via Nano Banana Pro (Unlimited mode) | ~30s/char | Yes |
| 3b | Scenes | Scene images with reference chaining (character portraits + previous scene) | ~30s/image | Yes |
| 4 | Video | Veo 3.1 Lite clips with start-frame + animation prompt + dialogue audio | ~90s/clip | Yes |
| 5 | Assembly | FFmpeg: trim dead frames → branding card insertion → concat → 4K upscale | 5-15 min | No (automatic) |

### Stage Details

**Research**: The app searches YouTube with queries like "AI Nollywood movie", "AI African drama full movie", etc. It uses a two-pool architecture — AI originals (filtered by AI keyword in title, 10k+ views) and remake candidates (traditional Nollywood hits, 500k+ views). Gemini analyzes up to 10 videos (interleaved from both pools) to build a pattern library of recurring themes, winning archetypes, title formulas, and audience triggers. Tone and setting are automatically derived from these patterns. Review the findings, then click **Use Research & Generate Script** or **Skip Research**. The pattern library is cached for 7 days and supports unlimited stories — each time, Claude picks a different combination of themes and the title dedup system ensures no two stories are too similar.

**Script**: A 4-layer copyright protection system ensures all generated content is original — research patterns are sanitized to abstract genre guidance before reaching Claude, generated titles are checked for similarity to source titles, and prompt guardrails prohibit reproducing existing plots or characters. Claude generates 3 title candidates informed by research patterns. Titles already produced (tracked via deduplication) are flagged. After you approve a title, Claude generates the full script as structured JSON: a character bible with hyper-detailed physical descriptions, image prompts for every line, animation prompts, and dialogue following the 9-word-max rule.

**Portraits & Scenes**: The Playwright browser automates Higgsfield's image generator. Portraits are generated first (no references needed). Scene images chain references — each image uses the character portraits of characters present in that scene plus the previous scene image for visual consistency. On location changes, the chain resets.

**Video**: Each scene image becomes a start frame for a Veo 3.1 Lite video clip. The animation prompt explicitly names the speaking character for lip-sync and silences non-speaking characters ("mouth CLOSED, no lip movement") to prevent Veo's tendency to mis-assign dialogue. Audio is enabled by default. Duration is set to 8 seconds at 720p in 16:9.

**Assembly**: FFmpeg trims 0.3s of dead frames from each clip start, inserts the channel branding card (`config/branding.fw.png`) as a 3-second clip at the intro, every ~1.5 minutes, and as an outro, then concatenates everything using the concat demuxer and upscales to 4K (lanczos). Dialogue subtitles are NOT baked in — YouTube and Facebook auto-generate captions from the Veo audio track. The final video lands in the project's `output/` folder.

## Project Persistence & Crash Recovery

All project state is stored in a local SQLite database — your progress is safe even if the app crashes mid-generation.

- **Resume on reopen**: If you close the app (or it crashes) during any stage, the launcher shows a "Continue: [Your Title]" button that picks up exactly where you left off. No work is lost.
- **Asset-level tracking**: Every portrait, scene image, and video clip is tracked individually. If the app crashes after generating 20 of 45 video clips, it resumes at clip 21 — not from scratch.
- **No abandon**: Once a story is started (title chosen), it stays in progress until assembly completes. The research pool is locked to that story. If credits run out, just come back when they reset and hit Continue.
- **Pool releases on completion**: The source video is only marked "used" after the final video is assembled and exported.
- **Graceful shutdown**: Closing the app via the X button, Ctrl+C in the terminal, or a system kill signal all trigger a clean shutdown — the pipeline is cancelled, any mid-generation assets are reset to "pending" for retry, Higgsfield session cookies are saved, and the database is flushed to disk.
- **Close confirmation**: If the pipeline is actively running when you click X, a dialog asks if you're sure. Either way, your progress is safe.
- **Corruption protection**: Database writes use atomic file operations (write to temp, then rename). If the database file ever gets corrupted, the app backs it up and starts fresh.

## Controls

- **Pause/Resume**: Pause automation at any time without losing progress
- **Cancel**: Stop the pipeline entirely (progress is saved to database)
- **Toggle Browser**: Show/hide the Higgsfield browser monitoring panel
- **Click any generated image**: Flag it for regeneration

## Updating Higgsfield Selectors

If Higgsfield changes their UI and automation breaks:

1. Open `config/higgsfield-selectors.json`
2. Open Higgsfield AI in Chrome and press F12 (DevTools)
3. Right-click on each UI element and inspect it
4. Update the CSS selectors in the config file
5. Key differences to watch for:
   - Image page: prompt is a **contenteditable div**, settings are **native `<select>`** elements
   - Video page: prompt is a **textbox div**, settings are **button dropdowns** (not `<select>`)
   - Unlimited toggle (image only): `button[role="switch"]` — check `aria-checked` before toggling
6. Restart the app

## Credit Budget

Video generation is the only paid stage — Unlimited mode is not available on the video page.

| Duration | Portraits | Scene Images | Video Clips | Total Credits |
|----------|-----------|-------------|-------------|---------------|
| 5 min | Free (Unlimited) ×4-6 | Free (Unlimited) ×45 | 12 credits × 45 = 540 | ~540 |
| 10 min | Free (Unlimited) ×4-6 | Free (Unlimited) ×90 | 12 credits × 90 = 1080 | ~1080 |

Higgsfield Creator sub: 6000 credits/month, resets on the 15th. That's ~5 full movies or ~11 short movies per month.

## Troubleshooting

- **"Claude API key is invalid"**: Go to Settings, re-paste your key, click Test API Keys
- **"Cannot reach Claude API"**: Check your internet connection; the pre-flight check runs before any pipeline stage
- **"SESSION_EXPIRED"**: Log into Higgsfield in the browser panel, then click Resume
- **"FFmpeg not found"**: Install FFmpeg and add it to your system PATH
- **"GEMINI_LOGIN_REQUIRED"**: Either add a Gemini API key in Settings (recommended) or log into Google AI Studio in the browser
- **Script JSON truncated**: Rare at `max_tokens: 16384`, but if it happens the app automatically recovers via 6-strategy JSON repair (bracket closing, quote fixing, truncation to last complete element). Check logs for `[SCRIPT]` recovery messages
- **Images look inconsistent**: The reference image slots or selectors may need updating — see `config/higgsfield-selectors.json`
- **YouTube search returns 0 results**: This can happen with very niche queries. The pipeline falls back to title-only analysis if no videos qualify
- **Video generation slow**: Veo 3.1 Lite takes ~90s per clip. At 90 clips, expect ~2.25 hours for video generation

## Project Structure

```
nollywood-ai-pipeline/
  config/
    higgsfield-selectors.json   # UI selectors for Higgsfield automation
    branding.fw.png             # Channel branding card (16:9 transparent PNG)
  prompts/
    script-prompt.txt           # Master script generation prompt
    research-brief-prompt.txt   # Research-informed title generation prompt
  src/
    main/
      main.js                   # Electron entry point + IPC handlers
      automation/
        higgsfield.js           # Playwright browser automation
      assembly/
        assembler.js            # FFmpeg video assembly
      database/
        db.js                   # SQLite init, migrations, query helpers
        migrations/
          001-initial.sql       # Schema: projects, assets, cache, used videos
      pipeline/
        orchestrator.js         # Pipeline stage management + approval gates
        script-engine.js        # Claude script generation
      research/
        youtube-scraper.js      # YouTube search + two-pool extraction
        gemini-analyzer.js      # Gemini video/title analysis
    preload/
      preload.js                # IPC bridge (renderer ↔ main)
    renderer/
      index.html                # Dashboard UI
  CLAUDE.md                     # Project knowledge for AI sessions (architecture, gotchas, decisions)
  SETUP.md                      # This file
  TESTING-RESULTS.md            # Operational findings from live testing
  package.json
```
