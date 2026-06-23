const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");

function runInstall(relativeScript) {
  const installScript = path.join(root, relativeScript);
  if (!fs.existsSync(installScript)) return;
  const result = spawnSync(process.execPath, [installScript], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const chromiumRoot = path.join(root, "node_modules", "puppeteer", ".local-chromium");

function hasChromium() {
  if (!fs.existsSync(chromiumRoot)) return false;
  return fs.readdirSync(chromiumRoot).some((name) =>
    /^(mac|win32|win64|linux)-/.test(name),
  );
}

function getFfmpegBinaryPath() {
  try {
    return require(path.join(root, "node_modules", "ffmpeg-static"));
  } catch {
    return null;
  }
}

function hasFfmpeg() {
  const binaryPath = getFfmpegBinaryPath();
  return Boolean(binaryPath && fs.existsSync(binaryPath));
}

if (!hasChromium()) {
  console.log("未检测到 Puppeteer Chromium，正在下载…");
  runInstall("node_modules/puppeteer/install.js");
}

if (!hasFfmpeg()) {
  console.log("未检测到 ffmpeg-static 二进制，正在下载…");
  runInstall("node_modules/ffmpeg-static/install.js");
}

if (!hasChromium()) {
  console.error(
    "打包前必须存在 node_modules/puppeteer/.local-chromium，请执行 npm install 后重试。",
  );
  process.exit(1);
}

if (!hasFfmpeg()) {
  console.error(
    "打包前必须存在 node_modules/ffmpeg-static/ffmpeg（或 ffmpeg.exe），请执行 npm install 后重试。",
  );
  process.exit(1);
}
