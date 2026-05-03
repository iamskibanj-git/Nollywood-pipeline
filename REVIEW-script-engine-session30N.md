# Script Engine Review — Session 30N

**File:** `src/main/pipeline/script-engine.js` (2270 lines → 2302 after fixes)
**Scope:** All Claude API integration — title generation, screenplay generation, JSON parsing, structural grading

---

## CRITICAL (Fixed — 5 issues)

### 1. `_closeUnclosedBrackets` closed in wrong order
The old code counted `{` and `[` separately, then always appended `]` before `}`. For truncated JSON like `{"chapters": [{"scenes": [` this produces `]}]}` — wrong. The nesting requires `]]}}`. **Fixed:** Rewrote to use an ordered nesting stack that closes in correct reverse order.

### 2. `_fixUnescapedQuotes` treated newlines as non-boundary
The lookahead checked if the next non-whitespace char was `:,}]`. But `\n` is a whitespace char that gets trimmed, and JSON string values DO end before newlines in formatted output. When a quote appeared at end-of-line, the code treated it as an "inner quote" and escaped it (`\"`), corrupting valid JSON. **Fixed:** Added `\n\r` to the boundary character set.

### 3. `reviewScriptStructure` silently auto-passed on grader failure
Both the "no JSON found" and "parse error" catch blocks returned `{ score: 65, pass: true }`. A malformed grader response — which could mean the script is genuinely terrible and the grader produced an oversized critical response that got truncated — would silently pass the quality gate. This defeats the entire purpose of structural review. **Fixed:** Both paths now return `{ score: 0, pass: false }` with a `grader_error` critical issue. The user can still override manually.

### 4. `_sanitizeKlingClipPrompts` fix #3 added `@` inside dialogue quotes
The bare-name prefixer was supposed to "not add @ inside dialogue quotes" (per the inline comment) but the code didn't actually check whether a match was inside quotes. This produced `@character_name` inside spoken dialogue, which triggers Higgsfield element resolution and corrupts the audio. Fix #4 partially cleaned this up, but the ordering meant unnecessary work and potential edge-case leaks. **Fixed:** Added `dialogueRanges` detection — the prefixer now skips any match position that falls inside a `]: "..."` block.

### 5. `_sanitizeKlingClipPrompts` fix #6 regex state corruption
The dual-speaker strip used `exec()` with a `g`-flag regex in a while loop, but modified the source `prompt` string inside the loop via `.replace()`. Modifying the string that a stateful regex is iterating over shifts `lastIndex`, causing skipped matches or double-matches. **Fixed:** Collect all replacements into an array first, then apply them after the loop exits.

---

## MEDIUM (Not fixed — design-level; noted for future sessions)

### 6. `onProgress` callback receives full accumulated text, not deltas
`_streamWithRetry` calls `onProgress(text)` where `text` is the *entire* response accumulated so far. For a 120K-token script, this means the UI callback receives 120K chars on every single delta event. Not a data bug, but a performance concern — the renderer re-processes the full string thousands of times. **Recommendation:** Pass only the delta to `onProgress`, or add a throttle (e.g., only call every 500ms).

### 7. Carry-forward context growth is unbounded
`_generateCarryForward` compresses previous chapters (strips image_prompts) but still passes the full compressed JSON of all prior chapters. For a 10-chapter cinematic script, by batch 5 the input is ~30-40K tokens of compressed prior chapters. The two-pass story-driven approach correctly solves this. **Recommendation:** Consider switching ALL iterative generation to two-pass, not just story-driven cinematic.

### 8. Title generation JSON parsing has no recovery
`generateTitles()` (line 106-114) does a single `JSON.parse` with only a regex extract fallback. Unlike script generation which has 6-strategy `_safeParseScriptJson`, title parsing just returns a fallback title from the concept. **Recommendation:** At minimum add trailing-comma and bracket-closing recovery.

### 9. `_truncateToLastComplete` depth threshold is heuristic
The function considers completion points at depth ≤ 2 — fine for flat scripts, but cinematic scripts nest deeper (chapter → scene → kling_clips → multi_shot_prompt). A truncation inside a kling_clip at depth 4 won't register as a completion point. **Recommendation:** Consider raising the depth threshold to 4 for cinematic mode, or parameterize it.

---

## LOW / NICE-TO-HAVE

### 10. `findSimilarSourceTitle` word-overlap is symmetric but shouldn't be
It divides overlap by `Math.min(genSet.size, srcSet.size)`. A 2-word generated title that matches 1 of 2 words gets score 0.5 — flagged. But a 10-word source title matching 1 of its 10 words against a 2-word generated title also scores by min(2,10)=2, so 1/2=0.5 — also flagged. The denominator should be `genSet.size` (how much of the *generated* title is borrowed), not the min of both.

### 11. `_buildSchemaAddendum` is a dead function
Returns empty string for all modes (line 1800-1802). The comment says "kept as placeholder." Either implement it or remove it to reduce confusion.

### 12. Character bible format diverges between templates
`script-prompt.txt` shows `{ id: "character_1", physical: { skin_tone, hair, face, body, distinguishing_marks } }` with a `wardrobe` field and `full_prompt_description`. But the story-driven outline prompt (line 380-403) uses a different schema: `{ physical_description: "...", outfits: [...] }` with `speech_style`, `speech_notes`, `role`, `arc_summary`. These are intentionally different (staged vs cinematic) but the script-prompt.txt example is always shown, even in cinematic mode where it doesn't match what Claude is asked to produce.

### 13. Oversized clip auto-split marks prompts as `[AUTO-SPLIT]` but nothing regenerates them
The auto-split at line 970-975 marks split clips with `[AUTO-SPLIT from ... — prompt needs regeneration]` but there's no downstream code that detects this marker and regenerates the prompt. These clips will go to Kling with a placeholder prompt.

### 14. No max_tokens guard on the structural review input
`reviewScriptStructure` sends the full skeleton JSON to Claude at `max_tokens: 8192` for the response, but the *input* (skeleton of a 10-chapter story-driven script with 60+ scenes) could easily hit 50-80K tokens. There's no check or warning if the input exceeds the model's context window.

---

## PROMPT QUALITY ASSESSMENT

**Title prompts:** Well-structured. Research-informed variant correctly separates pattern usage from copying. Originality requirements are specific and actionable. The 80-char limit is good for YouTube. The JSON format specification is clear.

**Script prompt (script-prompt.txt):** Very well-crafted. The 9-word rule, camera jump system, conversation lock, and sequential image chain are all clearly specified. Content guardrails are comprehensive. The `{{STRUCTURAL_SCAFFOLDING}}` and `{{CINEMATIC_SCAFFOLDING}}` injection points are clean.

**Cinematic scaffolding (`_buildCinematicScaffolding`):** Excellent. The Kling rendering budget section (push-in + dialogue word limits, props-in-hand constraints, laughter vs lip-sync, shot direction length) shows real production learning. The cross-clip continuity rules correctly address the start-frame-reset problem. The cultural dialogue cadence section (proverbial 12-word ceiling) is a nice touch.

**Structural review prompt:** Solid rubric. The 50/60/70 thresholds with +5 cinematic bump are well-calibrated. The hook-resolution ladder (20 points) is the strongest section — it directly targets retention. The severity guidance is actionable.

**One prompt concern:** The story-driven chapter prompt (line 523-600) is ~4K tokens of instruction per chapter. With 10 chapters, that's 40K tokens of repeated instruction. The character bible and outline are re-sent each time (correctly, since each call is independent), but the instruction preamble could be cached or abbreviated for chapters 2+.

---

## DURATION PRESET COMPLIANCE

Enforcement is correct. The script validates chapter count (hard fail < 50%), scene count per chapter (soft warn), and line count (soft warn for staged) or clip count (hard fail < 50% for cinematic). The `_calculateBatchPlan` correctly adjusts batch sizes per mode. The `_validateScriptCompleteness` auto-splits oversized clips (>3 lines). Story-driven mode correctly replaces fixed grid counts with "UNLIMITED" placeholders.

---

## ERROR HANDLING ASSESSMENT

`_streamWithRetry` covers the right error patterns: premature close, ECONNRESET, overloaded, rate_limit, 529, timeout, network, fetch failed. The 5s/10s/15s backoff is reasonable. Three retries is appropriate for transient errors.

**Gap:** No handling for `invalid_api_key` or `authentication_error` — these would consume all 3 retries before failing. Low priority since the pre-flight check should catch bad keys, but worth a fast-fail pattern.

---

## Changes Made

| Line(s) | Fix | Severity |
|---------|-----|----------|
| 1487-1512 | `_closeUnclosedBrackets` → ordered nesting stack | Critical |
| 1559 | `_fixUnescapedQuotes` → `\n\r` in boundary chars | Critical |
| 2043-2045 | `reviewScriptStructure` no-JSON → `pass: false` | Critical |
| 2065-2067 | `reviewScriptStructure` parse error → `pass: false` | Critical |
| 1258-1285 | bare-name `@` prefix → skip dialogue ranges | Critical |
| 1313-1337 | dual-speaker strip → collect-then-apply pattern | Medium |

All changes are in `src/main/pipeline/script-engine.js`. Syntax verified via `node -c`. Commit ready via `commit-session30N.ps1`.
