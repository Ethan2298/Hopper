import { EditorView, Decoration, DecorationSet, ViewPlugin } from "@codemirror/view"
import { StateField, StateEffect, EditorState, Extension } from "@codemirror/state"
import type { BookReaderOutline, ReaderUnit, OutlineStatement } from "./prose-types"
import { UnitOutlineWidget, GapWidget } from "./book-widgets"

// --- Fold state ---

/** Keys are `${unitIndex}:${statementIndex}`. */
export interface BookFoldState {
  expanded: Set<string>
}

export type BookFoldEffect =
  | { kind: "toggleStatement"; unitIndex: number; statementIndex: number }
  | { kind: "expandAll"; outline: BookReaderOutline }
  | { kind: "collapseAll" }

export const bookFoldEffect = StateEffect.define<BookFoldEffect>()

function emptyFoldState(): BookFoldState {
  return { expanded: new Set() }
}

function foldKey(unitIndex: number, statementIndex: number): string {
  return `${unitIndex}:${statementIndex}`
}

function applyFoldEffect(state: BookFoldState, eff: BookFoldEffect): BookFoldState {
  const next: BookFoldState = { expanded: new Set(state.expanded) }
  switch (eff.kind) {
    case "toggleStatement": {
      const k = foldKey(eff.unitIndex, eff.statementIndex)
      if (next.expanded.has(k)) next.expanded.delete(k)
      else next.expanded.add(k)
      return next
    }
    case "expandAll": {
      for (const u of eff.outline.units) {
        next.expanded.add(foldKey(u.index, -1))
        const stmts = effectiveStatements(u, eff.outline.prose[u.index]?.statements || [])
        for (let i = 0; i < stmts.length; i++) next.expanded.add(foldKey(u.index, i))
      }
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

// --- Statement synthesis (fallbacks for units the LLM didn't chunk) ---

function countLines(source: string): number {
  if (!source) return 0
  return source.split("\n").length
}

/**
 * Normalize a unit's statements for rendering:
 * - import-block: one "Import dependencies." bullet covering the whole source
 * - multi-line, no statements: one "Body" bullet covering lines 2..end
 * - single-line: no bullets (heading is the whole source)
 * Otherwise: use the LLM's statements as-is.
 */
function effectiveStatements(unit: ReaderUnit, llmStatements: OutlineStatement[]): OutlineStatement[] {
  const total = countLines(unit.source)

  if (unit.kind === "import-block") {
    if (total <= 0) return []
    return [{ text: "Import dependencies.", startLine: 1, endLine: total }]
  }

  if (!unit.isMultiLine) return []

  if (llmStatements.length > 0) return llmStatements

  // Fallback: one bullet revealing the whole body (lines 2..total).
  if (total < 2) return []
  return [{ text: "Body.", startLine: 2, endLine: total }]
}

// --- Helpers ---

function line(state: EditorState, lineNum: number) {
  const n = Math.max(1, Math.min(lineNum, state.doc.lines))
  return state.doc.line(n)
}

/** End of line INCLUDING trailing newline, so block-replace covers full lines. */
function lineEndIncl(state: EditorState, lineNum: number) {
  const n = Math.max(1, Math.min(lineNum, state.doc.lines))
  if (n < state.doc.lines) return state.doc.line(n + 1).from
  return state.doc.line(n).to
}

// --- Decoration builder ---

function buildDecorations(
  state: EditorState,
  outline: BookReaderOutline,
  onToggle: (unitIndex: number, statementIndex: number) => void
): DecorationSet {
  const fold = state.field(bookFoldState)
  const decos: { from: number; to: number; deco: Decoration }[] = []

  // Track which line numbers belong to some unit so we can hide everything else
  // (top-level comments, blank lines, stray expressions that aren't declarations).
  const covered: boolean[] = new Array(state.doc.lines + 1).fill(false)

  const sortedUnits = [...outline.units].sort((a, b) => a.fromLine - b.fromLine)

  for (const unit of sortedUnits) {
    const unitProse = outline.prose[unit.index]
    const llmStatements = unitProse?.statements || []
    const statements = effectiveStatements(unit, llmStatements)
    const summary = unitProse?.summary || ""

    // eq()-friendly signature: unit-level flag + per-statement flags.
    const unitFlag = fold.expanded.has(foldKey(unit.index, -1)) ? "1" : "0"
    const stmtFlags = statements
      .map((_, i) => (fold.expanded.has(foldKey(unit.index, i)) ? "1" : "0"))
      .join("")
    const expandedSignature = `${unitFlag}|${stmtFlags}`

    const from = line(state, unit.fromLine).from
    const to = lineEndIncl(state, unit.toLine)

    decos.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new UnitOutlineWidget(
          unit,
          summary,
          statements,
          expandedSignature,
          fold.expanded,
          onToggle
        ),
        block: true,
        inclusive: true,
      }),
    })

    for (let ln = unit.fromLine; ln <= unit.toLine; ln++) {
      if (ln >= 1 && ln <= state.doc.lines) covered[ln] = true
    }
  }

  // Collapse all uncovered line runs into invisible gap widgets. This is what
  // kills leaked top-level JSDoc/comments between declarations.
  let runStart: number | null = null
  for (let ln = 1; ln <= state.doc.lines; ln++) {
    if (!covered[ln]) {
      if (runStart === null) runStart = ln
    } else if (runStart !== null) {
      pushGap(runStart, ln - 1)
      runStart = null
    }
  }
  if (runStart !== null) pushGap(runStart, state.doc.lines)

  function pushGap(startLine: number, endLine: number) {
    const from = line(state, startLine).from
    const to = lineEndIncl(state, endLine)
    decos.push({
      from,
      to,
      deco: Decoration.replace({
        widget: new GapWidget(),
        block: true,
        inclusive: true,
      }),
    })
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(decos.map((d) => d.deco.range(d.from, d.to)))
}

// --- Extension factory ---

export function bookDecorationsExtension(outline: BookReaderOutline): Extension {
  let viewRef: EditorView | null = null

  const onToggle = (unitIndex: number, statementIndex: number) => {
    viewRef?.dispatch({
      effects: bookFoldEffect.of({ kind: "toggleStatement", unitIndex, statementIndex }),
    })
  }

  const decorationField = StateField.define<DecorationSet>({
    create(state) {
      try {
        return buildDecorations(state, outline, onToggle)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[book] buildDecorations threw on init:", err, { outline })
        return Decoration.none
      }
    },
    update(value, tr) {
      const foldChanged = tr.effects.some((e) => e.is(bookFoldEffect))
      if (!foldChanged && !tr.docChanged) return value
      try {
        return buildDecorations(tr.state, outline, onToggle)
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[book] buildDecorations threw on update:", err)
        return value
      }
    },
    provide: (f) => EditorView.decorations.from(f),
  })

  const viewCapture = ViewPlugin.fromClass(
    class {
      constructor(view: EditorView) {
        viewRef = view
      }
      destroy() {
        if (viewRef) viewRef = null
      }
    }
  )

  return [bookFoldState, decorationField, viewCapture]
}
