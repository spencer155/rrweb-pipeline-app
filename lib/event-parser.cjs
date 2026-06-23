const pako = require("pako");

/** 与 view-operation-trajectory-new.vue 的 unzipn 保持一致 */
function unzipn(b64Data) {
  const strData = Buffer.from(b64Data, "base64");
  const charData = [...strData];
  const binData = new Uint8Array(charData);
  const data = pako.inflate(binData);
  const array = new Uint16Array(data);
  let res = "";
  const chunk = 8 * 1024;
  let i;
  for (i = 0; i < array.length / chunk; i += 1) {
    res += String.fromCharCode.apply(null, array.slice(i * chunk, (i + 1) * chunk));
  }
  res += String.fromCharCode.apply(null, array.slice(i * chunk));
  try {
    return decodeURIComponent(res);
  } catch (e) {
    return res;
  }
}

/** 与 view-operation-trajectory-new.vue 的 unzipn3 保持一致 */
function unzipn3(b64Data) {
  const strData = Buffer.from(b64Data, "base64").toString("latin1");
  const charData = strData.split(",").map((x) => parseInt(x, 10));
  const data = pako.inflate(charData, { to: "string" });
  try {
    return decodeURIComponent(data);
  } catch (e) {
    return data;
  }
}

function inflateToUtf8(b64Data) {
  const binData = new Uint8Array(Buffer.from(b64Data, "base64"));
  return pako.inflate(binData, { to: "string" });
}

function parseMessage(message) {
  if (!message || typeof message !== "string") return "";
  const trimmed = message.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return trimmed;
  }

  const attempts = [
    () => unzipn(message),
    () => unzipn3(message),
    () => inflateToUtf8(message),
  ];

  for (const attempt of attempts) {
    try {
      const value = attempt();
      if (value) return value;
    } catch (e) {
      // try next
    }
  }
  return "";
}

function parseEventsPayload(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") return [raw];

  if (typeof raw !== "string") return [];

  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    // not plain JSON
  }

  const message = parseMessage(trimmed);
  if (!message) {
    throw new Error("轨迹片段解压失败");
  }

  try {
    const parsed = JSON.parse(message);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    throw new Error(`轨迹片段 JSON 解析失败：${e.message || e}`);
  }
}

function formatEvents(list) {
  list.forEach((item) => {
    let events = [];
    let firstContent = {};

    if (item.contentObjList && item.contentObjList.length) {
      item.contentObjList.forEach((content, index) => {
        if (index === 0) firstContent = content;

        try {
          let chunk = [];
          if (content.events) {
            chunk = parseEventsPayload(content.events);
          } else if (content.message) {
            chunk = parseEventsPayload(content.message);
          }
          if (chunk.length) {
            events = events.concat(chunk);
          }
        } catch (e) {
          console.warn("[formatEvents] skip chunk:", e.message || e);
        }
      });
    } else if (item.message) {
      try {
        events = parseEventsPayload(item.message);
      } catch (e) {
        console.warn("[formatEvents] skip item:", e.message || e);
      }
    }

    if (item.fileName || events.length) {
      item.message = events;
    }
    item.pageId = firstContent.pageId || item.pageId;
    item.pageVisitTime = firstContent.pageVisitTime || item.pageVisitTime;
    item.version = firstContent.version || item.version || 2;
  });
  return list;
}

function normalizeItemEvents(item) {
  const copy = { ...item };
  if (copy.version === 2 && Array.isArray(copy.message)) {
    return copy;
  }

  if (typeof copy.message === "string" || Array.isArray(copy.message)) {
    try {
      copy.message = parseEventsPayload(copy.message);
      copy.version = 2;
    } catch (e) {
      throw new Error(e.message || "轨迹数据异常，无法解析");
    }
  }

  if (!Array.isArray(copy.message) || !copy.message.length) {
    throw new Error("轨迹预览失败：无有效事件数据");
  }
  return copy;
}

module.exports = {
  formatEvents,
  normalizeItemEvents,
  parseEventsPayload,
  parseMessage,
  unzipn,
};
