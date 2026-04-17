# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Hopper (package name: `ergonomic-code`) — an Electron desktop app that renders a source file as an AST-aware "book": the code is parsed with Lezer via CodeMirror 6, split into discrete units (imports, functions, classes, types, variables), and each unit is annotated by Claude (via the Anthropic Messages API) with a one-line summary and short prose bullets.

Pipeline: `raw text → Lezer AST → FileStructure → ReaderUnit[] → LLM prose (JSON, per unit) → CodeMirror block decorations (card widgets over each unit)`.

**Design reference:** Book mode's UX target is the Google paper [Natural Language Outlines for Code: Literate Programming in the LLM Era](https://arxiv.org/abs/2408.04820) (Shi et al., FSE 2025) — NL statements interleaved with the code they summarize, bidirectional sync between prose and code. Current direction: a flat markdown-bullet outline (one bullet per unit, code revealed on click) rather than card chrome.

## Commands

- `npm run bundle` — bundle the renderer once (`esbuild app/editor.ts --bundle --outfile=app/bundle.js`).
- `npm start` / `npm run dev` — bundle, then launch Electron (`electron .`). Identical scripts; there is no watcher, so re-run after editing `app/*.ts`.
- No lint, test, or typecheck scripts are configured.

Runtime requires `ANTHROPIC_API_KEY` — loaded from `./.env` at Electron startup by `main.js` (see `envPath` parsing). Without it, `describe-book-outline` returns an error string instead of prose. Model is hardcoded to `claude-sonnet-4-6` in `main.js`.

## Architecture

Three-layer Electron app. Cross them only via the IPC handlers defined in `main.js` / `preload.js`:

- **Main process** (`main.js`) — owns all filesystem access (`read-dir`, `read-file`, `list-files`, `show-open-dialog`) and the Anthropic API proxy (`describe-book-outline`). The renderer never has `nodeIntegration`; everything flows through `ipcMain.handle`.
- **Preload** (`preload.js`) — exposes `window.fs` and `window.ai` via `contextBridge`. These are the only globals the renderer can use to reach the outside world.
- **Renderer** (`app/*.ts`, bundled to `app/bundle.js`, loaded by `app/index.html`) — CodeMirror 6 editor + a Book-mode reader view.

### Renderer module layout

- `editor.ts` — entry point. Owns the CodeMirror `EditorView`, file tree, and the **Book / Editor mode toggle** (Book shows AST-cards over the source; Editor shows plain CodeMirror with concept highlights). File extension → language extension mapping lives here (`.js/.ts/.jsx/.tsx/.py/.rs/.svelte`).
- `concepts.ts` — a CodeMirror `ViewPlugin` that walks `syntaxTree(state)` and decorates nodes by category (declaration, control-flow, invocation, …). Category → Lezer-node-name tables are per-language and live in `categories`. When adding a language, extend these tables.
- `file-structure.ts` — extracts a `FileStructure` (imports / exports / declarations as `FileNode` trees) from the Lezer AST. Takes an `EditorState`. Per-language node-name lookup tables at the top of the file (`nameNodes`, `funcNodes`, `classNodes`, `importNodes`, `varNodes`, …) are how language support is wired; keep them in sync with `concepts.ts`.
- `book-units.ts` — turns a `FileStructure` into a flat `ReaderUnit[]` (one unit per top-level declaration plus a coalesced imports unit). Records line ranges for each unit; these are the ranges the Book view paints over.
- `book-outline.ts` — calls `window.ai.describeBookOutline` with the units, zips the LLM's prose into a `BookReaderOutline`, SHA-256 caches by `CACHE_VERSION + filename + content` (bump `CACHE_VERSION` to invalidate).
- `book-decorations.ts` — CodeMirror `StateField` that provides block `Decoration.replace` widgets over each unit's line range. Fold state is managed through `bookFoldEffect`. (Must be a `StateField`, not a `ViewPlugin`: block-replace decorations need to survive across transactions without races.)
- `book-widgets.ts` — `OutlineRowWidget` (one per NL statement) and `ImportsRowWidget`. Flat markdown-style bullets; hover treatment matches the sidebar file-picker (`.tree-item:hover`).
- `book-view.ts` — public entry (`openBookView`) that creates an `EditorState`, extracts units, fetches prose, then builds the read-only `EditorView` with the decorations extension. Exposes `expandAll` / `collapseAll` via a `BookViewHandle`.
- `prose-types.ts` — shared types: `FileNode`, `FileStructure`, `ReaderUnit`, `UnitProse`, `BookReaderOutline`.

The LLM contract is JSON-in, JSON-out. The system prompt in `main.js` (`describe-book-outline` handler) implements the paper's **Interleaved Generation**: the renderer supplies each unit's `source` with 1-based `" n| "` line prefixes, and the LLM returns `{ prose: UnitProse[] }` where `UnitProse = { index, statements: OutlineStatement[] }` and `OutlineStatement = { text, startLine, endLine }` — line numbers are *unit-relative*. The renderer maps them to absolute doc lines and clamps to exclude the signature line. Statements are imperative present-tense fragments starting with a verb ("Compute", "Initialize", …). Unit source is capped at `MAX_UNIT_SOURCE = 8_000` chars per unit; one retry on parse failure, then a fallback outline with empty statements (unit renders natively).

### Adding a language

Three places must agree: (1) extension → CodeMirror language in `editor.ts` `langByExt` (and in `book-view.ts` `langByExt`), (2) Lezer node names in the per-category tables in `concepts.ts`, (3) Lezer node names in the per-kind tables in `file-structure.ts`. Lezer grammars give different node names per language (e.g. JS `FunctionDeclaration`, Python `FunctionDefinition`, Rust `FunctionItem`), which is why each table is keyed by language.

## codemirror-dev/

Checked-in clone of the upstream `codemirror/dev` monorepo, used for reference only. It is **not** part of the Electron build — `esbuild` bundles from `app/editor.ts` using the `@codemirror/*` packages installed via npm. Do not edit files under `codemirror-dev/` expecting them to affect the app.
