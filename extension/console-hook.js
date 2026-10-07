// Roda em document_start: guarda o que a página joga no console pra ferramenta console_logs.
(() => {
  if (globalThis.__claudeLogs) return;
  const logs = (globalThis.__claudeLogs = []);
  const MAX = 500;

  const pageWin = window.wrappedJSObject;

  function fmt(arg) {
    try {
      if (typeof arg === "string") return arg;
      if (arg && typeof arg === "object" && "message" in arg && "stack" in arg) {
        return `${arg.name || "Error"}: ${arg.message}`;
      }
      const s = pageWin.JSON.stringify(arg);
      if (s !== undefined) return s;
    } catch (_) {}
    try { return String(arg); } catch (_) { return "[?]"; }
  }

  function record(level, args) {
    const text = Array.from(args, fmt).join(" ").slice(0, 2000);
    logs.push({ level, text, t: Date.now() });
    if (logs.length > MAX) logs.splice(0, logs.length - MAX);
  }

  try {
    const pageConsole = pageWin.console;
    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const orig = pageConsole[level];
      exportFunction(function (...args) {
        record(level, args);
        // spread em vez de apply(arr): o array do content script não é legível pela página.
        return orig.call(pageConsole, ...args);
      }, pageConsole, { defineAs: level });
    }
  } catch (_) {}

  window.addEventListener("error", (e) => {
    record("exception", [`${e.message} (${e.filename}:${e.lineno})`]);
  });
  window.addEventListener("unhandledrejection", (e) => {
    record("exception", ["Promise rejeitada: " + fmt(e.reason)]);
  });
})();
