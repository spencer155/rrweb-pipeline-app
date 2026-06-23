const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "node_modules", "bxs-rrweb-player-2", "dist");
const destDir = path.join(__dirname, "..", "renderer", "vendor", "rrweb-player");

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(path.join(srcDir, "style.css"), path.join(destDir, "style.css"));
fs.copyFileSync(path.join(srcDir, "index.js"), path.join(destDir, "rrweb-player.bundle.js"));
