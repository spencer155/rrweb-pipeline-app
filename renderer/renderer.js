const folderPath = document.getElementById("folderPath");
const pickFolder = document.getElementById("pickFolder");
const mergedName = document.getElementById("mergedName");
const fpsSelect = document.getElementById("fpsSelect");
const parallelSelect = document.getElementById("parallelSelect");
const startBtn = document.getElementById("startBtn");
const logBox = document.getElementById("logBox");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");
const progressPhase = document.getElementById("progressPhase");
const progressFraction = document.getElementById("progressFraction");
const progressDetail = document.getElementById("progressDetail");

let selectedDir = null;
let unsubscribeLog = null;
let unsubscribeProgress = null;

/** 合并默认名：<所选文件夹的最后一级目录名>.mp4 */
function defaultMergedFilenameForDir(absPath) {
  const trimmed = absPath.trim().replace(/[/\\]+$/u, "");
  let base = trimmed.split(/[/\\]/u).filter(Boolean).pop() || "";
  base = base.replace(/[/\\:?*"|<>]/gu, "_").replace(/^\.+|\.+$/gu, "").trim();
  if (!base) base = "output";
  return `${base}.mp4`;
}

function appendLog(line) {
  logBox.textContent += `${line}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function resetProgressIdle() {
  progressWrap.classList.add("is-idle");
  progressWrap.classList.remove("is-done");
  progressBar.max = 1;
  progressBar.value = 0;
  progressPhase.textContent = "待机";
  progressFraction.textContent = "";
  progressDetail.textContent = "";
}

/** @param {{ completed?: number; total?: number; phase?: string; currentFile?: string | null }} state */
function applyProgress(state) {
  const phase = state.phase;
  const totalRaw = Number(state.total);
  const total = Number.isFinite(totalRaw) ? Math.max(Math.floor(totalRaw), 1) : 1;
  let completedRaw = Number(state.completed);
  if (!Number.isFinite(completedRaw)) completedRaw = 0;
  let completed = Math.min(Math.max(Math.floor(completedRaw), 0), total);

  progressBar.max = total;

  if (phase === "done") {
    completed = total;
    progressBar.value = total;
    progressFraction.textContent = `${total} / ${total}`;
    progressWrap.classList.remove("is-idle");
    progressWrap.classList.add("is-done");
    progressPhase.textContent = "已完成";
    progressDetail.textContent = "";
    return;
  }

  progressWrap.classList.remove("is-idle", "is-done");
  progressFraction.textContent = `${completed} / ${total}`;
  progressBar.value = completed;

  if (phase === "merge") {
    progressPhase.textContent = "合并视频";
    progressDetail.textContent = state.currentFile ? `输出文件：${state.currentFile}` : "";
    return;
  }

  progressPhase.textContent = "导出 JSON → MP4";
  progressDetail.textContent = state.currentFile ? `当前文件：${state.currentFile}` : "";
}

function setRunning(running) {
  startBtn.disabled = running || !selectedDir;
  pickFolder.disabled = running;
  mergedName.disabled = running;
  fpsSelect.disabled = running;
  parallelSelect.disabled = running;
}

resetProgressIdle();

pickFolder.addEventListener("click", async () => {
  const dir = await window.api.selectFolder();
  if (!dir) return;
  selectedDir = dir;
  folderPath.value = dir;
  mergedName.value = defaultMergedFilenameForDir(dir);
  startBtn.disabled = false;
  appendLog(`已选择文件夹：${dir}`);
});

startBtn.addEventListener("click", async () => {
  if (!selectedDir) return;
  logBox.textContent = "";
  if (unsubscribeLog) {
    unsubscribeLog();
    unsubscribeLog = null;
  }
  if (unsubscribeProgress) {
    unsubscribeProgress();
    unsubscribeProgress = null;
  }

  setRunning(true);
  unsubscribeLog = window.api.onLog(appendLog);
  unsubscribeProgress = window.api.onProgress(applyProgress);
  appendLog("———— 任务开始 ————");

  const res = await window.api.runPipeline({
    workDir: selectedDir,
    mergeVideos: true,
    mergedFileName: mergedName.value,
    fps: Number(fpsSelect.value),
    parallel: Number(parallelSelect.value),
  });

  if (res.success && res.result && res.result.finalProgress) {
    applyProgress(res.result.finalProgress);
  }

  if (unsubscribeLog) {
    unsubscribeLog();
    unsubscribeLog = null;
  }
  if (unsubscribeProgress) {
    unsubscribeProgress();
    unsubscribeProgress = null;
  }

  setRunning(false);

  if (res.success) {
    appendLog("———— 全部步骤已结束 ————");
    if (res.result.mergedPath) {
      appendLog(`合并文件：${res.result.mergedPath}`);
    }
  } else {
    appendLog(`错误：${res.error}`);
    resetProgressIdle();
  }
});
