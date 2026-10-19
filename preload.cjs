const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  selectOutputFolder: () => ipcRenderer.invoke("select-output-folder"),
  getSavedExportDir: () => ipcRenderer.invoke("get-export-dir"),
  selectJsonFolder: () => ipcRenderer.invoke("select-json-folder"),
  getSavedJsonFolder: () => ipcRenderer.invoke("get-json-folder"),
  listJsonFiles: (dir) => ipcRenderer.invoke("list-json-files", dir),
  exportJsonFolder: (payload) => ipcRenderer.invoke("export-json-folder", payload),
  mergeJsonFolder: (payload) => ipcRenderer.invoke("merge-json-folder", payload),
  queryTrajectory: (payload) => ipcRenderer.invoke("query-trajectory", payload),
  getTrajectoryEvents: (index) => ipcRenderer.invoke("get-trajectory-events", index),
  exportTrajectory: (payload) => ipcRenderer.invoke("export-trajectory", payload),
  mergeTrajectory: (payload) => ipcRenderer.invoke("merge-trajectory", payload),
  cancelExport: () => ipcRenderer.invoke("cancel-export"),
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
