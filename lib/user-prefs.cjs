const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

function getPrefsPath(userDataPath) {
  return path.join(userDataPath, "user-prefs.json");
}

async function readPrefs(userDataPath) {
  try {
    const raw = await fsp.readFile(getPrefsPath(userDataPath), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writePrefs(userDataPath, prefs) {
  await fsp.mkdir(userDataPath, { recursive: true });
  await fsp.writeFile(getPrefsPath(userDataPath), `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
}

async function getExportDir(app) {
  const prefs = await readPrefs(app.getPath("userData"));
  const dir = typeof prefs.exportDir === "string" ? prefs.exportDir.trim() : "";
  if (dir && fs.existsSync(dir)) return dir;
  return null;
}

async function setExportDir(app, dir) {
  if (!dir || typeof dir !== "string") return;
  const prefs = await readPrefs(app.getPath("userData"));
  prefs.exportDir = dir;
  await writePrefs(app.getPath("userData"), prefs);
}

module.exports = {
  getExportDir,
  setExportDir,
};
