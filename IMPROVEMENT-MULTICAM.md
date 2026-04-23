# Improvement Exploration: Multi-Cam Sequences Per Scene

> Status: design doc, no code yet. Captures the feature, the scope, and the decisions needed before implementation. Multi-cam is planned as an **opt-in feature flag** — not a pipeline rewrite.

## TL;DR

Current MVP output is visually static: every line of dialogue = one wide shot. Multi-cam adds camera variety (close-up, OTS, reaction) by letting Claude emit multiple shorter lines per story beat instead of one long line.

**Isolation strategy:** multi-cam is a project-level mode selected after research. Standard and multi-cam coexist. ~90% of the pipeline is identical between modes.

## Motivation

Watching the current 2-min MVP output feels like a slideshow of tableaux. Every clip is a 24-35mm wide shot. Same framing, 18 times in a row.

Real cinema uses **coverage**: establishing wide → over-the-shoulder → close-up → reaction shot. Each shot does different work:

- **Wide:** establishes space + character positions
- **Medium:** narrative focus, mid-expression
- **Close-up:** emotional beat, micro-expression, tension
- **Over-the-shoulder (OTS):** conversational rhythm, "who's speaking to whom"
- **Reaction shot:** cuts to listener's response
- **Insert / cutaway:** detail shot (hands, admission form, object)

Nano Banana Pro + Veo 3.1 Lite can produce all of these. We just haven't asked for them.

## User-Facing Design

### Mode picker — a new gate after research approval

```
Research → Research-approved → [MODE PICKER] → Title → Script → Portraits → ...
                                    ↑
                      User picks once per project:
                      Standard | Multi-cam
```

UI mockup:

```
┌─────────────────────────────────────────┐
│         Choose production style          │
├─────────────────────────────────────────┤
│                                          │
│  ◉ Standard                             │
│     One shot per line. Simpler, cheaper,│
│     proven. ~216 credits for 2-min.     │
│                                          │
│  ○ Multi-cam (experimental)             │
│     2-3 shots per line, dynamic camera  │
│     angles. More cinematic but ~2x      │
│     credits. ~432 credits for 2-min.    │
│                                          │
│                  [ Continue ]            │
└─────────────────────────────────────────┘
```

Default: Standard. "Experimental" label on Multi-cam until we have enough test data.

### Why AFTER research (not at project creation)

- Research (YouTube scrape + Gemini analysis) is 100% mode-agnostic
- User has seen the story patterns that emerged → can judge whether the source is dialogue-heavy (multi-cam wins) or action-heavy (standard suffices)
- Keeps project creation simple — no toggle when you haven't even searched yet

## Data Model

One column on the `projects` table:

```sql
-- In a new migration (006-multicam-mode.sql)
ALTER TABLE projects ADD COLUMN script_mode TEXT DEFAULT 'standard';
-- Valid values: 'standard' | 'multi-cam'
```

Every downstream decision reads this single field. No new tables, no new asset types.

## What's Shared vs Forked

### Fully shared (zero code change)

- Research scraper + Gemini analyzer
- Research approval gate
- Title generation + approval
- Portrait generation (per character, identical)
- Portrait approval gate
- Video clip generation module (Veo API call is identical; multi-cam just issues more of them)
- Scene approval gate
- Video clip approval gate
- Verify Clip backend — Gemini/Whisper verification works on any clip
- Assembly — concat in chapter/line order, agnostic to shot type
- Auto-retry, ad dismissal, context recreation, page-state recovery — all downstream of mode
- All DB helpers for assets
- All error-recovery scripts (wipe, redo-videos, reopen-project, status-check)

### Mode picker (new, small)

- New approval gate between `research-done` and title generation
- `script_mode` persisted to DB
- New IPC handler `set-script-mode(mode)`
- Small renderer view for the choice

### Forked (mode-specific logic, minor)

1. **Script prompt template.** Two files:
   - `prompts/script-prompt-standard.txt` (current, renamed)
   - `prompts/script-prompt-multicam.txt` (new — multi-cam output format)
   - Orchestrator reads `script_mode` and selects template

2. **Scene image reference chain.** `stageSceneReferences()` reads `script_mode`:
   - Standard: linear (line N → references line N-1 image)
   - Multi-cam: branching (close-ups/reactions re-anchor to the scene's establishing wide, not the immediately previous close-up)

3. **Verify Clip silent-reaction handling.** `ClipVerifier._tierForScore()`:
   - If a line's expected dialogue is `""` or `"[silent]"`, invert the silent→reject rule. A silent reaction is EXPECTED, so silent detection should auto-accept it. Dialogue in a silent-expected clip = reject (Veo hallucinated words).

## What Multi-Cam Actually Emits

### The format, concretely

Claude in multi-cam mode emits **more lines per scene**, each with its own dialogue fragment + shot metadata. Same story, more cuts.

### Example: one scene, both modes

**Scene setup:** Chief confronts Bush Girl in the compound. 3 story beats.

#### Standard mode (current) — 3 lines, 3 wide shots

```
Scene 3, Line 1: Bush Girl   "My hands filled this. My name is on it."
Scene 3, Line 2: Chief       "Bush girl. Going to university. God forbid!"
Scene 3, Line 3: Bush Girl   "Chief signed this form. I came to confirm."

→ 3 clips × 8s = 24s total, ~36 credits
→ Visual: 3 near-identical wide shots, only difference is who's speaking
```

#### Multi-cam mode — 7 lines, varied shots

```
Scene 3, Line 1: Bush Girl   "My hands filled this."           [WIDE establishing]
Scene 3, Line 2: Bush Girl   "My name is on it."                [CLOSE-UP on Bush Girl]
Scene 3, Line 3: Chief       "Bush girl."                       [OTS — over Bush Girl's shoulder]
Scene 3, Line 4: Chief       "Going to university."             [CLOSE-UP on Chief]
Scene 3, Line 5: Chief       "God forbid!"                      [MEDIUM on Chief, hand raised]
Scene 3, Line 6: [silent]    ""                                 [REACTION — Bush Girl's eyes]
Scene 3, Line 7: Bush Girl   "Chief signed this form. I came to confirm." [MEDIUM on Bush Girl]

→ 7 clips × 4-8s = ~34s total, ~84 credits
→ Visual: 7 varied shots, clear cinematic rhythm
```

Same 3 story beats, same dialogue, split at clause boundaries. Plus one silent reaction beat (new) and one establishing wide per scene (new).

### Image reference chain, visualized

**Standard:**
```
portraits: [Chief] [BushGirl]
              ↓
Scene 3 L1 ← [Chief, BushGirl] + Scene 2 L[last]
Scene 3 L2 ← [Chief, BushGirl] + Scene 3 L1
Scene 3 L3 ← [Chief, BushGirl] + Scene 3 L2
```

Linear: each line references the previous line's image.

**Multi-cam:**
```
portraits: [Chief] [BushGirl]
              ↓
Scene 3 L1 ← [Chief, BushGirl] + Scene 2 L[last]   ← WIDE (scene anchor)
Scene 3 L2 ← [BushGirl] + Scene 3 L1               ← close-up, re-anchors to wide
Scene 3 L3 ← [Chief]    + Scene 3 L1               ← OTS, re-anchors to wide
Scene 3 L4 ← [Chief]    + Scene 3 L3               ← close-up, chains from OTS
Scene 3 L5 ← [Chief]    + Scene 3 L4               ← medium, chains from close-up
Scene 3 L6 ← [BushGirl] + Scene 3 L1               ← reaction, re-anchors to wide
Scene 3 L7 ← [BushGirl] + Scene 3 L6               ← medium, chains from reaction
```

Branching: tight shots re-anchor to the scene's wide (Line 1) so location/lighting stay consistent even across camera cuts. Character portraits still appear in the ref stack for identity anchoring.

## Shot Type Taxonomy

Six values:

| Shot Type | Lens | Use |
|---|---|---|
| `wide` | 24-35mm | Scene establishing, group compositions |
| `medium` | 50mm | Default narrative shot, mid-expression |
| `close-up` | 85mm | Emotional beats, micro-expression |
| `ots-speaker` | 50mm | Over listener's shoulder, speaker's face |
| `ots-listener` | 50mm | Over speaker's shoulder, listener's reaction |
| `reaction` | 85mm | Silent cutaway to listener's face |

`insert` (prop shots) deferred to later — requires scene-level prop catalog in script.

## Cadence Rules (Prompt Constraints)

The multi-cam prompt MUST tell Claude:

1. **First line of every scene is `wide`.** Establishes space and character positions.
2. **No more than 2 consecutive `close-up` shots.** Cut wider at least every 3rd line.
3. **At least one `medium` or wider shot before the scene ends.** Spatial re-anchoring.
4. **Reaction shots are punctuation, not dominant.** ~1 per scene, at emotional peaks only.
5. **Dialogue splits at clause boundaries.** Natural speech beats — "." or ", " or ";" — not mid-word.
6. **Silent reactions count as lines.** Emit `dialogue: ""` with shot_type: reaction and an animation_prompt describing the held expression.

## Open Decisions Before Implementation

1. **Preset semantics in multi-cam mode.** Does "2-min preset" mean:
   - (a) 18 standard lines = ~36 multi-cam lines = ~3-4 min actual output? OR
   - (b) Same 2-min output duration, ~18 multi-cam lines (shorter dialogue per line)?
   - **Recommendation:** (b) — keep preset = output duration. Claude budgets dialogue to fit. User expectation: "2-min movie = 2 min of watching."

2. **Minimum Veo clip duration.** Veo 3.1 Lite floor is 4s. Silent reactions with "[silent]" prompt still produce 4s. Accept the 4s-minimum overhead on short shots?
   - **Recommendation:** Yes. A 4s reaction with 2s of dialogue + 2s of held expression looks fine cinematically. No trimming in assembly.

3. **Silent reaction detection in Verify Clip.** How do we tell the verifier "this clip is supposed to be silent"?
   - Option A: `expected_dialogue = ""` in DB → ClipVerifier sees empty, knows to expect silent.
   - Option B: `expected_dialogue = "[silent]"` sentinel string.
   - **Recommendation:** Option A (empty string). Cleaner, matches what the script emits.

4. **Dedup prompt collision.** Two `close-up` shots on the same character with similar framing might hash-dedup. `findExistingGeneration()` checks prompt hash.
   - **Recommendation:** Include shot_type + line_number in the prompt hash input. Each line is unique by (prompt text + shot_type + line_number), collisions avoided.

5. **Script length vs budget.** Multi-cam scripts are ~2x tokens. At current Claude token budget (16384 max), 10-min scripts might approach the limit.
   - **Recommendation:** Start with 1-min and 2-min presets only for multi-cam. Gate 5-min and 10-min behind a "test first" warning. Revisit when we have real script length data.

## Implementation Sketch (when we decide to ship)

Rough order, each step independently testable:

1. **Migration 006** — add `script_mode` column. Default 'standard'. Zero behavior change.
2. **DB helper** — `setScriptMode(projectId, mode)` + `getScriptMode(projectId)`.
3. **IPC + preload** — `set-script-mode` handler + preload exposure.
4. **Renderer** — mode picker view between research approval and title generation. No-op if mode already set (resume case).
5. **Orchestrator** — new stage between `research-done` and title-gen: `await waitForApproval('script-mode')`. Reads `script_mode` and persists it.
6. **Script prompt fork** — copy current prompt → `script-prompt-standard.txt`. Write new `script-prompt-multicam.txt` with multi-line-per-scene format, shot_type field per line, silent-reaction allowance. Orchestrator picks based on mode.
7. **Scene gen fork** — `stageSceneReferences()` reads mode. If multi-cam, implement branching ref chain (close-ups ref scene wide, not previous line).
8. **ClipVerifier fork** — silent-reaction tier handling (`expected_dialogue === "" → silent is expected → accept/reject rules invert`).
9. **Test on 1-min preset** — iterate on prompt template until shot rhythm feels right.
10. **Document** — update CLAUDE.md with new stage + mode column.

Each step is small, reversible, and doesn't affect the standard path.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Multi-cam credit cost surprises user | 2x Veo credits | Mode picker shows credit estimate for both modes BEFORE commit |
| Veo close-up mouth-sync worse than wide | Bad output, more redos | Verify Clip catches it. Auto-retry loop handles it. Human review in Verify tab |
| Nano Banana drifts face identity on close-ups | Wrong character in close-up | Portrait stays in ref stack. 85mm crops test well; 135mm may need tuning |
| Script prompt produces shot-type soup (all close-ups) | Boring output, wrong rhythm | Cadence rules in prompt. Cap consecutive close-ups. Require wide per scene |
| Mode picker confuses users | Wrong mode selected by accident | Default = Standard. Multi-cam is opt-in. Clear credit comparison in the picker |
| Resume of a multi-cam project in wrong mode | Pipeline generates wrong script format | `script_mode` persisted to DB; orchestrator reads it on resume |
| Silent reactions trigger Verify reject | False negatives | Special-case empty expected_dialogue in `_tierForScore` |

## What This ISN'T

- Not a pipeline rewrite. ~90% of the code is unchanged.
- Not a default behavior change. Standard stays the default until multi-cam is battle-tested.
- Not a requirement for existing projects. They continue to run Standard.
- Not a schema migration for existing assets. `script_mode` is a project-level field; asset rows don't need to know.
- Not a blocker for any current feature work. Ship MVP stability improvements + Verify Clip refinements first.

## Success Metrics (when we eventually ship)

1. **Visual quality** — blind A/B: does the multi-cam 1-min feel more cinematic than the standard 1-min?
2. **Credit efficiency** — does the 2x credit cost translate to >2x perceived quality?
3. **Verify Clip precision** — does the verifier handle silent-reaction clips without false rejects?
4. **Pipeline stability** — does multi-cam trigger any bugs that standard doesn't?

If any of these fail, Multi-cam stays experimental indefinitely; Standard remains the default. No harm done — that's the point of isolation.

## Dependencies

None blocking. This builds on top of the current shipped pipeline:
- Uses existing Verify Clip feature (needs silent-reaction extension)
- Uses existing scene image gen (needs ref chain variant)
- Uses existing video gen, approval gates, assembly
- Uses existing error recovery and auto-retry

When we're ready, it's an additive feature, not a migration.
