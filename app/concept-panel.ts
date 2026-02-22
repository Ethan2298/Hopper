import { EditorView, lineNumbers } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { syntaxTree } from "@codemirror/language"
import { oneDark } from "@codemirror/theme-one-dark"
import { conceptMap, conceptDescriptions, conceptColors } from "./concepts"

interface ConceptInstance {
  category: string
  nodeName: string
  from: number
  to: number
  text: string
  line: number
}

/** Extract all concept instances from the full syntax tree */
function extractConcepts(view: EditorView): ConceptInstance[] {
  const tree = syntaxTree(view.state)
  const doc = view.state.doc
  const instances: ConceptInstance[] = []

  tree.iterate({
    enter: (node) => {
      const category = conceptMap[node.name]
      if (category) {
        instances.push({
          category,
          nodeName: node.name,
          from: node.from,
          to: node.to,
          text: doc.sliceString(node.from, node.to),
          line: doc.lineAt(node.from).number,
        })
        return false
      }
    },
  })

  return instances
}

/** First line of code, truncated */
function label(inst: ConceptInstance): string {
  const firstLine = inst.text.split("\n")[0]
  return firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine
}

/** "control-flow" → "Control Flow" */
function displayCategory(cat: string): string {
  return cat.split("-").map(w => w[0].toUpperCase() + w.slice(1)).join(" ")
}

/** Short human-friendly description (after the em-dash) */
function shortDesc(cat: string): string {
  const full = conceptDescriptions[cat]
  if (!full) return ""
  const idx = full.indexOf("—")
  return idx >= 0 ? full.slice(idx + 1).trim() : full
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

export class ConceptPanel {
  private container: HTMLElement
  private view: EditorView | null = null
  private langExtension: any = []
  private snippetViews: EditorView[] = []

  constructor(container: HTMLElement) {
    this.container = container
  }

  update(view: EditorView, langExtension: any) {
    this.view = view
    this.langExtension = langExtension
    setTimeout(() => this.render(), 100)
  }

  private destroySnippets() {
    for (const v of this.snippetViews) v.destroy()
    this.snippetViews = []
  }

  private render() {
    this.destroySnippets()

    if (!this.view) return

    const instances = extractConcepts(this.view)

    if (instances.length === 0) {
      this.container.innerHTML = `<div class="cp-empty">No concepts found</div>`
      return
    }

    // Group by category preserving first-appearance order
    const groups = new Map<string, ConceptInstance[]>()
    for (const inst of instances) {
      let list = groups.get(inst.category)
      if (!list) {
        list = []
        groups.set(inst.category, list)
      }
      list.push(inst)
    }

    this.container.innerHTML = ""

    for (const [category, items] of groups) {
      const color = conceptColors[category] || "#abb2bf"

      const groupEl = document.createElement("div")
      groupEl.className = "cp-group"

      // Category header
      const header = document.createElement("div")
      header.className = "cp-group-header"
      header.innerHTML =
        `<span class="cp-arrow">&#9654;</span>` +
        `<span class="cp-dot" style="background:${color}"></span>` +
        `<span class="cp-cat-name">${displayCategory(category)}<span class="cp-cat-desc">${escapeHtml(shortDesc(category))}</span></span>` +
        `<span class="cp-count">${items.length}</span>`

      const list = document.createElement("div")
      list.className = "cp-group-items"
      list.style.display = "none"

      header.addEventListener("click", () => {
        const open = list.style.display !== "none"
        list.style.display = open ? "none" : "block"
        header.querySelector(".cp-arrow")!.innerHTML = open ? "&#9654;" : "&#9660;"
      })

      // Items
      for (const inst of items) {
        const item = document.createElement("div")
        item.className = "cp-item"

        const itemHeader = document.createElement("div")
        itemHeader.className = "cp-item-header"
        itemHeader.innerHTML =
          `<span class="cp-item-arrow">&#9654;</span>` +
          `<span class="cp-item-label">${escapeHtml(label(inst))}</span>` +
          `<span class="cp-item-node">${inst.nodeName}</span>` +
          `<span class="cp-item-line">:${inst.line}</span>`

        const snippetContainer = document.createElement("div")
        snippetContainer.className = "cp-snippet"
        snippetContainer.style.display = "none"
        snippetContainer.style.borderLeftColor = color

        let snippetCreated = false

        itemHeader.addEventListener("click", (e) => {
          e.stopPropagation()
          const open = snippetContainer.style.display !== "none"
          snippetContainer.style.display = open ? "none" : "block"
          itemHeader.querySelector(".cp-item-arrow")!.innerHTML = open ? "&#9654;" : "&#9660;"

          // Lazily create the CodeMirror snippet on first open
          if (!open && !snippetCreated) {
            snippetCreated = true
            const snippetView = new EditorView({
              doc: inst.text,
              extensions: [
                EditorState.readOnly.of(true),
                EditorView.editable.of(false),
                lineNumbers(),
                this.langExtension,
                oneDark,
              ],
              parent: snippetContainer,
            })
            this.snippetViews.push(snippetView)
          }
        })

        item.appendChild(itemHeader)
        item.appendChild(snippetContainer)
        list.appendChild(item)
      }

      groupEl.appendChild(header)
      groupEl.appendChild(list)
      this.container.appendChild(groupEl)
    }
  }
}
