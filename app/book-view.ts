import { EditorState, Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { minimalSetup } from "codemirror"
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { svelte } from "@replit/codemirror-lang-svelte"
import { getEditorTheme } from "./theme"
import { fetchBookOutline } from "./book-outline"
import { bookDecorationsExtension, bookFoldEffect } from "./book-decorations"
import type { BookReaderOutline } from "./prose-types"

const langByExt: Record<string, () => any> = {
  ".js": javascript,
  ".ts": () => javascript({ typescript: true }),
  ".jsx": () => javascript({ jsx: true }),
  ".tsx": () => javascript({ jsx: true, typescript: true }),
  ".py": python,
  ".rs": rust,
  ".svelte": svelte,
}

function getLangExtension(filename: string): Extension {
  const ext = "." + filename.split(".").pop()
  const factory = langByExt[ext]
  return factory ? factory() : []
}

export interface BookViewHandle {
  view: EditorView
  outline: BookReaderOutline
  expandAll: () => void
  collapseAll: () => void
  destroy: () => void
}

export async function openBookView(
  parent: HTMLElement,
  filename: string,
  content: string
): Promise<BookViewHandle | { error: string }> {
  // Loading placeholder
  parent.innerHTML = `
    <div class="book-thinking">
      <span class="thinking-spinner"></span>
      <span class="thinking-text">Thinking…</span>
    </div>
  `

  // Create a hidden temporary view solely to run Lezer on the content
  // so extractReaderUnits can walk the syntax tree. We destroy it
  // immediately after extracting units.
  const langExt = getLangExtension(filename)
  const probe = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [langExt],
    }),
    parent: document.createElement("div"),
  })

  let result
  try {
    result = await fetchBookOutline(probe, filename, content)
  } finally {
    probe.destroy()
  }

  if (result.error || !result.outline) {
    parent.innerHTML = `
      <div class="book-error">
        <p class="book-error-title">Could not generate Book view</p>
        <p class="book-error-message">${escapeHtml(result.error || "Unknown error")}</p>
      </div>
    `
    return { error: result.error || "Unknown error" }
  }

  parent.innerHTML = ""

  const outline = result.outline

  // Expose for ad-hoc inspection in devtools.
  ;(window as any).__bookOutline = outline

  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: [
        minimalSetup,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        langExt,
        getEditorTheme(),
        bookDecorationsExtension(outline),
      ],
    }),
    parent,
  })

  const handle: BookViewHandle = {
    view,
    outline,
    expandAll: () => {
      view.dispatch({ effects: bookFoldEffect.of({ kind: "expandAll", outline }) })
    },
    collapseAll: () => {
      view.dispatch({ effects: bookFoldEffect.of({ kind: "collapseAll" }) })
    },
    destroy: () => view.destroy(),
  }

  if (result.fallback) {
    const banner = document.createElement("div")
    banner.className = "book-fallback-banner"
    banner.textContent = "LLM prose unavailable; showing code with AST summaries only."
    parent.prepend(banner)
  }

  if (result.truncated) {
    const banner = document.createElement("div")
    banner.className = "book-truncated-note"
    banner.textContent = "This file was large; only the first portion was analyzed."
    parent.prepend(banner)
  }

  return handle
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
