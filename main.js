const { app, BrowserWindow, ipcMain, dialog } = require("electron")
const path = require("path")
const fs = require("fs")

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"

// Load .env file from project root
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

function createWindow() {
  const win = new BrowserWindow({
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
}

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

app.whenReady().then(createWindow)

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
