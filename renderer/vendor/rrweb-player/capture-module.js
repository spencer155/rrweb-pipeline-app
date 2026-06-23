/** 在 UMD 脚本执行前注入 module.exports，供 Electron 渲染进程捕获 rrweb-player */
(function captureModuleForUmd() {
  const mod = { exports: {} };
  globalThis.__rrwebPlayerMod = mod;
  globalThis.module = mod;
  globalThis.exports = mod.exports;
})();
