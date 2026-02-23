import { describeFile } from "./ai-prose"

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const FILE_REF_RE = /@([\w./\-]+\.\w+)/g
const ANNOTATION_RE = /\[\[(.*?)\|\|(.*?)\]\]/gs

export class BookPanel {
  private container: HTMLElement
  private projectFiles: string[] = []
  private onFileClick: ((relPath: string) => void) | null = null
  private requestId = 0
  private tooltip: HTMLDivElement | null = null

  constructor(container: HTMLElement) {
    this.container = container
    this.renderEmpty()
  }

  setProjectFiles(files: string[]) {
    this.projectFiles = files
  }

  setOnFileClick(cb: (relPath: string) => void) {
    this.onFileClick = cb
  }

  async update(content: string, filename: string) {
    const id = ++this.requestId
    this.renderLoading(filename)

    const result = await describeFile(filename, content, this.projectFiles)

    // Discard stale response
    if (id !== this.requestId) return

    if (result.error) {
      this.renderError(result.error)
      return
    }

    this.renderProse(filename, result.text!, result.truncated)
  }

  private renderEmpty() {
    this.container.innerHTML = `<div class="cp-empty">Open a file from the tree</div>`
  }

  private renderLoading(filename: string) {
    this.container.innerHTML = `
      <div class="book-loading">
        <span class="book-loading-dot"></span>
        <span>Reading ${escapeHtml(filename)}...</span>
      </div>
    `
  }

  private renderError(message: string) {
    this.container.innerHTML = `
      <div class="book-error">
        <p class="book-error-title">Could not generate description</p>
        <p class="book-error-message">${escapeHtml(message)}</p>
      </div>
    `
  }

  private renderProse(filename: string, text: string, truncated?: boolean) {
    const el = document.createElement("div")
    el.className = "book-prose"

    // Chapter title
    const title = document.createElement("h2")
    title.className = "book-title"
    title.textContent = filename
    el.appendChild(title)

    if (truncated) {
      const note = document.createElement("p")
      note.className = "book-truncated-note"
      note.textContent = "Note: This file was large, so only the first portion was analyzed."
      el.appendChild(note)
    }

    // Split into paragraphs and render with annotations + @filename links
    const paragraphs = text.split(/\n\n+/)
    for (const para of paragraphs) {
      if (!para.trim()) continue
      const p = document.createElement("p")
      p.className = "book-paragraph"
      this.renderAnnotatedText(p, para.trim())
      el.appendChild(p)
    }

    this.container.innerHTML = ""
    this.container.appendChild(el)
  }

  private renderAnnotatedText(container: HTMLElement, text: string) {
    let lastIndex = 0
    const regex = new RegExp(ANNOTATION_RE.source, ANNOTATION_RE.flags)

    for (const match of text.matchAll(regex)) {
      const phrase = match[1]
      const code = match[2]
      const start = match.index!
      const end = start + match[0].length

      // Non-annotation text before this match — delegate to file-link handler
      if (start > lastIndex) {
        this.renderWithFileLinks(container, text.slice(lastIndex, start))
      }

      if (!code.trim()) {
        // Empty code snippet — render as plain text
        container.appendChild(document.createTextNode(phrase))
      } else {
        const span = document.createElement("span")
        span.className = "book-code-highlight"
        span.textContent = phrase
        span.addEventListener("mouseenter", () => this.showCodeTooltip(span, code))
        span.addEventListener("mouseleave", () => this.hideCodeTooltip())
        container.appendChild(span)
      }

      lastIndex = end
    }

    // Remaining text after last annotation
    if (lastIndex < text.length) {
      this.renderWithFileLinks(container, text.slice(lastIndex))
    }
  }

  private showCodeTooltip(anchor: HTMLElement, code: string) {
    if (!this.tooltip) {
      this.tooltip = document.createElement("div")
      this.tooltip.className = "book-code-tooltip"
      document.body.appendChild(this.tooltip)
    }

    const pre = document.createElement("pre")
    pre.textContent = code
    this.tooltip.innerHTML = ""
    this.tooltip.appendChild(pre)
    this.tooltip.style.display = "block"

    const rect = anchor.getBoundingClientRect()
    const tooltipHeight = this.tooltip.offsetHeight

    // Show above by default, flip below if near top of viewport
    if (rect.top - tooltipHeight - 8 < 0) {
      this.tooltip.style.top = rect.bottom + 8 + "px"
    } else {
      this.tooltip.style.top = rect.top - tooltipHeight - 8 + "px"
    }
    this.tooltip.style.left = rect.left + "px"
  }

  private hideCodeTooltip() {
    if (this.tooltip) {
      this.tooltip.style.display = "none"
    }
  }

  private renderWithFileLinks(container: HTMLElement, text: string) {
    const projectSet = new Set(this.projectFiles)
    let lastIndex = 0

    for (const match of text.matchAll(FILE_REF_RE)) {
      const refFile = match[1]
      const start = match.index!
      const end = start + match[0].length

      // Text before this match
      if (start > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, start)))
      }

      if (projectSet.has(refFile)) {
        const link = document.createElement("a")
        link.className = "book-file-link"
        link.textContent = "@" + refFile
        link.href = "#"
        link.addEventListener("click", (e) => {
          e.preventDefault()
          if (this.onFileClick) this.onFileClick(refFile)
        })
        container.appendChild(link)
      } else {
        // Not a real file - render as plain text
        container.appendChild(document.createTextNode(match[0]))
      }

      lastIndex = end
    }

    // Remaining text after last match
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)))
    }
  }
}
