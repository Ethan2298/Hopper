import { EditorView, basicSetup } from "codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { svelte } from "@replit/codemirror-lang-svelte"
import { EditorState } from "@codemirror/state"
import { conceptClassifier } from "./concepts"
import { openBookView, type BookViewHandle } from "./book-view"
import { getEditorTheme, fileIcon } from "./theme"

declare global {
  interface Window {
    fs: {
      readDir: (path: string) => Promise<{ name: string; path: string; isDir: boolean }[]>
      readFile: (path: string) => Promise<string>
      getHomePath: () => Promise<string>
      showOpenDialog: () => Promise<string | null>
      listFiles: (rootDir: string) => Promise<string[]>
    }
    platform: string
  }
}

const langByExt: Record<string, () => any> = {
  ".js": javascript,
  ".ts": () => javascript({ typescript: true }),
  ".jsx": () => javascript({ jsx: true }),
  ".tsx": () => javascript({ jsx: true, typescript: true }),
  ".py": python,
  ".rs": rust,
  ".svelte": svelte,
}

function getLangExtension(filename: string) {
  const ext = "." + filename.split(".").pop()
  const factory = langByExt[ext]
  return factory ? factory() : []
}

let editorView: EditorView | null = null
let bookHandle: BookViewHandle | null = null
let currentMode: "book" | "editor" = "book"
let currentLangExt: any = []
let currentContent: string = ""
let currentFilename: string = ""
let projectRoot: string = ""
let projectFiles: string[] = []

function setMode(mode: "book" | "editor") {
  currentMode = mode
  const editorEl = document.getElementById("editor")!
  const bookEl = document.getElementById("book-view")!
  const bookBtn = document.getElementById("mode-book")!
  const editorBtn = document.getElementById("mode-editor")!
  const expandBtn = document.getElementById("mode-expand-all")!
  const collapseBtn = document.getElementById("mode-collapse-all")!

  if (mode === "book") {
    editorEl.classList.add("hidden")
    bookEl.classList.remove("hidden")
    bookBtn.classList.add("active")
    editorBtn.classList.remove("active")
    expandBtn.classList.remove("hidden")
    collapseBtn.classList.remove("hidden")
  } else {
    editorEl.classList.remove("hidden")
    bookEl.classList.add("hidden")
    bookBtn.classList.remove("active")
    editorBtn.classList.add("active")
    expandBtn.classList.add("hidden")
    collapseBtn.classList.add("hidden")
  }
}

async function openFile(filePath: string, filename: string) {
  const content = await window.fs.readFile(filePath)
  currentContent = content
  currentFilename = filename
  currentLangExt = getLangExtension(filename)

  // Editor mode — CodeMirror with concept highlights
  const editorParent = document.getElementById("editor")!
  if (editorView) {
    editorView.setState(
      EditorState.create({
        doc: content,
        extensions: [basicSetup, currentLangExt, getEditorTheme(), conceptClassifier()],
      })
    )
  } else {
    editorView = new EditorView({
      doc: content,
      extensions: [basicSetup, currentLangExt, getEditorTheme(), conceptClassifier()],
      parent: editorParent,
    })
  }

  // Book mode — fresh view per file
  const bookParent = document.getElementById("book-view")!
  if (bookHandle) {
    bookHandle.destroy()
    bookHandle = null
  }
  const result = await openBookView(bookParent, filename, content)
  if ("error" in result) {
    bookHandle = null
  } else {
    bookHandle = result
  }

  document.getElementById("current-file")!.textContent = filePath
}

// --- File tree ---

async function renderTree(container: HTMLElement, dirPath: string) {
  container.innerHTML = ""
  const entries = await window.fs.readDir(dirPath)

  for (const entry of entries) {
    const el = document.createElement("div")
    el.className = "tree-item"

    if (entry.isDir) {
      el.innerHTML = `<span class="tree-icon">${fileIcon(entry.name, true, false)}</span><span class="tree-name">${entry.name}</span>`
      el.classList.add("tree-dir")
      const children = document.createElement("div")
      children.className = "tree-children"
      children.style.display = "none"
      let loaded = false

      el.addEventListener("click", async (e) => {
        e.stopPropagation()
        if (!loaded) {
          await renderTree(children, entry.path)
          loaded = true
        }
        const open = children.style.display !== "none"
        children.style.display = open ? "none" : "block"
        el.querySelector(".tree-icon")!.innerHTML = fileIcon(entry.name, true, !open)
      })

      container.appendChild(el)
      container.appendChild(children)
    } else {
      el.innerHTML = `<span class="tree-icon tree-file-icon">${fileIcon(entry.name, false)}</span><span class="tree-name">${entry.name}</span>`
      el.classList.add("tree-file")
      el.addEventListener("click", (e) => {
        e.stopPropagation()
        document.querySelectorAll(".tree-file.active").forEach((f) => f.classList.remove("active"))
        el.classList.add("active")
        openFile(entry.path, entry.name)
      })
      container.appendChild(el)
    }
  }
}

async function init() {
  if (window.platform) {
    document.documentElement.setAttribute("data-platform", window.platform)
  }

  const openBtn = document.getElementById("open-folder")!
  const treeContainer = document.getElementById("file-tree")!

  document.getElementById("mode-book")!.addEventListener("click", () => setMode("book"))
  document.getElementById("mode-editor")!.addEventListener("click", () => setMode("editor"))
  document.getElementById("mode-expand-all")!.addEventListener("click", () => bookHandle?.expandAll())
  document.getElementById("mode-collapse-all")!.addEventListener("click", () => bookHandle?.collapseAll())

  openBtn.addEventListener("click", async () => {
    const dir = await window.fs.showOpenDialog()
    if (dir) {
      projectRoot = dir
      document.getElementById("folder-name")!.textContent = dir.split("/").pop() || dir
      projectFiles = await window.fs.listFiles(dir)
      await renderTree(treeContainer, dir)
    }
  })

  const home = await window.fs.getHomePath()
  document.getElementById("folder-name")!.textContent = "~"
  await renderTree(treeContainer, home)
}

init()
