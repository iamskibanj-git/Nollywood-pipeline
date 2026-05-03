# Session 30N-B Continuation Prompt

Paste this into a fresh conversation to continue the prestige tier implementation.

---

## Prompt

This is the Nollywood AI Video Pipeline (Electron app). Read `CLAUDE.md` for full project context — specifically the **"Prestige Tier — 45-Minute Duration"** section (added in Session 30N-A) for the complete design, risk mitigations, and implementation plan.

**Session 30N-A is committed.** It added:
- 45min presets to orchestrator.js (`DURATION_PRESETS`, `CINEMATIC_DURATION_PRESETS`, `getDurationTier`, `TIER_PRESTIGE` constant, R4 grader catch fix)
- Five-act prestige scaffolding in `script-engine.js` `_buildStructuralScaffolding` (lines ~1895-1972) and prestige cinematic constraints in `_buildCinematicScaffolding`
- Prestige grading rubric in `prompts/structure-review-prompt.txt`
- Prestige threshold 80/85 + grader `max_tokens` 16384 + skeleton compression in `reviewScriptStructure`
- 45min option in all 3 renderer UI dropdowns + both preset structure objects

**Session B tasks (you are implementing these now):**

### Task 13: Two-phase outline generation for prestige tier

The current `_generateStoryDriven()` method (script-engine.js, lines ~363-636) does a single Pass 1 (outline) + per-chapter Pass 2. For prestige (15 chapters), the Pass 1 outline output can exceed the `max_tokens` ceiling and get truncated.

**Implementation — split Pass 1 into Phase A1 + Phase A2:**

1. **Phase A1** (new): Generate the **arc skeleton only** — character bible, five-act beat structure (act-level plot points, not scene-level), relationship arcs, setup/payoff pairs, B-plot summaries, thematic thesis. Output target ~5K tokens. This is the story bible.

2. **Phase A2** (new): Generate detailed chapter outlines **in batches of 5** (3 calls for 15 chapters), using the Phase A1 arc skeleton as fixed context. Each batch outputs ~5K tokens of scene beats, emotional temperatures, power dynamics, target clips — the same fields as the current outline's `chapter_outlines[]`.

3. **Phase B** (existing Pass 2, modified): Generate each chapter independently using the **combined A1+A2 outline** as context, plus voice anchors (Task 14).

**Gate the two-phase path on `tier === 'prestige'`**. Non-prestige story-driven generation continues using the current single-outline Pass 1 unchanged.

**Key code locations to read first:**
- `_generateStoryDriven()` — lines 363-636 (current implementation, your starting point)
- The outline prompt (lines 374-465) — understand the schema Claude returns
- The chapter prompt (lines 523-600) — understand what context each chapter call gets
- `_calculateBatchPlan()` — grep for it, understand how batching works

### Task 14: Voice anchors in chapter generation

After Phase A (outline complete, whether single-pass or two-phase), extract:
- 2-3 **signature phrases** per major character from `character_bible[].speech_notes` + `speech_style`
- A **TONE_BASELINE** (1-2 sentences) derived from the outline's emotional temperatures and the story concept

Inject these as a `VOICE_ANCHORS` block into every Phase B/Pass 2 chapter prompt. Insert it after the `=== CHARACTER BIBLE ===` section and before `=== FULL STORY OUTLINE ===`.

This is ~200-400 tokens per call. The goal is preventing voice drift across 12-15 independent chapter calls — characters maintaining their speech patterns, verbal tics, and cultural register throughout.

**Voice anchors benefit ALL story-driven scripts (not just prestige)** — so implement them unconditionally for story-driven mode, not gated behind prestige.

### Task 16: Update CLAUDE.md

The prestige tier section in CLAUDE.md currently says "Status: Design complete... Not yet built." Update it to reflect that Session A (wiring) and Session B (engine) are complete. Add final implementation details: actual line numbers for the two-phase code, voice anchor format, any gotchas discovered during implementation.

### Task 17: Validation

- Verify `node -c` on all changed .js files (NOTE: the bash sandbox has a known NTFS mount sync issue — it may see stale file versions. If `node -c` fails with "Unexpected end of input" at a line that doesn't match the file's actual length via the Read tool, that's the sync issue, not a real syntax error. Document this.)
- Grep for the string `'prestige'` across the entire codebase to verify no typos or missing references
- Verify `_buildStructuralScaffolding('long-form', 8, {})` still returns long-form content (not prestige) — the R5 mitigation
- Dry-run token estimation: calculate input token budget for a 45min cinematic prestige run (Phase A1 input, Phase A2 batch input, Phase B chapter input, grader skeleton input)
- Prepare commit script `commit-session30N-prestige-B.ps1`

### Important notes:
- The orchestrator catch block at ~line 1255 (after Session A edits) uses `TIER_PRESTIGE` constant — if script-engine.js needs to reference it, import from orchestrator's exports
- The five-act `actBreaks` calculation in the scaffolding (lines ~1897-1901) uses 20/40/60/80% splits — the Phase A1 arc skeleton should use the same act boundaries
- Bash `node -c` may fail due to NTFS sync — use the Read tool as source of truth for file completeness
