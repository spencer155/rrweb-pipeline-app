const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "node_modules", "bxs-rrweb-player-2", "dist");
const destDir = path.join(__dirname, "..", "renderer", "vendor", "rrweb-player");

const { spawnSync } = require("child_process");

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(path.join(srcDir, "style.css"), path.join(destDir, "style.css"));
fs.copyFileSync(path.join(srcDir, "index.js"), path.join(destDir, "rrweb-player.bundle.js"));

const puppeteerInstall = path.join(__dirname, "..", "node_modules", "puppeteer", "install.js");
if (fs.existsSync(puppeteerInstall)) {
  const result = spawnSync(process.execPath, [puppeteerInstall], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

const ffmpegInstall = path.join(__dirname, "..", "node_modules", "ffmpeg-static", "install.js");
if (fs.existsSync(ffmpegInstall)) {
  const result = spawnSync(process.execPath, [ffmpegInstall], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}
