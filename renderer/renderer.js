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
const tabTrajectory = document.getElementById("tabTrajectory");
const tabJsonFolder = document.getElementById("tabJsonFolder");
const trajectoryQueryPanel = document.getElementById("trajectoryQueryPanel");
const jsonFolderPanel = document.getElementById("jsonFolderPanel");
const jsonSourceDirInput = document.getElementById("jsonSourceDir");
const pickJsonDir = document.getElementById("pickJsonDir");
const exportDirRow = document.getElementById("exportDirRow");
const trajectoryActions = document.getElementById("trajectoryActions");
const jsonActions = document.getElementById("jsonActions");
const convertJsonBtn = document.getElementById("convertJsonBtn");
const mergeJsonBtn = document.getElementById("mergeJsonBtn");
const stopJsonBtn = document.getElementById("stopJsonBtn");
const trajectoryListPanel = document.getElementById("trajectoryListPanel");
const jsonListPanel = document.getElementById("jsonListPanel");
const jsonFileCount = document.getElementById("jsonFileCount");
const jsonEmpty = document.getElementById("jsonEmpty");
const jsonTableWrap = document.getElementById("jsonTableWrap");
const jsonFileBody = document.getElementById("jsonFileBody");
const jsonSelectAll = document.getElementById("jsonSelectAll");
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
const trajectorySelectAll = document.getElementById("trajectorySelectAll");
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
let selectedTrajectoryIndices = new Set();
let currentPlayer = null;
let appMode = "trajectory";
let jsonSourceDir = null;
let jsonFolderFiles = [];
let selectedJsonNames = new Set();

function isItemSelectable(item) {
  return !item.error && item.durationMs > 0;
}

function getSelectableRowIndices() {
  return trajectoryItems.reduce((indices, item, rowIndex) => {
    if (isItemSelectable(item)) indices.push(rowIndex);
    return indices;
  }, []);
}

function getEffectiveItemIndices() {
  if (!selectedTrajectoryIndices.size) return null;
  return [...selectedTrajectoryIndices].sort((a, b) => a - b);
}

function clearTrajectorySelection() {
  selectedTrajectoryIndices.clear();
  if (trajectorySelectAll) {
    trajectorySelectAll.checked = false;
    trajectorySelectAll.indeterminate = false;
  }
}

function updateSelectionUi() {
  const selectable = getSelectableRowIndices();
  const selectedCount = selectedTrajectoryIndices.size;
  const totalCount = trajectoryItems.length;

  if (trajectoryCount) {
    if (!totalCount) {
      trajectoryCount.textContent = "";
    } else if (selectedCount > 0) {
      trajectoryCount.textContent = `共 ${totalCount} 条，已选 ${selectedCount} 条`;
    } else {
      trajectoryCount.textContent = `共 ${totalCount} 条`;
    }
  }

  exportAllBtn.textContent = selectedCount > 0
    ? `导出选中 (${selectedCount})`
    : "导出全部 MP4";
  mergeOnlyBtn.textContent = selectedCount > 0
    ? `合并选中 (${selectedCount})`
    : "仅合并视频";

  if (trajectorySelectAll) {
    trajectorySelectAll.disabled = policyRunning || !selectable.length;
    if (!selectable.length) {
      trajectorySelectAll.checked = false;
      trajectorySelectAll.indeterminate = false;
    } else {
      const selectedSelectable = selectable.filter((idx) => selectedTrajectoryIndices.has(idx)).length;
      trajectorySelectAll.checked = selectedSelectable === selectable.length;
      trajectorySelectAll.indeterminate = selectedSelectable > 0 && selectedSelectable < selectable.length;
    }
  }

  trajectoryItems.forEach((item, rowIndex) => {
    const row = trajectoryBody.querySelector(`tr[data-index="${rowIndex}"]`);
    if (!row) return;
    const checkbox = row.querySelector(".trajectory-row-check");
    if (!checkbox) return;
    checkbox.checked = selectedTrajectoryIndices.has(rowIndex);
    checkbox.disabled = policyRunning || !isItemSelectable(item);
  });

  const hasTarget = selectedCount > 0
    ? selectable.some((idx) => selectedTrajectoryIndices.has(idx))
    : hasExportableTrajectoryItems();
  mergeOnlyBtn.disabled = policyRunning || !hasTarget;
  exportAllBtn.disabled = policyRunning || !(selectedCount > 0 ? hasTarget : trajectoryItems.length);
}

function setRowSelected(rowIndex, checked) {
  const item = trajectoryItems[rowIndex];
  if (!item || !isItemSelectable(item)) return;
  if (checked) {
    selectedTrajectoryIndices.add(rowIndex);
  } else {
    selectedTrajectoryIndices.delete(rowIndex);
  }
  updateSelectionUi();
}

function setAllRowsSelected(checked) {
  selectedTrajectoryIndices.clear();
  if (checked) {
    getSelectableRowIndices().forEach((idx) => selectedTrajectoryIndices.add(idx));
  }
  updateSelectionUi();
}

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
  const showTrajectoryStop = running && appMode === "trajectory";
  const showJsonStop = running && appMode === "json";
  stopExportBtn.classList.toggle("hidden", !showTrajectoryStop);
  stopJsonBtn.classList.toggle("hidden", !showJsonStop);
  stopExportBtn.disabled = !running;
  stopJsonBtn.disabled = !running;
  pickExportDir.disabled = running;
  pickJsonDir.disabled = running;
  tabTrajectory.disabled = running;
  tabJsonFolder.disabled = running;
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
    const checkbox = row.querySelector(".trajectory-row-check");
    const itemDisabled = !!item.error || !item.durationMs;
    if (viewBtn) viewBtn.disabled = running || itemDisabled;
    if (exportBtn) exportBtn.disabled = running || itemDisabled;
    if (checkbox) checkbox.disabled = running || itemDisabled;
  });
  updateSelectionUi();
  updateJsonSelectionUi();
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
  clearTrajectorySelection();

  if (!items.length) {
    trajectoryEmpty.classList.remove("hidden");
    trajectoryEmpty.textContent = "未查询到轨迹数据";
    trajectoryTableWrap.classList.add("hidden");
    updateSelectionUi();
    return;
  }

  trajectoryEmpty.classList.add("hidden");
  trajectoryTableWrap.classList.remove("hidden");

  items.forEach((item, rowIndex) => {
    const tr = document.createElement("tr");
    tr.dataset.index = String(rowIndex);
    if (item.error) tr.classList.add("row-error");

    const tdCheck = document.createElement("td");
    tdCheck.className = "col-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "trajectory-row-check";
    checkbox.setAttribute("aria-label", `选择 ${item.pageDesc || item.pageId || "轨迹"}`);
    checkbox.disabled = !isItemSelectable(item);
    checkbox.addEventListener("change", () => {
      setRowSelected(rowIndex, checkbox.checked);
    });
    tdCheck.appendChild(checkbox);

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

    tr.append(tdCheck, tdPage, tdTime, tdDuration, tdStatus, tdAction);
    trajectoryBody.appendChild(tr);
  });

  updateSelectionUi();
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
  updateSelectionUi();
  policyAppendLog(`导出目录：${dir}`);
});

if (trajectorySelectAll) {
  trajectorySelectAll.addEventListener("change", () => {
    setAllRowsSelected(trajectorySelectAll.checked);
  });
}

if (window.api) {
  window.api.getSavedExportDir().then((dir) => {
    if (dir) applyExportDir(dir);
  });
}

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
  const itemIndices = getEffectiveItemIndices();
  const hasTarget = itemIndices
    ? itemIndices.some((idx) => isItemSelectable(trajectoryItems[idx]))
    : hasExportableTrajectoryItems();
  if (!hasTarget || policyRunning) return;

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
  policyAppendLog(itemIndices
    ? `———— 开始合并选中 ${itemIndices.length} 条 ————`
    : "———— 开始合并 ————");

  const res = await window.api.mergeTrajectory({
    outputDir,
    mergedFileName: policyMergedName.value,
    fps: Number(policyFpsSelect.value),
    itemIndices,
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
    openAlertModal("合并失败", res.error || "未知错误");
    resetProgressIdle(
      policyProgressWrap,
      policyProgressBar,
      policyProgressPhase,
      policyProgressFraction,
      policyProgressDetail,
    );
  }
}

async function runPolicyExport({ itemIndices = null, mergeVideos = true, clearLog = true, logTitle } = {}) {
  const effectiveIndices = itemIndices != null ? itemIndices : getEffectiveItemIndices();
  const exportAll = effectiveIndices == null;
  const hasTarget = exportAll
    ? trajectoryItems.length > 0
    : effectiveIndices.some((idx) => isItemSelectable(trajectoryItems[idx]));
  if (!hasTarget || policyRunning) return;

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
  if (exportAll) {
    resetExportStatuses();
  } else {
    effectiveIndices.forEach((idx) => updateExportStatus(idx, "pending"));
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
  policyAppendLog(logTitle || (exportAll
    ? "———— 开始导出 ————"
    : `———— 开始导出选中 ${effectiveIndices.length} 条 ————`));

  const payload = {
    outputDir,
    mergeVideos,
    mergedFileName: policyMergedName.value,
    fps: Number(policyFpsSelect.value),
    parallel: Number(policyParallelSelect.value),
  };
  if (!exportAll) {
    payload.itemIndices = effectiveIndices;
    if (effectiveIndices.length === 1) {
      payload.parallel = 1;
    }
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

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function setAppMode(mode) {
  if (policyRunning || mode === appMode) return;
  appMode = mode;
  const isJson = mode === "json";
  tabTrajectory.classList.toggle("is-active", !isJson);
  tabJsonFolder.classList.toggle("is-active", isJson);
  tabTrajectory.setAttribute("aria-selected", String(!isJson));
  tabJsonFolder.setAttribute("aria-selected", String(isJson));
  trajectoryQueryPanel.classList.toggle("hidden", isJson);
  jsonFolderPanel.classList.toggle("hidden", !isJson);
  trajectoryActions.classList.toggle("hidden", isJson);
  jsonActions.classList.toggle("hidden", !isJson);
  exportDirRow.classList.toggle("hidden", isJson);
  trajectoryListPanel.classList.toggle("hidden", isJson);
  jsonListPanel.classList.toggle("hidden", !isJson);
  policyMergedName.placeholder = isJson
    ? "如 merged.mp4，留空则为 merged.mp4"
    : "查询成功后自动填充，如：保单号_merged.mp4";
}

function getEffectiveJsonNames() {
  if (!selectedJsonNames.size) return null;
  return jsonFolderFiles
    .map((file) => file.name)
    .filter((name) => selectedJsonNames.has(name));
}

function updateJsonSelectionUi() {
  const totalCount = jsonFolderFiles.length;
  const selectedCount = selectedJsonNames.size;
  const targets = selectedCount > 0
    ? jsonFolderFiles.filter((file) => selectedJsonNames.has(file.name))
    : jsonFolderFiles;

  if (!totalCount) {
    jsonFileCount.textContent = "";
  } else if (selectedCount > 0) {
    jsonFileCount.textContent = `共 ${totalCount} 个，已选 ${selectedCount} 个`;
  } else {
    jsonFileCount.textContent = `共 ${totalCount} 个`;
  }

  convertJsonBtn.textContent = selectedCount > 0
    ? `转换选中 (${selectedCount})`
    : "转为视频";
  mergeJsonBtn.textContent = selectedCount > 0
    ? `合并选中 (${selectedCount})`
    : "仅合并视频";

  jsonSelectAll.disabled = policyRunning || !totalCount;
  if (!totalCount) {
    jsonSelectAll.checked = false;
    jsonSelectAll.indeterminate = false;
  } else {
    jsonSelectAll.checked = selectedCount === totalCount;
    jsonSelectAll.indeterminate = selectedCount > 0 && selectedCount < totalCount;
  }

  jsonFolderFiles.forEach((file, rowIndex) => {
    const row = jsonFileBody.querySelector(`tr[data-index="${rowIndex}"]`);
    if (!row) return;
    const checkbox = row.querySelector(".json-row-check");
    if (!checkbox) return;
    checkbox.checked = selectedJsonNames.has(file.name);
    checkbox.disabled = policyRunning;
  });

  convertJsonBtn.disabled = policyRunning || !targets.length;
  mergeJsonBtn.disabled = policyRunning || !targets.some((file) => file.hasMp4);
}

function updateJsonFileStatus(name, status) {
  const file = jsonFolderFiles.find((item) => item.name === name);
  if (!file) return;
  if (status === "success") file.hasMp4 = true;
  const rowIndex = jsonFolderFiles.indexOf(file);
  const row = jsonFileBody.querySelector(`tr[data-index="${rowIndex}"]`);
  if (!row) return;
  const statusCell = row.querySelector(".export-status");
  if (statusCell) {
    if (status) {
      statusCell.dataset.status = status;
      statusCell.textContent = EXPORT_STATUS_LABEL[status] || "—";
    } else {
      delete statusCell.dataset.status;
      statusCell.textContent = "—";
    }
  }
  const videoCell = row.querySelector(".json-has-mp4");
  if (videoCell) videoCell.textContent = file.hasMp4 ? "已生成" : "未生成";
  updateJsonSelectionUi();
}

function renderJsonFileList(files) {
  const previousSelection = selectedJsonNames;
  jsonFolderFiles = files;
  selectedJsonNames = new Set(
    files.map((file) => file.name).filter((name) => previousSelection.has(name)),
  );
  jsonFileBody.innerHTML = "";

  if (!files.length) {
    jsonEmpty.classList.remove("hidden");
    jsonEmpty.textContent = jsonSourceDir
      ? "该文件夹没有可转换的 JSON（已跳过 package.json、*.config.json 等）"
      : "选择文件夹后，这里会列出可转换的 JSON 文件";
    jsonTableWrap.classList.add("hidden");
    updateJsonSelectionUi();
    return;
  }

  jsonEmpty.classList.add("hidden");
  jsonTableWrap.classList.remove("hidden");

  files.forEach((file, rowIndex) => {
    const tr = document.createElement("tr");
    tr.dataset.index = String(rowIndex);

    const tdCheck = document.createElement("td");
    tdCheck.className = "col-check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "json-row-check";
    checkbox.setAttribute("aria-label", `选择 ${file.name}`);
    checkbox.checked = selectedJsonNames.has(file.name);
    checkbox.disabled = policyRunning;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedJsonNames.add(file.name);
      else selectedJsonNames.delete(file.name);
      updateJsonSelectionUi();
    });
    tdCheck.appendChild(checkbox);

    const tdName = document.createElement("td");
    tdName.className = "json-name";
    tdName.textContent = file.name;
    tdName.title = file.name;

    const tdSize = document.createElement("td");
    tdSize.textContent = formatFileSize(file.size);

    const tdVideo = document.createElement("td");
    tdVideo.className = "json-has-mp4";
    tdVideo.textContent = file.hasMp4 ? "已生成" : "未生成";

    const tdStatus = document.createElement("td");
    tdStatus.className = "export-status";
    tdStatus.textContent = "—";

    tr.append(tdCheck, tdName, tdSize, tdVideo, tdStatus);
    jsonFileBody.appendChild(tr);
  });

  updateJsonSelectionUi();
}

async function loadJsonFolder(dir, { silent = false } = {}) {
  jsonSourceDir = dir;
  jsonSourceDirInput.value = dir || "";
  if (!dir) {
    renderJsonFileList([]);
    return;
  }
  const res = await window.api.listJsonFiles(dir);
  if (!res.success) {
    policyAppendLog(`读取 JSON 文件夹失败：${res.error}`);
    renderJsonFileList([]);
    return;
  }
  if (!silent) {
    policyAppendLog(`已扫描 ${dir}，可转换 JSON ${res.files.length} 个`);
  }
  renderJsonFileList(res.files);
}

function subscribePipeline() {
  if (policyUnsubLog) policyUnsubLog();
  if (policyUnsubProgress) policyUnsubProgress();
  policyUnsubLog = window.api.onLog(policyAppendLog);
  policyUnsubProgress = window.api.onProgress((state) => {
    if (state.jsonFile && state.itemStatus) {
      updateJsonFileStatus(state.jsonFile, state.itemStatus);
    }
    if (state.phase) {
      applyProgressTo(
        policyProgressWrap,
        policyProgressBar,
        policyProgressPhase,
        policyProgressFraction,
        policyProgressDetail,
        state,
      );
    }
  });
}

function unsubscribePipeline() {
  if (policyUnsubLog) {
    policyUnsubLog();
    policyUnsubLog = null;
  }
  if (policyUnsubProgress) {
    policyUnsubProgress();
    policyUnsubProgress = null;
  }
}

function markJsonTargetsPending(names) {
  const targets = names && names.length
    ? names
    : jsonFolderFiles.map((file) => file.name);
  targets.forEach((name) => updateJsonFileStatus(name, "pending"));
}

async function finishJsonJob(res, doneLabel) {
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
  unsubscribePipeline();
  setPolicyRunning(false);

  if (res.success) {
    if (res.result && res.result.cancelled) {
      policyAppendLog(`———— ${doneLabel}已取消 ————`);
    } else {
      policyAppendLog(`———— ${doneLabel}完成 ————`);
      if (res.result && res.result.mergedPath) {
        policyAppendLog(`合并文件：${res.result.mergedPath}`);
      }
    }
    if (res.outputDir) policyAppendLog(`输出目录：${res.outputDir}`);
  } else {
    policyAppendLog(`错误：${res.error}`);
    openAlertModal(`${doneLabel}失败`, res.error || "未知错误");
    resetProgressIdle(
      policyProgressWrap,
      policyProgressBar,
      policyProgressPhase,
      policyProgressFraction,
      policyProgressDetail,
    );
  }
}

async function runJsonConvert() {
  const fileNames = getEffectiveJsonNames();
  const hasTarget = fileNames ? fileNames.length > 0 : jsonFolderFiles.length > 0;
  if (!hasTarget || policyRunning || !jsonSourceDir) return;

  policyLogBox.textContent = "";
  setPolicyRunning(true);
  markJsonTargetsPending(fileNames);
  subscribePipeline();
  policyAppendLog(fileNames
    ? `———— 开始转换选中 ${fileNames.length} 个 JSON ————`
    : "———— 开始转换文件夹内 JSON ————");

  const res = await window.api.exportJsonFolder({
    workDir: jsonSourceDir,
    fileNames,
    mergeVideos: true,
    mergedFileName: policyMergedName.value,
    fps: Number(policyFpsSelect.value),
    parallel: Number(policyParallelSelect.value),
  });
  await finishJsonJob(res, "转换");
}

async function runJsonMerge() {
  const fileNames = getEffectiveJsonNames();
  const targets = fileNames
    ? jsonFolderFiles.filter((file) => fileNames.includes(file.name))
    : jsonFolderFiles;
  if (policyRunning || !jsonSourceDir || !targets.some((file) => file.hasMp4)) return;

  policyLogBox.textContent = "";
  setPolicyRunning(true);
  subscribePipeline();
  policyAppendLog(fileNames
    ? `———— 开始合并选中 ${fileNames.length} 个视频 ————`
    : "———— 开始合并文件夹内视频 ————");

  const res = await window.api.mergeJsonFolder({
    workDir: jsonSourceDir,
    fileNames,
    mergedFileName: policyMergedName.value,
    fps: Number(policyFpsSelect.value),
  });
  await finishJsonJob(res, "合并");
}

tabTrajectory.addEventListener("click", () => setAppMode("trajectory"));
tabJsonFolder.addEventListener("click", () => setAppMode("json"));

pickJsonDir.addEventListener("click", async () => {
  const dir = await window.api.selectJsonFolder();
  if (!dir) return;
  await loadJsonFolder(dir);
});

jsonSelectAll.addEventListener("change", () => {
  selectedJsonNames.clear();
  if (jsonSelectAll.checked) {
    jsonFolderFiles.forEach((file) => selectedJsonNames.add(file.name));
  }
  updateJsonSelectionUi();
});

convertJsonBtn.addEventListener("click", () => {
  runJsonConvert();
});

mergeJsonBtn.addEventListener("click", () => {
  runJsonMerge();
});

stopJsonBtn.addEventListener("click", async () => {
  if (!policyRunning) return;
  stopJsonBtn.disabled = true;
  policyAppendLog("正在停止导出…");
  await window.api.cancelExport();
});

if (window.api) {
  window.api.getSavedJsonFolder().then((dir) => {
    if (dir) loadJsonFolder(dir, { silent: true });
  });
}

if (!isPlayerReady()) {
  policyAppendLog("警告：rrweb-player 未加载，请重启应用");
}
