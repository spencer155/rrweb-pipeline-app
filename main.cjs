const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { spawn } = require("child_process");

const ffmpegBinary = require("ffmpeg-static");

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
    const env = {
      ...process.env,
      ...envExtra,
      ELECTRON_RUN_AS_NODE: "1",
    };
    if (ffmpegBinary) {
      const dir = path.dirname(ffmpegBinary);
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
    if (!ffmpegBinary) {
      reject(new Error("未找到 ffmpeg 可执行文件（ffmpeg-static）"));
      return;
    }
    const child = spawn(ffmpegBinary, [
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
    if (!ffmpegBinary) { resolve(false); return; }
    const child = spawn(ffmpegBinary, [
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

async function runPipeline(win, opts) {
  const { workDir, mergeVideos, mergedFileName } = opts;
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

  const jsonFiles = listWorkdirJsonFiles(workDir);
  if (!jsonFiles.length) {
    throw new Error(
      "当前文件夹没有可转换的 .json（已跳过 package.json、rrvideo.defaults.json、*.config.json 等）。",
    );
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
    logTo(win, `开始：${base} → ${outName}`);
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
    } catch (e) {
      fail += 1;
      logTo(win, `失败：${base}`);
      logTo(win, String(e.message || e));
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
  }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 720,
    minWidth: 860,
    minHeight: 560,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
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
