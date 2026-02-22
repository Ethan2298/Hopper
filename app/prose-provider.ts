import type { FileNode, FileStructure, AnnotatedFile, AnnotatedNode, InlineNote } from "./prose-types"
import { syntaxTree } from "@codemirror/language"
import { EditorView } from "@codemirror/view"

// --- Public interface ---

export interface ProseProvider {
  annotateFile(structure: FileStructure, view: EditorView): AnnotatedFile
}

// --- Utilities ---

/** loginUser → "login User", is_valid → "is valid" */
export function humanizeName(name: string): string {
  // Split camelCase
  let result = name.replace(/([a-z])([A-Z])/g, "$1 $2")
  // Split snake_case
  result = result.replace(/_/g, " ")
  // Split kebab-case
  result = result.replace(/-/g, " ")
  return result.trim()
}

function plural(n: number, word: string): string {
  return n === 1 ? `${n} ${word}` : `${n} ${word}s`
}

function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    function: "function",
    class: "class",
    variable: "variable",
    import: "import",
    export: "export",
    control: "control structure",
    type: "type definition",
  }
  return labels[kind] || kind
}

function groupByKind(nodes: FileNode[]): Map<string, FileNode[]> {
  const groups = new Map<string, FileNode[]>()
  for (const node of nodes) {
    let list = groups.get(node.kind)
    if (!list) {
      list = []
      groups.set(node.kind, list)
    }
    list.push(node)
  }
  return groups
}

// --- Template prose (no LLM, structure-only) ---

export class TemplateProse implements ProseProvider {
  annotateFile(structure: FileStructure, view: EditorView): AnnotatedFile {
    const doc = view.state.doc
    const allDecls = structure.declarations
    const summary = this.fileSummary(structure)
    const outline = this.outline(structure)
    const nodes: AnnotatedNode[] = []

    // Annotate imports as a group
    if (structure.imports.length > 0) {
      const importNames = structure.imports.map((n) => n.name).filter((n) => n.length < 60)
      const groupNode: FileNode = {
        kind: "import",
        name: "Imports",
        params: [],
        isAsync: false,
        isExported: false,
        keyword: "import",
        from: structure.imports[0].from,
        to: structure.imports[structure.imports.length - 1].to,
        children: [],
        childSummary: { callCount: 0, conditionCount: 0, loopCount: 0, returnCount: 0, calledFunctions: [] },
      }
      const code = doc.sliceString(groupNode.from, groupNode.to)
      nodes.push({
        node: groupNode,
        summary: `This file imports from ${plural(structure.imports.length, "module")}.`,
        detail: importNames.length > 0 ? `Modules: ${importNames.join(", ")}` : "",
        inlineNotes: [],
        code,
      })
    }

    // Annotate each declaration
    for (const decl of allDecls) {
      const code = doc.sliceString(decl.from, decl.to)
      const nodeAnnotation = this.blockExplanation(decl)
      const inlineNotes = this.inlineNotes(decl, view)

      nodes.push({
        node: decl,
        summary: nodeAnnotation.summary,
        detail: nodeAnnotation.detail,
        inlineNotes,
        code,
      })
    }

    return { fileSummary: summary, outline, nodes }
  }

  fileSummary(structure: FileStructure): string {
    const parts: string[] = []

    // Count declarations by kind
    const kindGroups = groupByKind(structure.declarations)
    const kindParts: string[] = []

    for (const [kind, nodes] of kindGroups) {
      const names = nodes.map((n) => humanizeName(n.name)).filter((n) => n.length < 40)
      if (names.length <= 4) {
        kindParts.push(`${plural(nodes.length, kindLabel(kind))} (${names.join(", ")})`)
      } else {
        kindParts.push(plural(nodes.length, kindLabel(kind)))
      }
    }

    if (kindParts.length > 0) {
      parts.push(`This file defines ${kindParts.join(" and ")}`)
    }

    if (structure.imports.length > 0) {
      parts.push(`imports from ${plural(structure.imports.length, "module")}`)
    }

    if (parts.length === 0) return "This file is empty or contains no recognizable constructs."
    return parts.join(" and ") + "."
  }

  outline(structure: FileStructure): string[] {
    const lines: string[] = []

    if (structure.imports.length > 0) {
      lines.push(`Imports (${structure.imports.length})`)
      for (const imp of structure.imports) {
        lines.push(`  ${imp.name}`)
      }
    }

    const kindGroups = groupByKind(structure.declarations)
    const kindOrder = ["function", "class", "type", "variable", "control"]
    for (const kind of kindOrder) {
      const nodes = kindGroups.get(kind)
      if (!nodes) continue
      const label = kindLabel(kind)
      lines.push(`${label[0].toUpperCase() + label.slice(1)}s (${nodes.length})`)
      for (const node of nodes) {
        const name = humanizeName(node.name)
        if (node.kind === "function" && node.params.length > 0) {
          const paramStr = node.params.map((p) => p.name).join(", ")
          lines.push(`  ${name}(${paramStr})`)
        } else {
          lines.push(`  ${name}`)
        }
      }
    }

    return lines
  }

  blockExplanation(node: FileNode): { summary: string; detail: string } {
    const name = humanizeName(node.name)
    const { childSummary } = node

    switch (node.kind) {
      case "function": {
        let summary = ""
        if (node.isAsync) summary += "async "
        summary = `${name} is ${node.isAsync ? "an async " : "a "}function`

        if (node.params.length > 0) {
          const paramDesc = node.params
            .map((p) => (p.type ? `${p.name} (${p.type})` : p.name))
            .join(", ")
          summary += ` that takes ${paramDesc}`
        }
        if (node.returnType) {
          summary += ` and returns ${node.returnType}`
        }
        summary += "."

        // Build detail from child summary
        const detailParts: string[] = []
        if (childSummary.calledFunctions.length > 0) {
          const fns = childSummary.calledFunctions.slice(0, 5)
          detailParts.push(`calls ${fns.join(", ")}${childSummary.calledFunctions.length > 5 ? " and more" : ""}`)
        }
        if (childSummary.conditionCount > 0) {
          detailParts.push(`checks ${plural(childSummary.conditionCount, "condition")}`)
        }
        if (childSummary.loopCount > 0) {
          detailParts.push(`uses ${plural(childSummary.loopCount, "loop")}`)
        }
        if (childSummary.returnCount > 0) {
          detailParts.push(`returns ${plural(childSummary.returnCount, "value")}`)
        }

        const detail = detailParts.length > 0
          ? "Inside, it " + detailParts.join(", ") + "."
          : ""

        return { summary, detail }
      }

      case "class": {
        let summary = `${name} is a ${node.keyword === "trait" ? "trait" : node.keyword === "struct" ? "struct" : "class"}`
        if (node.children.length > 0) {
          const methods = node.children.filter((c) => c.kind === "function")
          const props = node.children.filter((c) => c.kind === "variable")
          const parts: string[] = []
          if (methods.length > 0) {
            const names = methods.map((m) => humanizeName(m.name)).slice(0, 5)
            parts.push(`${plural(methods.length, "method")} (${names.join(", ")}${methods.length > 5 ? ", ..." : ""})`)
          }
          if (props.length > 0) {
            parts.push(plural(props.length, "property"))
          }
          if (parts.length > 0) summary += ` with ${parts.join(" and ")}`
        }
        summary += "."
        return { summary, detail: "" }
      }

      case "variable": {
        if (node.keyword === "component") {
          return { summary: `Uses the ${name} component.`, detail: "" }
        }
        const kw = node.keyword === "const" ? "constant" : node.keyword === "let" ? "variable" : "value"
        let summary = `${name} is a ${kw}`
        if (node.isExported) summary += " (exported)"
        summary += "."
        return { summary, detail: "" }
      }

      case "type": {
        const typeKind = node.keyword === "interface" ? "interface" : node.keyword === "enum" ? "enum" : "type alias"
        return { summary: `${name} is ${typeKind === "enum" ? "an" : "a"} ${typeKind}.`, detail: "" }
      }

      case "control": {
        // Svelte template blocks get friendlier descriptions
        const kw = node.keyword
        if (kw.startsWith("{#")) {
          const blockType = kw.replace(/^\{#/, "").replace(/\}$/, "")
          const descriptions: Record<string, string> = {
            if: "Conditionally shows content based on a value.",
            each: "Repeats content for each item in a list.",
            await: "Shows different content while waiting for a result, then when it arrives.",
            key: "Re-creates content whenever a value changes.",
          }
          return { summary: `${name} — ${descriptions[blockType] || `A Svelte ${blockType} block.`}`, detail: "" }
        }
        return { summary: `A control structure (${kw}).`, detail: "" }
      }

      default:
        return { summary: `${name} (${node.kind}).`, detail: "" }
    }
  }

  inlineNotes(node: FileNode, view: EditorView): InlineNote[] {
    const doc = view.state.doc
    const tree = syntaxTree(view.state)
    const notes: InlineNote[] = []

    // Walk immediate body children for inline annotations
    const cursor = tree.resolve(node.from).cursor()
    const body = cursor.node.getChild("Block") || cursor.node.getChild("Body") || cursor.node.getChild("ClassBody")
    if (!body) return notes

    let child = body.firstChild
    while (child) {
      const note = noteForNode(child, doc)
      if (note) notes.push(note)
      child = child.nextSibling
    }

    return notes
  }
}

function noteForNode(node: { name: string; from: number; to: number; firstChild: any; getChild(name: string): any }, doc: { sliceString(from: number, to: number): string }): InlineNote | null {
  switch (node.name) {
    case "IfStatement":
    case "IfExpression": {
      const cond = extractConditionText(node, doc)
      return { from: node.from, to: node.to, text: `Check whether ${cond}` }
    }
    case "ReturnStatement":
    case "ReturnExpression": {
      const expr = doc.sliceString(node.from, node.to).replace(/^return\s*/, "").trim()
      const truncated = expr.length > 50 ? expr.slice(0, 47) + "..." : expr
      return { from: node.from, to: node.to, text: `Send back ${truncated || "nothing"}` }
    }
    case "ForStatement":
    case "ForExpression":
      return { from: node.from, to: node.to, text: "Loop through items" }
    case "WhileStatement":
    case "WhileExpression":
      return { from: node.from, to: node.to, text: "Repeat while a condition holds" }
    case "CallExpression":
    case "ExpressionStatement": {
      // Try to extract function name from expression
      const text = doc.sliceString(node.from, Math.min(node.to, node.from + 80))
      const match = text.match(/(?:await\s+)?(\w[\w.]*)\s*\(/)
      if (match) return { from: node.from, to: node.to, text: `Call ${humanizeName(match[1])}` }
      return null
    }
    case "VariableDeclaration":
    case "LetDeclaration": {
      const text = doc.sliceString(node.from, Math.min(node.to, node.from + 80)).split("\n")[0]
      return { from: node.from, to: node.to, text: `Set up: ${text.length > 50 ? text.slice(0, 47) + "..." : text}` }
    }
    case "TryStatement":
      return { from: node.from, to: node.to, text: "Try something that might fail" }
    case "SwitchStatement":
    case "MatchExpression":
      return { from: node.from, to: node.to, text: "Check multiple possible values" }
    default:
      return null
  }
}

function extractConditionText(node: { getChild(name: string): any; from: number; to: number }, doc: { sliceString(from: number, to: number): string }): string {
  const condChild = node.getChild("ParenthesizedExpression") || node.getChild("Condition")
  if (condChild) {
    const text = doc.sliceString(condChild.from, condChild.to).replace(/^\(/, "").replace(/\)$/, "").trim()
    return text.length > 50 ? text.slice(0, 47) + "..." : text
  }
  // Fallback
  const text = doc.sliceString(node.from, Math.min(node.to, node.from + 60))
  const match = text.match(/if\s*\(?(.*?)[\){]/)
  return match ? match[1].trim() : "a condition"
}
