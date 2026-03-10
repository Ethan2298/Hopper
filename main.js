const { app, BrowserWindow, ipcMain, dialog, Menu, nativeTheme } = require("electron")
const path = require("path")
const fs = require("fs")

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

// --- Settings persistence ---

const settingsPath = path.join(app.getPath("userData"), "settings.json")

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
  } catch {
    return {}
  }
}

function writeSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

function getThemeSetting() {
  return readSettings().theme || "system"
}

function setThemeSetting(value) {
  const settings = readSettings()
  settings.theme = value
  writeSettings(settings)
}

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

// --- Menu ---

let win = null

function buildAppMenu() {
  const themeSetting = getThemeSetting()

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
        {
          label: "Appearance",
          submenu: [
            {
              label: "Light",
              type: "radio",
              checked: themeSetting === "light",
              click: () => applyTheme("light"),
            },
            {
              label: "Dark",
              type: "radio",
              checked: themeSetting === "dark",
              click: () => applyTheme("dark"),
            },
            {
              label: "System",
              type: "radio",
              checked: themeSetting === "system",
              click: () => applyTheme("system"),
            },
          ],
        },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
  ]

  // macOS app menu
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

function applyTheme(setting) {
  setThemeSetting(setting)

  // Map to Electron's nativeTheme
  if (setting === "system") {
    nativeTheme.themeSource = "system"
  } else {
    nativeTheme.themeSource = setting
  }

  // Notify renderer
  if (win && !win.isDestroyed()) {
    win.webContents.send("set-theme", setting)
  }

  // Rebuild menu to update radio state
  buildAppMenu()
}

// --- Window ---

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Hopper",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  })

  win.loadFile(path.join(__dirname, "app", "index.html"))

  win.on("closed", () => {
    win = null
  })
}

// --- IPC handlers ---

ipcMain.handle("get-theme", () => {
  return getThemeSetting()
})

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

ipcMain.handle("describe-file", async (_event, { filename, fileContent, projectFiles, outline }) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return { error: "No ANTHROPIC_API_KEY environment variable set. Launch the app with: ANTHROPIC_API_KEY=sk-... npm start" }
  }

  const fileListBlock = projectFiles.join("\n")

  const systemPrompt = `You are writing a section of a technical book that explains a software project to a reader who can follow logic but is not a programmer. Each file is one section of the book.

Write a plain English description of what this file does. Imagine you are explaining it to a thoughtful colleague who has never written code. Use clear, short paragraphs. Do not use code blocks, code syntax, or programming jargon without immediately explaining it.

When this file depends on or refers to something defined in another file in the project, write the other file's name as @filename (for example, @utils.ts or @main.js). Only use @filename references for files that actually exist in the project -- here is the full list of files:

${fileListBlock}

When referring to specific pieces of code (a function name, a variable, a condition, a pattern), wrap the plain-English phrase and the actual code snippet together using this syntax: [[phrase||code]]. For example: "The file starts by [[importing the path library||const path = require("path")]]." Use this sparingly — about 2-4 annotations per paragraph. Keep code snippets to 1-3 lines. Do not nest annotations or include ]] inside the code portion. Continue using @filename for file references, not [[]].

Do not wrap your response in any special formatting. Just write the prose directly.`

  let userContent
  if (outline) {
    userContent = `Here is the file "${filename}":\n\n${fileContent}\n\nFor reference, here is the file's structure:\n\n${outline}`
  } else {
    userContent = `Here is the file "${filename}":\n\n${fileContent}`
  }

  try {
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
            content: userContent,
          },
        ],
      }),
    })

    if (!res.ok) {
      const body = await res.text()
      return { error: `API error ${res.status}: ${body}` }
    }

    const data = await res.json()
    const text = data.content?.[0]?.text
    if (!text) {
      return { error: "Unexpected API response format" }
    }
    return { text }
  } catch (err) {
    return { error: `Network error: ${err.message}` }
  }
})

// --- App lifecycle ---

app.whenReady().then(() => {
  // Apply persisted theme on startup
  const themeSetting = getThemeSetting()
  if (themeSetting === "system") {
    nativeTheme.themeSource = "system"
  } else {
    nativeTheme.themeSource = themeSetting
  }

  buildAppMenu()
  createWindow()
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
