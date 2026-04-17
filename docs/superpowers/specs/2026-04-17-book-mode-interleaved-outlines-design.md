# Book Mode: Interleaved NL Outlines

**Status:** Draft
**Date:** 2026-04-17
**Scope:** Replace Hopper's existing "Reader mode" (whole-file narrative prose) with a paper-inspired *Book mode* that renders a source file as collapsible natural-language bullets over the real code. Read-only (Phase 1).

## Motivation

Google's 2024 paper *Natural Language Outlines for Code: Literate Programming in the LLM Era* (Shi et al., arXiv:2408.04820) proposes NL outlines — short prose statements interleaved with code that partition each function into semantic sections. The paper reports that Gemini 1.5 Pro with their Interleaved Generation prompt produced outlines rated "excellent" by professional developers 60% of the time, "acceptable or better" 90% of the time.

Hopper's current reader mode generates a whole-file narrative. That's good for first-time reading but weak for navigation, skimming, and understanding function-level behavior. This spec replaces that narrative with a structured, collapsible outline that stays anchored to the real code.

Hopper diverges from the paper's visual treatment (plain `//*` comments inline with code) in one key way: prose is **prose-first and collapsed by default**. Opening a file shows a bulleted outline; code is fetched on demand by clicking a bullet. This is more consistent with Hopper's book metaphor and goes further than the paper in the direction it gestures at (literate programming, NL as primary modality). It also makes the view more scannable for files with many functions.

## Goals

- Render each source file as a three-level zoomable outline: **file → function → bullet → code**.
- Each function's body is partitioned into 4–8 prose bullets (adaptive, LLM decides), matching the paper's observed range.
- Every line of code belongs to exactly one bullet — no orphan code.
- Bullets render as italic serif prose; code renders as CodeMirror-highlighted monospace — visually distinct.
- Default state: all bullets collapsed. Click a bullet to reveal its code block beneath it.
- Reuse Hopper's existing `FileStructure` / Lezer pipeline for per-function boundary detection.
- Cache LLM responses aggressively, keyed on content + prompt version.

## Non-goals (Phase 1)

- **Editing.** Hopper stays read-only. No file writes, no dirty state, no save button.
- **Bidirectional sync.** No "edit prose, code regenerates" or vice versa. Deferred to Phase 2.
- **Cross-file navigation from bullets.** Bullets are text-only; no inline `@file` or `[[phrase||code]]` markup inside bullets. (Those primitives can return in Phase 2 if useful.)
- **Search across collapsed prose.** Nice-to-have but out of scope; follow-up work.
- **Per-file fold memory.** All bullets collapse to default on re-open. Persisting fold state per file is follow-up work.

## The three-level zoom model

| Level | Visible | Click target | Result |
|-------|---------|--------------|--------|
| **0 — File** | One header card per top-level declaration: signature (monospace) + one-line summary (serif). The function body is entirely hidden. Plus a single "Imports" bullet if the file has imports. | Click function card | Expand in place to Level 1 — bullets appear beneath the card, code stays hidden |
| **1 — Function** | The function card is still visible (now marked as expanded). Beneath it: the 4–8 prose bullets, all collapsed. | Click a bullet | Expand that bullet to Level 2 |
| **2 — Bullet** | Bullet's prose + the code block it summarizes, rendered with syntax highlighting, inline beneath the bullet. | Click bullet again | Collapse that bullet to Level 1 |

Multiple bullets and multiple functions can be open simultaneously (not accordion). Collapsing a function (clicking its card again) collapses all open bullets within it. There is a global "Expand All / Collapse All" control at the top of the file view.

Clicking a Level 0 card expands it *in place* — the page does not scroll. The Imports bullet behaves like a Level 1 bullet: one click expands code, one click collapses.

## Bullet kinds

Not all code is semantically meaningful. The LLM labels each bullet as one of:

- **`semantic`** — describes a meaningful chunk of logic. Rendered in italic serif (default prose style).
- **`chrome`** — describes boilerplate: function entry, local variable setup, trivial returns, imports. Rendered smaller, muted gray. Still collapsible; code still accessible.

The distinction is how the LLM is prompted to partition; see LLM output schema below. The rendering uses two CSS classes on the bullet widget.

## LLM output schema

The `describeFile` IPC handler returns a structured response instead of free-form prose:

```ts
interface BookOutline {
  functions: FunctionOutline[]   // one per top-level declaration, in source order
  imports?: ImportOutline         // present iff the file has imports
}

interface FunctionOutline {
  name: string                   // "renderAnnotatedText"
  signatureLine: number          // 1-based line of the signature
  oneLineSummary: string         // shown at level 0
  bullets: Bullet[]
}

interface Bullet {
  text: string                   // the prose bullet itself, plain text
  kind: "semantic" | "chrome"
  fromLine: number               // 1-based, inclusive
  toLine: number                 // 1-based, inclusive
}

interface ImportOutline {
  oneLineSummary: string         // "Electron IPC, path, fs, Anthropic SDK"
  fromLine: number
  toLine: number
}
```

**Coverage invariant:** For each function, the union of `[fromLine, toLine]` ranges across its bullets must equal the function's **body** line range (the lines strictly between the signature/opening-brace line and the closing-brace line, inclusive of any body lines). The signature line itself is rendered on the Level 0 card and is not covered by any bullet. No gaps, no overlaps. The main-process handler validates this before returning; on violation, it retries once with a corrective follow-up, then falls back to a single `chrome` bullet spanning the whole body (rendered as "Could not partition this function").

**Model:** Default `claude-sonnet-4-6` (Hopper's current model). Spec-level configurable; a follow-up can expose user-facing model selection (Haiku 4.5 for speed, Opus 4.6 for depth).

## Prompt

Adapted from the paper's **Interleaved Generation** technique: the model receives the full file plus the `FileStructure` outline (function signatures + line ranges), and is asked to emit the JSON schema above. Key constraints in the system prompt:

- Produce 4–8 bullets per function; very short functions may have 1–3.
- Every line of every function body must belong to exactly one bullet.
- Bullets must be concise (ideally ≤ 120 chars) and describe *what the code does*, not restate the code.
- Label boilerplate (entry, trivial setup, return) as `chrome`; semantic logic as `semantic`.
- Produce one `oneLineSummary` per function: one short sentence describing its purpose.

The prompt is stored in `main.js` alongside the existing `systemPrompt`. Bump the cache version constant.

## Architecture

### Module map

New modules:

- `app/book-outline.ts` — fetches and validates `BookOutline` from the IPC handler. Replaces `ai-prose.ts` for book-mode use. Keeps the SHA-256 content-based cache; `CACHE_VERSION` bumps to `v2`.
- `app/book-view.ts` — the Book-mode CodeMirror view. Owns the `EditorView`, the decoration plugin, the fold state, and the bullet-click handling.
- `app/book-decorations.ts` — CodeMirror `ViewPlugin` that materializes `BookOutline` as block-widget decorations: signature cards (level 0), bullets (level 1), and code-fold toggles.

Modified modules:

- `main.js` — `describe-file` IPC handler gains a new variant that returns `BookOutline` JSON. System prompt replaced. `CACHE_VERSION` bump.
- `app/editor.ts` — the mode toggle loses "Reader" and gains "Book." Book mode mounts `book-view.ts`; Editor mode unchanged (CodeMirror with concept highlights).
- `app/prose-types.ts` — adds `BookOutline`, `FunctionOutline`, `Bullet`, `ImportOutline`.

Retired (deleted or left untouched but no longer wired into `editor.ts`):

- `app/book-panel.ts` — the current whole-file narrative panel. Delete.
- `app/book-structure.ts` — the outline text builder for the old prompt. Its per-function walking logic partially moves into a helper inside `book-outline.ts`.
- `app/prose-panel.ts`, `app/prose-provider.ts`, `app/concept-panel.ts` — already unwired per CLAUDE.md; delete to reduce dead code.

### Data flow

```
open file
  → editor.ts detects Book mode
  → book-view.ts mounts EditorView (read-only) with full source
  → book-outline.ts calls window.ai.describeBookOutline(filename, content)
     → main.js sends structured prompt to claude-sonnet-4-6
     → validates coverage invariant, retries once on failure
     → returns BookOutline JSON (cached by SHA-256 of content+version)
  → book-decorations.ts transforms BookOutline into:
     - block widget above each function signature (level 0 card)
     - block widget above each bullet range (level 1 prose)
     - replace-range decoration over each bullet's code (hidden by default)
  → user clicks → toggle replace-range decoration → code expands/collapses inline
```

### Rendering: CodeMirror block widgets + replace-range decorations

We keep CodeMirror 6 as the editor (same as Hopper today). The outline is layered on top via two decoration types:

- **Block widgets** for prose (level 0 cards, level 1 bullets) — inserted at the line above each code range they describe. They are not part of the buffer; they are DOM injections keyed to source positions.
- **Replace decorations** for the code blocks themselves — wrap a line range in a decoration that, when the bullet is collapsed, replaces the range with an empty widget (collapsed). When expanded, the decoration is removed and normal highlighted code shows.

This means:

- The underlying buffer is always the real, unmodified source file (critical for Phase 2 — prose lives as metadata, not inline text).
- CodeMirror's syntax highlighting, scrolling, selection, and copy/paste all work unchanged on expanded code.
- Fold state is client-side only; no file mutation.

## Styling

- Level 0 function card: medium-large card, function signature in monospace, one-line summary in italic serif below, soft border, click anywhere to expand to Level 1.
- Level 1 prose bullets: italic serif, amber accent rail on the active (expanded) bullet, `chrome` kind renders at ~85% size and gray-400.
- Level 2 code block: standard CodeMirror theme (Hopper's current Codex-style theme), indented under its parent bullet with a subtle left border.
- Expand/collapse control at the top: simple icon button, toggles all bullets in the file.

## Error handling

- **Anthropic API failure / no key.** Book mode renders a single error card at the top of the file offering a "Retry" button. Editor mode remains fully functional.
- **Malformed LLM response (bad JSON, missing fields, coverage violation).** Main-process handler retries once. If still bad, fall back to a single `chrome` bullet per function spanning the entire body, with text "Could not partition this function."
- **File too large** (> `MAX_CONTENT_SIZE = 30_000` chars, same as today). Truncate with a warning bullet at the top of the file outline.
- **Cache hit on stale schema.** Bumping `CACHE_VERSION` invalidates all existing cache entries on upgrade.

## Testing

No test infra exists in Hopper today. This spec proposes adding a minimal manual QA checklist in the implementation plan, not introducing a test framework. Future work can add automated tests around:

- Coverage-invariant validation (pure function — easy to unit test).
- Prompt output stability across a small corpus of sample files (integration, needs API key).

## Open questions deferred to implementation plan

- Keybinding for Expand All / Collapse All.
- Does clicking a Level 0 function card scroll the page, or just expand in place?
- Handling of files with no top-level declarations (e.g. plain scripts): treat the whole file as a single synthetic function.
- What does a file with zero functions look like (e.g. `tsconfig.json`, plain text)? Likely: Book mode disabled, Editor mode auto-selected. Fallback behavior to be pinned down in the plan.

## Out-of-scope for this spec (Phase 2+)

- Bidirectional code ↔ prose editing.
- Search across prose.
- Per-file fold state persistence.
- Inline cross-file links (`@file`) and hover-snippets (`[[phrase||code]]`) inside bullets.
- Model picker UI.

## Success criteria

- Opening `app/book-panel.ts` (or any reasonably sized source file) in Book mode renders a single scrollable outline of all top-level declarations, with 4–8 bullets per function.
- Clicking any bullet reveals its code block inline with syntax highlighting.
- LLM output is validated against the coverage invariant; malformed responses trigger one retry then graceful fallback.
- Toggling to Editor mode shows the original CodeMirror view with concept highlights, unchanged.
- Performance: for a 500-line file, first render ≤ 5 s cold, < 100 ms warm (cached).
