// Injetado sob demanda na aba. Define globalThis.__claudeTools (escopo do content script).
(() => {
  if (globalThis.__claudeTools) return;

  const refToEl = new Map();
  const elToRef = new WeakMap();
  let nextRef = 1;

  function refFor(el) {
    let r = elToRef.get(el);
    if (!r) {
      r = nextRef++;
      elToRef.set(el, r);
    }
    refToEl.set(r, new WeakRef(el));
    return r;
  }

  // Caracteres invisíveis/de controle que servem pra esconder texto ou confundir a leitura.
  const SNEAKY = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁯﻿\u{E0000}-\u{E007F}]/gu;
  const clean = (s) => (s || "").replace(SNEAKY, "").replace(/\s+/g, " ").trim();

  // Visível de verdade pra uma pessoa olhando a tela. Texto escondido é o lugar clássico de prompt injection.
  function isVisible(el) {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    if (el.closest("[aria-hidden='true'],[hidden],template,noscript")) return false;
    const st = getComputedStyle(el);
    if (parseFloat(st.fontSize) < 4) return false;
    if (st.clipPath && st.clipPath !== "none" && /inset\(\s*(50%|100%)/.test(st.clipPath)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2 && !el.firstElementChild) return false;
    // Jogado pra fora da página (left: -9999px...): coordenada do DOCUMENTO negativa, onde ninguém consegue rolar.
    // (Coordenada da janela daria falso positivo pra conteúdo que só ficou acima depois de rolar.)
    if (r.right + scrollX < -1000 || r.bottom + scrollY < -1000) return false;
    if (st.color && st.color === st.backgroundColor && st.color !== "rgba(0, 0, 0, 0)") return false;
    return true;
  }

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "option", "combobox", "textbox", "searchbox", "slider", "spinbutton", "treeitem",
  ]);

  function isInteractive(el) {
    const tag = el.tagName;
    if (tag === "A" && el.hasAttribute("href")) return true;
    if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY") return true;
    if (tag === "INPUT") return el.type !== "hidden";
    if (el.isContentEditable && !el.parentElement?.isContentEditable) return true;
    const role = el.getAttribute("role");
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    return false;
  }

  function accName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) return clean(el.labels[0].innerText);
    const txt = clean(el.innerText);
    if (txt) return txt;
    return clean(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || "");
  }

  function describe(el) {
    const tag = el.tagName;
    const role = el.getAttribute("role");
    const name = accName(el).slice(0, 150);
    let kind = role || tag.toLowerCase();
    let extra = "";
    if (tag === "A") {
      kind = "link";
      extra = ` -> ${el.href}`;
    } else if (tag === "INPUT") {
      const t = el.type;
      if (t === "checkbox" || t === "radio") {
        kind = t;
        extra = el.checked ? " [marcado]" : " [desmarcado]";
      } else if (t === "submit" || t === "button" || t === "reset") {
        kind = "button";
      } else {
        kind = `input:${t}`;
        const v = t === "password" ? (el.value ? "••••" : "") : clean(el.value).slice(0, 200);
        if (v) extra = ` value="${v}"`;
        if (el.placeholder && name !== clean(el.placeholder)) extra += ` placeholder="${clean(el.placeholder)}"`;
      }
    } else if (tag === "TEXTAREA") {
      kind = "textarea";
      const v = clean(el.value).slice(0, 300);
      if (v) extra = ` value="${v}"`;
    } else if (tag === "SELECT") {
      kind = "select";
      const opts = Array.from(el.options).slice(0, 30).map((o) => (o.selected ? `*${clean(o.text)}` : clean(o.text)));
      extra = ` opções: ${opts.join(" | ")}`;
    } else if (el.isContentEditable) {
      kind = "editável";
    }
    if (el.disabled) extra += " [desabilitado]";
    return `[ref=${refFor(el)}] ${kind} "${name}"${extra}`;
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "HEAD", "META", "LINK"]);
  const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)/;

  function readPage({ filter = "all", maxChars = 40000 } = {}) {
    const lines = [];
    let buf = [];
    let hidden = 0;
    const flush = () => {
      if (buf.length) {
        const t = clean(buf.join(" "));
        if (t && filter === "all") lines.push(t);
        buf = [];
      }
    };

    function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.textContent;
          if (t && t.trim()) buf.push(t);
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const el = child;
        if (SKIP_TAGS.has(el.tagName.toUpperCase())) continue;
        if (getComputedStyle(el).display === "contents") {
          walk(el);
          continue;
        }
        if (!isVisible(el)) {
          // Conta só texto escondido com conteúdo relevante (pra avisar), mas não lê.
          if (clean(el.textContent).length > 20) hidden++;
          continue;
        }
        if (el.tagName === "IFRAME") {
          flush();
          lines.push(`[iframe ${el.src || "(sem src)"}]`);
          continue;
        }
        if (isInteractive(el)) {
          flush();
          lines.push(describe(el));
          continue;
        }
        const h = /^H([1-6])$/.exec(el.tagName);
        if (h) {
          flush();
          const t = clean(el.innerText);
          if (t) lines.push(`${"#".repeat(+h[1])} ${t}`);
          continue;
        }
        if (el.tagName === "IMG") {
          const alt = clean(el.alt);
          if (alt && filter === "all") buf.push(`[imagem: ${alt}]`);
          continue;
        }
        const block = BLOCK_DISPLAY.test(getComputedStyle(el).display);
        if (block) flush();
        walk(el.shadowRoot || el);
        if (block) flush();
      }
    }

    walk(document.body || document.documentElement);
    flush();

    let text = lines.join("\n");
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    return {
      title: clean(document.title),
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight },
      scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
      hiddenBlocksSkipped: hidden,
      truncated,
      text,
    };
  }

  function resolve({ ref, selector, x, y }) {
    let el = null;
    if (ref != null) {
      el = refToEl.get(Number(ref))?.deref() || null;
      if (!el || !el.isConnected) throw new Error(`ref=${ref} não existe mais na página; chame read_page de novo.`);
    } else if (selector) {
      el = selectAll(selector)[0];
      if (!el) throw new Error(`Nenhum elemento casa com o seletor ${selector}`);
    } else if (x != null && y != null) {
      el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`Nada no ponto (${x}, ${y})`);
    } else {
      throw new Error("Passe ref, selector ou x/y.");
    }
    return el;
  }

  function mouse(el, type, cx, cy) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: type.endsWith("down") ? 1 : 0, view: window }));
  }

  function click(args) {
    const el = resolve(args);
    if (args.x == null) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const cx = args.x ?? r.left + r.width / 2;
    const cy = args.y ?? r.top + r.height / 2;
    for (const t of ["pointerover", "pointerenter", "mouseover", "pointerdown", "mousedown"]) mouse(el, t, cx, cy);
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    for (const t of ["pointerup", "mouseup"]) mouse(el, t, cx, cy);
    el.click();
    return { clicked: describe(el) };
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function type(args) {
    const el = resolve(args);
    const { text = "", clear = true, submit = false } = args;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (clear) {
      if (el.select) el.select();
      else document.execCommand("selectAll");
    } else if (el.setSelectionRange && el.value != null) {
      const n = el.value.length;
      try { el.setSelectionRange(n, n); } catch (_) {}
    }
    // insertText imita digitação de verdade (React/Vue enxergam). Se não pegar, cai pro setter.
    const before = el.value ?? el.textContent;
    const ok = document.execCommand("insertText", false, text);
    const after = el.value ?? el.textContent;
    if ((!ok || after === before) && "value" in el && text) {
      setNativeValue(el, clear ? text : el.value + text);
    }
    if (submit) pressKey({ key: "Enter" }, el);
    return { typedInto: describe(el) };
  }

  const KEY_CODES = {
    Enter: [13, "Enter"], Escape: [27, "Escape"], Tab: [9, "Tab"], Backspace: [8, "Backspace"],
    ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
    " ": [32, "Space"], Delete: [46, "Delete"], Home: [36, "Home"], End: [35, "End"], PageDown: [34, "PageDown"], PageUp: [33, "PageUp"],
  };

  function pressKey({ key, ref, selector }, target) {
    const el = target || (ref != null || selector ? resolve({ ref, selector }) : document.activeElement || document.body);
    const [keyCode, code] = KEY_CODES[key] || [key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, key.length === 1 ? `Key${key.toUpperCase()}` : key];
    const init = { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true };
    const notCancelled = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (key === "Enter" || key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    // Eventos sintéticos não submetem formulário sozinhos; faz o que o navegador faria.
    if (key === "Enter" && notCancelled && el.form && el.tagName === "INPUT") {
      el.form.requestSubmit();
    }
    return { key, target: el === document.body ? "body" : describe(el) };
  }

  function scroll({ direction = "down", amount, ref, selector, pixels }) {
    if (ref != null || selector) {
      const el = resolve({ ref, selector });
      el.scrollIntoView({ block: "center", behavior: "instant" });
      return { scrolledTo: describe(el), y: Math.round(scrollY) };
    }
    let px;
    if (pixels != null) {
      px = Number(pixels);
      if (!Number.isFinite(px)) throw new Error("pixels tem que ser um número.");
      px = Math.max(-100000, Math.min(100000, px));
    } else {
      px = (amount ?? 0.8) * innerHeight * (direction === "up" ? -1 : 1);
    }
    // Página que rola num container interno: pega o maior elemento rolável.
    let target = document.scrollingElement;
    if (target.scrollHeight <= innerHeight + 5) {
      let best = null;
      for (const el of document.querySelectorAll("*")) {
        if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) {
          if (!best || el.clientHeight * el.clientWidth > best.clientHeight * best.clientWidth) best = el;
        }
      }
      if (best) target = best;
    }
    target.scrollBy({ top: px, behavior: "instant" });
    return { y: Math.round(target.scrollTop), max: target.scrollHeight - target.clientHeight };
  }

  function selectOption({ ref, selector, value }) {
    const el = resolve({ ref, selector });
    if (el.tagName !== "SELECT") throw new Error("Elemento não é um <select>.");
    const opt = Array.from(el.options).find((o) => o.value === value || clean(o.text) === value);
    if (!opt) throw new Error(`Opção "${value}" não encontrada.`);
    el.value = opt.value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: clean(opt.text) };
  }

  function consoleLogs({ onlyErrors = false, clear = false } = {}) {
    const all = globalThis.__claudeLogs || [];
    const out = all.filter((l) => !onlyErrors || l.level === "error" || l.level === "exception")
      .map((l) => ({ level: l.level, text: clean(l.text) }));
    if (clear) all.length = 0;
    return out;
  }

  // ---------- Pra confirmação: o background decide se pergunta ao usuário ----------

  // Texto que a pessoa VÊ no elemento. Nunca o aria-label, que a página pode fazer dizer outra coisa.
  function visibleText(el) {
    if (el.tagName === "INPUT" && /^(submit|button|reset|image)$/.test(el.type)) return clean(el.value || el.alt || "");
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      const label = el.labels && el.labels.length ? clean(el.labels[0].innerText) : "";
      return [label, clean(el.placeholder || "")].filter(Boolean).join(" / ");
    }
    return clean(el.innerText || "");
  }

  function inspect(args) {
    const el = args.action === "pressKey" && args.ref == null && !args.selector
      ? document.activeElement || document.body
      : resolve(args);
    const out = { element: `${el.tagName.toLowerCase()}: "${visibleText(el).slice(0, 200)}"`, submit: false, download: false, href: null };
    if (args.action === "click") {
      const btn = el.closest("button, input[type=submit], input[type=image]");
      if (btn && btn.form && (btn.type === "submit" || btn.type === "image")) out.submit = true;
      const a = el.closest("a[href]");
      if (a) {
        out.href = a.href;
        if (a.hasAttribute("download") || /^(blob|data):/i.test(a.href)) out.download = true;
      }
    } else if (args.action === "type") {
      out.submit = !!args.submit;
    } else if (args.action === "pressKey") {
      out.submit = args.key === "Enter" && el.tagName === "INPUT" && !!el.form;
    }
    return out;
  }

  // Envio de formulário que não estava previsto (botão comum cujo onclick chama requestSubmit, por exemplo)
  // é barrado e guardado; o background pergunta ao usuário e, se ele aprovar, chama submitPending.
  // Não pega envio feito por fetch/XHR nem form.submit() da página: isso é limitação conhecida (README).
  let guardArmed = false;
  let allowSubmit = false;
  let pendingSubmit = null;
  window.addEventListener("submit", (ev) => {
    if (!guardArmed || allowSubmit) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    pendingSubmit = { form: ev.target, submitter: ev.submitter || null };
  }, true);

  function guarded(fn) {
    return (args = {}) => {
      guardArmed = true;
      allowSubmit = !!args.allowSubmit;
      pendingSubmit = null;
      try {
        const r = fn(args);
        if (!pendingSubmit) return r;
        const { form, submitter } = pendingSubmit;
        const via = submitter ? `, botão "${visibleText(submitter).slice(0, 100)}"` : "";
        return { ...r, blockedSubmit: `formulário -> ${form.action}${via}` };
      } finally {
        guardArmed = false;
        allowSubmit = false;
      }
    };
  }

  function submitPending() {
    if (!pendingSubmit) throw new Error("Nenhum envio de formulário pendente.");
    const { form, submitter } = pendingSubmit;
    pendingSubmit = null;
    form.requestSubmit(submitter || undefined);
    return { submitted: true };
  }

  // ---------- Leitura com código fixo ----------
  // Cobrem o que a ferramenta javascript faria em site cuja CSP proíbe eval (código de extensão não passa pela CSP
  // da página). Parâmetro é só dado: seletor vai pro querySelectorAll, nunca vira código. Senha volta mascarada;
  // cookie, localStorage, sessionStorage e IndexedDB não são lidos por nenhuma delas.

  function selectAll(selector, root = document) {
    if (typeof selector !== "string" || !selector.trim() || selector.length > 500) {
      throw new Error("Seletor CSS ausente ou grande demais (máx. 500 caracteres).");
    }
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch (_) {
      throw new Error(`Seletor CSS inválido: ${selector}`);
    }
  }

  const clampInt = (v, def, min, max) => {
    const n = Number(v);
    return Math.min(max, Math.max(min, Number.isFinite(n) ? Math.trunc(n) : def));
  };
  const isPassword = (el) => el.tagName === "INPUT" && el.type === "password";

  // Valor atual de um campo, com senha mascarada igual ao read_page.
  function fieldValue(el) {
    if (isPassword(el)) return el.value ? "••••" : "";
    if (el.tagName === "SELECT") return Array.from(el.selectedOptions, (o) => clean(o.text)).join(" | ");
    if (el.type === "file") return el.files && el.files.length ? `(${el.files.length} arquivo(s))` : "";
    return String(el.value ?? "").slice(0, 500);
  }

  function query({ selector, attributes = [], limit = 20 }) {
    if (!Array.isArray(attributes) || attributes.length > 20 ||
        attributes.some((a) => typeof a !== "string" || !/^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/.test(a))) {
      throw new Error("attributes: lista de até 20 nomes de atributo válidos.");
    }
    const all = selectAll(selector);
    const elementos = all.slice(0, clampInt(limit, 20, 1, 200)).map((el) => {
      const visivel = isVisible(el);
      const item = { tag: el.tagName.toLowerCase(), visivel };
      if (visivel) item.texto = clean(el.innerText).slice(0, 500); // texto escondido fica de fora, como no read_page
      if (attributes.length) {
        item.atributos = {};
        for (const a of attributes) {
          // "value" de campo é o valor atual (com senha mascarada), não o atributo do HTML.
          if (a.toLowerCase() === "value" && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
            item.atributos[a] = fieldValue(el);
            continue;
          }
          const v = el.getAttribute(a);
          if (v != null) item.atributos[a] = v.slice(0, 1000);
        }
      }
      return item;
    });
    return { total: all.length, mostrados: elementos.length, elementos };
  }

  function extrairTabela({ selector }) {
    const el = selectAll(selector)[0];
    if (!el) throw new Error(`Nenhum elemento casa com o seletor ${selector}`);
    const table = el.tagName === "TABLE" ? el : el.querySelector("table");
    if (!table) throw new Error("O elemento não é nem contém uma <table>.");
    const linhas = [];
    let ocultas = 0;
    for (const tr of Array.from(table.rows)) {
      if (!isVisible(tr)) {
        ocultas++;
        continue;
      }
      if (linhas.length >= 500) break;
      linhas.push(Array.from(tr.cells).slice(0, 50).map((c) => (isVisible(c) ? clean(c.innerText).slice(0, 500) : "")));
    }
    return { linhas, totalLinhas: table.rows.length, linhasOcultasIgnoradas: ocultas };
  }

  function extrairLinks({ selector } = {}) {
    const roots = selector ? selectAll(selector) : [document];
    const vistos = new Set();
    const links = [];
    let ocultos = 0;
    for (const root of roots) {
      for (const a of root.tagName === "A" ? [root] : Array.from(root.querySelectorAll("a[href]"))) {
        if (!a.hasAttribute("href") || vistos.has(a)) continue;
        vistos.add(a);
        if (!isVisible(a)) {
          ocultos++;
          continue;
        }
        if (links.length < 300) links.push({ texto: visibleText(a).slice(0, 200), href: a.href });
      }
    }
    return { links, total: vistos.size, ocultosIgnorados: ocultos };
  }

  function estadoFormulario({ selector }) {
    const el = selectAll(selector)[0];
    if (!el) throw new Error(`Nenhum elemento casa com o seletor ${selector}`);
    const form = el.tagName === "FORM" ? el : el.closest("form") || el;
    const fields = form.tagName === "FORM" ? Array.from(form.elements) : selectAll("input, select, textarea, button", form);
    const campos = fields.slice(0, 200).map((f) => {
      const c = { tag: f.tagName.toLowerCase(), tipo: f.type || "", nome: f.name || "", id: f.id || "" };
      if (f.labels && f.labels.length) c.rotulo = clean(f.labels[0].innerText).slice(0, 200);
      if (f.tagName === "BUTTON" || /^(submit|button|reset|image)$/.test(f.type)) c.texto = visibleText(f).slice(0, 200);
      else if (f.type === "checkbox" || f.type === "radio") c.marcado = f.checked;
      else if (/^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName)) c.valor = fieldValue(f);
      if (f.disabled) c.desabilitado = true;
      if (f.required) c.obrigatorio = true;
      if (!isVisible(f)) c.visivel = false;
      return c;
    });
    return { formulario: form.tagName === "FORM" ? { acao: form.action, metodo: form.method } : null, campos };
  }

  function esperarPor({ selector, timeout = 10 }) {
    selectAll(selector); // seletor inválido falha já
    const limite = clampInt(Number(timeout) * 1000, 10000, 0, 30000);
    const inicio = Date.now();
    return new Promise((resolveP) => {
      const tick = () => {
        let el;
        try {
          el = selectAll(selector).find((e) => isVisible(e));
        } catch (_) {}
        if (el) return resolveP({ apareceu: true, depoisDeMs: Date.now() - inicio, elemento: describe(el) });
        if (Date.now() - inicio >= limite) return resolveP({ apareceu: false, depoisDeMs: Date.now() - inicio });
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  const TOOLS = {
    readPage, scroll, consoleLogs, inspect, submitPending, query, extrairTabela, extrairLinks, estadoFormulario, esperarPor,
    click: guarded(click), type: guarded(type), pressKey: guarded((a) => pressKey(a)), selectOption: guarded(selectOption),
  };
  globalThis.__claudeTools = TOOLS;

  // O background chama por mensagem, com os parâmetros como dados (nunca montando código).
  // Só aceita do próprio background (sem aba); página web não manda mensagem pra cá.
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (sender.id !== browser.runtime.id || sender.tab || !msg || msg.type !== "claude-tool") return;
    if (!Object.hasOwn(TOOLS, msg.name)) return Promise.resolve({ ok: false, e: "Ferramenta desconhecida." });
    return Promise.resolve()
      .then(() => TOOLS[msg.name](msg.args && typeof msg.args === "object" ? msg.args : {}))
      .then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: String((e && e.message) || e) }));
  });
})();
