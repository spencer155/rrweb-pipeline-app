const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const { spawn } = require("child_process");

const ffmpegBinary = require("ffmpeg-static");
const { queryTrajectory, sanitizeExportName } = require("./lib/trajectory-service.cjs");
const { getExportDir, setExportDir } = require("./lib/user-prefs.cjs");

/** 最近一次保单查询的完整轨迹（含 events），供预览与导出 */
let lastTrajectoryCache = null;

class PipelineAbortError extends Error {
  constructor() {
    super("导出已取消");
    this.name = "PipelineAbortError";
  }
}

/** @type {{ aborted: boolean; children: Set<import('child_process').ChildProcess>; running: boolean } | null} */
let activePipelineSession = null;

function beginPipelineSession() {
  if (activePipelineSession?.running) {
    throw new Error("已有导出任务进行中");
  }
  const session = {
    aborted: false,
    children: new Set(),
    running: true,
  };
  activePipelineSession = session;
  return session;
}

function endPipelineSession(session) {
  session.running = false;
  if (activePipelineSession === session) {
    activePipelineSession = null;
  }
}

function cancelActivePipeline() {
  if (!activePipelineSession?.running) return false;
  activePipelineSession.aborted = true;
  for (const child of activePipelineSession.children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  return true;
}

function isPipelineAborted(session) {
  return Boolean(session && session.aborted);
}

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

function spawnNodeCli({ rrvideoRoot, cliPath, args, envExtra, onData, session }) {
  return new Promise((resolve, reject) => {
    if (isPipelineAborted(session)) {
      reject(new PipelineAbortError());
      return;
    }

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
    session?.children.add(child);

    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => onData && onData(String(c), "stdout"));
    child.stderr.on("data", (c) => {
      stderr += String(c);
      onData && onData(String(c), "stderr");
    });
    child.on("error", (err) => {
      session?.children.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      session?.children.delete(child);
      if (isPipelineAborted(session)) {
        reject(new PipelineAbortError());
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `进程退出码 ${code}`));
    });
  });
}

function buildMergeVideoEncodeArgs(ffmpegConfig, fps) {
  const codec = String(ffmpegConfig.codec || "libx264");
  const frameRate = Math.max(1, Number(fps) || 15);
  const gop = Math.max(1, Math.round(frameRate));
  const args = ["-c:v", codec];

  if (codec === "libx264" || codec === "libx265") {
    args.push(
      "-preset", String(ffmpegConfig.preset != null ? ffmpegConfig.preset : "faster"),
      "-crf", String(ffmpegConfig.crf != null ? ffmpegConfig.crf : 23),
      "-g", String(gop),
      "-keyint_min", String(gop),
      "-sc_threshold", "0",
    );
  } else if (codec === "h264_videotoolbox") {
    args.push(
      "-b:v", String(ffmpegConfig.bitrate != null ? ffmpegConfig.bitrate : "4M"),
      "-g", String(gop),
    );
  } else if (ffmpegConfig.bitrate) {
    args.push("-b:v", String(ffmpegConfig.bitrate), "-g", String(gop));
  }

  args.push("-pix_fmt", String(ffmpegConfig.pixFmt || "yuv420p"));
  args.push("-r", String(frameRate));
  args.push("-vsync", "cfr");
  args.push("-movflags", "+faststart");

  if (Array.isArray(ffmpegConfig.extraArgs) && ffmpegConfig.extraArgs.length) {
    args.push(...ffmpegConfig.extraArgs.map(String));
  }

  return args;
}

function runFfmpegConcat({ workDir, listFile, outputAbs, ffmpegConfig, fps, session }) {
  return new Promise((resolve, reject) => {
    if (isPipelineAborted(session)) {
      reject(new PipelineAbortError());
      return;
    }
    const effectiveFfmpegBinary = getEffectiveFfmpegBinaryPath();
    if (!effectiveFfmpegBinary) {
      reject(new Error("未找到 ffmpeg 可执行文件（ffmpeg-static）"));
      return;
    }
    const child = spawn(effectiveFfmpegBinary, [
      "-y",
      "-hide_banner",
      "-loglevel", "warning",
      "-f", "concat",
      "-safe", "0",
      "-i", listFile,
      ...buildMergeVideoEncodeArgs(ffmpegConfig, fps),
      outputAbs,
    ], { cwd: workDir });
    session?.children.add(child);

    let err = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { err += String(c); });
    child.on("error", (error) => {
      session?.children.delete(child);
      reject(error);
    });
    child.on("close", (code) => {
      session?.children.delete(child);
      if (isPipelineAborted(session)) {
        reject(new PipelineAbortError());
        return;
      }
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

function clipBaseNameForItem(item, seqFallback) {
  const seq = item.index != null && Number.isFinite(Number(item.index))
    ? Number(item.index) + 1
    : seqFallback;
  const safePageId = String(item.pageId || "page").replace(/[/\\:?*"|<>]/gu, "_");
  return `${String(seq).padStart(3, "0")}_${safePageId}`;
}

/** 用 ffmpeg 检查文件是否可读；短片段（1～5 秒）导出后时长可能仅零点几秒，以能否解码为准，不按最短时长拦截 */
function probeVideoFile(absPath) {
  if (!fs.existsSync(absPath)) {
    return Promise.resolve({ valid: false, error: "文件不存在" });
  }
  const stat = fs.statSync(absPath);
  if (stat.size === 0) {
    return Promise.resolve({ valid: false, error: "文件为空（0 字节）" });
  }
  const effectiveFfmpegBinary = getEffectiveFfmpegBinaryPath();
  if (!effectiveFfmpegBinary) {
    return Promise.resolve({ valid: false, error: "ffmpeg 不可用" });
  }
  return new Promise((resolve) => {
    const child = spawn(effectiveFfmpegBinary, [
      "-hide_banner",
      "-v", "error",
      "-i", absPath,
      "-f", "null", "-",
    ]);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => { stderr += String(c); });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({
          valid: false,
          error: stderr.trim() || `无法读取视频（退出码 ${code}）`,
        });
        return;
      }
      let durationSec = null;
      const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/u);
      if (m) {
        durationSec = parseInt(m[1], 10) * 3600
          + parseInt(m[2], 10) * 60
          + parseFloat(m[3]);
        if (!Number.isFinite(durationSec)) durationSec = null;
      }
      resolve({ valid: true, size: stat.size, durationSec });
    });
    child.on("error", (e) => resolve({ valid: false, error: e.message || String(e) }));
  });
}

async function collectValidatedClips(win, workDir, items, mergedFileName) {
  const exportable = items.filter(
    (item) => !item.error && item.durationMs > 0 && item.events && item.events.length,
  );
  if (!exportable.length) {
    throw new Error("没有可合并的轨迹片段");
  }

  let outName = mergedFileName && mergedFileName.trim() ? mergedFileName.trim() : "merged.mp4";
  if (!outName.toLowerCase().endsWith(".mp4")) outName += ".mp4";
  const outputAbs = path.resolve(path.join(workDir, outName));

  logTo(win, `校验 ${exportable.length} 个片段视频…`);
  const clips = [];
  const errors = [];
  const warnings = [];
  let seqFallback = 0;

  for (const item of exportable) {
    seqFallback += 1;
    const base = clipBaseNameForItem(item, seqFallback);
    const mp4Name = `${base}.mp4`;
    const abs = path.resolve(path.join(workDir, mp4Name));
    const pageLabel = item.pageDesc || item.pageId || base;

    const probe = await probeVideoFile(abs);
    if (!probe.valid) {
      errors.push(`${pageLabel}（${mp4Name}）：${probe.error}`);
      continue;
    }

    if (abs === outputAbs) {
      warnings.push(`${mp4Name} 与合并输出文件名相同，已跳过`);
      continue;
    }

    let durText;
    if (probe.durationSec != null) {
      durText = `${probe.durationSec.toFixed(2)}s`;
    } else {
      durText = `可读，${Math.max(1, Math.round(probe.size / 1024))}KB`;
    }
    logTo(win, `✓ ${mp4Name}（${pageLabel}，${durText}）`);
    clips.push(abs);
  }

  for (const w of warnings) {
    logTo(win, `⚠ ${w}`);
  }

  if (errors.length) {
    throw new Error(`视频校验未通过：\n${errors.join("\n")}`);
  }
  if (!clips.length) {
    throw new Error("没有通过校验的片段可合并");
  }

  return { clips, outName, outputAbs };
}

async function runMergeOnly(win, opts) {
  const {
    workDir,
    items,
    mergedFileName,
    session = null,
  } = opts;
  const fps = Number.isFinite(Number(opts.fps)) && Number(opts.fps) > 0
    ? Number(opts.fps) : 15;

  if (!getEffectiveFfmpegBinaryPath()) {
    throw new Error("ffmpeg-static 不可用");
  }

  const { clips, outName, outputAbs } = await collectValidatedClips(
    win,
    workDir,
    items,
    mergedFileName,
  );

  const baseFfmpeg = await detectFastCodec();
  const effectiveConfig = {
    fps,
    ffmpeg: baseFfmpeg,
  };

  const totalSteps = 1;
  progressTo(win, {
    completed: 0,
    total: totalSteps,
    phase: "merge",
    currentFile: outName,
  });

  const listPath = path.join(workDir, `.merge_filelist.${process.pid}.txt`);
  const lines = clips
    .map((absP) => {
      const esc = absP.replace(/'/gu, `'\\''`);
      return `file '${esc}'`;
    })
    .join("\n");
  await fsp.writeFile(listPath, `${lines}\n`, "utf8");

  logTo(win, `按轨迹顺序合并 ${clips.length} 段 → ${outName}（重新编码以修正时间轴）`);
  try {
    await runFfmpegConcat({
      workDir,
      listFile: listPath,
      outputAbs,
      ffmpegConfig: effectiveConfig.ffmpeg,
      fps: effectiveConfig.fps,
      session,
    });
    logTo(win, `合并完成：${outputAbs}`);
  } catch (e) {
    if (e instanceof PipelineAbortError || isPipelineAborted(session)) {
      logTo(win, "--- 合并已取消 ---");
      progressTo(win, {
        completed: 0,
        total: totalSteps,
        phase: "done",
        currentFile: null,
      });
      return {
        cancelled: true,
        mergedPath: null,
        clipCount: clips.length,
        finalProgress: { phase: "done", completed: 0, total: totalSteps },
      };
    }
    throw e;
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
    cancelled: false,
    mergedPath: outputAbs,
    clipCount: clips.length,
    finalProgress: { phase: "done", completed: totalSteps, total: totalSteps },
  };
}

async function writeTrajectoryJsonFiles(workDir, items) {
  await fsp.mkdir(workDir, { recursive: true });
  const writtenFiles = [];
  let seq = 0;
  for (const item of items) {
    if (!item.events || !item.events.length) continue;
    seq += 1;
    const name = `${clipBaseNameForItem(item, seq)}.json`;
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
  const {
    workDir,
    mergeVideos,
    mergedFileName,
    items,
    cleanupJson = false,
    session = null,
  } = opts;
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
  let cancelled = false;
  /** JSON 文件名 → 成功时对应的 mp4 文件名（用于合并时按扫描顺序串联） */
  const successOutNameByJson = new Map();
  const failedJsonBases = new Set();
  let convertFinishedCount = 0;

  async function convertOne(base) {
    if (isPipelineAborted(session)) {
      cancelled = true;
      return;
    }
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
        session,
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
      if (e instanceof PipelineAbortError || isPipelineAborted(session)) {
        cancelled = true;
        if (itemIndex != null) {
          progressTo(win, { itemIndex, itemStatus: "cancelled" });
        }
        return;
      }
      fail += 1;
      failedJsonBases.add(base);
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
        if (isPipelineAborted(session)) {
          cancelled = true;
          if (running === 0) resolve();
          return;
        }
        while (running < parallel && nextIdx < jsonFiles.length && !isPipelineAborted(session)) {
          const f = jsonFiles[nextIdx++];
          running += 1;
          convertOne(f).finally(() => {
            running -= 1;
            if (isPipelineAborted(session)) {
              cancelled = true;
              if (running === 0) resolve();
              return;
            }
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

    if (cancelled || isPipelineAborted(session)) {
      for (const base of jsonFiles) {
        const itemIndex = itemIndexByJson.get(base);
        if (itemIndex == null) continue;
        if (successOutNameByJson.has(base) || failedJsonBases.has(base)) continue;
        progressTo(win, { itemIndex, itemStatus: "cancelled" });
      }
      logTo(win, `--- 导出已取消：成功 ${ok}，失败 ${fail}`);
      progressTo(win, {
        completed: convertFinishedCount,
        total: totalSteps,
        phase: "done",
        currentFile: null,
      });
      return {
        ok,
        fail,
        cancelled: true,
        mergedPath: null,
        finalProgress: {
          phase: "done",
          completed: convertFinishedCount,
          total: totalSteps,
        },
      };
    }

    logTo(win, `--- 导出结束：成功 ${ok}，失败 ${fail}`);

    if (!mergeVideos) {
      progressTo(win, {
        completed: jsonFiles.length,
        total: jsonFiles.length,
        phase: "done",
        currentFile: null,
      });
    }

    if (mergeVideos && !isPipelineAborted(session)) {
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

      logTo(win, `按 JSON 顺序合并 ${clipAbsOrdered.length} 段 → ${outName}（重新编码以修正时间轴）`);
      progressTo(win, {
        completed: jsonFiles.length,
        total: totalSteps,
        phase: "merge",
        currentFile: outName,
      });
      try {
        await runFfmpegConcat({
          workDir,
          listFile: listPath,
          outputAbs,
          ffmpegConfig: effectiveConfig.ffmpeg,
          fps: effectiveConfig.fps,
          session,
        });
        logTo(win, `合并完成：${outputAbs}`);
      } catch (e) {
        if (e instanceof PipelineAbortError || isPipelineAborted(session)) {
          logTo(win, "--- 合并已取消 ---");
          progressTo(win, {
            completed: jsonFiles.length,
            total: totalSteps,
            phase: "done",
            currentFile: null,
          });
          return {
            ok,
            fail,
            cancelled: true,
            mergedPath: null,
            finalProgress: {
              phase: "done",
              completed: jsonFiles.length,
              total: totalSteps,
            },
          };
        }
        throw e;
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

function resolveExportableItems(cache, itemIndices) {
  const all = cache.items.filter((item) => item.events && item.events.length);
  if (!Array.isArray(itemIndices) || !itemIndices.length) return all;
  const picked = [];
  for (const rawIdx of itemIndices) {
    const item = cache.items[Number(rawIdx)];
    if (item && item.events && item.events.length) {
      picked.push(item);
    }
  }
  if (!picked.length) {
    throw new Error("所选片段无可导出数据");
  }
  return picked;
}

async function buildTrajectoryExportContext(cache, baseDir, payload) {
  const exportKey = String(
    cache.exportKey
    || cache.videoAuditToken
    || cache.policyUuid
    || "",
  ).trim();
  const safeFolderName = sanitizeExportName(exportKey);
  const workDir = path.join(baseDir, safeFolderName);
  await fsp.mkdir(workDir, { recursive: true });

  const mergedBase = payload.mergedFileName && payload.mergedFileName.trim()
    ? payload.mergedFileName.trim().replace(/\.mp4$/iu, "")
    : `${cache.policyNo || safeFolderName}_merged`;
  const mergedFileName = `${mergedBase}.mp4`;

  return { workDir, mergedFileName, baseDir, safeFolderName };
}

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
        videoAuditToken: result.videoAuditToken,
        exportKey: result.exportKey,
        queryMode: result.queryMode,
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

ipcMain.handle("cancel-export", () => {
  return { success: cancelActivePipeline() };
});

ipcMain.handle("merge-trajectory", async (_e, payload) => {
  const win = BrowserWindow.fromWebContents(_e.sender);
  const session = beginPipelineSession();
  try {
    if (!lastTrajectoryCache?.items?.length) {
      throw new Error("请先查询保单轨迹");
    }
    const baseDir = payload.outputDir;
    if (!baseDir) {
      throw new Error("请选择导出目录");
    }
    const { workDir, mergedFileName } = await buildTrajectoryExportContext(
      lastTrajectoryCache,
      baseDir,
      payload,
    );
    const result = await runMergeOnly(win, {
      workDir,
      items: lastTrajectoryCache.items,
      mergedFileName,
      fps: payload.fps,
      session,
    });
    return { success: true, result, outputDir: workDir, baseDir };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  } finally {
    endPipelineSession(session);
  }
});

ipcMain.handle("export-trajectory", async (_e, payload) => {
  const win = BrowserWindow.fromWebContents(_e.sender);
  const session = beginPipelineSession();
  try {
    if (!lastTrajectoryCache?.items?.length) {
      throw new Error("请先查询保单轨迹");
    }
    const baseDir = payload.outputDir;
    if (!baseDir) {
      throw new Error("请选择导出目录");
    }
    const exportable = resolveExportableItems(lastTrajectoryCache, payload.itemIndices);
    const { workDir, mergedFileName } = await buildTrajectoryExportContext(
      lastTrajectoryCache,
      baseDir,
      payload,
    );

    const isSingleExport = Array.isArray(payload.itemIndices) && payload.itemIndices.length > 0;
    const mergeVideos = isSingleExport
      ? payload.mergeVideos === true
      : payload.mergeVideos !== false;

    const result = await runPipeline(win, {
      workDir,
      items: exportable,
      cleanupJson: true,
      mergeVideos,
      mergedFileName,
      fps: payload.fps,
      parallel: payload.parallel,
      session,
    });
    await setExportDir(app, baseDir);
    return { success: true, result, outputDir: workDir, baseDir };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  } finally {
    endPipelineSession(session);
  }
});
