const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("fs", {
  readDir: (dirPath) => ipcRenderer.invoke("read-dir", dirPath),
  readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),
  getHomePath: () => ipcRenderer.invoke("get-home-path"),
  showOpenDialog: () => ipcRenderer.invoke("show-open-dialog"),
  listFiles: (rootDir) => ipcRenderer.invoke("list-files", rootDir),
})

contextBridge.exposeInMainWorld("ai", {
  describe: (opts) => ipcRenderer.invoke("describe-file", opts),
})
