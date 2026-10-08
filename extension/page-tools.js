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
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
      return getComputedStyle(el).display === "contents" && visivelSemCaixa(el);
    }
    if (el.closest("[aria-hidden='true'],[hidden],template,noscript")) return false;
    const st = getComputedStyle(el);
    if (parseFloat(st.fontSize) < 4) return false;
    if (st.clipPath && st.clipPath !== "none" && /inset\(\s*(50%|100%)/.test(st.clipPath)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 && r.height < 2 && !el.firstElementChild) return false;
    // Jogado pra fora (left: -9999px...): mais de 1000px antes do começo da área onde ele está. A conta só
    // pela página marcava como escondido o que foi rolado pra cima dentro de uma caixa (chat, LinkedIn, apps).
    if ((r.right + scrollX < -1000 || r.bottom + scrollY < -1000) && foraDaArea(el, r)) return false;
    if (st.color && st.color === st.backgroundColor && st.color !== "rgba(0, 0, 0, 0)") return false;
    return true;
  }

  // Elemento sem caixa própria (display: contents; comum em link que embrulha um cartão inteiro): o Firefox diz
  // que não é visível, mas o que está dentro dele aparece. Visível se nada acima esconde e algum filho aparece.
  function visivelSemCaixa(el) {
    if (el.closest("[aria-hidden='true'],[hidden],template,noscript")) return false;
    if (Array.from(el.children).some(isVisible)) return true;
    if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim())) return false;
    let caixa = el.parentElement;
    while (caixa && getComputedStyle(caixa).display === "contents") caixa = caixa.parentElement;
    return !!caixa && isVisible(caixa);
  }

  // Texto que aparece de um elemento sem caixa própria (innerText dele traria até o texto escondido).
  const textoSemCaixa = (el) => clean(Array.from(el.childNodes, (n) =>
    n.nodeType === Node.TEXT_NODE ? n.textContent : n.nodeType === Node.ELEMENT_NODE && isVisible(n) ? n.innerText : "").join(" "));
  const semCaixa = (el) => getComputedStyle(el).display === "contents";

  // Pai na árvore que aparece na tela (sai de um shadow root aberto pro host dele).
  const pai = (el) => el.parentElement || (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);

  function rolavel(el) {
    if (el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1) return false;
    const st = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(`${st.overflowY} ${st.overflowX}`);
  }

  // Posição medida dentro da área onde o elemento está: a caixa que rola em volta dele (posição no conteúdo da
  // caixa, 0 = começo) ou, sem caixa, o documento. A caixa também pode ter sido jogada pra fora: sobe e confere.
  function foraDaArea(el, r) {
    for (let c = pai(el); c && c !== document.body && c !== document.documentElement; c = pai(c)) {
      if (!rolavel(c)) continue;
      const cr = c.getBoundingClientRect();
      if (r.bottom - cr.top + c.scrollTop < -1000 || r.right - cr.left + c.scrollLeft < -1000) return true;
      return foraDaArea(c, cr);
    }
    return r.right + scrollX < -1000 || r.bottom + scrollY < -1000;
  }

  // Caixa que rola o conteúdo principal quando a página em si não rola (apps, chats, LinkedIn): a maior visível.
  function caixaPrincipal() {
    let melhor = null;
    for (const el of document.querySelectorAll("*")) {
      if (el.scrollHeight > el.clientHeight + 50 && /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) &&
          el.clientHeight * el.clientWidth > (melhor ? melhor.clientHeight * melhor.clientWidth : 0) && el.checkVisibility()) {
        melhor = el;
      }
    }
    return melhor;
  }
  const paginaRola = () => document.scrollingElement.scrollHeight > innerHeight + 5;

  // Seletor curto que acha a caixa de novo (pra usar no scroll), ou null.
  function seletorDe(el) {
    const cands = [];
    if (el.id) cands.push(`#${CSS.escape(el.id)}`);
    const classes = Array.from(el.classList).slice(0, 3).map((c) => `.${CSS.escape(c)}`).join("");
    if (classes) cands.push(el.tagName.toLowerCase() + classes);
    cands.push(el.tagName.toLowerCase());
    return cands.find((sel) => sel.length <= 200 && document.querySelector(sel) === el) || null;
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
    const txt = semCaixa(el) ? textoSemCaixa(el) : clean(el.innerText);
    if (txt) return txt;
    return clean(el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("alt") || "");
  }

  // Endereço do link em formato curto: sem parâmetros de rastreio, só o caminho quando é do mesmo site, e nada
  // quando é a própria página (âncora). O navigate aceita caminho relativo à página da aba.
  const RASTREIO = /^(utm_\w+|fbclid|gclid|dclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|trk|trkInfo|lipi|trackingId|refId)$/i;
  function enderecoCurto(href) {
    let u;
    try {
      u = new URL(href);
    } catch (_) {
      return href;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return href;
    // Filtra no texto da query (mantém a codificação original do resto).
    if (u.search) {
      const resto = u.search.slice(1).split("&").filter((par) => {
        let k = par.split("=")[0];
        try {
          k = decodeURIComponent(k);
        } catch (_) {}
        return !RASTREIO.test(k);
      });
      u.search = resto.length ? `?${resto.join("&")}` : "";
    }
    const aqui = new URL(location.href);
    const rotaNoHash = /^#[!/]/.test(u.hash);
    if (u.origin === aqui.origin && u.pathname === aqui.pathname && u.search === aqui.search && !rotaNoHash) return null;
    return u.origin === aqui.origin ? u.pathname + u.search + u.hash : u.href;
  }

  // Imagem que não diz nada (ícone, selo, estrela...) não entra no texto.
  const IMG_DECORATIVA = /^[\w-]*(icon|label|logo|overlay|star|badge|flag|spinner|placeholder|avatar)[\w-]*$/i;

  // Campo de texto entra inteiro até este tamanho (o read_page ainda corta o total no maxChars).
  const LIMITE_CAMPO = 20000;

  // curto: o read_page vai entrar no elemento e mostrar o conteúdo, então o nome fica só como etiqueta.
  function describe(el, { curto = false } = {}) {
    const tag = el.tagName;
    const role = el.getAttribute("role");
    const nome = accName(el);
    const name = curto && nome.length > 80 ? `${nome.slice(0, 80)}…` : nome.slice(0, 150);
    let kind = role || tag.toLowerCase();
    let extra = "";
    if (tag === "A") {
      kind = "link";
      const alvo = enderecoCurto(el.href);
      extra = alvo ? ` -> ${alvo}` : "";
    } else if (tag === "INPUT") {
      const t = el.type;
      if (t === "checkbox" || t === "radio") {
        kind = t;
        extra = el.checked ? " [marcado]" : " [desmarcado]";
      } else if (t === "submit" || t === "button" || t === "reset") {
        kind = "button";
      } else {
        kind = `input:${t}`;
        const v = t === "password" ? (el.value ? "••••" : "") : clean(el.value).slice(0, 2000);
        if (v) extra = ` value="${v}"`;
        if (el.placeholder && name !== clean(el.placeholder)) extra += ` placeholder="${clean(el.placeholder)}"`;
      }
    } else if (tag === "TEXTAREA") {
      kind = "textarea";
      // Mantém as quebras de linha (texto de prompt, mensagem); só tira caractere invisível.
      const v = String(el.value || "").replace(SNEAKY, "").slice(0, LIMITE_CAMPO);
      if (v) extra = ` value="${v}"`;
    } else if (tag === "SELECT") {
      kind = "select";
      const opts = Array.from(el.options).slice(0, 30).map((o) => (o.selected ? `*${clean(o.text)}` : clean(o.text)));
      extra = ` opções: ${opts.join(" | ")}`;
    } else if (el.isContentEditable) {
      kind = "editável";
    }
    if (el.disabled) extra += " [desabilitado]";
    return `[ref=${refFor(el)}] ${kind}${name ? ` "${name}"` : ""}${extra}`;
  }

  // Elemento interativo que tem conteúdo de verdade dentro (editor de texto, cartão clicável, item de lista que é
  // um botão): o read_page lista o elemento e também entra nele (texto e os interativos de dentro).
  const DENTRO_INTERATIVO = "a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[contenteditable=''],[contenteditable=true]";
  function entraNoInterativo(el) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return false;
    if (el.isContentEditable) return true;
    return clean(el.innerText).length > 150 || !!el.querySelector(DENTRO_INTERATIVO);
  }

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "HEAD", "META", "LINK"]);
  const BLOCK_DISPLAY = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)/;

  // Tira o que só repete: texto alternativo de imagem que já está escrito na mesma linha ou na vizinha (vitrine de
  // loja repete o nome do produto na imagem e no título) e linha idêntica à anterior.
  function enxugar(lines) {
    const out = [];
    lines.forEach((linha, i) => {
      const l = linha.replace(/\[imagem: ([^\]]+)\]\s*/g, (m, alt) => {
        const k = alt.slice(0, 50);
        const fora = linha.replace(m, "");
        return fora.includes(k) || (lines[i + 1] || "").includes(k) || (lines[i - 1] || "").includes(k) ? "" : m;
      }).trim();
      if (l && out[out.length - 1] !== l) out.push(l);
    });
    return out;
  }

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
        if (semCaixa(el)) {
          // Link/botão sem caixa própria: entra na lista (com o endereço) e o conteúdo vem logo abaixo.
          if (isInteractive(el) && isVisible(el)) {
            flush();
            lines.push(describe(el, { curto: true }));
            walk(el);
            flush();
          } else {
            walk(el);
          }
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
          const entra = entraNoInterativo(el);
          lines.push(describe(el, { curto: entra }));
          if (entra) {
            walk(el.shadowRoot || el);
            flush();
          }
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
          if (alt && filter === "all" && !IMG_DECORATIVA.test(alt)) buf.push(`[imagem: ${alt}]`);
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

    let text = enxugar(lines).join("\n");
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    // Página que não rola sozinha: mostra a rolagem da caixa principal (senão o Claude via 0/0 e achava que era tudo).
    let caixa = null;
    if (!paginaRola()) {
      const c = caixaPrincipal();
      if (c) caixa = { y: Math.round(c.scrollTop), max: c.scrollHeight - c.clientHeight, seletor: seletorDe(c) };
    }
    return {
      title: clean(document.title),
      url: location.href,
      viewport: { w: innerWidth, h: innerHeight },
      scroll: { y: Math.round(scrollY), max: Math.max(0, document.documentElement.scrollHeight - innerHeight) },
      caixa,
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
    // Sem caixa própria (display: contents): mira no primeiro filho que aparece.
    const alvo = semCaixa(el) ? Array.from(el.children).find(isVisible) || el : el;
    if (args.x == null) alvo.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = alvo.getBoundingClientRect();
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

  function scroll({ direction, amount, ref, selector, pixels }) {
    const distancia = direction != null || amount != null || pixels != null;
    let el = null;
    if (ref != null || selector) {
      el = resolve({ ref, selector });
      if (!distancia) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        return { scrolledTo: describe(el), y: Math.round(scrollY) };
      }
    }
    let px;
    if (pixels != null) {
      px = Number(pixels);
      if (!Number.isFinite(px)) throw new Error("pixels tem que ser um número.");
      px = Math.max(-100000, Math.min(100000, px));
    } else {
      px = (amount ?? 0.8) * (el ? el.clientHeight : innerHeight) * (direction === "up" ? -1 : 1);
    }
    // Com selector/ref + distância: rola aquela caixa. Sem: a página, ou a caixa principal se a página não rola.
    const target = el || (paginaRola() ? document.scrollingElement : caixaPrincipal() || document.scrollingElement);
    target.scrollBy({ top: px, behavior: "instant" });
    return { y: Math.round(target.scrollTop), max: target.scrollHeight - target.clientHeight, ...(el ? { caixa: describe(el) } : {}) };
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
    return semCaixa(el) ? textoSemCaixa(el) : clean(el.innerText || "");
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
      if (visivel) item.texto = (semCaixa(el) ? textoSemCaixa(el) : clean(el.innerText)).slice(0, 500); // texto escondido fica de fora, como no read_page
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
    const out = { total: all.length, mostrados: elementos.length, elementos };
    if (!all.length) out.motivo = `Nenhum elemento casa com o seletor nesta página.${notaFrames()}`;
    else if (!all.some((el) => isVisible(el))) out.motivo = `Os ${all.length} elementos que casam estão escondidos (invisíveis, fora da tela ou sem tamanho); o texto deles não é mostrado.`;
    return out;
  }

  // Conteúdo que as ferramentas não alcançam, pra explicar resultado vazio.
  function notaFrames() {
    const n = document.querySelectorAll("iframe, frame").length;
    return n ? ` A página tem ${n} iframe(s); o conteúdo de iframe não é lido.` : "";
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
    const out = { links, total: vistos.size, ocultosIgnorados: ocultos };
    if (!links.length) {
      out.motivo = selector && !roots.length ? `Nenhum elemento casa com o seletor ${selector}.`
        : !vistos.size ? "Não há nenhum <a href> aqui: os itens podem ser botões ou elementos clicáveis sem link (veja os [ref] no read_page)." + notaFrames()
        : `Os ${vistos.size} links estão escondidos (invisíveis, fora da tela ou sem tamanho).`;
    }
    return out;
  }

  function estadoFormulario({ selector }) {
    const el = selectAll(selector)[0];
    if (!el) throw new Error(`Nenhum elemento casa com o seletor ${selector}`);
    const form = el.tagName === "FORM" ? el : el.closest("form") || el;
    const CAMPOS = "input, select, textarea, button";
    // Fora de <form>: os campos dentro do elemento, ou o próprio elemento se ele já é um campo.
    const fields = form.tagName === "FORM" ? Array.from(form.elements) : [...(form.matches(CAMPOS) ? [form] : []), ...selectAll(CAMPOS, form)];
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
    const out = { formulario: form.tagName === "FORM" ? { acao: form.action, metodo: form.method } : null, campos };
    if (!campos.length) out.motivo = "O elemento não é um formulário nem tem campos (input, select, textarea, button) dentro. Campo editável (contenteditable) aparece no read_page como \"editável\".";
    return out;
  }

  // Elemento com conteúdo de verdade: texto, campo, imagem/mídia (dele ou dentro dele). Caixa vazia com altura
  // e fundo cinza é o "esqueleto" que site mostra enquanto carrega.
  const MIDIA = "img,svg,video,canvas,iframe,input,textarea,select,picture,object,embed";
  const temConteudo = (el) => !!clean(el.innerText) || el.matches(MIDIA) || !!el.querySelector(MIDIA);

  // Esqueleto/indicador de carregamento visível na página.
  const ESQUELETO = '[aria-busy="true"],[class*="skeleton" i],[class*="shimmer" i]';
  const temEsqueleto = () => Array.from(document.querySelectorAll(ESQUELETO)).slice(0, 200).some((e) => e.checkVisibility());

  // Espera a página assentar depois de carregar: ~1 s depois do load (conteúdo que vem por fetch chega logo
  // depois), 600 ms sem mudança no DOM e nenhum esqueleto de carregamento visível. Para em maxMs de qualquer jeito.
  function assentar({ maxMs = 4000 } = {}) {
    const limite = clampInt(maxMs, 4000, 0, 10000);
    const inicio = performance.now();
    const nav = performance.getEntriesByType("navigation")[0];
    const desdeLoad = nav?.loadEventEnd ? inicio - nav.loadEventEnd : Infinity;
    const minimo = Math.max(0, 1000 - desdeLoad);
    let ultima = inicio;
    const obs = new MutationObserver(() => (ultima = performance.now()));
    obs.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    return new Promise((resolveP) => {
      const tick = () => {
        const agora = performance.now();
        const ok = agora - inicio >= minimo && agora - ultima >= 600 && !temEsqueleto();
        if (ok || agora - inicio >= limite) {
          obs.disconnect();
          return resolveP({ ms: Math.round(agora - inicio), assentou: ok });
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  function esperarPor({ selector, timeout = 10, vazio = false }) {
    selectAll(selector); // seletor inválido falha já
    const limite = clampInt(Number(timeout) * 1000, 10000, 0, 30000);
    const inicio = Date.now();
    return new Promise((resolveP) => {
      const tick = () => {
        let el;
        try {
          el = selectAll(selector).find((e) => isVisible(e) && (vazio || temConteudo(e)));
        } catch (_) {}
        if (el) return resolveP({ apareceu: true, depoisDeMs: Date.now() - inicio, elemento: describe(el) });
        if (Date.now() - inicio >= limite) {
          let todos = [];
          try {
            todos = selectAll(selector);
          } catch (_) {}
          const visiveis = todos.filter((e) => isVisible(e));
          const motivo = !todos.length ? `nenhum elemento casou com o seletor em ${Math.round(limite / 1000)} s.${notaFrames()}`
            : !visiveis.length ? `${todos.length} elemento(s) casam, mas estão escondidos.`
            : `${visiveis.length} elemento(s) casam e estão visíveis, mas vazios (esqueleto de carregamento?). Se vazio basta, use vazio=true.`;
          return resolveP({ apareceu: false, depoisDeMs: Date.now() - inicio, motivo });
        }
        setTimeout(tick, 150);
      };
      tick();
    });
  }

  const TOOLS = {
    readPage, scroll, consoleLogs, inspect, submitPending, query, extrairTabela, extrairLinks, estadoFormulario, esperarPor, assentar,
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
