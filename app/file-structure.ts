import { EditorView } from "@codemirror/view"
import { syntaxTree } from "@codemirror/language"
import { SyntaxNode } from "@lezer/common"
import type { FileNode, FileNodeKind, FileStructure, ChildSummary } from "./prose-types"

// Per-language lookup tables for child accessor names
const nameNodes: Record<string, string[]> = {
  js: ["VariableDefinition", "PropertyDefinition"],
  py: ["VariableName"],
  rs: ["BoundIdentifier", "TypeIdentifier"],
}

const funcNodes: Record<string, string[]> = {
  js: ["FunctionDeclaration", "FunctionExpression", "ArrowFunction", "MethodDeclaration"],
  py: ["FunctionDefinition"],
  rs: ["FunctionItem"],
}

const classNodes: Record<string, string[]> = {
  js: ["ClassDeclaration", "ClassExpression"],
  py: ["ClassDefinition"],
  rs: ["StructItem", "EnumItem", "TraitItem", "ImplItem"],
}

const importNodes: Record<string, string[]> = {
  js: ["ImportDeclaration"],
  py: ["ImportStatement"],
  rs: ["UseDeclaration", "ExternCrateDeclaration"],
}

const exportNodes: Record<string, string[]> = {
  js: ["ExportDeclaration"],
  py: [],
  rs: [],
}

const typeNodes: Record<string, string[]> = {
  js: ["TypeAliasDeclaration", "InterfaceDeclaration", "EnumDeclaration"],
  py: [],
  rs: ["TypeItem"],
}

const varNodes: Record<string, string[]> = {
  js: ["VariableDeclaration"],
  py: ["AssignStatement"],
  rs: ["LetDeclaration", "ConstItem", "StaticItem"],
}

const controlNodes = new Set([
  "IfStatement", "ForStatement", "WhileStatement", "DoStatement",
  "SwitchStatement", "TryStatement",
  "IfExpression", "MatchExpression", "WhileExpression",
  "ForExpression", "LoopExpression",
])

const loopNodes = new Set([
  "ForStatement", "WhileStatement", "DoStatement",
  "WhileExpression", "ForExpression", "LoopExpression",
])

const conditionNodes = new Set([
  "IfStatement", "SwitchStatement", "TryStatement",
  "IfExpression", "MatchExpression",
])

// Svelte template block nodes
const svelteBlockNodes = new Set([
  "IfBlock", "EachBlock", "AwaitBlock", "KeyBlock",
])

function detectLanguage(filename: string): string {
  const ext = filename.split(".").pop() || ""
  if (ext === "svelte") return "svelte"
  if (["js", "ts", "jsx", "tsx", "mjs"].includes(ext)) return "js"
  if (ext === "py") return "py"
  if (ext === "rs") return "rs"
  return "js" // default fallback
}

function extractName(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }, lang: string): string {
  // Try language-specific name nodes first
  const names = nameNodes[lang] || nameNodes.js
  for (const childName of names) {
    const child = node.getChild(childName)
    if (child) return doc.sliceString(child.from, child.to)
  }

  // For functions, look for the function name child
  const fnName = node.getChild("VariableDefinition") || node.getChild("VariableName") || node.getChild("BoundIdentifier")
  if (fnName) return doc.sliceString(fnName.from, fnName.to)

  // For variable declarations, dig into the declarator
  for (const declName of ["VariableDeclarator", "VariableDefinition"]) {
    const decl = node.getChild(declName)
    if (decl) {
      const inner = decl.getChild("VariableDefinition") || decl.getChild("VariableName")
      if (inner) return doc.sliceString(inner.from, inner.to)
    }
  }

  // For export declarations, look inside the exported declaration
  const exportChild = node.getChild("FunctionDeclaration") || node.getChild("ClassDeclaration") || node.getChild("VariableDeclaration")
  if (exportChild) return extractName(exportChild, doc, lang)

  // For class/struct, try type name patterns
  const typeId = node.getChild("TypeIdentifier") || node.getChild("TypeName")
  if (typeId) return doc.sliceString(typeId.from, typeId.to)

  // Fallback: first line, trimmed
  const text = doc.sliceString(node.from, Math.min(node.to, node.from + 60))
  const first = text.split("\n")[0].trim()
  return first.length > 40 ? first.slice(0, 37) + "..." : first
}

function extractParams(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): { name: string; type?: string }[] {
  const paramList = node.getChild("ParamList") || node.getChild("Parameters") || node.getChild("TypeParamList")
  if (!paramList) return []

  const params: { name: string; type?: string }[] = []
  let child = paramList.firstChild
  while (child) {
    // Skip parens and commas
    if (child.name !== "(" && child.name !== ")" && child.name !== "," && child.name !== "...") {
      const nameChild = child.getChild("VariableDefinition") || child.getChild("VariableName") || child.getChild("BoundIdentifier")
      const name = nameChild
        ? doc.sliceString(nameChild.from, nameChild.to)
        : doc.sliceString(child.from, child.to).split(/[,:=]/)[0].trim()

      if (name && name !== "(" && name !== ")") {
        const typeAnn = child.getChild("TypeAnnotation")
        const type = typeAnn ? doc.sliceString(typeAnn.from, typeAnn.to).replace(/^:\s*/, "") : undefined
        params.push({ name, type })
      }
    }
    child = child.nextSibling
  }
  return params
}

function extractReturnType(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): string | undefined {
  const typeAnn = node.getChild("TypeAnnotation")
  if (typeAnn) {
    return doc.sliceString(typeAnn.from, typeAnn.to).replace(/^:\s*/, "").replace(/^\s*->\s*/, "")
  }
  // Rust return type
  const retType = node.getChild("ReturnType") || node.getChild("TypeIdentifier")
  if (retType && retType.parent === node) {
    return doc.sliceString(retType.from, retType.to).replace(/^\s*->\s*/, "")
  }
  return undefined
}

function buildChildSummary(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): ChildSummary {
  const summary: ChildSummary = {
    callCount: 0,
    conditionCount: 0,
    loopCount: 0,
    returnCount: 0,
    calledFunctions: [],
  }

  const cursor = node.cursor()
  if (!cursor.firstChild()) return summary

  do {
    walkForSummary(cursor.node, doc, summary)
  } while (cursor.nextSibling())

  // Deduplicate called functions
  summary.calledFunctions = [...new Set(summary.calledFunctions)]
  return summary
}

function walkForSummary(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }, summary: ChildSummary) {
  if (node.name === "CallExpression" || node.name === "NewExpression" || node.name === "MacroInvocation") {
    summary.callCount++
    // Extract function name from call
    const callee = node.firstChild
    if (callee) {
      const text = doc.sliceString(callee.from, callee.to)
      const name = text.split(".").pop()?.split("(")[0]?.trim()
      if (name && name.length < 40) summary.calledFunctions.push(name)
    }
  }

  if (conditionNodes.has(node.name)) summary.conditionCount++
  if (loopNodes.has(node.name)) summary.loopCount++
  if (node.name === "ReturnStatement" || node.name === "ReturnExpression") summary.returnCount++

  // Recurse into children but don't enter nested function bodies
  const skip = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunction", "FunctionDefinition", "FunctionItem", "MethodDeclaration"])
  if (skip.has(node.name)) return

  let child = node.firstChild
  while (child) {
    walkForSummary(child, doc, summary)
    child = child.nextSibling
  }
}

function classifyNode(node: SyntaxNode, lang: string): FileNodeKind | null {
  const fns = funcNodes[lang] || funcNodes.js
  const cls = classNodes[lang] || classNodes.js
  const imp = importNodes[lang] || importNodes.js
  const exp = exportNodes[lang] || exportNodes.js
  const typ = typeNodes[lang] || typeNodes.js
  const vars = varNodes[lang] || varNodes.js

  if (fns.includes(node.name)) return "function"
  if (cls.includes(node.name)) return "class"
  if (imp.includes(node.name)) return "import"
  if (exp.includes(node.name)) return "export"
  if (typ.includes(node.name)) return "type"
  if (vars.includes(node.name)) return "variable"
  if (controlNodes.has(node.name)) return "control"
  return null
}

function isExported(node: SyntaxNode): boolean {
  // JS: export declaration wraps the child
  if (node.parent?.name === "ExportDeclaration") return true
  // Check for export keyword in the node text
  const prev = node.prevSibling
  if (prev?.name === "export") return true
  return false
}

function isAsync(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): boolean {
  const text = doc.sliceString(node.from, Math.min(node.to, node.from + 20))
  return text.trimStart().startsWith("async")
}

function extractKeyword(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }): string {
  const text = doc.sliceString(node.from, Math.min(node.to, node.from + 30))
  const match = text.match(/^(export\s+)?(async\s+)?(const|let|var|function|class|interface|type|enum|struct|trait|impl|fn|use|import|from|pub|mod)\b/)
  return match?.[3] || node.name
}

function buildFileNode(node: SyntaxNode, doc: { sliceString(from: number, to: number): string }, lang: string): FileNode | null {
  const kind = classifyNode(node, lang)
  if (!kind) return null

  const name = extractName(node, doc, lang)
  const params = kind === "function" ? extractParams(node, doc) : []
  const returnType = kind === "function" ? extractReturnType(node, doc) : undefined
  const childSummary = (kind === "function" || kind === "class") ? buildChildSummary(node, doc) : emptySummary()

  // Recursively extract children for function/class bodies
  const children: FileNode[] = []
  if (kind === "function" || kind === "class") {
    const body = node.getChild("Block") || node.getChild("Body") || node.getChild("ClassBody") || node.getChild("DeclarationList")
    if (body) {
      let child = body.firstChild
      while (child) {
        const childNode = buildFileNode(child, doc, lang)
        if (childNode) children.push(childNode)
        child = child.nextSibling
      }
    }
  }

  return {
    kind,
    name,
    params,
    returnType,
    isAsync: isAsync(node, doc),
    isExported: isExported(node),
    keyword: extractKeyword(node, doc),
    from: node.from,
    to: node.to,
    children,
    childSummary,
  }
}

function emptySummary(): ChildSummary {
  return { callCount: 0, conditionCount: 0, loopCount: 0, returnCount: 0, calledFunctions: [] }
}

/** Walk JS nodes and add them to the structure (shared by JS files and Svelte script blocks). */
function walkJsNodes(node: SyntaxNode | null, doc: { sliceString(from: number, to: number): string }, lang: string, structure: FileStructure) {
  while (node) {
    if (node.name === "ExportDeclaration") {
      let inner = node.firstChild
      while (inner) {
        const fileNode = buildFileNode(inner, doc, lang)
        if (fileNode) {
          fileNode.isExported = true
          if (fileNode.kind === "import") structure.imports.push(fileNode)
          else structure.declarations.push(fileNode)
          structure.exports.push({ ...fileNode, kind: "export" })
        }
        inner = inner.nextSibling
      }
      if (!node.firstChild || classifyNode(node.firstChild, lang) === null) {
        const exportNode = buildFileNode(node, doc, lang)
        if (exportNode) structure.exports.push(exportNode)
      }
    } else {
      const fileNode = buildFileNode(node, doc, lang)
      if (fileNode) {
        if (fileNode.kind === "import") structure.imports.push(fileNode)
        else if (fileNode.kind === "export") structure.exports.push(fileNode)
        else structure.declarations.push(fileNode)
      }
    }
    node = node.nextSibling
  }
}

/**
 * Single-pass flat iterate over the Svelte tree.
 * Picks up: template blocks, component usages, and nested JS declarations.
 * Uses tree.iterate() with enter/leave to avoid manual recursion.
 */
function extractSvelteNodes(view: EditorView, structure: FileStructure) {
  const tree = syntaxTree(view.state)
  const doc = view.state.doc
  const seen = new Set<number>() // track by `from` to avoid dupes

  tree.iterate({
    enter: (node) => {
      if (seen.has(node.from)) return false

      // Svelte template blocks → control nodes
      if (svelteBlockNodes.has(node.name)) {
        seen.add(node.from)
        const blockName = node.name.replace("Block", "")
        let exprText = ""
        const openChild = node.node.firstChild
        if (openChild) {
          const openText = doc.sliceString(openChild.from, openChild.to)
          const match = openText.match(/\{[#:@]\w+\s+(.*)\}/)
          if (match) exprText = match[1].trim()
        }
        structure.declarations.push({
          kind: "control",
          name: exprText ? `${blockName}: ${exprText.length > 40 ? exprText.slice(0, 37) + "..." : exprText}` : blockName,
          params: [],
          isAsync: node.name === "AwaitBlock",
          isExported: false,
          keyword: `{#${blockName.toLowerCase()}}`,
          from: node.from,
          to: node.to,
          children: [],
          childSummary: emptySummary(),
        })
        return false // don't recurse into block children
      }

      // Component usages (Element with ComponentName)
      if (node.name === "ComponentName") {
        seen.add(node.from)
        const name = doc.sliceString(node.from, node.to)
        structure.declarations.push({
          kind: "variable",
          name: `<${name}>`,
          params: [],
          isAsync: false,
          isExported: false,
          keyword: "component",
          from: node.from,
          to: node.to,
          children: [],
          childSummary: emptySummary(),
        })
        return false
      }

      // JS declarations inside <script> (nested parser overlay)
      const kind = classifyNode(node.node, "js")
      if (kind) {
        seen.add(node.from)
        const fileNode = buildFileNode(node.node, doc, "js")
        if (fileNode) {
          if (fileNode.kind === "import") structure.imports.push(fileNode)
          else if (fileNode.kind === "export") {
            // Check inside for the real declaration
            const inner = node.node.firstChild
            if (inner) {
              const innerNode = buildFileNode(inner, doc, "js")
              if (innerNode) {
                innerNode.isExported = true
                structure.declarations.push(innerNode)
              }
            }
            structure.exports.push(fileNode)
          }
          else structure.declarations.push(fileNode)
        }
        return false // don't recurse into classified nodes
      }
    },
  })
}

export function extractFileStructure(view: EditorView, filename: string = ""): FileStructure {
  const tree = syntaxTree(view.state)
  const doc = view.state.doc
  const lang = detectLanguage(filename)

  const structure: FileStructure = {
    imports: [],
    exports: [],
    declarations: [],
    language: lang,
  }

  if (lang === "svelte") {
    extractSvelteNodes(view, structure)
  } else {
    // Standard JS/TS/Python/Rust: walk top-level nodes directly
    walkJsNodes(tree.topNode.firstChild, doc, lang, structure)
  }

  return structure
}
