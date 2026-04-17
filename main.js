const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron")
const path = require("path")
const fs = require("fs")

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

// --- .env loading ---

const envPath = path.join(__dirname, ".env")
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!process.env[key]) process.env[key] = value
  }
}

// --- Book outline helpers ---

const MAX_BOOK_CONTENT = 30_000

/**
 * Coverage-invariant validator. Mirrors app/book-outline-validate.ts.
 * Returns { ok: boolean, errors: string[] }.
 */
function validateBookOutline(outline, lineCount) {
  const errors = []
  if (!outline || !Array.isArray(outline.functions)) {
    return { ok: false, errors: ["outline missing functions array"] }
  }
  for (const fn of outline.functions) {
    if (!fn || typeof fn.name !== "string" || typeof fn.signatureLine !== "number") {
      errors.push("function missing name or signatureLine")
      continue
    }
    if (fn.signatureLine < 1 || fn.signatureLine > lineCount) {
      errors.push(`function "${fn.name}": signatureLine out of range`)
      continue
    }
    if (!Array.isArray(fn.bullets) || fn.bullets.length === 0) {
      errors.push(`function "${fn.name}": no bullets`)
      continue
    }
    const sorted = [...fn.bullets].sort((a, b) => a.fromLine - b.fromLine)
    const bodyStart = fn.signatureLine + 1
    if (sorted[0].fromLine !== bodyStart) {
      errors.push(`function "${fn.name}": first bullet starts at ${sorted[0].fromLine}, expected ${bodyStart}`)
    }
    for (let i = 1; i < sorted.length; i++) {
      const expected = sorted[i - 1].toLine + 1
      if (sorted[i].fromLine !== expected) {
        errors.push(`function "${fn.name}": bullet ${i} starts at ${sorted[i].fromLine}, expected ${expected}`)
      }
    }
    for (const b of sorted) {
      if (b.fromLine > b.toLine) errors.push(`function "${fn.name}": bullet has fromLine > toLine`)
      if (b.toLine > lineCount) errors.push(`function "${fn.name}": bullet toLine ${b.toLine} > lineCount ${lineCount}`)
    }
  }
  if (outline.imports) {
    const imp = outline.imports
    if (imp.fromLine < 1 || imp.toLine > lineCount || imp.fromLine > imp.toLine) {
      errors.push(`imports: invalid range [${imp.fromLine}, ${imp.toLine}]`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Post-process the LLM response: strip any ```json fences, parse, and return.
 * Returns { outline, parseError }.
 */
function parseBookOutlineResponse(text) {
  let body = text.trim()
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fenceMatch) body = fenceMatch[1].trim()
  try {
    return { outline: JSON.parse(body) }
  } catch (err) {
    return { parseError: err.message }
  }
}

/** Fallback outline: one chrome bullet per declaration covering the whole body. */
function fallbackOutline(fileContent) {
  const lineCount = fileContent.split("\n").length
  return {
    functions: [
      {
        name: "(unpartitioned)",
        signatureLine: 1,
        oneLineSummary: "Could not partition this file.",
        bullets: [
          {
            text: "Could not partition this function.",
            kind: "chrome",
            fromLine: 2,
            toLine: lineCount,
          },
        ],
      },
    ],
  }
}

// --- Menu ---

let win = null

function buildAppMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { role: "close" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "toggleDevTools" },
      ],
    },
  ]

  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    })
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// --- Window ---

function createWindow() {
  const isMac = process.platform === "darwin"
  const isWin = process.platform === "win32"

  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Hopper",
    backgroundColor: "#171717",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
    ...(isMac && {
      titleBarStyle: "hiddenInset",
    }),
    ...(isWin && {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#8a8f98",
        height: 36,
      },
    }),
  })

  win.loadFile(path.join(__dirname, "app", "index.html"))

  win.on("closed", () => {
    win = null
  })
}

// --- IPC handlers ---

ipcMain.handle("read-dir", async (_event, dirPath) => {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
  return entries
    .filter((e) => !e.name.startsWith("."))
    .sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1
      if (!a.isDirectory() && b.isDirectory()) return 1
      return a.name.localeCompare(b.name)
    })
    .map((e) => ({
      name: e.name,
      path: path.join(dirPath, e.name),
      isDir: e.isDirectory(),
    }))
})

ipcMain.handle("read-file", async (_event, filePath) => {
  return fs.readFileSync(filePath, "utf-8")
})

ipcMain.handle("get-home-path", async () => {
  return app.getPath("home")
})

ipcMain.handle("show-open-dialog", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  })
  if (result.canceled) return null
  return result.filePaths[0]
})

ipcMain.handle("list-files", async (_event, rootDir) => {
  const results = []
  function walk(dir, prefix) {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue
      const rel = prefix ? prefix + "/" + entry.name : entry.name
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel)
      } else {
        results.push(rel)
      }
    }
  }
  walk(rootDir, "")
  return results
})

ipcMain.handle("describe-book-outline", async (_event, { filename, fileContent }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { error: "No ANTHROPIC_API_KEY environment variable set. Launch the app with: ANTHROPIC_API_KEY=sk-... npm start" }
  }

  let content = fileContent
  let truncated = false
  if (content.length > MAX_BOOK_CONTENT) {
    content = content.slice(0, MAX_BOOK_CONTENT)
    truncated = true
  }
  const lineCount = content.split("\n").length

  const systemPrompt = `You are generating a Natural Language Outline for a source file, in the style of Shi et al. 2024 (arXiv:2408.04820). You partition the file's code into prose bullets suitable for a literate-programming reader.

Return STRICT JSON matching this TypeScript type — no prose before or after, no markdown fences:

type BookOutline = {
  functions: FunctionOutline[]
  imports?: { oneLineSummary: string; fromLine: number; toLine: number }
}
type FunctionOutline = {
  name: string
  signatureLine: number
  oneLineSummary: string
  bullets: Bullet[]
}
type Bullet = {
  text: string
  kind: "semantic" | "chrome"
  fromLine: number
  toLine: number
}

Rules:
1. Include one FunctionOutline per top-level function, method, class method, or class body. Do not skip any.
2. "signatureLine" is the 1-based line of the declaration (where the name appears). Do NOT include it in any bullet's range.
3. For each function, produce 4–8 bullets. Very short functions may have 1–3 bullets. Very long functions may have up to 10.
4. Bullets must PARTITION the function body with no gaps and no overlaps. The first bullet starts at signatureLine+1, each subsequent bullet starts at the previous bullet's toLine+1, and the last bullet ends at the last line of the function body (the closing brace line inclusive, if present).
5. Each "text" is concise prose describing what that section of code does, NOT a restatement of the code. Prefer <= 120 chars.
6. Label boilerplate (function entry, trivial variable setup, trivial returns) as kind: "chrome". Label meaningful logic as kind: "semantic".
7. Produce a one-sentence "oneLineSummary" for each function describing its purpose.
8. If the file has import/use/require statements, include an "imports" object with a one-line summary and the range covering all of them.

Output: JSON object only. No commentary.`

  async function runOnce() {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `File: ${filename}\nLine count: ${lineCount}\n\n<file>\n${content}\n</file>`,
          },
        ],
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      return { httpError: `API error ${res.status}: ${body}` }
    }
    const data = await res.json()
    const text = data.content?.[0]?.text
    if (!text) return { httpError: "Unexpected API response format" }
    return parseBookOutlineResponse(text)
  }

  try {
    let result = await runOnce()
    if (result.httpError) return { error: result.httpError }

    let validation = result.outline
      ? validateBookOutline(result.outline, lineCount)
      : { ok: false, errors: [`parse failed: ${result.parseError || "unknown"}`] }

    if (!validation.ok) {
      // One retry
      result = await runOnce()
      if (result.httpError) return { error: result.httpError }
      validation = result.outline
        ? validateBookOutline(result.outline, lineCount)
        : { ok: false, errors: [`parse failed: ${result.parseError || "unknown"}`] }
    }

    if (!validation.ok) {
      return { outline: fallbackOutline(content), truncated, fallback: true, errors: validation.errors }
    }

    return { outline: result.outline, truncated }
  } catch (err) {
    return { error: `Network error: ${err.message}` }
  }
})

// --- App lifecycle ---

app.whenReady().then(() => {
  buildAppMenu()
  createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
