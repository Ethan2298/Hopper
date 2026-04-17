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

const MAX_UNIT_SOURCE = 8_000

/**
 * Parse the LLM's JSON response. Strip optional ```json fences.
 * Returns { prose: UnitProse[], rawText } or { parseError, rawText }.
 */
function parseProseResponse(text) {
  let body = text.trim()
  const fenceMatch = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/)
  if (fenceMatch) body = fenceMatch[1].trim()
  try {
    const parsed = JSON.parse(body)
    return { prose: Array.isArray(parsed?.prose) ? parsed.prose : null, rawText: text }
  } catch (err) {
    return { parseError: err.message, rawText: text }
  }
}

function proseByIndex(prose, unitCount) {
  const map = {}
  for (const p of prose || []) {
    if (!p || typeof p.index !== "number") continue
    if (p.index < 0 || p.index >= unitCount) continue
    map[p.index] = {
      index: p.index,
      oneLineSummary: typeof p.oneLineSummary === "string" ? p.oneLineSummary : "",
      bullets: Array.isArray(p.bullets)
        ? p.bullets
            .filter((b) => b && typeof b.text === "string")
            .map((b) => ({
              text: b.text,
              kind: b.kind === "chrome" ? "chrome" : "semantic",
            }))
        : [],
    }
  }
  return map
}

function fallbackProse(units) {
  const map = {}
  for (const u of units) {
    map[u.index] = {
      index: u.index,
      oneLineSummary: `${u.kind} ${u.name}`,
      bullets: [],
    }
  }
  return map
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

ipcMain.handle("describe-book-outline", async (_event, { filename, units }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { error: "No ANTHROPIC_API_KEY environment variable set. Launch the app with: ANTHROPIC_API_KEY=sk-... npm start" }
  }

  if (!Array.isArray(units) || units.length === 0) {
    return { prose: {}, fallback: false }
  }

  // Cap each unit's source so a giant file can't blow the context.
  const trimmedUnits = units.map((u) => ({
    ...u,
    source: typeof u.source === "string" && u.source.length > MAX_UNIT_SOURCE
      ? u.source.slice(0, MAX_UNIT_SOURCE) + "\n// … (truncated)"
      : u.source,
  }))

  const systemPrompt = `You are writing prose for a literate-programming reader over source code. The file has already been parsed into discrete "units" — functions, classes, interfaces, types, and the like. For each unit, produce a one-line summary and, if the unit has a multi-line body, a short list of prose bullets describing the body in reading order.

Return STRICT JSON matching this TypeScript type — no prose before or after, no markdown fences:

type Response = { prose: UnitProse[] }
type UnitProse = {
  index: number
  oneLineSummary: string
  bullets: Bullet[]   // empty for single-line units
}
type Bullet = {
  text: string
  kind: "semantic" | "chrome"
}

Rules:
1. Return one UnitProse per input unit. Preserve the input index on each entry.
2. oneLineSummary: one short sentence describing the unit's purpose.
3. bullets: For a multi-line unit, produce 3–7 bullets reading the body top-to-bottom. Each bullet is concise prose (ideally ≤ 120 chars), describing WHAT that section of code does, not restating the code.
4. For single-line or declaration-only units (e.g. \`export type X = ...\`, \`const Y = 1\`), bullets must be an empty array \`[]\`.
5. Bullet kind: "chrome" for boilerplate (function entry, trivial setup, trivial returns); "semantic" for meaningful logic. When in doubt, "semantic".
6. Do NOT invent line numbers, file paths, or any other metadata. The renderer attaches those from its own AST.

Output: JSON object only. No commentary.`

  const userContent = [
    `File: ${filename}`,
    `Unit count: ${trimmedUnits.length}`,
    "",
    "Units:",
    trimmedUnits.map((u) => {
      return [
        `<unit index="${u.index}" kind="${u.kind}" name="${u.name || ""}" multiline="${u.isMultiLine ? "true" : "false"}">`,
        u.source || "",
        `</unit>`,
      ].join("\n")
    }).join("\n\n"),
  ].join("\n")

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
        messages: [{ role: "user", content: userContent }],
      }),
    })
    if (!res.ok) {
      const body = await res.text()
      return { httpError: `API error ${res.status}: ${body}` }
    }
    const data = await res.json()
    const text = data.content?.[0]?.text
    if (!text) return { httpError: "Unexpected API response format" }
    return parseProseResponse(text)
  }

  try {
    let result = await runOnce()
    if (result.httpError) return { error: result.httpError }

    let prose = result.prose
    if (!prose) {
      console.log(`[book] ${filename} attempt 1 parse failed:`, result.parseError)
      if (result.rawText) console.log(`[book] raw response (first 500):`, result.rawText.slice(0, 500))
      result = await runOnce()
      if (result.httpError) return { error: result.httpError }
      prose = result.prose
    }

    if (!prose) {
      console.log(`[book] ${filename} attempt 2 parse failed:`, result.parseError)
      if (result.rawText) console.log(`[book] raw response (first 500):`, result.rawText.slice(0, 500))
      return { prose: fallbackProse(units), fallback: true }
    }

    return { prose: proseByIndex(prose, units.length), fallback: false }
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
