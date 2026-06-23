const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const { spawn } = require("child_process");

const ffmpegBinary = require("ffmpeg-static");
const { queryTrajectory } = require("./lib/trajectory-service.cjs");
const { getExportDir, setExportDir } = require("./lib/user-prefs.cjs");

/** 最近一次保单查询的完整轨迹（含 events），供预览与导出 */
let lastTrajectoryCache = null;

const SKIP_JSON = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "rrvideo.defaults.json",
]);

/** 与 shell 脚本一致：跳过约定名的 json 与 *.config.json */
function listWorkdirJsonFiles(workDir) {
  const names = fs.readdirSync(workDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".json"))
    .map((d) => d.name)
    .filter((name) => {
      if (SKIP_JSON.has(name)) return false;
      if (name.endsWith(".config.json")) return false;
      return true;
    });

  return names.sort((a, b) => {
    const baseA = path.basename(a, ".json");
    const baseB = path.basename(b, ".json");
    const na = Number(baseA);
    const nb = Number(baseB);
    const aNum = !Number.isNaN(na) && String(na) === baseA;
    const bNum = !Number.isNaN(nb) && String(nb) === baseB;
    if (aNum && bNum) return na - nb;
    return a.localeCompare(b, "en");
  });
}

function getRrvideoRoot() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "rrvideo");
  }
  return path.resolve(__dirname, "node_modules", "rrvideo");
}

function getCliPath(rrvideoRoot) {
  return path.join(rrvideoRoot, "build", "cli.js");
}

function resolveChromiumExecutableFromRoot(chromiumRoot) {
  if (!fs.existsSync(chromiumRoot)) return null;

  const platformPrefix = process.platform === "darwin"
    ? "mac-"
    : process.platform === "win32"
      ? (process.arch === "ia32" ? "win32-" : "win64-")
      : "linux-";
  const revisionDir = fs.readdirSync(chromiumRoot)
    .find((name) => name.startsWith(platformPrefix));
  if (!revisionDir) return null;

  const executablePath = process.platform === "darwin"
    ? path.join(chromiumRoot, revisionDir, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium")
    : process.platform === "win32"
      ? path.join(chromiumRoot, revisionDir, "chrome-win", "chrome.exe")
      : path.join(chromiumRoot, revisionDir, "chrome-linux", "chrome");

  return fs.existsSync(executablePath) ? executablePath : null;
}

function getPackagedChromiumExecutablePath() {
  if (!app.isPackaged) return null;

  const candidates = [
    path.join(process.resourcesPath, "chromium"),
    path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "node_modules",
      "puppeteer",
      ".local-chromium",
    ),
  ];

  for (const chromiumRoot of candidates) {
    const executablePath = resolveChromiumExecutableFromRoot(chromiumRoot);
    if (executablePath) return executablePath;
  }
  return null;
}

function getEffectiveFfmpegBinaryPath() {
  if (!app.isPackaged) {
    return ffmpegBinary && fs.existsSync(ffmpegBinary) ? ffmpegBinary : null;
  }

  const resourceBinaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const resourcePath = path.join(
    process.resourcesPath,
    "ffmpeg-static",
    resourceBinaryName,
  );
  if (fs.existsSync(resourcePath)) return resourcePath;

  if (ffmpegBinary) {
    const unpackedPath = ffmpegBinary.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`,
    );
    if (fs.existsSync(unpackedPath)) return unpackedPath;
  }

  return null;
}

function logTo(win, line) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("pipeline-log", line);
  }
}

function progressTo(win, state) {
  if (win && !win.isDestroyed()) {
    win.webContents.send("pipeline-progress", state);
  }
}

function spawnNodeCli({ rrvideoRoot, cliPath, args, envExtra, onData }) {
  return new Promise((resolve, reject) => {
    const nodePathEntries = [];
    if (app.isPackaged) {
      nodePathEntries.push(
        path.join(process.resourcesPath, "app.asar", "node_modules"),
        path.join(process.resourcesPath, "app.asar.unpacked", "node_modules"),
        path.join(process.resourcesPath, "node_modules"),
      );
    }

    const env = {
      ...process.env,
      ...envExtra,
      ELECTRON_RUN_AS_NODE: "1",
    };
    if (nodePathEntries.length) {
      env.NODE_PATH = [nodePathEntries.join(path.delimiter), env.NODE_PATH]
        .filter(Boolean)
        .join(path.delimiter);
    }
    const chromiumExecutablePath = getPackagedChromiumExecutablePath();
    if (chromiumExecutablePath) {
      env.PUPPETEER_EXECUTABLE_PATH = chromiumExecutablePath;
    }
    const effectiveFfmpegBinary = getEffectiveFfmpegBinaryPath();
    if (effectiveFfmpegBinary) {
      env.FFMPEG_BIN = effectiveFfmpegBinary;
      const dir = path.dirname(effectiveFfmpegBinary);
      env.PATH = `${dir}${path.delimiter}${env.PATH || ""}`;
    }

    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: rrvideoRoot,
      env,
    });

    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => onData && onData(String(c), "stdout"));
    child.stderr.on("data", (c) => {
      stderr += String(c);
      onData && onData(String(c), "stderr");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `进程退出码 ${code}`));
    });
  });
}

function runFfmpegConcat({ workDir, listFile, outputAbs }) {
  return new Promise((resolve, reject) => {
    const effectiveFfmpegBinary = getEffectiveFfmpegBinaryPath();
    if (!effectiveFfmpegBinary) {
      reject(new Error("未找到 ffmpeg 可执行文件（ffmpeg-static）"));
      return;
    }
    const child = spawn(effectiveFfmpegBinary, [
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      "-c", "copy",
      outputAbs,
    ], { cwd: workDir });

    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { err += String(c); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            err.trim() ||
              `ffmpeg concat 退出码 ${code}。若编码不一致，请尝试用应用外命令行重编码合并。`,
          ),
        );
      }
    });
  });
}

/** 探测某个 ffmpeg 编解码器在当前机器上是否可用 */
function probeCodec(codec) {
  return new Promise((resolve) => {
    const effectiveFfmpegBinary = getEffectiveFfmpegBinaryPath();
    if (!effectiveFfmpegBinary) { resolve(false); return; }
    const child = spawn(effectiveFfmpegBinary, [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=size=16x16:rate=1:duration=0.1",
      "-frames:v", "1",
      "-c:v", codec,
      "-f", "null", "-",
    ]);
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * 按平台返回最佳的「快速编码」ffmpeg 配置，结果会被缓存。
 * - macOS  → h264_videotoolbox（Apple 硬件编码器）
 * - Win/Lin → 依次探测 h264_nvenc / h264_amf / h264_qsv，
 *             全部不可用则回退到 libx264 preset=faster
 */
let _fastCodecCache = null;
async function detectFastCodec() {
  if (_fastCodecCache !== null) return _fastCodecCache;

  if (process.platform === "darwin") {
    _fastCodecCache = {
      codec: "h264_videotoolbox",
      bitrate: "4M",
      pixFmt: "nv12",
      extraArgs: [
        "-color_range", "tv",
        "-colorspace", "bt709",
        "-color_trc", "bt709",
        "-color_primaries", "bt709",
      ],
    };
    return _fastCodecCache;
  }

  const candidates = process.platform === "win32"
    ? ["h264_nvenc", "h264_amf", "h264_qsv"]
    : ["h264_nvenc", "h264_qsv"];

  for (const codec of candidates) {
    if (await probeCodec(codec)) {
      _fastCodecCache = { codec, bitrate: "4M", pixFmt: "yuv420p" };
      return _fastCodecCache;
    }
  }

  _fastCodecCache = { codec: "libx264", preset: "faster", crf: 23, pixFmt: "yuv420p" };
  return _fastCodecCache;
}

async function writeTrajectoryJsonFiles(workDir, items) {
  await fsp.mkdir(workDir, { recursive: true });
  const writtenFiles = [];
  let seq = 0;
  for (const item of items) {
    if (!item.events || !item.events.length) continue;
    seq += 1;
    const safePageId = String(item.pageId || "page").replace(/[/\\:?*"|<>]/gu, "_");
    const name = `${String(seq).padStart(3, "0")}_${safePageId}.json`;
    await fsp.writeFile(
      path.join(workDir, name),
      JSON.stringify(item.events),
      "utf8",
    );
    writtenFiles.push({ name, itemIndex: item.index });
  }
  if (!writtenFiles.length) {
    throw new Error("没有可导出的轨迹片段（事件数据为空或解析失败）");
  }
  return writtenFiles;
}

async function runPipeline(win, opts) {
  const { workDir, mergeVideos, mergedFileName, items, cleanupJson = false } = opts;
  const fps = Number.isFinite(Number(opts.fps)) && Number(opts.fps) > 0
    ? Number(opts.fps) : 15;
  const parallel = [1, 2, 4].includes(Number(opts.parallel))
    ? Number(opts.parallel) : 2;
  const fastEncode = true;

  const rrvideoRoot = getRrvideoRoot();
  const cliPath = getCliPath(rrvideoRoot);

  if (!fs.existsSync(rrvideoRoot)) {
    throw new Error(`找不到转换器目录：${rrvideoRoot}`);
  }
  if (!fs.existsSync(cliPath)) {
    throw new Error(`找不到 CLI：${cliPath}`);
  }
  if (!ffmpegBinary) {
    throw new Error("ffmpeg-static 不可用");
  }
  if (app.isPackaged && !getPackagedChromiumExecutablePath()) {
    throw new Error(
      "打包应用内未找到 Chromium，无法导出视频。请重新安装应用（需包含 Chromium 的完整安装包）。",
    );
  }
  if (app.isPackaged && !getEffectiveFfmpegBinaryPath()) {
    throw new Error(
      "打包应用内未找到 ffmpeg，无法导出视频。请重新安装应用（需包含 ffmpeg 的完整安装包）。",
    );
  }

  let jsonFiles;
  let jsonFilesToCleanup = [];
  let itemIndexByJson = new Map();

  if (Array.isArray(items) && items.length) {
    logTo(win, `从接口数据导出 ${items.length} 个轨迹片段…`);
    jsonFilesToCleanup = await writeTrajectoryJsonFiles(workDir, items);
    jsonFiles = jsonFilesToCleanup.map((entry) => entry.name);
    itemIndexByJson = new Map(
      jsonFilesToCleanup.map((entry) => [entry.name, entry.itemIndex]),
    );
  } else {
    jsonFiles = listWorkdirJsonFiles(workDir);
    if (!jsonFiles.length) {
      throw new Error(
        "当前文件夹没有可转换的 .json（已跳过 package.json、rrvideo.defaults.json、*.config.json 等）。",
      );
    }
  }

  const defaultsPath = path.join(workDir, "rrvideo.defaults.json");
  const hasDefaults = fs.existsSync(defaultsPath);
  const userDefaults = hasDefaults
    ? JSON.parse(fs.readFileSync(defaultsPath, "utf8"))
    : {};

  const baseFfmpeg = fastEncode
    ? await detectFastCodec()
    : { codec: "libx264", preset: "medium", crf: 23, pixFmt: "yuv420p" };

  const effectiveConfig = {
    renderDelayMs: 10,
    ...userDefaults,
    fps,
    ffmpeg: { ...baseFfmpeg, ...(userDefaults.ffmpeg || {}) },
  };

  const tempConfigPath = path.join(workDir, `.rrvideo.tmp.${process.pid}.json`);
  await fsp.writeFile(tempConfigPath, JSON.stringify(effectiveConfig, null, 2), "utf8");

  logTo(win, `工作目录：${workDir}`);
  logTo(win, `将转换 ${jsonFiles.length} 个 JSON …`);
  if (hasDefaults) {
    logTo(win, `已合并用户配置：rrvideo.defaults.json`);
  }
  logTo(
    win,
    `有效配置：fps=${effectiveConfig.fps}  codec=${effectiveConfig.ffmpeg.codec}` +
    `  renderDelay=${effectiveConfig.renderDelayMs}ms  并发=${parallel}`,
  );

  /** 含可选的「合并」一步；若最后跳过合并会在那时把 total 改掉 */
  let totalSteps = jsonFiles.length + (mergeVideos ? 1 : 0);
  progressTo(win, {
    completed: 0,
    total: totalSteps,
    phase: "convert",
    currentFile: null,
  });

  let ok = 0;
  let fail = 0;
  /** JSON 文件名 → 成功时对应的 mp4 文件名（用于合并时按扫描顺序串联） */
  const successOutNameByJson = new Map();
  let convertFinishedCount = 0;

  async function convertOne(base) {
    const inputAbs = path.join(workDir, base);
    const outName = `${path.basename(base, path.extname(base))}.mp4`;
    const outputAbs = path.join(workDir, outName);
    const args = ["--input", inputAbs, "--output", outputAbs, "--config", tempConfigPath];
    const itemIndex = itemIndexByJson.get(base);
    logTo(win, `开始：${base} → ${outName}`);
    if (itemIndex != null) {
      progressTo(win, { itemIndex, itemStatus: "exporting" });
    }
    progressTo(win, {
      completed: convertFinishedCount,
      total: totalSteps,
      phase: "convert",
      currentFile: base,
    });
    try {
      await spawnNodeCli({
        rrvideoRoot,
        cliPath,
        args,
        envExtra: {},
        onData: (chunk, stream) => {
          const trimmed = chunk.replace(/\s+$/u, "");
          if (trimmed) logTo(win, `[${stream}] ${trimmed}`);
        },
      });
      ok += 1;
      successOutNameByJson.set(base, outName);
      logTo(win, `完成：${outName}`);
      if (itemIndex != null) {
        progressTo(win, { itemIndex, itemStatus: "success" });
      }
    } catch (e) {
      fail += 1;
      logTo(win, `失败：${base}`);
      logTo(win, String(e.message || e));
      if (itemIndex != null) {
        progressTo(win, { itemIndex, itemStatus: "failed" });
      }
    } finally {
      convertFinishedCount += 1;
      progressTo(win, {
        completed: convertFinishedCount,
        total: totalSteps,
        phase: "convert",
        currentFile: null,
      });
    }
  }

  try {
    await new Promise((resolve) => {
      let nextIdx = 0;
      let running = 0;

      function schedule() {
        while (running < parallel && nextIdx < jsonFiles.length) {
          const f = jsonFiles[nextIdx++];
          running += 1;
          convertOne(f).finally(() => {
            running -= 1;
            if (nextIdx < jsonFiles.length) {
              schedule();
            } else if (running === 0) {
              resolve();
            }
          });
        }
        if (running === 0) resolve();
      }

      schedule();
    });

    logTo(win, `--- 导出结束：成功 ${ok}，失败 ${fail}`);

    if (!mergeVideos) {
      progressTo(win, {
        completed: jsonFiles.length,
        total: jsonFiles.length,
        phase: "done",
        currentFile: null,
      });
    }

    if (mergeVideos) {
      let outName =
        mergedFileName && mergedFileName.trim()
          ? mergedFileName.trim()
          : "merged.mp4";
      if (!outName.toLowerCase().endsWith(".mp4")) outName += ".mp4";

      const outputAbs = path.resolve(path.join(workDir, outName));
      const clipAbsOrdered = [];
      for (const jsonBase of jsonFiles) {
        const produced = successOutNameByJson.get(jsonBase);
        if (!produced) continue;
        const abs = path.resolve(path.join(workDir, produced));
        if (abs === outputAbs) continue;
        if (fs.existsSync(abs)) clipAbsOrdered.push(abs);
      }

      if (!clipAbsOrdered.length) {
        logTo(win, "没有成功导出的片段可合并，跳过合并。");
        totalSteps = jsonFiles.length;
        progressTo(win, {
          completed: jsonFiles.length,
          total: totalSteps,
          phase: "done",
          currentFile: null,
        });
        const n = jsonFiles.length;
        return {
          ok,
          fail,
          mergedPath: null,
          finalProgress: { phase: "done", completed: n, total: n },
        };
      }

      const listPath = path.join(workDir, `.merge_filelist.${process.pid}.txt`);
      const lines = clipAbsOrdered
        .map((absP) => {
          const esc = absP.replace(/'/gu, `'\\''`);
          return `file '${esc}'`;
        })
        .join("\n");
      await fsp.writeFile(listPath, `${lines}\n`, "utf8");

      logTo(win, `按 JSON 顺序合并 ${clipAbsOrdered.length} 段 → ${outName}`);
      progressTo(win, {
        completed: jsonFiles.length,
        total: totalSteps,
        phase: "merge",
        currentFile: outName,
      });
      try {
        await runFfmpegConcat({ workDir, listFile: listPath, outputAbs });
        logTo(win, `合并完成：${outputAbs}`);
      } finally {
        await fsp.unlink(listPath).catch(() => {});
      }

      progressTo(win, {
        completed: totalSteps,
        total: totalSteps,
        phase: "done",
        currentFile: null,
      });

      return {
        ok,
        fail,
        mergedPath: outputAbs,
        finalProgress: { phase: "done", completed: totalSteps, total: totalSteps },
      };
    }

    return {
      ok,
      fail,
      mergedPath: null,
      finalProgress: {
        phase: "done",
        completed: jsonFiles.length,
        total: jsonFiles.length,
      },
    };
  } finally {
    await fsp.unlink(tempConfigPath).catch(() => {});
    if (cleanupJson && jsonFilesToCleanup.length) {
      for (const entry of jsonFilesToCleanup) {
        await fsp.unlink(path.join(workDir, entry.name)).catch(() => {});
      }
      logTo(win, `已清理 ${jsonFilesToCleanup.length} 个中间 JSON 文件`);
    }
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      /** rrweb 回放需加载录制页中的跨域样式与资源 */
      webSecurity: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  detectFastCodec();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("select-folder", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  if (canceled || !filePaths[0]) return null;
  return filePaths[0];
});

ipcMain.handle("run-pipeline", async (_e, payload) => {
  const win = BrowserWindow.fromWebContents(_e.sender);
  try {
    const result = await runPipeline(win, payload);
    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
});

ipcMain.handle("query-trajectory", async (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const log = (line) => logTo(win, line);
  try {
    const result = await queryTrajectory({ ...payload, log });
    lastTrajectoryCache = result;
    return {
      success: true,
      result: {
        policyNo: result.policyNo,
        policyUuid: result.policyUuid,
        items: result.items.map((item) => ({
          index: item.index,
          pageId: item.pageId,
          pageDesc: item.pageDesc,
          pageVisitTime: item.pageVisitTime,
          durationMs: item.durationMs,
          durationText: item.durationText,
          error: item.error || null,
        })),
        steps: result.steps || [],
      },
    };
  } catch (error) {
    lastTrajectoryCache = null;
    return {
      success: false,
      error: error.message || String(error),
    };
  }
});

ipcMain.handle("get-trajectory-events", (_e, index) => {
  const idx = Number(index);
  const item = lastTrajectoryCache?.items?.[idx];
  if (!item || !item.events || !item.events.length) {
    return {
      success: false,
      error: item?.error || `该片段无可用轨迹数据（index=${idx}）`,
    };
  }
  let events = item.events;
  try {
    events = JSON.parse(JSON.stringify(item.events));
  } catch (e) {
    return {
      success: false,
      error: `轨迹数据无法序列化：${e.message || e}`,
    };
  }
  return {
    success: true,
    events,
    pageId: item.pageId,
    pageDesc: item.pageDesc,
  };
});

ipcMain.handle("get-export-dir", async () => {
  return getExportDir(app);
});

ipcMain.handle("select-output-folder", async () => {
  const savedDir = await getExportDir(app);
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    defaultPath: savedDir || path.join(os.homedir(), "Downloads"),
  });
  if (canceled || !filePaths[0]) return null;
  await setExportDir(app, filePaths[0]);
  return filePaths[0];
});

ipcMain.handle("export-trajectory", async (_e, payload) => {
  const win = BrowserWindow.fromWebContents(_e.sender);
  try {
    if (!lastTrajectoryCache?.items?.length) {
      throw new Error("请先查询保单轨迹");
    }
    const outputDir = payload.outputDir;
    if (!outputDir) {
      throw new Error("请选择导出目录");
    }
    const exportable = lastTrajectoryCache.items.filter(
      (item) => item.events && item.events.length,
    );
    if (!exportable.length) {
      throw new Error("没有可导出的轨迹片段（事件数据为空或解析失败）");
    }

    const mergedBase = payload.mergedFileName && payload.mergedFileName.trim()
      ? payload.mergedFileName.trim().replace(/\.mp4$/iu, "")
      : `${lastTrajectoryCache.policyNo || "trajectory"}_merged`;
    const mergedFileName = `${mergedBase}.mp4`;

    const result = await runPipeline(win, {
      workDir: outputDir,
      items: exportable,
      cleanupJson: true,
      mergeVideos: payload.mergeVideos !== false,
      mergedFileName,
      fps: payload.fps,
      parallel: payload.parallel,
    });
    await setExportDir(app, outputDir);
    return { success: true, result, outputDir };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
});
