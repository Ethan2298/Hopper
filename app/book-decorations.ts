import { EditorView, Decoration, DecorationSet, ViewPlugin } from "@codemirror/view"
import { StateField, StateEffect, EditorState, Extension } from "@codemirror/state"
import type { BookReaderOutline } from "./prose-types"
import { CardWidget } from "./book-widgets"

// --- Fold state ---

export interface BookFoldState {
  expandedUnits: Set<number>
}

export type BookFoldEffect =
  | { kind: "toggleUnit"; index: number }
  | { kind: "expandAll"; outline: BookReaderOutline }
  | { kind: "collapseAll" }

export const bookFoldEffect = StateEffect.define<BookFoldEffect>()

function emptyFoldState(): BookFoldState {
  return { expandedUnits: new Set() }
}

function applyFoldEffect(state: BookFoldState, eff: BookFoldEffect): BookFoldState {
  const next: BookFoldState = { expandedUnits: new Set(state.expandedUnits) }
  switch (eff.kind) {
    case "toggleUnit": {
      if (next.expandedUnits.has(eff.index)) next.expandedUnits.delete(eff.index)
      else next.expandedUnits.add(eff.index)
      return next
    }
    case "expandAll": {
      for (const u of eff.outline.units) next.expandedUnits.add(u.index)
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

// --- Helpers ---

function line(state: EditorState, lineNum: number) {
  const n = Math.max(1, Math.min(lineNum, state.doc.lines))
  return state.doc.line(n)
}

/** Position at end of a line INCLUDING its trailing newline, so block
 *  replace decorations cover whole lines and hide gutter entries. */
function lineEndIncl(state: EditorState, lineNum: number) {
  const n = Math.max(1, Math.min(lineNum, state.doc.lines))
  if (n < state.doc.lines) return state.doc.line(n + 1).from
  return state.doc.line(n).to
}

// --- Decoration builder ---

function buildDecorations(
  state: EditorState,
  outline: BookReaderOutline,
  onToggle: (unitIndex: number) => void
): DecorationSet {
  const fold = state.field(bookFoldState)
  const decos: { from: number; to: number; deco: Decoration }[] = []

  for (const unit of outline.units) {
    const expanded = fold.expandedUnits.has(unit.index)
    const prose = outline.prose[unit.index]

    if (!expanded) {
      // L0: replace the whole unit range with the collapsed card.
      const from = line(state, unit.fromLine).from
      const to = lineEndIncl(state, unit.toLine)
      decos.push({
        from,
        to,
        deco: Decoration.replace({
          widget: new CardWidget(unit, prose, 0, onToggle),
          block: true,
          inclusive: true,
        }),
      })
    } else {
      // L1: block widget ABOVE the unit's first line (card with bullets);
      // the code below renders natively.
      const from = line(state, unit.fromLine).from
      decos.push({
        from,
        to: from,
        deco: Decoration.widget({
          widget: new CardWidget(unit, prose, 1, onToggle),
          block: true,
          side: -1,
        }),
      })
    }
  }

  decos.sort((a, b) => a.from - b.from || a.to - b.to)
  return Decoration.set(decos.map((d) => d.deco.range(d.from, d.to)))
}

// --- Extension factory ---

export function bookDecorationsExtension(outline: BookReaderOutline): Extension {
  let viewRef: EditorView | null = null

  const onToggle = (unitIndex: number) => {
    viewRef?.dispatch({ effects: bookFoldEffect.of({ kind: "toggleUnit", index: unitIndex }) })
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
