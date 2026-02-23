import type { FileStructure, FileNode } from "./prose-types"

interface NodeEntry {
  fileNode: FileNode
  code: string
  depth: number
}

/**
 * Walk the FileStructure tree, assign sequential IDs, and produce:
 * - outline: text to send to the LLM as context
 * - nodeMap: metadata keyed by ID (used to build symbol-to-code map)
 */
export function buildOutline(
  structure: FileStructure,
  doc: string
): { outline: string; nodeMap: Map<number, NodeEntry> } {
  const nodeMap = new Map<number, NodeEntry>()
  const lines: string[] = []
  let nextId = 1

  // Group imports into a single node if there are any
  if (structure.imports.length > 0) {
    const firstFrom = Math.min(...structure.imports.map((n) => n.from))
    const lastTo = Math.max(...structure.imports.map((n) => n.to))
    const code = doc.slice(firstFrom, lastTo)
    const preview = code.split("\n").slice(0, 2).join("\n")
    const names = structure.imports.map((n) => n.name).join(", ")

    const syntheticNode: FileNode = {
      kind: "import",
      name: names.length > 60 ? names.slice(0, 57) + "..." : names,
      params: [],
      isAsync: false,
      isExported: false,
      keyword: "import",
      from: firstFrom,
      to: lastTo,
      children: [],
      childSummary: { callCount: 0, conditionCount: 0, loopCount: 0, returnCount: 0, calledFunctions: [] },
    }

    const id = nextId++
    nodeMap.set(id, { fileNode: syntheticNode, code, depth: 0 })
    lines.push(`imports (lines ${lineNum(doc, firstFrom)}-${lineNum(doc, lastTo)})`)
    lines.push(`  ${preview}`)
  }

  // Walk declarations (top-level)
  for (const decl of structure.declarations) {
    walkNode(decl, 0, doc, lines, nodeMap, () => nextId++)
  }

  function walkNode(
    node: FileNode,
    depth: number,
    source: string,
    outLines: string[],
    map: Map<number, NodeEntry>,
    getId: () => number
  ) {
    const id = getId()
    const code = source.slice(node.from, node.to)
    const preview = code.split("\n").slice(0, 2).join("\n")
    const indent = "  ".repeat(depth)
    const label = node.kind === "function"
      ? `${node.keyword} ${node.name}(${node.params.map((p) => p.name).join(", ")})`
      : `${node.keyword} ${node.name}`

    map.set(id, { fileNode: node, code, depth })
    outLines.push(`${indent}${label} (lines ${lineNum(source, node.from)}-${lineNum(source, node.to)})`)
    outLines.push(`${indent}  ${preview}`)

    for (const child of node.children) {
      walkNode(child, depth + 1, source, outLines, map, getId)
    }
  }

  return { outline: lines.join("\n"), nodeMap }
}

function lineNum(doc: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < doc.length; i++) {
    if (doc[i] === "\n") line++
  }
  return line
}
