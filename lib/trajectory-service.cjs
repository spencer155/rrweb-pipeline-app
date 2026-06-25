const config = require("../config.cjs");
const { formatEvents, normalizeItemEvents } = require("./event-parser.cjs");
const { pageDesc } = require("./page-map.cjs");

function resolveEnv() {
  return {
    apiBase: config.apiBase,
    userUuid: config.userUuid,
    appId: config.appId,
  };
}

function buildApiUrl(apiBase, path, params) {
  const base = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
  const pathname = path.startsWith("/") ? path.slice(1) : path;
  const qs = new URLSearchParams(params);
  return `${base}${pathname}?${qs}`;
}

function extractVideoAuditToken(data) {
  if (!data) return null;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (typeof data === "object") {
    const main = data.policyMainOrder;
    if (main && typeof main.videoAuditToken === "string" && main.videoAuditToken.trim()) {
      return main.videoAuditToken.trim();
    }
    if (typeof data.videoAuditToken === "string" && data.videoAuditToken.trim()) {
      return data.videoAuditToken.trim();
    }
    if (typeof data.token === "string" && data.token.trim()) {
      return data.token.trim();
    }
  }
  return null;
}

function extractPolicyNo(data) {
  const main = data && data.policyMainOrder;
  if (main && typeof main.policyNo === "string" && main.policyNo.trim()) {
    return main.policyNo.trim();
  }
  return null;
}

function maskUrl(url) {
  try {
    const u = new URL(url);
    for (const key of ["policyUuid", "policyNo", "videoAuditToken", "userUuid"]) {
      const v = u.searchParams.get(key);
      if (v && v.length > 8) {
        u.searchParams.set(key, `${v.slice(0, 4)}…${v.slice(-4)}`);
      }
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function apiGet(url, log) {
  const safeUrl = maskUrl(url);
  log?.(`[HTTP] → GET ${safeUrl}`);
  if (typeof log === "function") {
    console.log(`[trajectory] GET ${safeUrl}`);
  }

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "rrweb-pipeline-app/1.0",
    },
  });

  let body = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      body = await res.json();
    } catch (e) {
      body = null;
    }
  }

  if (!res.ok) {
    const bizMsg = body && (body.msg || body.info || body.message);
    log?.(`[HTTP] ← ${res.status} ${bizMsg || "失败"}`);
    throw new Error(
      bizMsg
        ? `接口请求失败 (${res.status})：${bizMsg}`
        : `接口请求失败 (${res.status})：${url}`,
    );
  }

  if (body && body.code != null && body.code !== 200 && body.success !== true) {
    const bizMsg = body.msg || body.info || body.message || `code=${body.code}`;
    log?.(`[HTTP] ← 200 业务错误：${bizMsg}`);
    throw new Error(bizMsg);
  }

  log?.(`[HTTP] ← ${res.status} OK`);
  return body;
}

async function apiGetSafe(url, log) {
  try {
    return await apiGet(url, log);
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

async function getPolicyInfo({ policyUuid, log }) {
  const { apiBase } = resolveEnv();
  const url = buildApiUrl(apiBase, "api/policy/getPolicyInfo", {
    policyUuid: policyUuid.trim(),
  });
  const body = await apiGet(url, log);
  const data = body && body.data;
  const token = extractVideoAuditToken(data);
  if (token) {
    return {
      token,
      policyNo: extractPolicyNo(data),
      url,
    };
  }
  throw new Error("请输入正确的 policyUuid");
}

async function getVideoDataFromOss({ videoAuditToken, policyUuid, log }) {
  const { apiBase, userUuid, appId } = resolveEnv();
  const params = {
    videoAuditToken,
    userUuid,
    appId,
  };
  const trimmedUuid = policyUuid && policyUuid.trim();
  if (trimmedUuid) {
    params.policyUuid = trimmedUuid;
  }
  const url = buildApiUrl(apiBase, "api/audit/getVideoDataFromOss", params);
  const body = await apiGet(url, log);
  if (Array.isArray(body.data) && body.data.length) {
    return { data: body.data, url };
  }
  return { data: null, url };
}

async function getVideoAuditLog({ videoAuditToken, log }) {
  const { apiBase, userUuid, appId } = resolveEnv();
  const url = buildApiUrl(apiBase, "api/audit/getVideoAuditLog", {
    appId,
    userUuid,
    videoAuditToken,
  });
  const body = await apiGetSafe(url, log);
  if (body.error) {
    return { data: [], url, error: body.error };
  }
  if (Array.isArray(body.data)) {
    return { data: body.data, url };
  }
  return { data: [], url };
}

function computeDurationMs(events) {
  if (!Array.isArray(events) || !events.length) return 0;
  const sorted = [...events].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  const start = Number(sorted[0].timestamp) || 0;
  const end = Number(sorted[sorted.length - 1].timestamp) || start;
  return Math.max(0, end - start);
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return "—";
  const totalSec = Math.max(1, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m > 0) return `${m}:${String(s).padStart(2, "0")}`;
  return `0:${String(s).padStart(2, "0")}`;
}

function toListItem(raw, index) {
  const normalized = normalizeItemEvents(raw);
  const durationMs = computeDurationMs(normalized.message);
  return {
    index,
    pageId: normalized.pageId,
    pageDesc: pageDesc(normalized.pageId),
    pageVisitTime: normalized.pageVisitTime,
    version: normalized.version || 2,
    events: normalized.message,
    eventCount: normalized.message.length,
    durationMs,
    durationText: formatDuration(durationMs),
  };
}

function sanitizeExportName(name) {
  return String(name).trim().replace(/[/\\:?*"|<>]/gu, "_") || "trajectory";
}

async function fetchTrajectoryRawList({ videoAuditToken, policyUuid, log, steps }) {
  let rawList = null;

  try {
    const ossResult = await getVideoDataFromOss({ videoAuditToken, policyUuid, log });
    if (ossResult.data) {
      rawList = formatEvents(ossResult.data);
      const withEvents = rawList.filter((item) => Array.isArray(item.message) && item.message.length);
      steps.push(
        `getVideoDataFromOss：${ossResult.data.length} 条原始记录，${withEvents.length} 条含有效事件`,
      );
      rawList = withEvents.length ? withEvents : null;
    } else {
      steps.push("getVideoDataFromOss：无数据");
    }
  } catch (e) {
    steps.push(`getVideoDataFromOss 失败：${e.message || e}`);
    rawList = null;
  }

  if (!rawList || !rawList.length) {
    const logResult = await getVideoAuditLog({ videoAuditToken, log });
    if (logResult.error) {
      steps.push(`getVideoAuditLog 不可用：${logResult.error}`);
    } else {
      steps.push(`getVideoAuditLog：${logResult.data.length} 条`);
    }
    rawList = logResult.data;
  }

  return rawList;
}

function buildTrajectoryItems(rawList) {
  if (!rawList || !rawList.length) return [];

  const filtered = rawList.filter((item) => item.pageId !== "CP_DDXQ");
  const items = [];
  filtered.forEach((raw, idx) => {
    try {
      items.push(toListItem(raw, idx));
    } catch (e) {
      items.push({
        index: idx,
        pageId: raw.pageId,
        pageDesc: pageDesc(raw.pageId),
        pageVisitTime: raw.pageVisitTime,
        version: raw.version || 2,
        events: null,
        eventCount: 0,
        durationMs: 0,
        durationText: "—",
        error: e.message || String(e),
      });
    }
  });
  return items;
}

async function queryTrajectory({ policyUuid, videoAuditToken, log }) {
  const token = videoAuditToken && videoAuditToken.trim();
  const uuid = policyUuid && policyUuid.trim();

  const { apiBase } = resolveEnv();
  log?.(`[主进程] 接口请求在 Node 主进程发起`);
  log?.(`[主进程] API 基址：${apiBase}`);

  const steps = [];

  if (token) {
    steps.push("使用 videoAuditToken 直接查询（跳过 getPolicyInfo）");
    const rawList = await fetchTrajectoryRawList({
      videoAuditToken: token,
      policyUuid: uuid,
      log,
      steps,
    });
    if (!rawList || !rawList.length) {
      throw new Error(
        `未查询到操作轨迹数据。\n${steps.join("\n")}\n`
        + "请确认 videoAuditToken 是否正确。",
      );
    }
    const items = buildTrajectoryItems(rawList);
    const exportKey = sanitizeExportName(token);
    return {
      videoAuditToken: token,
      policyNo: "",
      policyUuid: uuid,
      exportKey,
      queryMode: "token",
      items,
      steps,
    };
  }

  if (!uuid || uuid.length < 32) {
    throw new Error("请输入 policyUuid（至少 32 位）或 videoAuditToken");
  }

  const policyInfo = await getPolicyInfo({
    policyUuid: uuid,
    log,
  });
  const resolvedToken = policyInfo.token;
  const resolvedPolicyNo = policyInfo.policyNo || "";
  steps.push("getPolicyInfo 成功");

  const rawList = await fetchTrajectoryRawList({
    videoAuditToken: resolvedToken,
    policyUuid: uuid,
    log,
    steps,
  });

  if (!rawList || !rawList.length) {
    throw new Error(
      `未查询到操作轨迹数据。\n${steps.join("\n")}\n`
      + "请确认 policyUuid 是否正确。",
    );
  }

  const items = buildTrajectoryItems(rawList);

  return {
    videoAuditToken: resolvedToken,
    policyNo: resolvedPolicyNo,
    policyUuid: uuid,
    exportKey: sanitizeExportName(uuid),
    queryMode: "policyUuid",
    items,
    steps,
  };
}

module.exports = {
  queryTrajectory,
  sanitizeExportName,
  pageDesc,
  computeDurationMs,
  formatDuration,
};
