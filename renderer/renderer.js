/* global rrwebPlayer */

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
const videoAuditToken = document.getElementById("videoAuditToken");
const searchBtn = document.getElementById("searchBtn");
const exportDir = document.getElementById("exportDir");
const pickExportDir = document.getElementById("pickExportDir");
const policyMergedName = document.getElementById("policyMergedName");
const policyFpsSelect = document.getElementById("policyFpsSelect");
const policyParallelSelect = document.getElementById("policyParallelSelect");
const exportAllBtn = document.getElementById("exportAllBtn");
const mergeOnlyBtn = document.getElementById("mergeOnlyBtn");
const stopExportBtn = document.getElementById("stopExportBtn");
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
const alertModal = document.getElementById("alertModal");
const alertModalBackdrop = document.getElementById("alertModalBackdrop");
const alertModalTitle = document.getElementById("alertModalTitle");
const alertModalBody = document.getElementById("alertModalBody");
const alertModalClose = document.getElementById("alertModalClose");
const alertModalOk = document.getElementById("alertModalOk");

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

function openAlertModal(title, message) {
  alertModalTitle.textContent = title || "提示";
  alertModalBody.textContent = message || "";
  alertModal.classList.remove("hidden");
}

function closeAlertModal() {
  alertModal.classList.add("hidden");
}

playerModalClose.addEventListener("click", closePlayerModal);
playerModalBackdrop.addEventListener("click", closePlayerModal);
alertModalClose.addEventListener("click", closeAlertModal);
alertModalBackdrop.addEventListener("click", closeAlertModal);
alertModalOk.addEventListener("click", closeAlertModal);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!alertModal.classList.contains("hidden")) {
    closeAlertModal();
    return;
  }
  if (!playerModal.classList.contains("hidden")) {
    closePlayerModal();
  }
});

function policyAppendLog(line) {
  policyLogBox.textContent += `${line}\n`;
  policyLogBox.scrollTop = policyLogBox.scrollHeight;
}

function hasExportableTrajectoryItems() {
  return trajectoryItems.some((item) => !item.error && item.durationMs > 0);
}

function setPolicyRunning(running) {
  policyRunning = running;
  searchBtn.disabled = running;
  exportAllBtn.disabled = running || !trajectoryItems.length;
  mergeOnlyBtn.disabled = running || !hasExportableTrajectoryItems();
  stopExportBtn.classList.toggle("hidden", !running);
  stopExportBtn.disabled = !running;
  pickExportDir.disabled = running;
  policyMergedName.disabled = running;
  policyFpsSelect.disabled = running;
  policyParallelSelect.disabled = running;
  policyUuid.disabled = running;
  videoAuditToken.disabled = running;
  trajectoryItems.forEach((item, rowIndex) => {
    const row = trajectoryBody.querySelector(`tr[data-index="${rowIndex}"]`);
    if (!row) return;
    const viewBtn = row.querySelector(".btn-link:not(.btn-export-one)");
    const exportBtn = row.querySelector(".btn-export-one");
    const itemDisabled = !!item.error || !item.durationMs;
    if (viewBtn) viewBtn.disabled = running || itemDisabled;
    if (exportBtn) exportBtn.disabled = running || itemDisabled;
  });
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
  cancelled: "已取消",
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
    mergeOnlyBtn.disabled = true;
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
    tdAction.className = "row-actions";

    const viewBtn = document.createElement("button");
    viewBtn.type = "button";
    viewBtn.className = "btn-link";
    viewBtn.textContent = "查看";
    viewBtn.disabled = !!item.error || !item.durationMs;
    viewBtn.addEventListener("click", () => previewTrajectory(rowIndex));

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "btn-link btn-export-one";
    exportBtn.textContent = "导出";
    exportBtn.disabled = policyRunning || !!item.error || !item.durationMs;
    exportBtn.addEventListener("click", () => exportSingleTrajectory(rowIndex));

    tdAction.append(viewBtn, exportBtn);

    tr.append(tdPage, tdTime, tdDuration, tdStatus, tdAction);
    trajectoryBody.appendChild(tr);
  });

  exportAllBtn.disabled = policyRunning || !trajectoryItems.length;
  mergeOnlyBtn.disabled = policyRunning || !hasExportableTrajectoryItems();
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
  mergeOnlyBtn.disabled = policyRunning || !hasExportableTrajectoryItems();
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
    videoAuditToken: videoAuditToken.value,
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
  if (!policyMergedName.value.trim()) {
    const nameKey = res.result.exportKey
      || res.result.videoAuditToken
      || res.result.policyNo
      || res.result.policyUuid;
    if (nameKey) {
      policyMergedName.value = `${nameKey}_merged.mp4`;
    }
  }
  renderTrajectoryList(res.result.items);
});

async function runPolicyMergeOnly({ clearLog = true } = {}) {
  if (!hasExportableTrajectoryItems() || policyRunning) return;

  const outputDir = await ensureExportDir();
  if (!outputDir) return;

  if (clearLog) {
    policyLogBox.textContent = "";
  }
  if (policyUnsubLog) {
    policyUnsubLog();
    policyUnsubLog = null;
  }
  if (policyUnsubProgress) {
    policyUnsubProgress();
    policyUnsubProgress = null;
  }

  setPolicyRunning(true);
  policyUnsubLog = window.api.onLog(policyAppendLog);
  policyUnsubProgress = window.api.onProgress((state) => {
    applyProgressTo(
      policyProgressWrap,
      policyProgressBar,
      policyProgressPhase,
      policyProgressFraction,
      policyProgressDetail,
      state,
    );
  });
  policyAppendLog("———— 开始合并（校验片段视频）————");

  const res = await window.api.mergeTrajectory({
    outputDir,
    mergedFileName: policyMergedName.value,
    fps: Number(policyFpsSelect.value),
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
    if (res.result && res.result.cancelled) {
      policyAppendLog("———— 合并已取消 ————");
    } else {
      policyAppendLog("———— 合并完成 ————");
      if (res.result && res.result.mergedPath) {
        policyAppendLog(`合并文件：${res.result.mergedPath}`);
      }
      if (res.result && res.result.clipCount) {
        policyAppendLog(`共合并 ${res.result.clipCount} 个片段`);
      }
    }
    policyAppendLog(`输出目录：${res.outputDir}`);
  } else {
    policyAppendLog(`错误：${res.error}`);
    const isValidationError = res.error && String(res.error).includes("校验");
    openAlertModal(
      isValidationError ? "合并校验未通过" : "合并失败",
      res.error || "未知错误",
    );
    resetProgressIdle(
      policyProgressWrap,
      policyProgressBar,
      policyProgressPhase,
      policyProgressFraction,
      policyProgressDetail,
    );
  }
}

async function runPolicyExport({ itemIndices = null, mergeVideos = true, clearLog = true, logTitle }) {
  if (!trajectoryItems.length || policyRunning) return;

  const outputDir = await ensureExportDir();
  if (!outputDir) return;

  if (clearLog) {
    policyLogBox.textContent = "";
  }
  if (policyUnsubLog) {
    policyUnsubLog();
    policyUnsubLog = null;
  }
  if (policyUnsubProgress) {
    policyUnsubProgress();
    policyUnsubProgress = null;
  }

  setPolicyRunning(true);
  if (itemIndices == null) {
    resetExportStatuses();
  } else {
    itemIndices.forEach((idx) => updateExportStatus(idx, "pending"));
  }

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
  policyAppendLog(logTitle || "———— 开始导出 ————");

  const payload = {
    outputDir,
    mergeVideos,
    mergedFileName: policyMergedName.value,
    fps: Number(policyFpsSelect.value),
    parallel: Number(policyParallelSelect.value),
  };
  if (itemIndices != null) {
    payload.itemIndices = itemIndices;
    payload.parallel = 1;
  }

  const res = await window.api.exportTrajectory(payload);

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
    if (res.result && res.result.cancelled) {
      policyAppendLog("———— 导出已取消 ————");
    } else {
      policyAppendLog("———— 导出完成 ————");
      if (res.result && res.result.mergedPath) {
        policyAppendLog(`合并文件：${res.result.mergedPath}`);
      }
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
}

async function exportSingleTrajectory(rowIndex) {
  const item = trajectoryItems[rowIndex];
  if (!item || item.error || !item.durationMs || policyRunning) return;
  const label = item.pageDesc || item.pageId || `第 ${rowIndex + 1} 条`;
  await runPolicyExport({
    itemIndices: [rowIndex],
    mergeVideos: false,
    clearLog: true,
    logTitle: `———— 开始导出：${label} ————`,
  });
}

exportAllBtn.addEventListener("click", async () => {
  await runPolicyExport({ mergeVideos: true, clearLog: true });
});

mergeOnlyBtn.addEventListener("click", async () => {
  await runPolicyMergeOnly({ clearLog: true });
});

stopExportBtn.addEventListener("click", async () => {
  if (!policyRunning) return;
  stopExportBtn.disabled = true;
  policyAppendLog("正在停止导出…");
  await window.api.cancelExport();
});

if (!isPlayerReady()) {
  policyAppendLog("警告：rrweb-player 未加载，请重启应用");
}
