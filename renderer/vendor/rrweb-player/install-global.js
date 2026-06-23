(function installRrwebPlayerGlobal() {
  const g = globalThis;

  if (typeof g.rrwebPlayer === "function") {
    return;
  }

  const sources = [
    g.__rrwebPlayerMod && g.__rrwebPlayerMod.exports,
    typeof module !== "undefined" && module.exports,
    typeof exports !== "undefined" && exports,
  ];

  for (const exp of sources) {
    if (!exp) continue;
    if (typeof exp === "function") {
      g.rrwebPlayer = exp;
      return;
    }
    if (typeof exp.default === "function") {
      g.rrwebPlayer = exp.default;
      return;
    }
    if (typeof exp.Player === "function") {
      g.rrwebPlayer = exp.Player;
      return;
    }
  }

  console.error("[rrweb-player] 未能挂载到 globalThis.rrwebPlayer，请检查 bundle 是否加载成功");
})();
