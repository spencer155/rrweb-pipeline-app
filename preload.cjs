const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  runPipeline: (payload) => ipcRenderer.invoke("run-pipeline", payload),
  onLog: (callback) => {
    const handler = (_e, line) => callback(line);
    ipcRenderer.on("pipeline-log", handler);
    return () => ipcRenderer.removeListener("pipeline-log", handler);
  },
  onProgress: (callback) => {
    const handler = (_e, state) => callback(state);
    ipcRenderer.on("pipeline-progress", handler);
    return () => ipcRenderer.removeListener("pipeline-progress", handler);
  },
});
