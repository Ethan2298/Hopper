import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin } from "@codemirror/view"
import { StateField, StateEffect, EditorState, Extension } from "@codemirror/state"
import type { BookOutline } from "./prose-types"
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

/**
 * Position of the end of a line INCLUDING its trailing newline.
 * Needed as the `to` of block-replace decorations so CodeMirror
 * treats the range as whole lines and hides the gutter entries.
 */
function lineEndIncl(state: EditorState, lineNum: number) {
  const n = Math.max(1, Math.min(lineNum, state.doc.lines))
  if (n < state.doc.lines) return state.doc.line(n + 1).from
  return state.doc.line(n).to
}

interface BookCallbacks {
  onToggleFunction: (fnName: string) => void
  onToggleBullet: (fnName: string, bulletIdx: number) => void
  onToggleImports: () => void
}

function buildDecorations(
  state: EditorState,
  outline: BookOutline,
  cb: BookCallbacks
): DecorationSet {
  const fold = state.field(bookFoldState)
  const decos: { from: number; to: number; deco: Decoration }[] = []

  const onToggleFunction = cb.onToggleFunction
  const onToggleBullet = cb.onToggleBullet
  const onToggleImports = cb.onToggleImports

  // Imports
  if (outline.imports) {
    const { fromLine, toLine } = outline.imports
    if (!fold.importsExpanded) {
      const from = line(state, fromLine).from
      const to = lineEndIncl(state, toLine)
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
    const expanded = fold.expandedFunctions.has(fn.name)
    const expandedBullets = fold.expandedBullets.get(fn.name) || new Set<number>()

    const sigText = state.doc.sliceString(signatureLineInfo.from, signatureLineInfo.to)

    if (!expanded) {
      // L0: one big replace covering signature..lastBullet
      decos.push({
        from: signatureLineInfo.from,
        to: lineEndIncl(state, lastBulletTo),
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
        to: lineEndIncl(state, fn.signatureLine),
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
          const bTo = lineEndIncl(state, b.toLine)
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

// --- Extension factory ---
//
// CodeMirror 6 requires BLOCK decorations to come from a StateField, not a
// ViewPlugin. We build the DecorationSet in a StateField, but we still need
// a reference to the EditorView so click handlers can dispatch StateEffects.
// A tiny ViewPlugin captures the view into a closure that the StateField's
// callbacks read when building widgets.

export function bookDecorationsExtension(outline: BookOutline): Extension {
  let viewRef: EditorView | null = null

  const cb: BookCallbacks = {
    onToggleFunction: (fnName) => {
      viewRef?.dispatch({ effects: bookFoldEffect.of({ kind: "toggleFunction", fnName }) })
    },
    onToggleBullet: (fnName, bulletIdx) => {
      viewRef?.dispatch({ effects: bookFoldEffect.of({ kind: "toggleBullet", fnName, bulletIdx }) })
    },
    onToggleImports: () => {
      viewRef?.dispatch({ effects: bookFoldEffect.of({ kind: "toggleImports" }) })
    },
  }

  const decorationField = StateField.define<DecorationSet>({
    create(state) {
      try {
        return buildDecorations(state, outline, cb)
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
        return buildDecorations(tr.state, outline, cb)
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
