const SERVER_URL = "ws://127.0.0.1:47823";

let ws = null;
let connected = false;

// Abas que o Claude pode ver/controlar: as que ele abriu + as que você compartilhou clicando no ícone.
const allowedTabs = new Set();

// ---------- Regras de segurança ----------

// Sites permitidos = permissões de host concedidas pelo usuário (optional_permissions). Quem garante é o
// próprio Firefox: sem a permissão, executeScript falha. A checagem aqui só dá uma mensagem clara antes.

// Erro com código: o servidor usa o código (não o texto) pra dizer ao Claude o que fazer.
function coded(code, message, info = {}) {
  const e = new Error(message);
  e.code = code;
  e.info = info;
  return e;
}

function hostMatches(host, domain) {
  domain = domain.toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
  host = host.toLowerCase();
  return host === domain || host.endsWith("." + domain);
}

// localhost, IPs privados e nomes de rede local. new URL() já normaliza 2130706433, 0x7f.1 etc. pra 127.0.0.1.
function isPrivateHost(host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!h.includes(".") && !h.includes(":")) return true; // nome sem ponto: "roteador", "impressora"
  if (h === "localhost" || /\.(localhost|local|lan|internal|home\.arpa)$/.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) return h === "::" || h === "::1" || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith("::ffff:");
  return false;
}

function webUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    throw new Error(`URL inválida: ${url}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Bloqueado: o Claude só age em páginas http/https (${u.protocol}).`);
  }
  return u;
}

async function checkUrl(url) {
  const u = webUrl(url);
  const host = u.hostname;
  const { blockedDomains = [], allowPrivateNetwork = false } = await browser.storage.local.get(["blockedDomains", "allowPrivateNetwork"]);
  if (!allowPrivateNetwork && isPrivateHost(host)) {
    throw coded("rede_local", `Bloqueado: ${host} é localhost/rede local. Só o usuário pode liberar rede local, nas opções da extensão.`, { host });
  }
  for (const d of blockedDomains) {
    if (hostMatches(host, d)) throw new Error(`Bloqueado: ${host} está na lista de sites proibidos (configurada pelo usuário no Firefox).`);
  }
  if (!(await browser.permissions.contains({ origins: [`${u.protocol}//${host}/*`] }))) {
    throw coded(
      "fora_da_lista",
      `Bloqueado: ${host} não está na lista de sites permitidos. Peça ao usuário pra adicionar nas opções da extensão ` +
      `ou clicar no ícone da extensão numa aba desse site.`,
      { host },
    );
  }
}

async function getAllowedTab(tabId, s) {
  if (!allowedTabs.has(tabId)) {
    throw new Error(`A aba ${tabId} não está liberada pro Claude. Abra uma com tab_new ou peça pro usuário clicar no ícone da extensão nessa aba.`);
  }
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab) {
    allowedTabs.delete(tabId);
    throw new Error(`A aba ${tabId} não existe mais.`);
  }
  await checkUrl(tab.url);
  noteRead(hostOf(tab.url), s);
  return tab;
}

const DEFAULT_BLOCKED = [
  "bb.com.br", "itau.com.br", "bradesco.com.br", "santander.com.br", "caixa.gov.br", "nubank.com.br",
  "inter.co", "bancointer.com.br", "c6bank.com.br", "sicoob.com.br", "sicredi.com.br", "btgpactual.com",
  "mercadopago.com.br", "picpay.com", "paypal.com", "pagbank.com.br", "binance.com",
];

browser.runtime.onInstalled.addListener(async () => {
  const { blockedDomains } = await browser.storage.local.get("blockedDomains");
  if (blockedDomains === undefined) await browser.storage.local.set({ blockedDomains: DEFAULT_BLOCKED });
});

// console-hook só nos sites permitidos (antes rodava em todo site, inclusive banco).
let hookSync = Promise.resolve();
let hookReg = null;
function syncConsoleHook() {
  hookSync = hookSync.then(async () => {
    await hookReg?.unregister();
    hookReg = null;
    const { origins = [] } = await browser.permissions.getAll();
    if (origins.length) {
      hookReg = await browser.contentScripts.register({ matches: origins, js: [{ file: "console-hook.js" }], runAt: "document_start" });
    }
  }).catch(() => {});
}
browser.permissions.onAdded.addListener(syncConsoleHook);
browser.permissions.onRemoved.addListener(syncConsoleHook);
syncConsoleHook();

// ---------- Confirmação do usuário ----------
// Ações pedem confirmação numa janela da extensão (moz-extension://, fora do alcance das ferramentas).
// "Permitir agir em <site> por N min" libera clicar/digitar/escolher/teclas/navegar NAQUELE site. Envio de
// formulário, download, javascript e ir pra outro site perguntam sempre. A janela fecha sozinha quando a
// sessão lê conteúdo de outro site ou usa qualquer ferramenta fora do navegador (aviso vem do hook, via servidor).

// Cada conversa tem o próprio estado: o Claude do terminal (ponte WebSocket) e o do painel lateral (ponte nativa)
// não compartilham aprovação por tarefa nem a lista de sites lidos.
//   grants: host -> { until, grantedAt } · lastLocalReadAt: última ferramenta fora do navegador (ctx.localReadAt)
//   readHosts: sites lidos; vão pro servidor/painel e aparecem na mensagem da trava
const newSession = (origin) => ({ origin, grants: new Map(), lastLocalReadAt: 0, readHosts: new Set() });
const sessions = { term: newSession("term"), chat: newSession("chat") };

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return "";
  }
}

function hasGrant(host, s) {
  const g = s.grants.get(host);
  if (!g) return false;
  if (Date.now() > g.until || g.grantedAt < s.lastLocalReadAt) {
    s.grants.delete(host);
    refreshAllBadges();
    return false;
  }
  return true;
}

const grantFor = (host) => sessions.term.grants.get(host) || sessions.chat.grants.get(host);

// Conteúdo de um site entrou na sessão: aprovação dos outros cai (senão dava pra ler Y e digitar em X sem perguntar).
function noteRead(host, s) {
  if (!host) return;
  s.readHosts.add(host);
  let changed = false;
  for (const h of s.grants.keys()) {
    if (h !== host) changed = s.grants.delete(h) || changed;
  }
  if (changed) refreshAllBadges();
}

async function grantMinutes() {
  const { grantMinutes = 15 } = await browser.storage.local.get("grantMinutes");
  return Math.min(120, Math.max(1, Number(grantMinutes) || 15));
}

// Tira caracteres invisíveis/de controle (mantém quebra de linha) e corta textos enormes.
const SNEAKY = /[\u0000-\u0009\u000B-\u001F\u007F­​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;
const safe = (s, max) => (s == null ? undefined : String(s).replace(SNEAKY, "").slice(0, max));

const pending = new Map(); // id -> { details, finish, windowId }
let confirmQueue = Promise.resolve();
const CONFIRM_TIMEOUT_MS = 150000;

// Abre a janela de confirmação (uma por vez) e resolve com "once", "window", "deny" ou "timeout".
function confirmAction(details) {
  const run = () => new Promise((resolve) => {
    const id = crypto.randomUUID();
    let timer = null;
    const finish = (decision) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(timer);
      if (p.windowId != null) browser.windows.remove(p.windowId).catch(() => {});
      resolve(decision);
    };
    timer = setTimeout(() => finish("timeout"), CONFIRM_TIMEOUT_MS);
    pending.set(id, { details, finish, windowId: null });
    browser.windows.create({ type: "popup", url: `confirm.html#${id}`, width: 560, height: 600 }).then(
      (win) => {
        const p = pending.get(id);
        if (p) p.windowId = win.id;
        else browser.windows.remove(win.id).catch(() => {});
      },
      () => finish("deny"),
    );
  });
  const result = confirmQueue.then(run);
  confirmQueue = result.catch(() => {});
  return result;
}

browser.windows.onRemoved.addListener((windowId) => {
  for (const p of pending.values()) if (p.windowId === windowId) p.finish("deny");
});

browser.runtime.onMessage.addListener((msg, sender) => {
  // Só a página confirm.html da própria extensão responde. Página web não manda mensagem pro background,
  // e o content script (page-tools) não tem esse código.
  const base = browser.runtime.getURL("confirm.html");
  if (!sender.url || !sender.url.startsWith(base + "#")) return;
  const p = pending.get(sender.url.slice(base.length + 1));
  if (!p) return;
  if (p.windowId != null && sender.tab?.windowId !== p.windowId) return;
  if (msg?.type === "confirm:get") return Promise.resolve(p.details);
  if (msg?.type === "confirm:answer" && ["once", "window", "deny"].includes(msg.decision)) p.finish(msg.decision);
});

// kind "acao": livre se houver aprovação vigente pra windowHost. Os outros kinds (envio, download,
// javascript, outro = outro site) perguntam sempre. windowHost = site que o botão "por N min" libera.
async function authorize(d, s) {
  if (d.kind === "acao" && d.windowHost && hasGrant(d.windowHost, s)) return;
  const details = {
    kind: d.kind,
    action: d.action,
    host: d.host,
    windowHost: d.windowHost || null,
    minutes: await grantMinutes(),
    element: safe(d.element, 300),
    text: safe(d.text, 2000),
    key: safe(d.key, 40),
    option: safe(d.option, 200),
    url: safe(d.url, 600),
    code: safe(d.code, 4000),
  };
  // Pedido do painel aparece na própria conversa (se o painel estiver aberto); do terminal, na janelinha.
  const decision = await (s.origin === "chat" && panelPorts.size ? confirmInChat(details) : confirmAction(details));
  if (decision === "window" && d.windowHost) {
    const now = Date.now();
    s.grants.set(d.windowHost, { until: now + details.minutes * 60000, grantedAt: now });
    refreshAllBadges();
    return;
  }
  if (decision === "once") return;
  if (decision === "timeout") {
    throw coded("expirou", "O usuário não respondeu ao pedido de confirmação no Firefox (expirou). Pergunte a ele no chat antes de tentar de novo.");
  }
  throw coded("negado", "O usuário NEGOU essa ação na janela de confirmação do Firefox. Não tente de novo nem por outro caminho; pergunte a ele o que fazer.");
}

// Rede de segurança pra download que não deu pra prever (link comum que o servidor manda como anexo):
// logo depois de uma ação do Claude, pausa o download e pergunta. Negado, apaga o arquivo.
let lastActionAt = 0;
let lastActionSession = sessions.term;
let downloadOkUntil = 0;
function markAction(s) {
  lastActionAt = Date.now();
  lastActionSession = s;
}
browser.downloads.onCreated.addListener(async (item) => {
  const now = Date.now();
  if (now - lastActionAt > 15000 || now < downloadOkUntil) return;
  await browser.downloads.pause(item.id).catch(() => {});
  let ok = false;
  try {
    const host = hostOf(item.referrer || item.url);
    await authorize({ kind: "download", action: "baixar um arquivo", host, url: item.url, element: item.filename }, lastActionSession);
    ok = true;
  } catch (_) {}
  if (ok) {
    await browser.downloads.resume(item.id).catch(() => {});
    return;
  }
  await browser.downloads.cancel(item.id).catch(() => {});
  await browser.downloads.removeFile(item.id).catch(() => {});
  await browser.downloads.erase({ id: item.id }).catch(() => {});
});

// Aprovação vencida some do ícone.
setInterval(() => {
  for (const s of Object.values(sessions)) for (const h of [...s.grants.keys()]) hasGrant(h, s);
}, 30000);

// ---------- Ícone / badge ----------

// Abas onde o Claude tentou tirar print e precisa que o usuário clique no ícone (activeTab).
const screenshotWanted = new Set();

async function refreshBadge(tabId) {
  const on = allowedTabs.has(tabId);
  const wantsShot = screenshotWanted.has(tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const g = tab && grantFor(hostOf(tab.url));
  const until = g ? new Date(g.until).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  await browser.browserAction.setBadgeText({ tabId, text: wantsShot ? "📷" : on ? "✓" : "" });
  await browser.browserAction.setTitle({
    tabId,
    title: `Claude: ${connected ? "conectado" : tokenProblem || "desconectado"}\n` +
      (wantsShot ? "O Claude pediu um print desta aba: clique pra permitir (vale até a página mudar)."
        : on ? "Esta aba está liberada pro Claude (clique pra revogar)."
        : "Clique pra liberar esta aba (e este site) pro Claude.") +
      (g ? `\nO Claude pode agir neste site sem perguntar até ${until}.` : ""),
  });
}

async function refreshAllBadges() {
  await browser.browserAction.setBadgeBackgroundColor({ color: connected ? "#2e9e44" : "#888888" });
  for (const t of await browser.tabs.query({})) refreshBadge(t.id);
}

// O clique no ícone é um gesto do usuário: dá activeTab nesta página (o que libera o print)
// e é o único jeito, além das opções, de adicionar um site à lista de permitidos.
browser.browserAction.onClicked.addListener((tab) => {
  if (allowedTabs.has(tab.id) && !screenshotWanted.has(tab.id)) {
    allowedTabs.delete(tab.id);
    for (const s of Object.values(sessions)) s.grants.delete(hostOf(tab.url)); // revogar a aba cancela a aprovação do site
    refreshAllBadges();
    return;
  }
  screenshotWanted.delete(tab.id);
  let origins = [];
  try {
    origins = [`*://${webUrl(tab.url).hostname}/*`];
  } catch (_) {}
  if (!origins.length) {
    refreshBadge(tab.id);
    return;
  }
  // permissions.request tem que ser chamado direto no clique, sem await antes, senão o Firefox recusa.
  browser.permissions.request({ origins }).then(
    (granted) => {
      if (granted) allowedTabs.add(tab.id);
      refreshBadge(tab.id);
    },
    () => refreshBadge(tab.id),
  );
});

browser.tabs.onRemoved.addListener((id) => {
  allowedTabs.delete(id);
  screenshotWanted.delete(id);
});
browser.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading" || info.url) refreshBadge(id);
});

// ---------- Helpers de aba ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLoad(tabId, timeoutMs = 20000) {
  await sleep(300);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const t = await browser.tabs.get(tabId);
    if (t.status === "complete") return t;
    await sleep(200);
  }
  return browser.tabs.get(tabId);
}

async function ensureTools(tabId) {
  const [has] = await browser.tabs.executeScript(tabId, { code: "typeof globalThis.__claudeTools !== 'undefined'" });
  if (!has) {
    await browser.tabs.executeScript(tabId, { file: "console-hook.js" });
    await browser.tabs.executeScript(tabId, { file: "page-tools.js" });
  }
}

// Parâmetros vão como dados numa mensagem pro content script; nada é montado como código.
async function execTool(tabId, name, args) {
  let res;
  try {
    res = await browser.tabs.sendMessage(tabId, { type: "claude-tool", name, args: args || {} }, { frameId: 0 });
  } catch (_) {
    throw new Error("A página não respondeu (recarregou ou navegou no meio). Tente de novo.");
  }
  if (!res) throw new Error("A página não respondeu. Tente de novo.");
  if (!res.ok) throw new Error(res.e);
  return res.v;
}

// Só leitura: não pede confirmação.
async function runTool(tabId, name, args, s) {
  await getAllowedTab(tabId, s);
  await ensureTools(tabId);
  return execTool(tabId, name, args);
}

const ACTION_LABEL = { click: "clicar", type: "digitar", pressKey: "apertar uma tecla", selectOption: "escolher uma opção" };

// Ação na página: descobre o que ela vai fazer (enviar formulário? baixar? sair do site?) e pede confirmação
// quando precisa, mostrando o texto VISÍVEL do elemento.
async function runAction(tabId, name, args, s) {
  const tab = await getAllowedTab(tabId, s);
  await ensureTools(tabId);
  const host = hostOf(tab.url);
  const info = await execTool(tabId, "inspect", { ...args, action: name });
  const base = {
    action: ACTION_LABEL[name],
    host,
    element: info.element,
    text: name === "type" ? args.text : undefined,
    key: name === "pressKey" ? args.key : undefined,
    option: name === "selectOption" ? args.value : undefined,
  };
  let link = null;
  try {
    if (info.href) link = new URL(info.href);
  } catch (_) {}

  if (info.download) {
    await authorize({ ...base, kind: "download", url: info.href }, s);
    downloadOkUntil = Date.now() + 15000;
  } else if (info.submit) {
    await authorize({ ...base, kind: "envio" }, s);
  } else if (link && link.protocol !== "javascript:" && link.hostname !== host) {
    // Link pra outro site: o destino tem que estar na lista e o usuário confirma sempre.
    const web = link.protocol === "http:" || link.protocol === "https:";
    if (web) await checkUrl(link.href);
    await authorize({ ...base, kind: "outro", url: link.href, windowHost: web ? link.hostname : null }, s);
  } else {
    await authorize({ ...base, kind: "acao", windowHost: host }, s);
  }

  markAction(s);
  const res = await execTool(tabId, name, { ...args, allowSubmit: info.submit });
  if (res && res.blockedSubmit) {
    try {
      await authorize({ ...base, kind: "envio", element: res.blockedSubmit }, s);
    } catch (e) {
      throw coded(e.code, `A ação rodou, mas tentou enviar um formulário e o envio foi barrado. ${e.message}`, e.info);
    }
    markAction(s);
    await execTool(tabId, "submitPending", {});
  }
  return res;
}

function tabInfo(t) {
  return { tabId: t.id, title: t.title, url: t.url, active: t.active, status: t.status };
}

// ---------- Comandos ----------

const handlers = {
  async tabs_list(_, s) {
    const tabs = await browser.tabs.query({});
    const mine = [];
    for (const t of tabs.filter((t) => allowedTabs.has(t.id))) {
      // Aba liberada que foi parar num site fora da lista: nem título nem URL vão pro Claude.
      const ok = await checkUrl(t.url).then(() => true, () => false);
      if (ok) noteRead(hostOf(t.url), s); // título também é conteúdo do site
      mine.push(ok ? tabInfo(t) : { ...tabInfo(t), title: "(bloqueado)", url: "(fora dos sites permitidos)" });
    }
    return { tabs: mine, otherTabsHidden: tabs.length - mine.length };
  },

  async tab_new({ url = "about:blank" }, s) {
    if (url !== "about:blank") {
      await checkUrl(url);
      const dest = hostOf(url);
      await authorize({ kind: "acao", action: "abrir uma aba", host: dest, url, windowHost: dest }, s);
      markAction(s);
    }
    const t = await browser.tabs.create({ url, active: true });
    allowedTabs.add(t.id);
    refreshBadge(t.id);
    if (url === "about:blank") return tabInfo(t);
    const loaded = await waitForLoad(t.id);
    await checkUrl(loaded.url); // redirecionou pra fora da lista?
    noteRead(hostOf(loaded.url), s);
    return tabInfo(loaded);
  },

  async tab_close({ tabId }, s) {
    await getAllowedTab(tabId, s).catch((e) => {
      if (!allowedTabs.has(tabId)) throw e;
    });
    await browser.tabs.remove(tabId);
    allowedTabs.delete(tabId);
    return { closed: tabId };
  },

  async navigate({ tabId, url }, s) {
    const tab = await getAllowedTab(tabId, s);
    const host = hostOf(tab.url);
    const HISTORY = { back: "voltar uma página", forward: "avançar uma página", reload: "recarregar a página" };
    if (HISTORY[url]) {
      await authorize({ kind: "acao", action: HISTORY[url], host, windowHost: host }, s);
      markAction(s);
      if (url === "back") await browser.tabs.goBack(tabId);
      else if (url === "forward") await browser.tabs.goForward(tabId);
      else await browser.tabs.reload(tabId);
    } else {
      await checkUrl(url);
      const dest = hostOf(url);
      // Mesmo site: livre com aprovação vigente. Outro site: pergunta sempre (a URL pode levar dados).
      await authorize(dest === host
        ? { kind: "acao", action: "navegar", host, url, windowHost: host }
        : { kind: "outro", action: "ir pra outro site", host, url, windowHost: dest }, s);
      markAction(s);
      await browser.tabs.update(tabId, { url });
    }
    const t = await waitForLoad(tabId);
    await checkUrl(t.url); // redirecionou pra algo bloqueado?
    noteRead(hostOf(t.url), s);
    return tabInfo(t);
  },

  async screenshot({ tabId }, s) {
    const tab = await getAllowedTab(tabId, s);
    if (!tab.active) {
      await browser.tabs.update(tabId, { active: true });
      await sleep(250);
    }
    let dataUrl;
    try {
      // scale 1 => 1px da imagem = 1px CSS, então dá pra clicar usando as coordenadas do print.
      dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 75, scale: 1 });
    } catch (e) {
      if (!/activeTab/i.test(String(e?.message || e))) throw e;
      // Sem <all_urls>, o Firefox só deixa tirar print depois que o usuário clica no ícone nesta página.
      screenshotWanted.add(tabId);
      refreshBadge(tabId);
      const host = new URL(tab.url).hostname;
      throw coded(
        "print",
        `PRECISA DO USUÁRIO: o print só funciona depois que ele clica no ícone do Claude na barra do Firefox com a aba ${tabId} (${host}) aberta. ` +
        `O ícone dessa aba agora mostra 📷. Avise o usuário agora, dizendo exatamente isso, e espere ele confirmar antes de tentar de novo. ` +
        `A permissão vale só até a página mudar; ou use read_page, que não precisa disso.`,
        { tabId, host },
      );
    }
    screenshotWanted.delete(tabId);
    refreshBadge(tabId);
    return { image: dataUrl.split(",")[1], mimeType: "image/jpeg" };
  },

  read_page: ({ tabId, filter }, s) => runTool(tabId, "readPage", { filter }, s),
  click: ({ tabId, ...a }, s) => runAction(tabId, "click", a, s),
  type: ({ tabId, ...a }, s) => runAction(tabId, "type", a, s),
  press_key: ({ tabId, ...a }, s) => runAction(tabId, "pressKey", a, s),
  select_option: ({ tabId, ...a }, s) => runAction(tabId, "selectOption", a, s),
  scroll: ({ tabId, ...a }, s) => runTool(tabId, "scroll", a, s),
  console_logs: ({ tabId, ...a }, s) => runTool(tabId, "consoleLogs", a, s),
  // Leitura com código fixo (sem confirmação, mesmas checagens de site/aba e noteRead do runTool).
  query: ({ tabId, ...a }, s) => runTool(tabId, "query", a, s),
  extrair_tabela: ({ tabId, ...a }, s) => runTool(tabId, "extrairTabela", a, s),
  extrair_links: ({ tabId, ...a }, s) => runTool(tabId, "extrairLinks", a, s),
  estado_formulario: ({ tabId, ...a }, s) => runTool(tabId, "estadoFormulario", a, s),
  esperar_por: ({ tabId, ...a }, s) => runTool(tabId, "esperarPor", a, s),

  async javascript({ tabId, code }, s) {
    const tab = await getAllowedTab(tabId, s);
    const { allowJavascript = false } = await browser.storage.local.get("allowJavascript");
    if (!allowJavascript) {
      throw coded("js_off", "A ferramenta javascript está desligada. Só o usuário pode ligar, nas opções da extensão (about:addons).");
    }
    await authorize({ kind: "javascript", action: "rodar JavaScript na página", host: hostOf(tab.url), code }, s);
    markAction(s);
    // world MAIN: roda como script da própria página, sem browser.* e sem o fetch privilegiado da extensão.
    // A função é serializada e reavaliada na página, então não pode usar nada de fora dela.
    const [inj] = await browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      args: [code],
      func: async (code) => {
        try {
          let fn;
          // Primeiro tenta como expressão; se nem compilar, roda como corpo de função.
          try {
            fn = new Function(`return (async () => { return (${code}\n); })();`);
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e;
            fn = new Function(`return (async () => { ${code}\n })();`);
          }
          const v = await fn();
          if (v === undefined) return { v: "undefined" };
          try { return { v: JSON.stringify(v, null, 1) }; } catch (_) { return { v: String(v) }; }
        } catch (e) {
          // No Firefox o e.stack não traz a mensagem, só as linhas.
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          if (e instanceof EvalError || /CSP|Content Security Policy/i.test(msg)) {
            return { err: "A página proíbe eval pela Content Security Policy; a ferramenta javascript não funciona neste site." };
          }
          return { err: msg };
        }
      },
    });
    if (inj?.error) throw new Error(String(inj.error.message || inj.error));
    const res = inj?.result;
    if (res?.err) throw new Error(res.err);
    return { result: res?.v };
  },
};

// ---------- Painel lateral (chat) ----------
// painel (sidebar.html) ⇄ background ⇄ programa local "claude_firefox_chat" (native messaging, só esta extensão
// pode chamar: allowed_extensions no manifesto do host) ⇄ Claude Code via SDK.
// O background só repassa ao programa local os tipos de mensagem abaixo, e só vindos do painel desta extensão.
// Ferramentas do navegador que o Claude do painel usa chegam como {type:"tool"} e rodam na sessão "chat".

const NATIVE_HOST = "claude_firefox_chat";
const TO_HOST = new Set(["list", "open", "send", "interrupt", "permission_answer", "rename", "delete", "new"]);
const panelPorts = new Set();
const chatConfirms = new Map(); // id -> finish(decision)
let nativePort = null;

function toPanel(msg) {
  for (const p of panelPorts) {
    try {
      p.postMessage(msg);
    } catch (_) {}
  }
}

// Pasta de trabalho e textos do painel (jeito de conversar e "sobre mim"), vindos das opções.
const CHAT_KEYS = ["chatWorkdir", "chatEstilo", "chatSobreMim"];
async function chatConfig() {
  const { chatWorkdir = "", chatEstilo, chatSobreMim = "" } = await browser.storage.local.get(CHAT_KEYS);
  const estilo = typeof chatEstilo === "string" && chatEstilo.trim() ? chatEstilo : globalThis.ESTILO_PADRAO;
  return { type: "config", workdir: chatWorkdir, estilo, sobreMim: chatSobreMim };
}

function ensureNative() {
  if (nativePort) return nativePort;
  const port = browser.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "tool") {
      const reply = await runCommand(msg, sessions.chat);
      if (nativePort === port) port.postMessage({ ...reply, type: "tool_result" });
      return;
    }
    toPanel(msg); // eventos da conversa
  });
  port.onDisconnect.addListener((p) => {
    if (nativePort === port) nativePort = null;
    resetSession(sessions.chat);
    toPanel({ type: "host_down", error: String(p?.error?.message || "") });
  });
  chatConfig().then((c) => nativePort === port && port.postMessage(c));
  return port;
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && CHAT_KEYS.some((k) => changes[k]) && nativePort) chatConfig().then((c) => nativePort?.postMessage(c));
});

// Pedido de confirmação do navegador feito pelo Claude do painel: aparece como botões na conversa.
function confirmInChat(details) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    let timer = null;
    const finish = (decision) => {
      if (!chatConfirms.has(id)) return;
      chatConfirms.delete(id);
      clearTimeout(timer);
      toPanel({ type: "confirm_close", id, decision });
      resolve(decision);
    };
    timer = setTimeout(() => finish("timeout"), CONFIRM_TIMEOUT_MS);
    chatConfirms.set(id, finish);
    toPanel({ type: "confirm_request", id, details });
  });
}

browser.runtime.onConnect.addListener((port) => {
  const ok = port.name === "painel" && port.sender?.id === browser.runtime.id && !port.sender.tab &&
    typeof port.sender.url === "string" && port.sender.url.startsWith(browser.runtime.getURL("sidebar.html"));
  if (!ok) {
    port.disconnect();
    return;
  }
  panelPorts.add(port);
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    // Ninguém mais vendo a conversa: confirmação pendente do navegador vira "negado".
    if (!panelPorts.size) for (const finish of [...chatConfirms.values()]) finish("deny");
  });
  port.onMessage.addListener((msg) => {
    if (msg?.type === "confirm_answer") {
      if (["once", "window", "deny"].includes(msg.decision)) chatConfirms.get(msg.id)?.(msg.decision);
      return;
    }
    if (!TO_HOST.has(msg?.type)) return;
    try {
      ensureNative().postMessage(msg);
    } catch (e) {
      port.postMessage({ type: "host_down", error: String(e?.message || e) });
    }
  });
  port.postMessage({ type: "panel_ready" });
});

// ---------- Conexão com o servidor MCP ----------
// Só conversa com um servidor que prove conhecer o token gerado por instalar-extensao.sh (token.json, fora do
// git): desafio-resposta HMAC nos dois sentidos, sem o token trafegar. Antes disso, nenhum comando é aceito.

let tokenKey = null;
let tokenProblem = "";
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const isHex64 = (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

async function loadToken() {
  try {
    const { token } = await (await fetch(browser.runtime.getURL("token.json"))).json();
    if (!isHex64(token)) throw new Error("token inválido");
    tokenKey = await crypto.subtle.importKey("raw", fromHex(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  } catch (_) {
    tokenProblem = "sem token: rode instalar-extensao.sh e recarregue a extensão";
  }
}

// Sessão nova do Claude Code não herda aprovação nem histórico de sites da anterior.
function resetSession(s) {
  s.grants.clear();
  s.readHosts.clear();
  s.lastLocalReadAt = 0;
}

// Roda um comando de ferramenta numa sessão e monta a resposta (igual pras duas pontes).
async function runCommand({ id, cmd, params, ctx }, s) {
  // O hook do Claude Code marca quando a sessão usa ferramenta fora do navegador; aprovação anterior a isso cai.
  if (Number(ctx?.localReadAt) > s.lastLocalReadAt) s.lastLocalReadAt = Number(ctx.localReadAt);
  const h = typeof cmd === "string" && Object.hasOwn(handlers, cmd) ? handlers[cmd] : null;
  let reply;
  try {
    if (!h) throw new Error(`Comando desconhecido: ${cmd}`);
    reply = { id, ok: true, result: await h(params || {}, s) };
  } catch (e) {
    reply = { id, ok: false, error: String((e && e.message) || e), code: e?.code || null, info: e?.info || null };
  }
  reply.hosts = [...s.readHosts];
  return reply;
}

function connect() {
  if (!tokenKey) return;
  let sock;
  try {
    sock = new WebSocket(SERVER_URL);
  } catch (_) {
    setTimeout(connect, 3000);
    return;
  }
  ws = sock;
  let authed = false;
  let myNonce = null;
  let serverNonce = null;
  const authTimer = setTimeout(() => sock.close(), 5000);

  sock.onclose = () => {
    clearTimeout(authTimer);
    if (ws === sock) ws = null;
    if (authed) {
      connected = false;
      resetSession(sessions.term);
      refreshAllBadges();
    }
    setTimeout(connect, 3000);
  };
  sock.onerror = () => {};
  // Fila só pra despachar: o handshake termina (verify é assíncrono) antes de olhar a próxima mensagem.
  // Comandos rodam em paralelo (um esperando confirmação não trava os outros).
  let queue = Promise.resolve();
  sock.onmessage = (ev) => {
    queue = queue.then(() => dispatch(ev.data)).catch(() => {});
  };

  async function dispatch(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch (_) {
      return;
    }
    if (!authed) {
      try {
        if (msg.type === "hello" && !myNonce && isHex64(msg.nonce)) {
          serverNonce = msg.nonce;
          myNonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
          const mac = await crypto.subtle.sign("HMAC", tokenKey, enc.encode(`claude-firefox ext ${serverNonce} ${myNonce}`));
          sock.send(JSON.stringify({ type: "auth", nonce: myNonce, mac: toHex(mac) }));
          return;
        }
        if (msg.type === "ok" && myNonce && isHex64(msg.mac) &&
            await crypto.subtle.verify("HMAC", tokenKey, fromHex(msg.mac), enc.encode(`claude-firefox srv ${myNonce} ${serverNonce}`))) {
          authed = true;
          clearTimeout(authTimer);
          connected = true;
          resetSession(sessions.term);
          refreshAllBadges();
          return;
        }
      } catch (_) {}
      sock.close(); // qualquer outra coisa antes de autenticar = servidor que não conhece o token
      return;
    }
    // Sem await: comando esperando confirmação não trava os outros.
    runCommand(msg, sessions.term).then((reply) => {
      if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
    });
  }
}

loadToken().then(() => {
  refreshAllBadges();
  connect();
});
