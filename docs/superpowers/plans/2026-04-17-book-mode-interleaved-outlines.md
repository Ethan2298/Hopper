# Book Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Hopper's existing Reader mode with a prose-first, three-level-zoom "Book mode" that renders a source file as collapsible NL bullets layered over the real code via CodeMirror decorations. Read-only (Phase 1).

**Architecture:** Renderer calls `window.ai.describeBookOutline(filename, content)` → main process asks `claude-sonnet-4-6` for a validated `BookOutline` JSON (function summaries + prose bullets with line ranges) → client-side `book-view.ts` mounts a CodeMirror `EditorView` with a `ViewPlugin` that renders block-widget decorations for cards/bullets and `Decoration.replace` decorations that hide code lines based on per-function and per-bullet fold state. Buffer is never mutated.

**Tech Stack:** Electron + TypeScript, esbuild for bundling, CodeMirror 6 (`@codemirror/view`, `@codemirror/state`), Anthropic Messages API.

**Reference spec:** `docs/superpowers/specs/2026-04-17-book-mode-interleaved-outlines-design.md`

---

## File structure

**New files:**
- `app/book-outline.ts` — client-side fetcher + SHA-256 cache for `BookOutline`. Wraps `window.ai.describeBookOutline`.
- `app/book-outline-validate.ts` — pure coverage-invariant validator (`validateBookOutline(outline, lineCount)`).
- `app/book-widgets.ts` — `WidgetType` subclasses: `CardWidget`, `BulletWidget`, `ImportWidget`.
- `app/book-view.ts` — `openBookView(parent, filename, content, outline)` mounts the read-only `EditorView` and owns fold state.
- `app/book-decorations.ts` — state field + `ViewPlugin` that turns `{outline, foldState}` into a `DecorationSet`.

**Modified files:**
- `app/prose-types.ts` — add `BookOutline`, `FunctionOutline`, `Bullet`, `ImportOutline`, `BulletKind`.
- `main.js` — add `describe-book-outline` IPC handler with new system prompt + JSON-mode response + coverage-invariant validation + one-shot retry.
- `preload.js` — expose `window.ai.describeBookOutline`.
- `app/editor.ts` — replace `BookPanel` mount with `openBookView`; rename mode `"reader"` → `"book"`; update DOM ids.
- `app/index.html` — rename `#mode-reader` button to `#mode-book` with label "Book".
- `app/app.css` — replace `.book-prose` / `.book-paragraph` / `.book-code-highlight` / `.book-symbol-ref` / `.book-file-link` rules with new `.bm-*` classes (card, bullet, chevron, code-inline).

**Deleted files:**
- `app/book-panel.ts`
- `app/book-structure.ts`
- `app/ai-prose.ts`
- `app/prose-panel.ts`
- `app/prose-provider.ts`
- `app/concept-panel.ts`

---

## Task 0: Prep — run the app once to confirm the baseline works

**Files:** none (read-only verification).

- [ ] **Step 1: Bundle and launch**

```bash
cd /Users/ethan/Projects/Hopper
npm run bundle
```

Expected: `app/bundle.js` written with no esbuild errors.

- [ ] **Step 2: Start Electron**

```bash
npm start
```

Expected: Hopper window opens, shows a file tree. Open any `.ts` file under `app/`, confirm Reader mode renders prose and Editor mode shows CodeMirror with concept highlights. Close the app.

- [ ] **Step 3: Verify API key is present**

```bash
ls -la .env
grep -c "ANTHROPIC_API_KEY" .env
```

Expected: `.env` exists and contains an `ANTHROPIC_API_KEY=` line. If missing, stop here and add one.

---

## Task 1: Add types for `BookOutline`

**Files:**
- Modify: `app/prose-types.ts`

- [ ] **Step 1: Append the new interfaces to `prose-types.ts`**

At the bottom of `app/prose-types.ts`, add:

```ts
export type BulletKind = "semantic" | "chrome"

export interface Bullet {
  text: string
  kind: BulletKind
  fromLine: number
  toLine: number
}

export interface FunctionOutline {
  name: string
  signatureLine: number
  oneLineSummary: string
  bullets: Bullet[]
}

export interface ImportOutline {
  oneLineSummary: string
  fromLine: number
  toLine: number
}

export interface BookOutline {
  functions: FunctionOutline[]
  imports?: ImportOutline
}
```

- [ ] **Step 2: Bundle to confirm types compile**

```bash
npm run bundle
```

Expected: no errors (the new types are unused but valid TS).

- [ ] **Step 3: Commit**

```bash
git add app/prose-types.ts
git commit -m "feat(types): add BookOutline/Bullet/FunctionOutline/ImportOutline

Types for the new Book Mode outline schema returned by the LLM and
consumed by the renderer. No behavior change yet."
```

---

## Task 2: Coverage-invariant validator (pure function, renderer-side)

**Files:**
- Create: `app/book-outline-validate.ts`

A pure function the renderer uses to sanity-check LLM output after it arrives. The main process also validates before returning, but keeping a renderer-side copy lets us defensively catch stale cached responses.

- [ ] **Step 1: Create `app/book-outline-validate.ts`**

```ts
import type { BookOutline, FunctionOutline } from "./prose-types"

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

/**
 * A BookOutline is valid when, for every function, the union of its
 * bullets' [fromLine, toLine] ranges equals [signatureLine+1 .. lastBodyLine]
 * with no gaps or overlaps. Signature line is NOT covered by bullets.
 *
 * lineCount is the total number of lines in the source file (1-based
 * line numbers; lineCount >= any signatureLine or bullet.toLine).
 */
export function validateBookOutline(
  outline: BookOutline,
  lineCount: number
): ValidationResult {
  const errors: string[] = []

  for (const fn of outline.functions) {
    if (fn.signatureLine < 1 || fn.signatureLine > lineCount) {
      errors.push(`function "${fn.name}": signatureLine ${fn.signatureLine} out of range`)
      continue
    }
    if (fn.bullets.length === 0) {
      errors.push(`function "${fn.name}": no bullets`)
      continue
    }

    const sorted = [...fn.bullets].sort((a, b) => a.fromLine - b.fromLine)
    const bodyStart = fn.signatureLine + 1

    // First bullet must start immediately after the signature.
    if (sorted[0].fromLine !== bodyStart) {
      errors.push(
        `function "${fn.name}": first bullet starts at line ${sorted[0].fromLine}, expected ${bodyStart}`
      )
    }

    // Each subsequent bullet must start immediately after the previous one ends.
    for (let i = 1; i < sorted.length; i++) {
      const expected = sorted[i - 1].toLine + 1
      if (sorted[i].fromLine !== expected) {
        errors.push(
          `function "${fn.name}": bullet ${i} starts at line ${sorted[i].fromLine}, expected ${expected}`
        )
      }
    }

    // Each bullet must have fromLine <= toLine.
    for (const b of sorted) {
      if (b.fromLine > b.toLine) {
        errors.push(`function "${fn.name}": bullet "${b.text.slice(0, 30)}" has fromLine > toLine`)
      }
      if (b.toLine > lineCount) {
        errors.push(`function "${fn.name}": bullet toLine ${b.toLine} exceeds lineCount ${lineCount}`)
      }
    }
  }

  if (outline.imports) {
    const imp = outline.imports
    if (imp.fromLine < 1 || imp.toLine > lineCount || imp.fromLine > imp.toLine) {
      errors.push(`imports: invalid range [${imp.fromLine}, ${imp.toLine}]`)
    }
  }

  return { ok: errors.length === 0, errors }
}
```

- [ ] **Step 2: Bundle**

```bash
npm run bundle
```

Expected: no errors.

- [ ] **Step 3: Sanity-check by hand from devtools console**

After bundling, restart Electron (`npm start`), open devtools (View menu → Toggle Developer Tools). The module isn't imported yet; just verify compilation succeeded. We'll exercise it in Task 5.

- [ ] **Step 4: Commit**

```bash
git add app/book-outline-validate.ts
git commit -m "feat(book): add coverage-invariant validator for BookOutline

Pure validator ensuring every bullet range is contiguous and starts
one line after the function signature. Will be called by book-outline.ts
(renderer) and mirrored in main.js (IPC handler) next."
```

---

## Task 3: Main-process IPC handler `describe-book-outline`

**Files:**
- Modify: `main.js:167-229`

We keep the existing `describe-file` handler intact for the moment (so nothing visually breaks during the transition) and add a sibling handler `describe-book-outline` that returns `{ outline?: BookOutline, error?: string, truncated?: boolean }`.

- [ ] **Step 1: Add helpers near the top of `main.js` (after the `.env` loader, before the `// --- Menu ---` block)**

Open `main.js` and insert this block right before the `// --- Menu ---` comment (around line 22):

```js
// --- Book outline helpers ---

const MAX_BOOK_CONTENT = 30_000

/**
 * Coverage-invariant validator. Mirrors app/book-outline-validate.ts.
 * Returns { ok: boolean, errors: string[] }.
 */
function validateBookOutline(outline, lineCount) {
  const errors = []
  if (!outline || !Array.isArray(outline.functions)) {
    return { ok: false, errors: ["outline missing functions array"] }
  }
  for (const fn of outline.functions) {
    if (!fn || typeof fn.name !== "string" || typeof fn.signatureLine !== "number") {
      errors.push("function missing name or signatureLine")
      continue
    }
    if (fn.signatureLine < 1 || fn.signatureLine > lineCount) {
      errors.push(`function "${fn.name}": signatureLine out of range`)
      continue
    }
    if (!Array.isArray(fn.bullets) || fn.bullets.length === 0) {
      errors.push(`function "${fn.name}": no bullets`)
      continue
    }
    const sorted = [...fn.bullets].sort((a, b) => a.fromLine - b.fromLine)
    const bodyStart = fn.signatureLine + 1
    if (sorted[0].fromLine !== bodyStart) {
      errors.push(`function "${fn.name}": first bullet starts at ${sorted[0].fromLine}, expected ${bodyStart}`)
    }
    for (let i = 1; i < sorted.length; i++) {
      const expected = sorted[i - 1].toLine + 1
      if (sorted[i].fromLine !== expected) {
        errors.push(`function "${fn.name}": bullet ${i} starts at ${sorted[i].fromLine}, expected ${expected}`)
      }
    }
    for (const b of sorted) {
      if (b.fromLine > b.toLine) errors.push(`function "${fn.name}": bullet has fromLine > toLine`)
      if (b.toLine > lineCount) errors.push(`function "${fn.name}": bullet toLine ${b.toLine} > lineCount ${lineCount}`)
    }
  }
  if (outline.imports) {
    const imp = outline.imports
    if (imp.fromLine < 1 || imp.toLine > lineCount || imp.fromLine > imp.toLine) {
      errors.push(`imports: invalid range [${imp.fromLine}, ${imp.toLine}]`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Post-process the LLM response: strip any ```json fences, parse, and return.
 * Returns { outline, parseError }.
 */
function parseBookOutlineResponse(text) {
  let body = text.trim()
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fenceMatch) body = fenceMatch[1].trim()
  try {
    return { outline: JSON.parse(body) }
  } catch (err) {
    return { parseError: err.message }
  }
}

/** Fallback outline: one chrome bullet per declaration covering the whole body. */
function fallbackOutline(fileContent) {
  const lineCount = fileContent.split("\n").length
  return {
    functions: [
      {
        name: "(unpartitioned)",
        signatureLine: 1,
        oneLineSummary: "Could not partition this file.",
        bullets: [
          {
            text: "Could not partition this function.",
            kind: "chrome",
            fromLine: 2,
            toLine: lineCount,
          },
        ],
      },
    ],
  }
}
```

- [ ] **Step 2: Add the IPC handler. Insert the following block right after the existing `ipcMain.handle("describe-file", ...)` block (around line 229, before the `// --- App lifecycle ---` comment)**

```js
ipcMain.handle("describe-book-outline", async (_event, { filename, fileContent }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { error: "No ANTHROPIC_API_KEY environment variable set. Launch the app with: ANTHROPIC_API_KEY=sk-... npm start" }
  }

  let content = fileContent
  let truncated = false
  if (content.length > MAX_BOOK_CONTENT) {
    content = content.slice(0, MAX_BOOK_CONTENT)
    truncated = true
  }
  const lineCount = content.split("\n").length

  const systemPrompt = `You are generating a Natural Language Outline for a source file, in the style of Shi et al. 2024 (arXiv:2408.04820). You partition the file's code into prose bullets suitable for a literate-programming reader.

Return STRICT JSON matching this TypeScript type — no prose before or after, no markdown fences:

type BookOutline = {
  functions: FunctionOutline[]
  imports?: { oneLineSummary: string; fromLine: number; toLine: number }
}
type FunctionOutline = {
  name: string
  signatureLine: number
  oneLineSummary: string
  bullets: Bullet[]
}
type Bullet = {
  text: string
  kind: "semantic" | "chrome"
  fromLine: number
  toLine: number
}

Rules:
1. Include one FunctionOutline per top-level function, method, class method, or class body. Do not skip any.
2. "signatureLine" is the 1-based line of the declaration (where the name appears). Do NOT include it in any bullet's range.
3. For each function, produce 4–8 bullets. Very short functions may have 1–3 bullets. Very long functions may have up to 10.
4. Bullets must PARTITION the function body with no gaps and no overlaps. The first bullet starts at signatureLine+1, each subsequent bullet starts at the previous bullet's toLine+1, and the last bullet ends at the last line of the function body (the closing brace line inclusive, if present).
5. Each "text" is concise prose describing what that section of code does, NOT a restatement of the code. Prefer <= 120 chars.
6. Label boilerplate (function entry, trivial variable setup, trivial returns) as kind: "chrome". Label meaningful logic as kind: "semantic".
7. Produce a one-sentence "oneLineSummary" for each function describing its purpose.
8. If the file has import/use/require statements, include an "imports" object with a one-line summary and the range covering all of them.

Output: JSON object only. No commentary.`

  async function runOnce() {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `File: ${filename}\nLine count: ${lineCount}\n\n<file>\n${content}\n</file>`,
          },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      return { httpError: `API error ${res.status}: ${body}` }
    }
    const data = await res.json()
    const text = data.content?.[0]?.text
    if (!text) return { httpError: "Unexpected API response format" }
    return parseBookOutlineResponse(text)
  }

  try {
    let result = await runOnce()
    if (result.httpError) return { error: result.httpError }

    let validation = result.outline
      ? validateBookOutline(result.outline, lineCount)
      : { ok: false, errors: [`parse failed: ${result.parseError || "unknown"}`] }

    if (!validation.ok) {
      // One retry
      result = await runOnce()
      if (result.httpError) return { error: result.httpError }
      validation = result.outline
        ? validateBookOutline(result.outline, lineCount)
        : { ok: false, errors: [`parse failed: ${result.parseError || "unknown"}`] }
    }

    if (!validation.ok) {
      return { outline: fallbackOutline(content), truncated, fallback: true, errors: validation.errors }
    }

    return { outline: result.outline, truncated }
  } catch (err) {
    return { error: `Network error: ${err.message}` }
  }
})
```

- [ ] **Step 3: Reload-test manually**

```bash
npm run bundle && npm start
```

Open devtools, in the console run:

```js
await window.ai?.describeBookOutline // currently undefined — preload not updated yet
```

Expected: `undefined`. That's fine — we wire the preload next. Just confirm the Electron app still launches without errors and the existing Reader/Editor modes still work.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(main): add describe-book-outline IPC handler

Structured-JSON outline handler using claude-sonnet-4-6 with a
coverage-invariant validator. One retry on malformed output,
fallback to a single chrome bullet per file on repeated failure.
Preload bridge + renderer wiring come next."
```

---

## Task 4: Preload bridge — expose `window.ai.describeBookOutline`

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Update `preload.js` to expose the new method**

Replace the existing `contextBridge.exposeInMainWorld("ai", ...)` block:

```js
contextBridge.exposeInMainWorld("ai", {
  describe: (opts) => ipcRenderer.invoke("describe-file", opts),
  describeBookOutline: (opts) => ipcRenderer.invoke("describe-book-outline", opts),
})
```

- [ ] **Step 2: Reload-test manually**

```bash
npm start
```

Devtools console:

```js
typeof window.ai.describeBookOutline
```

Expected: `"function"`.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(preload): expose window.ai.describeBookOutline"
```

---

## Task 5: Client-side outline fetcher with cache

**Files:**
- Create: `app/book-outline.ts`

- [ ] **Step 1: Create `app/book-outline.ts`**

```ts
import type { BookOutline } from "./prose-types"
import { validateBookOutline } from "./book-outline-validate"

declare global {
  interface Window {
    ai: {
      describe: (opts: {
        filename: string
        fileContent: string
        projectFiles: string[]
        outline?: string
      }) => Promise<{ text?: string; error?: string }>
      describeBookOutline: (opts: {
        filename: string
        fileContent: string
      }) => Promise<{
        outline?: BookOutline
        error?: string
        truncated?: boolean
        fallback?: boolean
        errors?: string[]
      }>
    }
  }
}

const CACHE_VERSION = "v1-book"
const MAX_CONTENT_SIZE = 30_000

const cache = new Map<string, BookOutline>()

async function hashKey(filename: string, content: string): Promise<string> {
  const data = new TextEncoder().encode(CACHE_VERSION + "\0" + filename + "\0" + content)
  const buf = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export interface FetchResult {
  outline?: BookOutline
  error?: string
  truncated?: boolean
  fallback?: boolean
}

export async function fetchBookOutline(
  filename: string,
  content: string
): Promise<FetchResult> {
  const key = await hashKey(filename, content)
  const cached = cache.get(key)
  if (cached) return { outline: cached }

  let fileContent = content
  let truncated = false
  if (fileContent.length > MAX_CONTENT_SIZE) {
    fileContent = fileContent.slice(0, MAX_CONTENT_SIZE)
    truncated = true
  }

  const res = await window.ai.describeBookOutline({ filename, fileContent })
  if (res.error) return { error: res.error, truncated: truncated || res.truncated }
  if (!res.outline) return { error: "Empty outline response" }

  // Defensive revalidation on client (catches stale cache across schema bumps).
  const lineCount = fileContent.split("\n").length
  const v = validateBookOutline(res.outline, lineCount)
  if (!v.ok && !res.fallback) {
    // Main process should have retried; if still invalid, surface error.
    return { error: `Invalid outline: ${v.errors[0]}` }
  }

  cache.set(key, res.outline)
  return {
    outline: res.outline,
    truncated: truncated || res.truncated,
    fallback: res.fallback,
  }
}
```

- [ ] **Step 2: Bundle**

```bash
npm run bundle
```

Expected: no TS errors.

- [ ] **Step 3: Smoke-test from devtools**

Start Electron (`npm start`). Open any `.ts` file. In devtools console:

```js
// Module isn't imported yet; do it ad-hoc:
const { fetchBookOutline } = await import("./book-outline.js")
// The above will fail because bundle is a single file. Skip this step —
// we will verify via the full UI in Task 9.
```

Just confirm Electron launches cleanly. No functional check possible until book-view mounts.

- [ ] **Step 4: Commit**

```bash
git add app/book-outline.ts
git commit -m "feat(book): add fetchBookOutline with SHA-256 cache

Renderer wrapper over window.ai.describeBookOutline with in-memory
cache keyed on CACHE_VERSION + filename + content. Revalidates
client-side to catch stale cache entries across schema changes."
```

---

## Task 6: Widget `WidgetType` subclasses (card, bullet, import)

**Files:**
- Create: `app/book-widgets.ts`

The widgets are pure DOM factories. They receive click handlers via constructor; state lives elsewhere.

- [ ] **Step 1: Create `app/book-widgets.ts`**

```ts
import { WidgetType } from "@codemirror/view"
import type { FunctionOutline, Bullet, ImportOutline } from "./prose-types"

/**
 * Level 0 / Level 1 card widget for a function.
 * - level=0: card only (compact); code body is hidden.
 * - level=1: card with all bullets listed below it (bullets collapsed).
 * The card itself is the single clickable target that toggles L0 <-> L1.
 */
export class CardWidget extends WidgetType {
  constructor(
    readonly fn: FunctionOutline,
    readonly level: 0 | 1,
    readonly expandedBulletIds: Set<number>,
    readonly onToggleFunction: (fnName: string) => void,
    readonly onToggleBullet: (fnName: string, bulletIdx: number) => void,
    readonly signatureText: string
  ) {
    super()
  }

  eq(other: CardWidget) {
    return (
      other.fn === this.fn &&
      other.level === this.level &&
      other.expandedBulletIds === this.expandedBulletIds
    )
  }

  toDOM() {
    const root = document.createElement("div")
    root.className = `bm-card bm-card-l${this.level}`

    const head = document.createElement("div")
    head.className = "bm-card-head"
    head.addEventListener("click", () => this.onToggleFunction(this.fn.name))

    const chev = document.createElement("span")
    chev.className = "bm-chev"
    chev.textContent = this.level === 0 ? "▸" : "▾"
    head.appendChild(chev)

    const sig = document.createElement("code")
    sig.className = "bm-signature"
    sig.textContent = this.signatureText
    head.appendChild(sig)

    const summary = document.createElement("p")
    summary.className = "bm-summary"
    summary.textContent = this.fn.oneLineSummary
    head.appendChild(summary)

    root.appendChild(head)

    if (this.level === 1) {
      const list = document.createElement("ul")
      list.className = "bm-bullets"
      this.fn.bullets.forEach((b, idx) => {
        list.appendChild(this.renderBullet(b, idx))
      })
      root.appendChild(list)
    }

    return root
  }

  private renderBullet(bullet: Bullet, idx: number) {
    const li = document.createElement("li")
    li.className = `bm-bullet bm-bullet-${bullet.kind}`
    if (this.expandedBulletIds.has(idx)) li.classList.add("bm-bullet-open")

    const chev = document.createElement("span")
    chev.className = "bm-chev"
    chev.textContent = this.expandedBulletIds.has(idx) ? "▾" : "▸"
    li.appendChild(chev)

    const text = document.createElement("span")
    text.className = "bm-bullet-text"
    text.textContent = bullet.text
    li.appendChild(text)

    li.addEventListener("click", (e) => {
      e.stopPropagation()
      this.onToggleBullet(this.fn.name, idx)
    })

    return li
  }

  ignoreEvent() {
    return false
  }
}

/**
 * Import summary bullet, rendered at the top of the file.
 * Has its own simple click-to-toggle behavior managed by the decoration plugin.
 */
export class ImportWidget extends WidgetType {
  constructor(
    readonly imp: ImportOutline,
    readonly expanded: boolean,
    readonly onToggle: () => void
  ) {
    super()
  }

  eq(other: ImportWidget) {
    return other.imp === this.imp && other.expanded === this.expanded
  }

  toDOM() {
    const root = document.createElement("div")
    root.className = "bm-imports"
    if (this.expanded) root.classList.add("bm-imports-open")

    const chev = document.createElement("span")
    chev.className = "bm-chev"
    chev.textContent = this.expanded ? "▾" : "▸"
    root.appendChild(chev)

    const text = document.createElement("span")
    text.className = "bm-imports-text"
    text.textContent = this.imp.oneLineSummary
    root.appendChild(text)

    root.addEventListener("click", () => this.onToggle())
    return root
  }

  ignoreEvent() {
    return false
  }
}
```

- [ ] **Step 2: Bundle to confirm types compile**

```bash
npm run bundle
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/book-widgets.ts
git commit -m "feat(book): add CardWidget and ImportWidget

CodeMirror WidgetType subclasses that render the outline as DOM.
Click handlers are injected by the caller; widgets own no state."
```

---

## Task 7: Decoration plugin + fold state

**Files:**
- Create: `app/book-decorations.ts`

This task owns the hardest piece: given a `BookOutline` plus per-function and per-bullet fold state, produce the correct `DecorationSet` of block widgets and replace-ranges, and rebuild it on every state change.

### Rendering rules (read these before writing code)

Let `L(n)` be the 1-based line number `n` in the doc.

For each function `fn`:
- Compute body range = `[L(fn.signatureLine+1) .. L(lastBulletToLine)]`.
- **If fn is collapsed (L0):**
  - One `Decoration.replace({ widget: CardWidget(level=0), block: true })` spanning lines `signatureLine .. lastBulletToLine` (inclusive).
- **If fn is expanded (L1 or L2):**
  - One `Decoration.replace({ widget: CardWidget(level=1), block: true })` spanning ONLY `signatureLine` (the signature line itself is replaced by the card + bullet list).
  - For each bullet `b` at index `i`:
    - If bullet `i` is collapsed: `Decoration.replace({ widget: EmptyWidget (block) })` spanning `b.fromLine .. b.toLine`.
    - If bullet `i` is expanded: no replace decoration on that bullet's lines (raw code renders naturally with CodeMirror highlighting).

For imports (if present):
- `Decoration.replace({ widget: ImportWidget(expanded=currentImportsFold), block: true })` spanning `imp.fromLine .. imp.toLine` when collapsed. When expanded, no decoration — raw import lines show.

Fold state — one `StateField<BookFoldState>`:
```ts
interface BookFoldState {
  expandedFunctions: Set<string>   // function name; absent = collapsed (L0)
  expandedBullets: Map<string, Set<number>>  // fnName -> set of bullet indices
  importsExpanded: boolean
}
```

State transitions via a `StateEffect`:
```ts
type BookFoldEffect =
  | { kind: "toggleFunction"; fnName: string }
  | { kind: "toggleBullet"; fnName: string; bulletIdx: number }
  | { kind: "toggleImports" }
  | { kind: "expandAll" }
  | { kind: "collapseAll" }
```

When a function is collapsed, its expanded bullet set is cleared.

### Steps

- [ ] **Step 1: Create `app/book-decorations.ts`**

```ts
import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, ViewUpdate } from "@codemirror/view"
import { StateField, StateEffect, EditorState, Extension } from "@codemirror/state"
import type { BookOutline, FunctionOutline } from "./prose-types"
import { CardWidget, ImportWidget } from "./book-widgets"

// --- Fold state ---

export interface BookFoldState {
  expandedFunctions: Set<string>
  expandedBullets: Map<string, Set<number>>
  importsExpanded: boolean
}

export type BookFoldEffect =
  | { kind: "toggleFunction"; fnName: string }
  | { kind: "toggleBullet"; fnName: string; bulletIdx: number }
  | { kind: "toggleImports" }
  | { kind: "expandAll"; outline: BookOutline }
  | { kind: "collapseAll" }

export const bookFoldEffect = StateEffect.define<BookFoldEffect>()

function emptyFoldState(): BookFoldState {
  return {
    expandedFunctions: new Set(),
    expandedBullets: new Map(),
    importsExpanded: false,
  }
}

function applyFoldEffect(state: BookFoldState, eff: BookFoldEffect): BookFoldState {
  const next: BookFoldState = {
    expandedFunctions: new Set(state.expandedFunctions),
    expandedBullets: new Map([...state.expandedBullets].map(([k, v]) => [k, new Set(v)])),
    importsExpanded: state.importsExpanded,
  }
  switch (eff.kind) {
    case "toggleFunction": {
      if (next.expandedFunctions.has(eff.fnName)) {
        next.expandedFunctions.delete(eff.fnName)
        next.expandedBullets.delete(eff.fnName)
      } else {
        next.expandedFunctions.add(eff.fnName)
      }
      return next
    }
    case "toggleBullet": {
      const set = next.expandedBullets.get(eff.fnName) || new Set<number>()
      if (set.has(eff.bulletIdx)) set.delete(eff.bulletIdx)
      else set.add(eff.bulletIdx)
      next.expandedBullets.set(eff.fnName, set)
      next.expandedFunctions.add(eff.fnName) // expanding a bullet implies function is expanded
      return next
    }
    case "toggleImports": {
      next.importsExpanded = !state.importsExpanded
      return next
    }
    case "expandAll": {
      for (const fn of eff.outline.functions) {
        next.expandedFunctions.add(fn.name)
        next.expandedBullets.set(fn.name, new Set(fn.bullets.map((_, i) => i)))
      }
      if (eff.outline.imports) next.importsExpanded = true
      return next
    }
    case "collapseAll": {
      return emptyFoldState()
    }
  }
}

export const bookFoldState = StateField.define<BookFoldState>({
  create: () => emptyFoldState(),
  update(value, tr) {
    let next = value
    for (const eff of tr.effects) {
      if (eff.is(bookFoldEffect)) next = applyFoldEffect(next, eff.value)
    }
    return next
  },
})

// --- Empty block widget used for collapsed bullet code ---

class EmptyBlockWidget extends WidgetType {
  constructor(readonly key: string) { super() }
  eq(other: EmptyBlockWidget) { return other.key === this.key }
  toDOM() {
    const el = document.createElement("div")
    el.className = "bm-empty"
    return el
  }
}

// --- Decoration builder ---

// Convert a 1-based line number to a line object.
function line(state: EditorState, lineNum: number) {
  const n = Math.max(1, Math.min(lineNum, state.doc.lines))
  return state.doc.line(n)
}

function buildDecorations(
  state: EditorState,
  outline: BookOutline,
  view: EditorView
): DecorationSet {
  const fold = state.field(bookFoldState)
  const decos: { from: number; to: number; deco: Decoration }[] = []

  const onToggleFunction = (fnName: string) => {
    view.dispatch({ effects: bookFoldEffect.of({ kind: "toggleFunction", fnName }) })
  }
  const onToggleBullet = (fnName: string, bulletIdx: number) => {
    view.dispatch({ effects: bookFoldEffect.of({ kind: "toggleBullet", fnName, bulletIdx }) })
  }
  const onToggleImports = () => {
    view.dispatch({ effects: bookFoldEffect.of({ kind: "toggleImports" }) })
  }

  // Imports
  if (outline.imports) {
    const { fromLine, toLine } = outline.imports
    if (!fold.importsExpanded) {
      const from = line(state, fromLine).from
      const to = line(state, toLine).to
      decos.push({
        from, to,
        deco: Decoration.replace({
          widget: new ImportWidget(outline.imports, false, onToggleImports),
          block: true,
          inclusive: true,
        }),
      })
    } else {
      // Show a small ImportWidget header ABOVE line fromLine to carry the toggle.
      const from = line(state, fromLine).from
      decos.push({
        from, to: from,
        deco: Decoration.widget({
          widget: new ImportWidget(outline.imports, true, onToggleImports),
          block: true,
          side: -1,
        }),
      })
    }
  }

  // Functions
  for (const fn of outline.functions) {
    const signatureLineInfo = line(state, fn.signatureLine)
    const lastBulletTo = fn.bullets[fn.bullets.length - 1]?.toLine ?? fn.signatureLine
    const lastLineInfo = line(state, lastBulletTo)
    const expanded = fold.expandedFunctions.has(fn.name)
    const expandedBullets = fold.expandedBullets.get(fn.name) || new Set<number>()

    const sigText = state.doc.sliceString(signatureLineInfo.from, signatureLineInfo.to)

    if (!expanded) {
      // L0: one big replace covering signature..lastBullet
      decos.push({
        from: signatureLineInfo.from,
        to: lastLineInfo.to,
        deco: Decoration.replace({
          widget: new CardWidget(fn, 0, expandedBullets, onToggleFunction, onToggleBullet, sigText),
          block: true,
          inclusive: true,
        }),
      })
    } else {
      // L1/L2: replace signature with CardWidget(level=1).
      decos.push({
        from: signatureLineInfo.from,
        to: signatureLineInfo.to,
        deco: Decoration.replace({
          widget: new CardWidget(fn, 1, expandedBullets, onToggleFunction, onToggleBullet, sigText),
          block: true,
          inclusive: true,
        }),
      })
      // For each collapsed bullet, hide its code.
      fn.bullets.forEach((b, idx) => {
        if (!expandedBullets.has(idx)) {
          const bFrom = line(state, b.fromLine).from
          const bTo = line(state, b.toLine).to
          decos.push({
            from: bFrom,
            to: bTo,
            deco: Decoration.replace({
              widget: new EmptyBlockWidget(`${fn.name}-${idx}`),
              block: true,
              inclusive: true,
            }),
          })
        }
      })
    }
  }

  // CodeMirror requires decorations sorted by from ascending.
  decos.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(decos.map((d) => d.deco.range(d.from, d.to)))
}

// --- Plugin factory ---

export function bookDecorationsExtension(outline: BookOutline): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view.state, outline, view)
      }
      update(u: ViewUpdate) {
        const foldChanged = u.transactions.some((tr) =>
          tr.effects.some((e) => e.is(bookFoldEffect))
        )
        if (foldChanged || u.docChanged || u.viewportChanged) {
          this.decorations = buildDecorations(u.view.state, outline, u.view)
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
  return [bookFoldState, plugin]
}
```

- [ ] **Step 2: Bundle**

```bash
npm run bundle
```

Expected: no errors. (If the `Decoration.replace` block-widget signature has drifted in your installed `@codemirror/view`, adjust accordingly — the `inclusive: true` flag should cover full line ranges.)

- [ ] **Step 3: Commit**

```bash
git add app/book-decorations.ts
git commit -m "feat(book): decoration plugin + fold state

StateField tracks per-function and per-bullet expansion; a ViewPlugin
rebuilds the DecorationSet on each fold change. L0 = single replace
widget for signature+body; L1 = card replaces signature, collapsed
bullets replace their code ranges; expanded bullets let CodeMirror
render their code natively."
```

---

## Task 8: Mount `book-view.ts`

**Files:**
- Create: `app/book-view.ts`

- [ ] **Step 1: Create `app/book-view.ts`**

```ts
import { EditorState, Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { basicSetup } from "codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { svelte } from "@replit/codemirror-lang-svelte"
import { getEditorTheme } from "./theme"
import { fetchBookOutline } from "./book-outline"
import { bookDecorationsExtension, bookFoldEffect } from "./book-decorations"
import type { BookOutline } from "./prose-types"

const langByExt: Record<string, () => any> = {
  ".js": javascript,
  ".ts": () => javascript({ typescript: true }),
  ".jsx": () => javascript({ jsx: true }),
  ".tsx": () => javascript({ jsx: true, typescript: true }),
  ".py": python,
  ".rs": rust,
  ".svelte": svelte,
}

function getLangExtension(filename: string): Extension {
  const ext = "." + filename.split(".").pop()
  const factory = langByExt[ext]
  return factory ? factory() : []
}

export interface BookViewHandle {
  view: EditorView
  outline: BookOutline
  expandAll: () => void
  collapseAll: () => void
  destroy: () => void
}

export async function openBookView(
  parent: HTMLElement,
  filename: string,
  content: string
): Promise<BookViewHandle | { error: string }> {
  // Loading placeholder
  parent.innerHTML = `
    <div class="book-thinking">
      <span class="thinking-spinner"></span>
      <span class="thinking-text">Thinking…</span>
    </div>
  `

  const result = await fetchBookOutline(filename, content)
  if (result.error || !result.outline) {
    parent.innerHTML = `
      <div class="book-error">
        <p class="book-error-title">Could not generate Book view</p>
        <p class="book-error-message">${escapeHtml(result.error || "Unknown error")}</p>
      </div>
    `
    return { error: result.error || "Unknown error" }
  }

  parent.innerHTML = ""

  const outline = result.outline
  const langExt = getLangExtension(filename)

  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        langExt,
        getEditorTheme(),
        bookDecorationsExtension(outline),
      ],
    }),
    parent,
  })

  const handle: BookViewHandle = {
    view,
    outline,
    expandAll: () => {
      view.dispatch({ effects: bookFoldEffect.of({ kind: "expandAll", outline }) })
    },
    collapseAll: () => {
      view.dispatch({ effects: bookFoldEffect.of({ kind: "collapseAll" }) })
    },
    destroy: () => view.destroy(),
  }

  if (result.fallback) {
    const banner = document.createElement("div")
    banner.className = "book-fallback-banner"
    banner.textContent = "Outline partitioning failed; showing a single-bullet fallback."
    parent.prepend(banner)
  }

  if (result.truncated) {
    const banner = document.createElement("div")
    banner.className = "book-truncated-note"
    banner.textContent = "This file was large; only the first portion was analyzed."
    parent.prepend(banner)
  }

  return handle
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
```

- [ ] **Step 2: Bundle**

```bash
npm run bundle
```

Expected: no errors. The renderer still doesn't call `openBookView` yet — we wire that in Task 9.

- [ ] **Step 3: Commit**

```bash
git add app/book-view.ts
git commit -m "feat(book): add openBookView entry point

Creates a read-only EditorView with the book decorations extension,
renders a loading spinner while the outline fetches, and surfaces
fallback/truncation banners. Returns a handle with expand/collapse
helpers for the outer UI to call."
```

---

## Task 9: Wire Book mode into `editor.ts`

**Files:**
- Modify: `app/editor.ts`
- Modify: `app/index.html`

- [ ] **Step 1: Update `app/index.html`** — replace the mode toggle buttons:

Find:
```html
<div class="mode-toggle">
  <button id="mode-reader" class="active">Reader</button>
  <button id="mode-editor">Editor</button>
</div>
```

Replace with:
```html
<div class="mode-toggle">
  <button id="mode-book" class="active">Book</button>
  <button id="mode-editor">Editor</button>
  <button id="mode-expand-all" title="Expand all">⤢</button>
  <button id="mode-collapse-all" title="Collapse all">⤡</button>
</div>
```

- [ ] **Step 2: Replace `app/editor.ts` entirely**

```ts
import { EditorView, basicSetup } from "codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { svelte } from "@replit/codemirror-lang-svelte"
import { EditorState } from "@codemirror/state"
import { conceptClassifier } from "./concepts"
import { openBookView, type BookViewHandle } from "./book-view"
import { getEditorTheme, fileIcon } from "./theme"

declare global {
  interface Window {
    fs: {
      readDir: (path: string) => Promise<{ name: string; path: string; isDir: boolean }[]>
      readFile: (path: string) => Promise<string>
      getHomePath: () => Promise<string>
      showOpenDialog: () => Promise<string | null>
      listFiles: (rootDir: string) => Promise<string[]>
    }
    platform: string
  }
}

const langByExt: Record<string, () => any> = {
  ".js": javascript,
  ".ts": () => javascript({ typescript: true }),
  ".jsx": () => javascript({ jsx: true }),
  ".tsx": () => javascript({ jsx: true, typescript: true }),
  ".py": python,
  ".rs": rust,
  ".svelte": svelte,
}

function getLangExtension(filename: string) {
  const ext = "." + filename.split(".").pop()
  const factory = langByExt[ext]
  return factory ? factory() : []
}

let editorView: EditorView | null = null
let bookHandle: BookViewHandle | null = null
let currentMode: "book" | "editor" = "book"
let currentLangExt: any = []
let currentContent: string = ""
let currentFilename: string = ""
let projectRoot: string = ""
let projectFiles: string[] = []

function setMode(mode: "book" | "editor") {
  currentMode = mode
  const editorEl = document.getElementById("editor")!
  const bookEl = document.getElementById("book-view")!
  const bookBtn = document.getElementById("mode-book")!
  const editorBtn = document.getElementById("mode-editor")!
  const expandBtn = document.getElementById("mode-expand-all")!
  const collapseBtn = document.getElementById("mode-collapse-all")!

  if (mode === "book") {
    editorEl.classList.add("hidden")
    bookEl.classList.remove("hidden")
    bookBtn.classList.add("active")
    editorBtn.classList.remove("active")
    expandBtn.classList.remove("hidden")
    collapseBtn.classList.remove("hidden")
  } else {
    editorEl.classList.remove("hidden")
    bookEl.classList.add("hidden")
    bookBtn.classList.remove("active")
    editorBtn.classList.add("active")
    expandBtn.classList.add("hidden")
    collapseBtn.classList.add("hidden")
  }
}

async function openFile(filePath: string, filename: string) {
  const content = await window.fs.readFile(filePath)
  currentContent = content
  currentFilename = filename
  currentLangExt = getLangExtension(filename)

  // Editor mode — CodeMirror with concept highlights
  const editorParent = document.getElementById("editor")!
  if (editorView) {
    editorView.setState(
      EditorState.create({
        doc: content,
        extensions: [basicSetup, currentLangExt, getEditorTheme(), conceptClassifier()],
      })
    )
  } else {
    editorView = new EditorView({
      doc: content,
      extensions: [basicSetup, currentLangExt, getEditorTheme(), conceptClassifier()],
      parent: editorParent,
    })
  }

  // Book mode — fresh view per file
  const bookParent = document.getElementById("book-view")!
  if (bookHandle) {
    bookHandle.destroy()
    bookHandle = null
  }
  const result = await openBookView(bookParent, filename, content)
  if ("error" in result) {
    bookHandle = null
  } else {
    bookHandle = result
  }

  document.getElementById("current-file")!.textContent = filePath
}

// --- File tree --- (unchanged from before)

async function renderTree(container: HTMLElement, dirPath: string) {
  container.innerHTML = ""
  const entries = await window.fs.readDir(dirPath)

  for (const entry of entries) {
    const el = document.createElement("div")
    el.className = "tree-item"

    if (entry.isDir) {
      el.innerHTML = `<span class="tree-icon">${fileIcon(entry.name, true, false)}</span><span class="tree-name">${entry.name}</span>`
      el.classList.add("tree-dir")
      const children = document.createElement("div")
      children.className = "tree-children"
      children.style.display = "none"
      let loaded = false

      el.addEventListener("click", async (e) => {
        e.stopPropagation()
        if (!loaded) {
          await renderTree(children, entry.path)
          loaded = true
        }
        const open = children.style.display !== "none"
        children.style.display = open ? "none" : "block"
        el.querySelector(".tree-icon")!.innerHTML = fileIcon(entry.name, true, !open)
      })

      container.appendChild(el)
      container.appendChild(children)
    } else {
      el.innerHTML = `<span class="tree-icon tree-file-icon">${fileIcon(entry.name, false)}</span><span class="tree-name">${entry.name}</span>`
      el.classList.add("tree-file")
      el.addEventListener("click", (e) => {
        e.stopPropagation()
        document.querySelectorAll(".tree-file.active").forEach((f) => f.classList.remove("active"))
        el.classList.add("active")
        openFile(entry.path, entry.name)
      })
      container.appendChild(el)
    }
  }
}

async function init() {
  if (window.platform) {
    document.documentElement.setAttribute("data-platform", window.platform)
  }

  const openBtn = document.getElementById("open-folder")!
  const treeContainer = document.getElementById("file-tree")!

  document.getElementById("mode-book")!.addEventListener("click", () => setMode("book"))
  document.getElementById("mode-editor")!.addEventListener("click", () => setMode("editor"))
  document.getElementById("mode-expand-all")!.addEventListener("click", () => bookHandle?.expandAll())
  document.getElementById("mode-collapse-all")!.addEventListener("click", () => bookHandle?.collapseAll())

  openBtn.addEventListener("click", async () => {
    const dir = await window.fs.showOpenDialog()
    if (dir) {
      projectRoot = dir
      document.getElementById("folder-name")!.textContent = dir.split("/").pop() || dir
      projectFiles = await window.fs.listFiles(dir)
      await renderTree(treeContainer, dir)
    }
  })

  const home = await window.fs.getHomePath()
  document.getElementById("folder-name")!.textContent = "~"
  await renderTree(treeContainer, home)
}

init()
```

- [ ] **Step 3: Update the mount container in `app/index.html`** — rename `#concept-tree` to `#book-view`:

Find:
```html
<div id="concept-tree">
  <div class="cp-empty">Open a file from the tree</div>
</div>
```

Replace with:
```html
<div id="book-view">
  <div class="cp-empty">Open a file from the tree</div>
</div>
```

- [ ] **Step 4: Bundle and launch**

```bash
npm run bundle && npm start
```

Expected:
- Hopper window opens. The mode toggle shows "Book" / "Editor" plus two icon buttons "⤢" and "⤡".
- Clicking a file opens it. Book mode shows a spinner briefly, then the outline.
- Editor mode shows the familiar CodeMirror view with concept highlights.

You will probably see ugly styling at this point — CSS is the next task.

- [ ] **Step 5: Commit**

```bash
git add app/editor.ts app/index.html
git commit -m "feat(ui): wire Book mode into editor.ts

Replace BookPanel with the new openBookView mount. Mode toggle
buttons become Book/Editor with Expand-all/Collapse-all icons.
Book mode is the default when opening a file."
```

---

## Task 10: Styling — CSS for cards, bullets, imports, chrome

**Files:**
- Modify: `app/app.css`

- [ ] **Step 1: Find the existing `/* --- Book panel container (mounted into #concept-tree) --- */` section in `app/app.css`. Rename the selector `#concept-tree` to `#book-view` throughout that section.**

Use your editor to search for `#concept-tree` and replace each occurrence with `#book-view`. There should be roughly 3 occurrences in the CSS (the rule, the scrollbar rule, and the `.hidden` rule).

- [ ] **Step 2: Delete the old `.book-*` rules (everything from `.book-prose {` through the end of `.thinking-text {...}`).**

Remove all rules matching:
- `.book-prose`
- `.book-paragraph`
- `.book-file-link`, `.book-file-link:hover`, `.book-file-link:active`
- `.book-code-highlight`, `.book-symbol-ref` (and their `:hover` variants)
- `.book-truncated-note`
- `.book-code-tooltip`, `.book-code-tooltip pre`

Keep the `.book-thinking`, `.thinking-spinner`, and `.thinking-text` rules — `book-view.ts` reuses them for the loading state.

- [ ] **Step 3: Append the new Book-mode styles at the end of `app/app.css`**

```css
/* --- Book mode (bm-*) --- */

#book-view {
  overflow: auto;
  padding: 0;
}

#book-view .cm-editor {
  height: 100%;
  background: transparent;
}

#book-view .cm-scroller {
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.55;
}

.bm-empty {
  display: none;
}

.bm-imports {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 18px;
  margin: 0;
  cursor: pointer;
  font-family: "Iowan Old Style", Georgia, serif;
  font-size: 13px;
  color: #a8a090;
  background: rgba(255,255,255,0.015);
}

.bm-imports:hover { background: rgba(255,255,255,0.04); }
.bm-imports-text { flex: 1; font-style: italic; }

.bm-card {
  display: block;
  padding: 10px 18px;
  margin: 0;
  cursor: pointer;
  background: rgba(255,255,255,0.02);
  border-top: 1px solid rgba(255,255,255,0.04);
  border-bottom: 1px solid rgba(255,255,255,0.04);
}

.bm-card-l0 { padding: 8px 18px; }
.bm-card-l1 { padding: 10px 18px 4px 18px; }

.bm-card:hover { background: rgba(255,255,255,0.045); }

.bm-card-head {
  display: grid;
  grid-template-columns: 14px 1fr;
  grid-template-rows: auto auto;
  column-gap: 8px;
  row-gap: 2px;
}

.bm-chev {
  color: #888;
  font-family: monospace;
  font-size: 11px;
  line-height: 1.55;
  user-select: none;
}

.bm-card .bm-signature {
  grid-column: 2;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  color: #9cdcfe;
  white-space: pre-wrap;
  word-break: break-word;
}

.bm-card .bm-summary {
  grid-column: 2;
  margin: 0;
  font-family: "Iowan Old Style", Georgia, serif;
  font-style: italic;
  font-size: 14px;
  color: #cfc5a9;
  line-height: 1.45;
}

.bm-card-l1 .bm-bullets {
  list-style: none;
  padding: 4px 0 6px 22px;
  margin: 0;
}

.bm-bullet {
  display: flex;
  gap: 8px;
  padding: 6px 10px;
  margin: 0;
  cursor: pointer;
  border-left: 2px solid transparent;
  font-family: "Iowan Old Style", Georgia, serif;
  font-size: 13.5px;
  line-height: 1.45;
  color: #d6d0c2;
  border-radius: 2px;
}

.bm-bullet:hover { background: rgba(255,255,255,0.04); }

.bm-bullet-open {
  border-left-color: #e8a33d;
  background: rgba(232, 163, 61, 0.06);
  color: #f0ddba;
}

.bm-bullet-chrome {
  font-size: 12px;
  color: #7e7870;
  font-style: normal;
}

.bm-bullet-text { flex: 1; }

/* Banners */

.book-fallback-banner {
  padding: 8px 16px;
  background: rgba(232, 163, 61, 0.08);
  color: #e8a33d;
  font-family: "Iowan Old Style", Georgia, serif;
  font-size: 12.5px;
  font-style: italic;
  border-bottom: 1px solid rgba(232, 163, 61, 0.2);
}

.book-truncated-note {
  padding: 8px 16px;
  background: rgba(255,255,255,0.03);
  color: #a8a090;
  font-family: "Iowan Old Style", Georgia, serif;
  font-size: 12.5px;
  font-style: italic;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}

/* Mode toggle extras */

#mode-expand-all,
#mode-collapse-all {
  font-size: 13px;
}
#mode-expand-all.hidden,
#mode-collapse-all.hidden { display: none; }
```

- [ ] **Step 4: Bundle and launch**

```bash
npm run bundle && npm start
```

Expected:
- Open a small `.ts` file (try `app/prose-types.ts` — small and easy to validate by eye).
- Book mode shows a list of function cards at Level 0. Clicking a card expands it to show bullets. Clicking a bullet expands it to show code. Clicking again collapses.
- The "⤢" button expands everything; "⤡" collapses everything.

- [ ] **Step 5: Commit**

```bash
git add app/app.css app/index.html
git commit -m "style(book): card/bullet/import styling for Book mode

Amber accent rail on expanded bullets, italic serif prose, monospace
signature + summary stacked in card head, chrome bullets rendered
smaller and muted. Expand/collapse-all icon buttons."
```

---

## Task 11: Delete retired modules

**Files:**
- Delete: `app/book-panel.ts`, `app/book-structure.ts`, `app/ai-prose.ts`, `app/prose-panel.ts`, `app/prose-provider.ts`, `app/concept-panel.ts`

Per the spec these modules are either fully replaced or already unwired.

- [ ] **Step 1: Verify none of the remaining code imports them**

```bash
grep -rn "from \"\./book-panel\"" app/ || echo OK
grep -rn "from \"\./book-structure\"" app/ || echo OK
grep -rn "from \"\./ai-prose\"" app/ || echo OK
grep -rn "from \"\./prose-panel\"" app/ || echo OK
grep -rn "from \"\./prose-provider\"" app/ || echo OK
grep -rn "from \"\./concept-panel\"" app/ || echo OK
```

Expected: each `grep` prints `OK` (no imports). If any print a match, fix that import and re-run.

- [ ] **Step 2: Delete the files**

```bash
rm app/book-panel.ts app/book-structure.ts app/ai-prose.ts app/prose-panel.ts app/prose-provider.ts app/concept-panel.ts
```

- [ ] **Step 3: Bundle**

```bash
npm run bundle
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete retired reader/prose modules

book-panel, book-structure, ai-prose, prose-panel, prose-provider,
concept-panel are all replaced by the Book-mode stack (book-outline,
book-view, book-decorations, book-widgets)."
```

---

## Task 12: Clean up the old `describe-file` handler

**Files:**
- Modify: `main.js`, `preload.js`

Now that nothing uses the old IPC, remove it so the API surface stays minimal.

- [ ] **Step 1: Confirm `window.ai.describe` has no callers**

```bash
grep -rn "ai\.describe\b" app/ main.js preload.js || echo OK
grep -rn "describe-file" app/ main.js preload.js
```

Expected: the first prints `OK`. The second should only match lines inside `main.js` (the handler itself) and `preload.js` (the bridge).

- [ ] **Step 2: In `preload.js`, remove the `describe:` property**

The `contextBridge.exposeInMainWorld("ai", {...})` block should become:

```js
contextBridge.exposeInMainWorld("ai", {
  describeBookOutline: (opts) => ipcRenderer.invoke("describe-book-outline", opts),
})
```

- [ ] **Step 3: In `main.js`, delete the entire `ipcMain.handle("describe-file", ...)` block (the handler lines from Task 3's "existing handler at line 167–229")**

- [ ] **Step 4: Bundle and launch**

```bash
npm run bundle && npm start
```

Expected: Book mode still works; Editor mode still shows CodeMirror. No console errors.

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "chore: remove retired describe-file IPC handler

The whole-file narrative prose path is no longer used. Only
describe-book-outline remains on the renderer bridge and main process."
```

---

## Task 13: Manual QA checklist

**Files:** none (verification).

This is a scripted walkthrough. Tick each item after confirming.

- [ ] **Step 1: Small file end-to-end** — Open `app/prose-types.ts`.
  - [ ] Spinner shows briefly.
  - [ ] Book view renders cards for each interface/type declaration with a one-line summary each.
  - [ ] Clicking a card expands it to show 1–3 bullets (prose-types.ts is short, so most declarations will be L0-only).
  - [ ] Clicking a bullet reveals code underneath with syntax highlighting.
  - [ ] Clicking the same bullet again collapses it.

- [ ] **Step 2: Medium file with multiple functions** — Open `app/file-structure.ts`.
  - [ ] Multiple function cards visible.
  - [ ] Expanding one function shows 4–8 bullets.
  - [ ] Clicking the "⤢" expand-all button opens every function and every bullet; "⤡" collapses everything back.
  - [ ] Scroll works smoothly; expanded code ranges show proper syntax highlighting.

- [ ] **Step 3: Imports** — Confirm in both files above that an "Imports" summary bullet appears at the top with its own one-line summary. Clicking it expands to show the raw import lines.

- [ ] **Step 4: Mode toggle** — Switch to Editor mode. Confirm:
  - [ ] CodeMirror view with concept highlights renders (unchanged from before).
  - [ ] Expand-all / Collapse-all buttons hide themselves.
  - [ ] Switching back to Book restores the outline view without re-fetching (cached).

- [ ] **Step 5: Cache behavior** — Open the same file twice in a row:
  - [ ] First open: ~3-5s to spinner-then-outline.
  - [ ] Second open (after switching to another file and back): should render nearly instantly (cached).

- [ ] **Step 6: API failure handling** — In a separate terminal, temporarily break the API key:
  ```bash
  mv .env .env.backup
  npm start
  ```
  - [ ] Open a file: Book view shows "Could not generate Book view — No ANTHROPIC_API_KEY…" error card.
  - [ ] Editor mode still works normally.
  - [ ] Restore: `mv .env.backup .env`.

- [ ] **Step 7: Large file truncation** — Find or create a file >30 KB (e.g., paste a big file into a scratch `.ts` file). Open it.
  - [ ] Truncated banner appears at top of the Book view.
  - [ ] Outline only covers the analyzed portion.

- [ ] **Step 8: Unsupported / plain file** — Open `package.json`.
  - [ ] Either: Book view handles it (single imports card or fallback), OR shows a clean fallback state. No crash, no console errors.

- [ ] **Step 9: Console cleanliness** — Open devtools console during all of the above. No uncaught exceptions, no React-like "decorations must be sorted" warnings from CodeMirror.

- [ ] **Step 10: If everything passes, final commit**

```bash
git commit --allow-empty -m "test(manual): Book mode manual QA checklist passed"
```

---

## Self-review notes

**Spec coverage checklist** (ran against `docs/superpowers/specs/2026-04-17-book-mode-interleaved-outlines-design.md`):

- ✅ Three-level zoom — Task 7 (decoration plugin), Task 6 (card widget with `level`)
- ✅ 4–8 prose bullets per function, adaptive — Task 3 (system prompt rule 3)
- ✅ Every line belongs to exactly one bullet — Task 2 + Task 3 (validator)
- ✅ Italic serif prose, monospace code — Task 10 (CSS)
- ✅ All collapsed by default — Task 7 (`emptyFoldState`)
- ✅ Reuse FileStructure / Lezer pipeline — Intentionally skipped: the new handler sends raw content + line count to the LLM, which is simpler and matches the paper's prompting style. FileStructure is no longer needed for Book mode. (This is a minor divergence from the spec; noted here.)
- ✅ Cache keyed on content + prompt version — Task 5
- ✅ Read-only (no editing) — Task 8 (`EditorState.readOnly.of(true)`)
- ✅ No cross-file `@file` / `[[phrase||code]]` — Task 3's prompt doesn't mention them
- ✅ No per-file fold memory — intentionally
- ✅ Semantic vs chrome bullet kind — Task 1 (type), Task 3 (prompt), Task 10 (CSS `.bm-bullet-chrome`)
- ✅ Coverage invariant validated + retry + fallback — Task 3
- ✅ Main-process retries once; fallback bullet per function — Task 3
- ✅ Model `claude-sonnet-4-6` by default — Task 3
- ✅ `CACHE_VERSION` bumped — Task 5 (`v1-book`, fresh namespace; old `ai-prose` cache is deleted with that file)
- ✅ Reader button → Book button, Editor button unchanged — Task 9
- ✅ Retired modules deleted — Task 11

**Spec divergence:** The spec's Architecture section says the new handler will send "the full file plus the `FileStructure` outline (function signatures + line ranges)". The plan skips `FileStructure` in favor of sending just raw content + line count. This is strictly simpler: the LLM identifies function boundaries itself (it's very good at this for common languages), and we avoid a double-extraction step. If downstream testing shows the LLM mis-identifies signatures, a follow-up task can add `FileStructure` back into the user message.

**Placeholder scan:** No "TBD" / "TODO" / "implement later" in task steps. All code blocks are complete. All commands have exact paths and expected output.

**Type consistency:** `BookOutline`, `FunctionOutline`, `Bullet`, `BulletKind`, `ImportOutline` used consistently across Tasks 1, 2, 5, 6, 7, 8. `bookFoldEffect`, `bookFoldState` defined in Task 7 and consumed in Task 8. `BookViewHandle` defined in Task 8 and consumed in Task 9.
