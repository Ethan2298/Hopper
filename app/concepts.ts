import { EditorView, ViewPlugin, ViewUpdate, Decoration, DecorationSet, hoverTooltip, Tooltip } from "@codemirror/view"
import { Extension, RangeSetBuilder } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"

// --- Concept map: Lezer node name → category ---

export const conceptMap: Record<string, string> = {}

const categories: Record<string, string[]> = {
  "declaration": [
    // JS/TS/Python
    "VariableDeclaration", "FunctionDeclaration", "ClassDeclaration",
    "TypeAliasDeclaration", "InterfaceDeclaration", "EnumDeclaration",
    "FunctionDefinition", "ClassDefinition",
    // Rust
    "LetDeclaration", "FunctionItem", "StructItem", "EnumItem",
    "TraitItem", "ImplItem", "TypeItem", "ConstItem", "StaticItem",
    "UnionItem", "ModItem",
  ],
  "import-export": [
    // JS/TS/Python
    "ImportDeclaration", "ExportDeclaration", "ImportStatement",
    // Rust
    "UseDeclaration", "ExternCrateDeclaration",
  ],
  "control-flow": [
    // JS/TS/Python
    "IfStatement", "ForStatement", "WhileStatement", "DoStatement",
    "SwitchStatement", "TryStatement",
    // Rust
    "IfExpression", "MatchExpression", "WhileExpression",
    "ForExpression", "LoopExpression",
  ],
  "control-jump": [
    // JS/TS/Python
    "ReturnStatement", "ThrowStatement", "BreakStatement", "ContinueStatement",
    "RaiseStatement",
    // Rust
    "ReturnExpression", "BreakExpression", "ContinueExpression",
  ],
  "invocation": [
    // JS/TS
    "CallExpression", "NewExpression", "TaggedTemplateExpression",
    // Rust
    "MacroInvocation",
  ],
  "data-literal": [
    // JS/TS/Python
    "String", "Number", "BooleanLiteral", "RegExp", "TemplateString",
    "ArrayExpression", "ObjectExpression",
    // Rust
    "RawString", "Char", "Integer", "Float", "Boolean", "TupleExpression",
  ],
  "parameter": [
    "ParamList", "ArrayPattern", "ObjectPattern",
  ],
  "async": [
    // JS/TS
    "AwaitExpression", "YieldExpression",
    // Rust
    "AsyncBlock",
  ],
  "jsx": [
    "JSXElement", "JSXSelfClosingTag",
  ],
}

for (const [category, nodeNames] of Object.entries(categories)) {
  for (const name of nodeNames) {
    conceptMap[name] = category
  }
}

// --- Tooltip descriptions ---

export const conceptDescriptions: Record<string, string> = {
  "declaration": "Declaration — defines a name (variable, function, class, or type) for later use",
  "import-export": "Import/Export — brings in or exposes modules and bindings",
  "control-flow": "Control Flow — directs which code path executes (branching, looping, error handling)",
  "control-jump": "Control Jump — exits or skips part of the current flow (return, throw, break)",
  "invocation": "Invocation — calls a function or constructor to run its body",
  "data-literal": "Data Literal — a value written directly in source code (string, number, array, object)",
  "parameter": "Parameter — declares the inputs a function or pattern expects",
  "async": "Async — pauses execution to wait for or yield a value",
  "jsx": "JSX — embeds a UI element described with XML-like syntax",
}

// --- ViewPlugin: walks syntax tree, applies decorations ---

class ConceptHighlighter {
  decorations: DecorationSet
  tree: ReturnType<typeof syntaxTree>
  markCache: Record<string, Decoration> = Object.create(null)

  constructor(view: EditorView) {
    this.tree = syntaxTree(view.state)
    this.decorations = this.buildDeco(view)
  }

  update(update: ViewUpdate) {
    const tree = syntaxTree(update.state)
    if (tree != this.tree || update.viewportChanged) {
      this.tree = tree
      this.decorations = this.buildDeco(update.view)
    } else if (update.docChanged) {
      this.decorations = this.decorations.map(update.changes)
    }
  }

  buildDeco(view: EditorView): DecorationSet {
    if (!this.tree.length) return Decoration.none
    const builder = new RangeSetBuilder<Decoration>()

    for (const { from, to } of view.visibleRanges) {
      this.tree.iterate({
        from,
        to,
        enter: (node) => {
          const category = conceptMap[node.name]
          if (category) {
            const cls = `concept-${category}`
            const mark = this.markCache[cls] || (this.markCache[cls] = Decoration.mark({ class: cls }))
            builder.add(node.from, node.to, mark)
            return false // skip children to prevent double-decoration
          }
        },
      })
    }

    return builder.finish()
  }
}

const plugin = ViewPlugin.fromClass(ConceptHighlighter, {
  decorations: (v) => v.decorations,
})

// --- Hover tooltip ---

const tooltip = hoverTooltip((view, pos) => {
  const tree = syntaxTree(view.state)
  let node = tree.resolveInner(pos)

  // Walk up to find the outermost classified ancestor
  let classified: { from: number; to: number; category: string } | null = null
  let cur: typeof node | null = node
  while (cur) {
    const cat = conceptMap[cur.name]
    if (cat) {
      classified = { from: cur.from, to: cur.to, category: cat }
    }
    cur = cur.parent
  }

  if (!classified) return null

  return {
    pos: classified.from,
    end: classified.to,
    above: true,
    create() {
      const dom = document.createElement("div")
      dom.className = "concept-tooltip"
      dom.textContent = conceptDescriptions[classified!.category] || classified!.category
      return { dom }
    },
  } satisfies Tooltip
}, { hoverTime: 300 })

// --- Category colors (shared with concept panel) ---

export const conceptColors: Record<string, string> = {
  "declaration": "#61afef",
  "import-export": "#c678dd",
  "control-flow": "#e06c75",
  "control-jump": "#d19a66",
  "invocation": "#56b6c2",
  "data-literal": "#98c379",
  "parameter": "#e5c07b",
  "async": "#61afef",
  "jsx": "#e06c75",
}

// --- CSS theme ---

function border(color: string) {
  return `2px solid ${color}80` // 50% opacity via hex alpha
}
function bg(color: string) {
  return `${color}0F` // ~6% opacity
}

const theme = EditorView.baseTheme({
  ".concept-declaration":    { borderLeft: border("#61afef"), backgroundColor: bg("#61afef") },
  ".concept-import-export":  { borderLeft: border("#c678dd"), backgroundColor: bg("#c678dd") },
  ".concept-control-flow":   { borderLeft: border("#e06c75"), backgroundColor: bg("#e06c75") },
  ".concept-control-jump":   { borderLeft: border("#d19a66"), backgroundColor: bg("#d19a66") },
  ".concept-invocation":     { borderLeft: border("#56b6c2"), backgroundColor: bg("#56b6c2") },
  ".concept-data-literal":   { borderLeft: border("#98c379"), backgroundColor: bg("#98c379") },
  ".concept-parameter":      { borderLeft: border("#e5c07b"), backgroundColor: bg("#e5c07b") },
  ".concept-async":          { borderLeft: border("#61afef"), backgroundColor: bg("#61afef") },
  ".concept-jsx":            { borderLeft: border("#e06c75"), backgroundColor: bg("#e06c75") },

  ".concept-tooltip": {
    padding: "4px 8px",
    fontSize: "13px",
    fontFamily: "sans-serif",
    lineHeight: "1.4",
  },
})

// --- Public API ---

export function conceptClassifier(): Extension {
  return [plugin, tooltip, theme]
}
