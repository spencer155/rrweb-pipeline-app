const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  selectOutputFolder: () => ipcRenderer.invoke("select-output-folder"),
  getSavedExportDir: () => ipcRenderer.invoke("get-export-dir"),
  runPipeline: (payload) => ipcRenderer.invoke("run-pipeline", payload),
  queryTrajectory: (payload) => ipcRenderer.invoke("query-trajectory", payload),
  getTrajectoryEvents: (index) => ipcRenderer.invoke("get-trajectory-events", index),
  exportTrajectory: (payload) => ipcRenderer.invoke("export-trajectory", payload),
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
