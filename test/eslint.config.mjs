// Checagem do run.sh: nome usado sem estar definido (ex.: função apagada junto com um trecho que saiu).
const g = (nomes) => Object.fromEntries(nomes.map((n) => [n, "readonly"]));
const navegador = g(["window", "document", "browser", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch", "URL", "Node", "NodeFilter",
  "getComputedStyle", "getSelection", "location", "navigator", "crypto", "TextEncoder", "WeakRef", "DOMParser", "MutationObserver", "requestAnimationFrame",
  "ShadowRoot", "HTMLElement", "Element", "CSS", "innerWidth", "innerHeight", "scrollX", "scrollY", "addEventListener", "removeEventListener", "globalThis",
  "queueMicrotask", "structuredClone", "Event", "KeyboardEvent", "MouseEvent", "InputEvent", "FocusEvent", "PointerEvent", "WebSocket", "AbortController",
  "Promise", "Map", "Set", "WeakMap", "marked", "DOMPurify", "ESTILO_PADRAO", "trocarTema", "pintarMarkdown", "atob", "btoa", "Blob", "performance",
  "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "Range", "Text", "self", "alert", "confirm", "open", "close", "devicePixelRatio", "IntersectionObserver",
  "ResizeObserver", "matchMedia", "history", "screen", "Image", "FileReader", "ClipboardItem", "CustomEvent", "XPathResult", "XMLSerializer", "Intl", "exportFunction", "cloneInto", "renderMarkdown"]);
export default [
  { files: ["**/*.js"], languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: navegador }, rules: { "no-undef": "error" } },
  { files: ["**/*.mjs", "hooks/guard.js", "server/index.js"], languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: g(["process", "console", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch", "URL", "Buffer", "TextEncoder", "AbortController", "structuredClone", "globalThis", "queueMicrotask", "performance", "Headers", "Response", "AbortSignal"]) }, rules: { "no-undef": "error" } },
];
