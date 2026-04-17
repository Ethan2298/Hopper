import type { EditorView } from "@codemirror/view"
import type { FileNode } from "./prose-types"
import { extractFileStructure } from "./file-structure"
import type { ReaderUnit, ReaderUnitKind } from "./prose-types"

function nodeKindToUnitKind(kind: FileNode["kind"]): ReaderUnitKind {
  switch (kind) {
    case "function": return "function"
    case "class": return "class"
    case "type": return "type"
    case "variable": return "variable"
    case "import": return "import-block"
    case "export": return "other"
    case "control": return "other"
    default: return "other"
  }
}

function offsetToLine(view: EditorView, offset: number): number {
  const n = Math.max(0, Math.min(offset, view.state.doc.length))
  return view.state.doc.lineAt(n).number
}

/**
 * Derive flat, indexed ReaderUnits from a file's AST.
 * Imports are coalesced into a single "import-block" unit.
 * Top-level declarations each become one unit, in source order.
 */
export function extractReaderUnits(view: EditorView, filename: string): ReaderUnit[] {
  const structure = extractFileStructure(view, filename)
  const doc = view.state.doc
  const units: ReaderUnit[] = []

  // Coalesced imports unit
  if (structure.imports.length > 0) {
    const from = Math.min(...structure.imports.map((n) => n.from))
    const to = Math.max(...structure.imports.map((n) => n.to))
    const fromLine = offsetToLine(view, from)
    const toLine = offsetToLine(view, to)
    units.push({
      index: units.length,
      kind: "import-block",
      name: "Imports",
      signatureLine: fromLine,
      fromLine,
      toLine,
      isMultiLine: fromLine < toLine,
      source: doc.sliceString(from, to),
    })
  }

  // One unit per top-level declaration, in source order
  const decls = [...structure.declarations].sort((a, b) => a.from - b.from)
  for (const decl of decls) {
    const fromLine = offsetToLine(view, decl.from)
    const toLine = offsetToLine(view, decl.to)
    units.push({
      index: units.length,
      kind: nodeKindToUnitKind(decl.kind),
      name: decl.name || decl.kind,
      signatureLine: fromLine,
      fromLine,
      toLine,
      isMultiLine: fromLine < toLine,
      source: doc.sliceString(decl.from, decl.to),
    })
  }

  return units
}
