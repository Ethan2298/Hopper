# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Hopper (package name: `ergonomic-code`) — an Electron desktop app that renders a source file as an AST-aware "book": the code is parsed with Lezer via CodeMirror 6, structured into an outline, and then annotated by Claude (via the Anthropic Messages API) into plain-English prose with hoverable code references.

Pipeline: `raw text → Lezer AST → FileStructure → outline → LLM prose with @file and [[phrase||code]] markup → interactive reader UI`.

## Commands

- `npm run bundle` — bundle the renderer once (`esbuild app/editor.ts --bundle --outfile=app/bundle.js`).
- `npm start` / `npm run dev` — bundle, then launch Electron (`electron .`). Identical scripts; there is no watcher, so re-run after editing `app/*.ts`.
- No lint, test, or typecheck scripts are configured.

Runtime requires `ANTHROPIC_API_KEY` — loaded from `./.env` at Electron startup by `main.js` (see `envPath` parsing). Without it, `describe-file` returns an error string instead of prose. Model is hardcoded to `claude-sonnet-4-6` in `main.js`.

## Architecture

Three-layer Electron app. Cross them only via the IPC handlers defined in `main.js` / `preload.js`:

- **Main process** (`main.js`) — owns all filesystem access (`read-dir`, `read-file`, `list-files`, `show-open-dialog`) and the Anthropic API proxy (`describe-file`). The renderer never has `nodeIntegration`; everything flows through `ipcMain.handle`.
- **Preload** (`preload.js`) — exposes `window.fs` and `window.ai` via `contextBridge`. These are the only globals the renderer can use to reach the outside world.
- **Renderer** (`app/*.ts`, bundled to `app/bundle.js`, loaded by `app/index.html`) — CodeMirror 6 editor + custom "book" reader panel.

### Renderer module layout

- `editor.ts` — entry point. Owns the CodeMirror `EditorView`, file tree, and the **reader / editor mode toggle** (reader shows the annotated book; editor shows CodeMirror with concept highlights). File extension → language extension mapping lives here (`.js/.ts/.jsx/.tsx/.py/.rs/.svelte`).
- `concepts.ts` — a CodeMirror `ViewPlugin` that walks `syntaxTree(state)` and decorates nodes by category (declaration, control-flow, invocation, …). Category → Lezer-node-name tables are per-language and live in `categories`. When adding a language, extend these tables.
- `file-structure.ts` — extracts a `FileStructure` (imports / exports / declarations as `FileNode` trees) from the Lezer AST. Per-language node-name lookup tables at the top of the file (`nameNodes`, `funcNodes`, `classNodes`, `importNodes`, `varNodes`, …) are how language support is wired; keep them in sync with `concepts.ts`.
- `book-structure.ts` — turns a `FileStructure` into a text **outline** that is sent to the model as extra context, plus a `nodeMap` used to resolve symbol names back to source ranges.
- `ai-prose.ts` — thin wrapper over `window.ai.describe`. Caches responses by SHA-256 of `CACHE_VERSION + filename + content` (bump `CACHE_VERSION` to invalidate). Truncates content at `MAX_CONTENT_SIZE = 30_000` chars.
- `book-panel.ts` — the reader UI. Parses the LLM's two custom markup forms:
  - `@filename.ext` → clickable link that opens that project file.
  - `[[phrase||code]]` → inline phrase with a hover tooltip showing the literal code snippet, linked via AST to the source.
  - The LLM prompt that teaches these conventions lives in `main.js` (`systemPrompt` inside `describe-file`). If you change the markup, update both the prompt and the regexes (`FILE_REF_RE`, `ANNOTATION_RE`).
- `prose-types.ts` — shared types (`FileNode`, `FileStructure`, `AnnotatedFile`, `ZoomLevel`).
- `prose-provider.ts`, `prose-panel.ts`, `concept-panel.ts` — earlier/alternative prose and concept-tree panels (not all are wired into the current `editor.ts`).

### Adding a language

Three places must agree: (1) extension → CodeMirror language in `editor.ts` `langByExt`, (2) Lezer node names in the per-category tables in `concepts.ts`, (3) Lezer node names in the per-kind tables in `file-structure.ts`. Lezer grammars give different node names per language (e.g. JS `FunctionDeclaration`, Python `FunctionDefinition`, Rust `FunctionItem`), which is why each table is keyed by language.

## codemirror-dev/

Checked-in clone of the upstream `codemirror/dev` monorepo, used for reference only. It is **not** part of the Electron build — `esbuild` bundles from `app/editor.ts` using the `@codemirror/*` packages installed via npm. Do not edit files under `codemirror-dev/` expecting them to affect the app.
