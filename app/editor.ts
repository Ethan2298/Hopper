import { EditorView, basicSetup } from "codemirror"
import { javascript } from "@codemirror/lang-javascript"
import { python } from "@codemirror/lang-python"
import { rust } from "@codemirror/lang-rust"
import { svelte } from "@replit/codemirror-lang-svelte"
import { oneDark } from "@codemirror/theme-one-dark"
import { EditorState } from "@codemirror/state"
import { conceptClassifier } from "./concepts"
import { BookPanel } from "./book-panel"

declare global {
  interface Window {
    fs: {
      readDir: (path: string) => Promise<{ name: string; path: string; isDir: boolean }[]>
      readFile: (path: string) => Promise<string>
      getHomePath: () => Promise<string>
      showOpenDialog: () => Promise<string | null>
      listFiles: (rootDir: string) => Promise<string[]>
    }
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
let bookPanel: BookPanel | null = null
let currentMode: "reader" | "editor" = "reader"
let currentLangExt: any = []
let projectRoot: string = ""
let projectFiles: string[] = []

function setMode(mode: "reader" | "editor") {
  currentMode = mode
  const editorEl = document.getElementById("editor")!
  const conceptEl = document.getElementById("concept-tree")!
  const learnBtn = document.getElementById("mode-reader")!
  const editorBtn = document.getElementById("mode-editor")!

  if (mode === "reader") {
    editorEl.classList.add("hidden")
    conceptEl.classList.remove("hidden")
    learnBtn.classList.add("active")
    editorBtn.classList.remove("active")
  } else {
    editorEl.classList.remove("hidden")
    conceptEl.classList.add("hidden")
    learnBtn.classList.remove("active")
    editorBtn.classList.add("active")
  }
}

function openFile(filePath: string, filename: string) {
  window.fs.readFile(filePath).then((content) => {
    const parent = document.getElementById("editor")!
    currentLangExt = getLangExtension(filename)

    if (editorView) {
      editorView.setState(
        EditorState.create({
          doc: content,
          extensions: [basicSetup, currentLangExt, oneDark, conceptClassifier()],
        })
      )
    } else {
      editorView = new EditorView({
        doc: content,
        extensions: [basicSetup, currentLangExt, oneDark, conceptClassifier()],
        parent,
      })
    }

    document.getElementById("current-file")!.textContent = filePath

    // Update book panel with file content
    if (bookPanel) {
      bookPanel.update(content, filename)
    }
  })
}

// --- File tree ---

async function renderTree(container: HTMLElement, dirPath: string) {
  container.innerHTML = ""
  const entries = await window.fs.readDir(dirPath)

  for (const entry of entries) {
    const el = document.createElement("div")
    el.className = "tree-item"

    if (entry.isDir) {
      el.innerHTML = `<span class="tree-icon">&#9654;</span><span class="tree-name">${entry.name}</span>`
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
        el.querySelector(".tree-icon")!.innerHTML = open ? "&#9654;" : "&#9660;"
      })

      container.appendChild(el)
      container.appendChild(children)
    } else {
      el.innerHTML = `<span class="tree-icon tree-file-icon">&#9643;</span><span class="tree-name">${entry.name}</span>`
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

// --- Init ---

async function init() {
  const openBtn = document.getElementById("open-folder")!
  const treeContainer = document.getElementById("file-tree")!

  bookPanel = new BookPanel(document.getElementById("concept-tree")!)
  bookPanel.setOnFileClick((relPath) => {
    if (!projectRoot) return
    const absPath = projectRoot + "/" + relPath
    const filename = relPath.split("/").pop() || relPath
    openFile(absPath, filename)
  })

  // Mode toggle
  document.getElementById("mode-reader")!.addEventListener("click", () => setMode("reader"))
  document.getElementById("mode-editor")!.addEventListener("click", () => setMode("editor"))

  openBtn.addEventListener("click", async () => {
    const dir = await window.fs.showOpenDialog()
    if (dir) {
      projectRoot = dir
      document.getElementById("folder-name")!.textContent = dir.split("/").pop() || dir
      projectFiles = await window.fs.listFiles(dir)
      if (bookPanel) bookPanel.setProjectFiles(projectFiles)
      await renderTree(treeContainer, dir)
    }
  })

  // Default: open home directory
  const home = await window.fs.getHomePath()
  document.getElementById("folder-name")!.textContent = "~"
  await renderTree(treeContainer, home)
}

init()
