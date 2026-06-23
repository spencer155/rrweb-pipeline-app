/* global rrwebPlayer */

// ── Tab switching ──────────────────────────────────────────────
const tabPolicy = document.getElementById("tabPolicy");
const tabLocal = document.getElementById("tabLocal");
const panelPolicy = document.getElementById("panelPolicy");
const panelLocal = document.getElementById("panelLocal");

tabPolicy.addEventListener("click", () => switchTab("policy"));
tabLocal.addEventListener("click", () => switchTab("local"));

function switchTab(name) {
  const isPolicy = name === "policy";
  tabPolicy.classList.toggle("active", isPolicy);
  tabLocal.classList.toggle("active", !isPolicy);
  tabPolicy.setAttribute("aria-selected", String(isPolicy));
  tabLocal.setAttribute("aria-selected", String(!isPolicy));
  panelPolicy.classList.toggle("hidden", !isPolicy);
  panelLocal.classList.toggle("hidden", isPolicy);
}

// ── Shared helpers ─────────────────────────────────────────────
function formatDateTime(value) {
  if (value == null || value === "") return "—";
  let d;
  if (typeof value === "number") {
    d = new Date(value > 1e12 ? value : value * 1000);
  } else {
    d = new Date(value);
  }
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** @param {{ completed?: number; total?: number; phase?: string; currentFile?: string | null }} state */
function applyProgressTo(wrap, bar, phaseEl, fractionEl, detailEl, state) {
  const phase = state.phase;
  const totalRaw = Number(state.total);
  const total = Number.isFinite(totalRaw) ? Math.max(Math.floor(totalRaw), 1) : 1;
  let completedRaw = Number(state.completed);
  if (!Number.isFinite(completedRaw)) completedRaw = 0;
  let completed = Math.min(Math.max(Math.floor(completedRaw), 0), total);

  bar.max = total;

  if (phase === "done") {
    completed = total;
    bar.value = total;
    fractionEl.textContent = `${total} / ${total}`;
    wrap.classList.remove("is-idle");
    wrap.classList.add("is-done");
    phaseEl.textContent = "已完成";
    detailEl.textContent = "";
    return;
  }

  wrap.classList.remove("is-idle", "is-done");
  fractionEl.textContent = `${completed} / ${total}`;
  bar.value = completed;

  if (phase === "merge") {
    phaseEl.textContent = "合并视频";
    detailEl.textContent = state.currentFile ? `输出文件：${state.currentFile}` : "";
    return;
  }

  phaseEl.textContent = "导出 MP4";
  detailEl.textContent = state.currentFile ? `当前文件：${state.currentFile}` : "";
}

function resetProgressIdle(wrap, bar, phaseEl, fractionEl, detailEl) {
  wrap.classList.add("is-idle");
  wrap.classList.remove("is-done");
  bar.max = 1;
  bar.value = 0;
  phaseEl.textContent = "待机";
  fractionEl.textContent = "";
  detailEl.textContent = "";
}

// ═══════════════════════════════════════════════════════════════
// 保单查询
// ═══════════════════════════════════════════════════════════════
const policyUuid = document.getElementById("policyUuid");
const searchBtn = document.getElementById("searchBtn");
const exportDir = document.getElementById("exportDir");
const pickExportDir = document.getElementById("pickExportDir");
const policyMergedName = document.getElementById("policyMergedName");
const policyFpsSelect = document.getElementById("policyFpsSelect");
const policyParallelSelect = document.getElementById("policyParallelSelect");
const exportAllBtn = document.getElementById("exportAllBtn");
const policyLogBox = document.getElementById("policyLogBox");
const policyProgressWrap = document.getElementById("policyProgressWrap");
const policyProgressBar = document.getElementById("policyProgressBar");
const policyProgressPhase = document.getElementById("policyProgressPhase");
const policyProgressFraction = document.getElementById("policyProgressFraction");
const policyProgressDetail = document.getElementById("policyProgressDetail");
const trajectoryEmpty = document.getElementById("trajectoryEmpty");
const trajectoryTableWrap = document.getElementById("trajectoryTableWrap");
const trajectoryBody = document.getElementById("trajectoryBody");
const trajectoryCount = document.getElementById("trajectoryCount");
const playerHost = document.getElementById("playerHost");
const playerTitle = document.getElementById("playerTitle");
const playerModal = document.getElementById("playerModal");
const playerModalBackdrop = document.getElementById("playerModalBackdrop");
const playerModalClose = document.getElementById("playerModalClose");

let policyRunning = false;
let policyUnsubLog = null;
let policyUnsubProgress = null;
let selectedExportDir = null;
let trajectoryItems = [];
let currentPlayer = null;

function applyExportDir(dir) {
  if (!dir) return;
  selectedExportDir = dir;
  exportDir.value = dir;
}

function openPlayerModal(title) {
  playerTitle.textContent = title || "轨迹回放";
  playerModal.classList.remove("hidden");
}

function closePlayerModal() {
  playerModal.classList.add("hidden");
  destroyPlayer();
  document.querySelectorAll(".trajectory-table tr.is-active").forEach((tr) => {
    tr.classList.remove("is-active");
  });
}

playerModalClose.addEventListener("click", closePlayerModal);
playerModalBackdrop.addEventListener("click", closePlayerModal);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !playerModal.classList.contains("hidden")) {
    closePlayerModal();
  }
});

function policyAppendLog(line) {
  policyLogBox.textContent += `${line}\n`;
  policyLogBox.scrollTop = policyLogBox.scrollHeight;
}

function setPolicyRunning(running) {
  policyRunning = running;
  searchBtn.disabled = running;
  exportAllBtn.disabled = running || !trajectoryItems.length;
  pickExportDir.disabled = running;
  policyMergedName.disabled = running;
  policyFpsSelect.disabled = running;
  policyParallelSelect.disabled = running;
  policyUuid.disabled = running;
}

function destroyPlayer() {
  playerHost.innerHTML = "";
  currentPlayer = null;
}

function prepareEventsForReplay(events) {
  if (!Array.isArray(events) || !events.length) return [];
  const sorted = [...events].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const hasSnapshot = sorted.some((e) => e.type === 2);
  if (!hasSnapshot) {
    policyAppendLog("警告：该片段缺少 FullSnapshot，回放可能为空白");
  }
  return sorted;
}

function isPlayerReady() {
  return typeof globalThis.rrwebPlayer === "function";
}

function mountPlayer(options) {
  const Ctor = globalThis.rrwebPlayer;
  if (typeof Ctor !== "function") return null;
  return new Ctor(options);
}

async function previewTrajectory(rowIndex) {
  const idx = Number(rowIndex);
  policyAppendLog(`正在加载轨迹预览（第 ${idx + 1} 条）…`);
  openPlayerModal("加载中…");

  if (!isPlayerReady()) {
    const msg = "bxs-rrweb-player-2 未加载，请重启应用";
    playerTitle.textContent = msg;
    policyAppendLog(`预览失败：${msg}`);
    return;
  }

  try {
    const res = await window.api.getTrajectoryEvents(idx);
    if (!res.success) {
      playerTitle.textContent = res.error || "加载失败";
      destroyPlayer();
      policyAppendLog(`预览失败：${res.error}`);
      return;
    }

    destroyPlayer();
    const events = prepareEventsForReplay(res.events);
    playerTitle.textContent = `${res.pageDesc || res.pageId}（${events.length} 个事件）`;

    const mountEl = document.createElement("div");
    mountEl.className = "player-mount";
    playerHost.appendChild(mountEl);

    const width = Math.max(Math.min(playerHost.clientWidth - 24, 1024), 375);
    currentPlayer = mountPlayer({
      target: mountEl,
      data: {
        events,
        width,
        UNSAFE_replayCanvas: true,
        showTimeStamp: true,
      },
    });
    if (!currentPlayer) {
      throw new Error("播放器实例化失败");
    }

    document.querySelectorAll(".trajectory-table tr.is-active").forEach((tr) => {
      tr.classList.remove("is-active");
    });
    const activeRow = trajectoryBody.querySelector(`tr[data-index="${idx}"]`);
    if (activeRow) activeRow.classList.add("is-active");

    policyAppendLog(`预览已加载：${res.pageDesc || res.pageId}`);
  } catch (e) {
    destroyPlayer();
    playerTitle.textContent = "预览失败";
    policyAppendLog(`预览异常：${e.message || e}`);
    console.error(e);
  }
}

const EXPORT_STATUS_LABEL = {
  pending: "待导出",
  exporting: "导出中",
  success: "导出成功",
  failed: "导出失败",
};

function updateExportStatus(rowIndex, status) {
  const row = trajectoryBody.querySelector(`tr[data-index="${rowIndex}"]`);
  if (!row) return;
  const cell = row.querySelector(".export-status");
  if (!cell) return;
  if (status) {
    cell.dataset.status = status;
    cell.textContent = EXPORT_STATUS_LABEL[status] || "—";
  } else {
    delete cell.dataset.status;
    cell.textContent = "—";
  }
}

function resetExportStatuses() {
  trajectoryItems.forEach((item, rowIndex) => {
    if (!item.error && item.durationMs > 0) {
      updateExportStatus(rowIndex, "pending");
    } else {
      updateExportStatus(rowIndex, "");
    }
  });
}

function renderTrajectoryList(items) {
  trajectoryItems = items;
  trajectoryBody.innerHTML = "";

  if (!items.length) {
    trajectoryEmpty.classList.remove("hidden");
    trajectoryEmpty.textContent = "未查询到轨迹数据";
    trajectoryTableWrap.classList.add("hidden");
    trajectoryCount.textContent = "";
    exportAllBtn.disabled = true;
    return;
  }

  trajectoryEmpty.classList.add("hidden");
  trajectoryTableWrap.classList.remove("hidden");
  trajectoryCount.textContent = `共 ${items.length} 条`;

  items.forEach((item, rowIndex) => {
    const tr = document.createElement("tr");
    tr.dataset.index = String(rowIndex);
    if (item.error) tr.classList.add("row-error");

    const tdPage = document.createElement("td");
    tdPage.textContent = item.pageDesc || item.pageId || "—";

    const tdTime = document.createElement("td");
    tdTime.textContent = formatDateTime(item.pageVisitTime);

    const tdDuration = document.createElement("td");
    tdDuration.textContent = item.error ? "—" : (item.durationText || "—");

    const tdStatus = document.createElement("td");
    tdStatus.className = "export-status";
    tdStatus.textContent = "—";

    const tdAction = document.createElement("td");
    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "btn-link";
    viewBtn.textContent = "查看";
    viewBtn.disabled = !!item.error || !item.durationMs;
    viewBtn.addEventListener("click", () => previewTrajectory(rowIndex));
    tdAction.appendChild(viewBtn);

    tr.append(tdPage, tdTime, tdDuration, tdStatus, tdAction);
    trajectoryBody.appendChild(tr);
  });

  exportAllBtn.disabled = policyRunning || !trajectoryItems.length;
}

async function ensureExportDir() {
  if (selectedExportDir) return selectedExportDir;
  const dir = await window.api.selectOutputFolder();
  if (!dir) return null;
  applyExportDir(dir);
  policyAppendLog(`导出目录：${dir}`);
  return dir;
}

resetProgressIdle(
  policyProgressWrap,
  policyProgressBar,
  policyProgressPhase,
  policyProgressFraction,
  policyProgressDetail,
);

pickExportDir.addEventListener("click", async () => {
  const dir = await window.api.selectOutputFolder();
  if (!dir) return;
  applyExportDir(dir);
  exportAllBtn.disabled = policyRunning || !trajectoryItems.length;
  policyAppendLog(`导出目录：${dir}`);
});

window.api.getSavedExportDir().then((dir) => {
  if (dir) applyExportDir(dir);
});

searchBtn.addEventListener("click", async () => {
  policyLogBox.textContent = "";
  closePlayerModal();
  setPolicyRunning(true);
  policyAppendLog("正在查询轨迹…");

  const res = await window.api.queryTrajectory({
    policyUuid: policyUuid.value,
  });

  setPolicyRunning(false);

  if (!res.success) {
    policyAppendLog(`查询失败：${res.error}`);
    renderTrajectoryList([]);
    return;
  }

  if (res.result.steps && res.result.steps.length) {
    res.result.steps.forEach((line) => policyAppendLog(line));
  }
  policyAppendLog(`查询成功，共 ${res.result.items.length} 条轨迹`);
  if (!policyMergedName.value.trim() && res.result.policyNo) {
    policyMergedName.value = `${res.result.policyNo}_merged.mp4`;
  }
  renderTrajectoryList(res.result.items);
});

exportAllBtn.addEventListener("click", async () => {
  if (!trajectoryItems.length || policyRunning) return;

  const outputDir = await ensureExportDir();
  if (!outputDir) return;

  policyLogBox.textContent = "";
  if (policyUnsubLog) {
    policyUnsubLog();
    policyUnsubLog = null;
  }
  if (policyUnsubProgress) {
    policyUnsubProgress();
    policyUnsubProgress = null;
  }

  setPolicyRunning(true);
  resetExportStatuses();
  policyUnsubLog = window.api.onLog(policyAppendLog);
  policyUnsubProgress = window.api.onProgress((state) => {
    if (state.itemIndex != null && state.itemStatus) {
      updateExportStatus(state.itemIndex, state.itemStatus);
    }
    applyProgressTo(
      policyProgressWrap,
      policyProgressBar,
      policyProgressPhase,
      policyProgressFraction,
      policyProgressDetail,
      state,
    );
  });
  policyAppendLog("———— 开始导出 ————");

  const res = await window.api.exportTrajectory({
    outputDir,
    mergeVideos: true,
    mergedFileName: policyMergedName.value,
    fps: Number(policyFpsSelect.value),
    parallel: Number(policyParallelSelect.value),
  });

  if (res.success && res.result && res.result.finalProgress) {
    applyProgressTo(
      policyProgressWrap,
      policyProgressBar,
      policyProgressPhase,
      policyProgressFraction,
      policyProgressDetail,
      res.result.finalProgress,
    );
  }

  if (policyUnsubLog) {
    policyUnsubLog();
    policyUnsubLog = null;
  }
  if (policyUnsubProgress) {
    policyUnsubProgress();
    policyUnsubProgress = null;
  }

  setPolicyRunning(false);

  if (res.success) {
    policyAppendLog("———— 导出完成 ————");
    if (res.result.mergedPath) {
      policyAppendLog(`合并文件：${res.result.mergedPath}`);
    }
    policyAppendLog(`输出目录：${res.outputDir}`);
  } else {
    policyAppendLog(`错误：${res.error}`);
    resetProgressIdle(
      policyProgressWrap,
      policyProgressBar,
      policyProgressPhase,
      policyProgressFraction,
      policyProgressDetail,
    );
  }
});

// ═══════════════════════════════════════════════════════════════
// 本地文件夹（原有逻辑）
// ═══════════════════════════════════════════════════════════════
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

function setRunning(running) {
  startBtn.disabled = running || !selectedDir;
  pickFolder.disabled = running;
  mergedName.disabled = running;
  fpsSelect.disabled = running;
  parallelSelect.disabled = running;
}

resetProgressIdle(progressWrap, progressBar, progressPhase, progressFraction, progressDetail);

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
  unsubscribeProgress = window.api.onProgress((state) => {
    applyProgressTo(progressWrap, progressBar, progressPhase, progressFraction, progressDetail, state);
  });
  appendLog("———— 任务开始 ————");

  const res = await window.api.runPipeline({
    workDir: selectedDir,
    mergeVideos: true,
    mergedFileName: mergedName.value,
    fps: Number(fpsSelect.value),
    parallel: Number(parallelSelect.value),
  });

  if (res.success && res.result && res.result.finalProgress) {
    applyProgressTo(progressWrap, progressBar, progressPhase, progressFraction, progressDetail, res.result.finalProgress);
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
    resetProgressIdle(progressWrap, progressBar, progressPhase, progressFraction, progressDetail);
  }
});

if (!isPlayerReady()) {
  policyAppendLog("警告：rrweb-player 未加载，请重启应用");
}
