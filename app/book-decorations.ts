import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, ViewUpdate } from "@codemirror/view"
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
