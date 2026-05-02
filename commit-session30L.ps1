Set-Location $PSScriptRoot
if (Test-Path ".git\index.lock") { Remove-Item ".git\index.lock" -Force }

$msg = @"
Session 30L: Shorts planner rework + 3-phase flow + persistence + bugfixes

Shorts planner — real ffprobe durations + calendar-aware grouping:
- _probeClipDurations(): ffprobe every clip before planning (fallback chain)
- Calendar-driven: total duration / calendar days = target per short (30-90s)
- Posts/day computed automatically (total shorts / calendar days)
- Start date = tomorrow (never today), or day after last scheduled short
- Calendar days defaults to remaining days in current month
- Stats: totalClips, totalDuration, totalShorts, targetPerShort, postsPerDay

Shorts tab — 3-phase persistent flow:
- Plan Calendar: probes durations, fills table, saves to DB (status=planned)
  Plan survives app restarts — no more lost work on close.
- Assemble + SEO: reads planned shorts from DB, FFmpeg + Claude API batch
  Updates each row to assembled/seo_done. Resumable.
- Upload: Playwright schedules seo_done shorts on Facebook one at a time.
- savePlan(), updateShortAssembled(), getPlannedShorts() DB methods
- IPC: shorts:planCalendar (plan-only), shorts:assemble (FFmpeg+SEO)

Shorts eligibility fix:
- getEligibleProjects() now clip-based, not completed_at-based
  Projects at publish gate with clips assembled now show up
- Subquery pattern avoids HAVING-without-GROUP-BY SQL error

DB module fixes:
- Exported queryAll, queryOne, runSql from db.js
- ShortsScheduler + ShortsController use db singleton import
  (was broken: this.db.queryAll is not a function)

Pipeline lifecycle:
- completeProject() moved to after assembly (before publish)
  Assembly = end of production. Publish/shorts = distribution.

Aspect ratio threading (30k completion):
- Orchestrator passes project.aspect_ratio to ThumbnailGenerator
  All 3 stages (key art, title card, composite) respect project aspect

CLAUDE.md: Session 30L summary
"@

git add -A
git commit -m $msg
Write-Host "`nDone." -ForegroundColor Green
