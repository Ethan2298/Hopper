import { EditorView, lineNumbers } from "@codemirror/view"
import { EditorState } from "@codemirror/state"
import { oneDark } from "@codemirror/theme-one-dark"
import { conceptColors } from "./concepts"
import { extractFileStructure } from "./file-structure"
import { TemplateProse, humanizeName } from "./prose-provider"
import type { ZoomLevel, AnnotatedFile, AnnotatedNode, FileNode } from "./prose-types"

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function colorForKind(kind: string): string {
  const map: Record<string, string> = {
    function: conceptColors["declaration"] || "#61afef",
    class: conceptColors["declaration"] || "#61afef",
    variable: conceptColors["declaration"] || "#61afef",
    import: conceptColors["import-export"] || "#c678dd",
    export: conceptColors["import-export"] || "#c678dd",
    control: conceptColors["control-flow"] || "#e06c75",
    type: conceptColors["declaration"] || "#61afef",
  }
  return map[kind] || "#abb2bf"
}

export class ProsePanel {
  private container: HTMLElement
  private view: EditorView | null = null
  private langExtension: any = []
  private snippetViews: EditorView[] = []
  private currentZoom: ZoomLevel = 2
  private annotated: AnnotatedFile | null = null
  private prose = new TemplateProse()
  private filename: string = ""

  constructor(container: HTMLElement) {
    this.container = container
  }

  setZoom(level: ZoomLevel) {
    this.currentZoom = level
    this.render()
  }

  getZoom(): ZoomLevel {
    return this.currentZoom
  }

  update(view: EditorView, langExtension: any, filename: string = "") {
    this.view = view
    this.langExtension = langExtension
    this.filename = filename
    setTimeout(() => {
      if (!this.view) return
      const structure = extractFileStructure(this.view, this.filename)
      this.annotated = this.prose.annotateFile(structure, this.view)
      this.render()
    }, 200)
  }

  private destroySnippets() {
    for (const v of this.snippetViews) v.destroy()
    this.snippetViews = []
  }

  private render() {
    this.destroySnippets()
    if (!this.annotated) {
      this.container.innerHTML = `<div class="cp-empty">Open a file from the tree</div>`
      return
    }

    switch (this.currentZoom) {
      case 0: this.renderSummary(); break
      case 1: this.renderOutline(); break
      case 2: this.renderExplanations(); break
      case 3: this.renderInterleaved(); break
    }
  }

  // --- Level 0: Summary ---
  private renderSummary() {
    const { fileSummary } = this.annotated!
    this.container.innerHTML = `
      <div class="prose-summary">
        <div class="prose-summary-card">
          <p>${escapeHtml(fileSummary)}</p>
          <div class="prose-summary-hint">Click "Outline" or "Explain" for more detail</div>
        </div>
      </div>
    `
  }

  // --- Level 1: Outline ---
  private renderOutline() {
    const lines = this.annotated!.outline
    const html = lines
      .map((line) => {
        if (line.startsWith("  ")) {
          return `<li class="prose-outline-item">${escapeHtml(line.trim())}</li>`
        } else {
          return `</ul><h3 class="prose-outline-heading">${escapeHtml(line)}</h3><ul class="prose-outline-list">`
        }
      })
      .join("\n")

    this.container.innerHTML = `
      <div class="prose-outline">
        <ul class="prose-outline-list">${html}</ul>
      </div>
    `

    // Make outline items clickable → jump to Level 2
    this.container.querySelectorAll(".prose-outline-item").forEach((el) => {
      ;(el as HTMLElement).style.cursor = "pointer"
      el.addEventListener("click", () => {
        this.setZoom(2)
        // Dispatch event so editor.ts can update button state
        this.container.dispatchEvent(new CustomEvent("zoom-change", { detail: 2, bubbles: true }))
      })
    })
  }

  // --- Level 2: Explanations ---
  private renderExplanations() {
    this.container.innerHTML = ""
    const nodes = this.annotated!.nodes

    if (nodes.length === 0) {
      this.container.innerHTML = `<div class="cp-empty">No constructs found in this file</div>`
      return
    }

    for (const ann of nodes) {
      const block = this.createProseBlock(ann)
      this.container.appendChild(block)
    }
  }

  private createProseBlock(ann: AnnotatedNode): HTMLElement {
    const block = document.createElement("div")
    block.className = "prose-block"

    const color = colorForKind(ann.node.kind)
    block.style.borderLeftColor = color

    // Header
    const header = document.createElement("div")
    header.className = "prose-block-header"
    const kindBadge = `<span class="prose-kind-badge" style="background:${color}20;color:${color}">${ann.node.kind}</span>`
    header.innerHTML = `${kindBadge} <span class="prose-block-name">${escapeHtml(humanizeName(ann.node.name))}</span>`

    // Body
    const body = document.createElement("div")
    body.className = "prose-block-body"

    const summaryP = document.createElement("p")
    summaryP.className = "prose-block-summary"
    summaryP.textContent = ann.summary
    body.appendChild(summaryP)

    if (ann.detail) {
      const detailP = document.createElement("p")
      detailP.className = "prose-block-detail"
      detailP.textContent = ann.detail
      body.appendChild(detailP)
    }

    // Show code toggle
    const toggle = document.createElement("button")
    toggle.className = "prose-code-toggle"
    toggle.textContent = "Show code"

    const snippetContainer = document.createElement("div")
    snippetContainer.className = "cp-snippet"
    snippetContainer.style.display = "none"
    snippetContainer.style.borderLeftColor = color

    let snippetCreated = false

    toggle.addEventListener("click", () => {
      const open = snippetContainer.style.display !== "none"
      snippetContainer.style.display = open ? "none" : "block"
      toggle.textContent = open ? "Show code" : "Hide code"

      if (!open && !snippetCreated) {
        snippetCreated = true
        const snippetView = new EditorView({
          doc: ann.code,
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

    block.appendChild(header)
    block.appendChild(body)
    block.appendChild(toggle)
    block.appendChild(snippetContainer)

    return block
  }

  // --- Level 3: Interleaved ---
  private renderInterleaved() {
    this.container.innerHTML = ""
    const nodes = this.annotated!.nodes

    if (nodes.length === 0) {
      this.container.innerHTML = `<div class="cp-empty">No constructs found in this file</div>`
      return
    }

    for (const ann of nodes) {
      const section = document.createElement("div")
      section.className = "prose-interleaved"

      const color = colorForKind(ann.node.kind)
      section.style.borderLeftColor = color

      // Prose header
      const header = document.createElement("div")
      header.className = "prose-interleaved-header"
      header.innerHTML = `<strong>${escapeHtml(humanizeName(ann.node.name))}</strong> &mdash; ${escapeHtml(ann.summary)}`
      section.appendChild(header)

      // Split code into chunks of ~4 lines with inline notes interspersed
      const lines = ann.code.split("\n")
      const chunkSize = 4
      let lineIndex = 0

      while (lineIndex < lines.length) {
        // Check if any inline notes apply to lines in this chunk
        // For simplicity, interleave notes between chunks based on position
        const chunkStart = lineIndex
        const chunkEnd = Math.min(lineIndex + chunkSize, lines.length)
        const chunkCode = lines.slice(chunkStart, chunkEnd).join("\n")

        if (chunkCode.trim()) {
          // Create code chunk
          const codeDiv = document.createElement("div")
          codeDiv.className = "prose-interleaved-code"

          const snippetView = new EditorView({
            doc: chunkCode,
            extensions: [
              EditorState.readOnly.of(true),
              EditorView.editable.of(false),
              lineNumbers(),
              this.langExtension,
              oneDark,
            ],
            parent: codeDiv,
          })
          this.snippetViews.push(snippetView)
          section.appendChild(codeDiv)
        }

        // Insert any relevant inline notes after this chunk
        if (ann.inlineNotes.length > 0 && lineIndex < lines.length) {
          // Match inline notes to approximate line positions within the block
          const noteIndex = Math.floor((chunkStart / lines.length) * ann.inlineNotes.length)
          if (noteIndex < ann.inlineNotes.length && chunkStart > 0) {
            const note = ann.inlineNotes[noteIndex]
            if (note) {
              const noteDiv = document.createElement("div")
              noteDiv.className = "prose-interleaved-note"
              noteDiv.textContent = note.text
              section.appendChild(noteDiv)
            }
          }
        }

        lineIndex = chunkEnd
      }

      this.container.appendChild(section)
    }
  }
}
