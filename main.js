const { app, BrowserWindow, ipcMain, dialog } = require("electron")
const path = require("path")
const fs = require("fs")

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

app.whenReady().then(createWindow)

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
