const SERVER_URL = "ws://127.0.0.1:47823";

let ws = null;
let connected = false;

// Abas que o Claude pode ver/controlar: as que ele abriu + as que você liberou (menu do ícone ou botão do painel).
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
    if (hostMatches(host, d)) throw coded("proibido", `Bloqueado: ${host} está na lista de sites proibidos (configurada pelo usuário no Firefox).`, { host });
  }
  if (!(await browser.permissions.contains({ origins: [`${u.protocol}//${host}/*`] }))) {
    throw coded(
      "fora_da_lista",
      `Bloqueado: ${host} não está na lista de sites permitidos. Peça ao usuário pra adicionar nas opções da extensão ` +
      `ou, numa aba desse site, pelo botão direito no ícone do Claude → marque \\"Claude pode agir nesta aba\\".`,
      { host },
    );
  }
}

// Painel, só leitura: a aba ATIVA (da janela em foco) conta como emprestada pro Claude do painel, sem clique no
// ícone, desde que o site dela passe no checkUrl (lista de permitidos, sites proibidos, rede local). Vale pra
// qualquer aba de site permitido enquanto ela for a ativa. Ações nunca usam isto: continuam exigindo a aba liberada.
async function abaEmprestada(tab, s) {
  if (s !== sessions.chat || !tab?.active) return false;
  const [ativa] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  return !!ativa && ativa.id === tab.id;
}

// Aba ativa em que o Claude do painel tentou AGIR sem ela estar liberada: o painel mostra "Liberar esta aba".
let abaPedida = null;

async function getAllowedTab(tabId, s, { leitura = false } = {}) {
  if (!allowedTabs.has(tabId)) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    const emprestada = tab && (await abaEmprestada(tab, s));
    if (emprestada && leitura) {
      await checkUrl(tab.url);
      noteRead(hostOf(tab.url), s);
      return tab;
    }
    if (emprestada) {
      await checkUrl(tab.url); // site fora da lista: o motivo certo é esse, não a liberação da aba
      abaPedida = tabId;
      avisarPainel();
    }
    throw coded(
      "nao_liberada",
      `A aba ${tabId} não está liberada pro Claude agir nela.` +
        (s === sessions.chat ? "" : " Abra uma com tab_new ou peça pro usuário liberar a aba (botão direito no ícone do Claude → marque 'Claude pode agir nesta aba')."),
      { tabId },
    );
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

// Chave da API do modelo auxiliar: as opções mandam pra cá e daqui vai direto pro programa do painel (que grava em
// arquivo 0600). Não fica no armazenamento da extensão e o painel nunca vê.
const chavePendente = new Map(); // id -> resolve
function chaveDoWorker(pedido) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      chavePendente.delete(id);
      resolve({ erro: "o programa do painel não respondeu" });
    }, 10000);
    chavePendente.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    try {
      ensureNative().postMessage({ type: "worker_chave", id, acao: pedido.acao === "status" ? "status" : "gravar", chave: String(pedido.chave ?? "").slice(0, 400) });
    } catch (e) {
      chavePendente.delete(id);
      clearTimeout(timer);
      resolve({ erro: String(e?.message || e) });
    }
  });
}
browser.runtime.onMessage.addListener((msg, sender) => {
  const daOpcoes = typeof sender.url === "string" && sender.url.split("#")[0] === browser.runtime.getURL("options.html");
  if (msg?.type !== "worker_chave" || sender.id !== browser.runtime.id || !daOpcoes) return;
  return chaveDoWorker(msg).then((r) => ({ final: typeof r.final === "string" ? r.final.slice(-4) : "", erro: r.erro ? String(r.erro).slice(0, 200) : "" }));
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

// Abas onde o Claude tentou tirar print e precisa de um gesto do usuário nela (activeTab: clique no ícone, item do menu
// do ícone ou atalho da extensão).
const screenshotWanted = new Set();
// Abas cujo print o usuário liberou com um gesto nesta página (clique no ícone, caixa do menu, atalho). O Firefox não
// deixa revogar activeTab, então a extensão exige isto também: desmarcar a caixa bloqueia o print. Cai quando a página
// muda (que é quando o activeTab do Firefox também cai).
const printLiberado = new Set();
function liberarPrint(tabId) {
  if (tabId == null) return;
  printLiberado.add(tabId);
  screenshotWanted.delete(tabId);
  refreshBadge(tabId);
}

async function refreshBadge(tabId) {
  avisarPainel();
  const on = allowedTabs.has(tabId);
  const wantsShot = screenshotWanted.has(tabId);
  const tab = await browser.tabs.get(tabId).catch(() => null);
  const g = tab && grantFor(hostOf(tab.url));
  const until = g ? new Date(g.until).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";
  // Estado desta aba, igual às caixas do menu do ícone. Ler: o painel lê a aba ativa sem clique se o site passa no
  // checkUrl (lista de permitidos, proibidos, rede local).
  let ler = "não: não é uma página da web";
  if (tab) {
    try {
      await checkUrl(tab.url);
      ler = "sim, enquanto for a aba ativa (site permitido)";
    } catch (e) {
      if (e.code === "fora_da_lista") ler = "não: site fora da lista de permitidos";
      else if (e.code === "proibido") ler = "não: site proibido nas opções";
      else if (e.code === "rede_local") ler = "não: rede local (só liberando nas opções)";
    }
  }
  await browser.browserAction.setBadgeText({ tabId, text: wantsShot ? "📷" : on ? "✓" : "" });
  await browser.browserAction.setTitle({
    tabId,
    title: `Claude: ${connected ? "conectado" : tokenProblem || "desconectado"}\n` +
      "Nesta aba:\n" +
      `• Ler: ${ler}\n` +
      `• Agir: ${on ? "sim (aba marcada no menu)" : "não (botão direito → \"Claude pode agir nesta aba\")"}\n` +
      `• Print: ${printLiberado.has(tabId) ? "sim, até a página mudar" : "não (clique no ícone ou botão direito → print)"}` +
      (wantsShot ? "\n📷 O Claude pediu um print desta aba: clique no ícone, use o menu (botão direito) ou Alt+Shift+P." : "") +
      (g ? `\nO Claude pode agir neste site sem perguntar até ${until}.` : "") +
      "\nClique: abre/fecha o painel. Botão direito: liberar agir/print e opções.",
  });
}

async function refreshAllBadges() {
  await browser.browserAction.setBadgeBackgroundColor({ color: connected ? "#2e9e44" : "#888888" });
  for (const t of await browser.tabs.query({})) refreshBadge(t.id);
}

// Clique (esquerdo) no ícone: abre/fecha o painel. O toggle tem que ser a primeira coisa, ainda dentro do gesto. O
// mesmo clique dá activeTab nesta página, o que libera o print dela.
browser.browserAction.onClicked.addListener((tab) => {
  browser.sidebarAction.toggle().catch(() => {});
  liberarPrint(tab?.id);
});

// Liberar/revogar a aba pro Claude agir (o que o clique no ícone fazia antes). Liberar pede a permissão do site ao
// Firefox se ela ainda não existe; tem que ser chamado direto no gesto (item do menu), sem await antes.
function alternarAba(tab) {
  if (allowedTabs.has(tab.id)) {
    allowedTabs.delete(tab.id);
    for (const s of Object.values(sessions)) s.grants.delete(hostOf(tab.url)); // revogar a aba cancela a aprovação do site
    refreshAllBadges();
    return;
  }
  let origins = [];
  try {
    origins = [`*://${webUrl(tab.url).hostname}/*`];
  } catch (_) {}
  if (!origins.length) return refreshBadge(tab.id);
  browser.permissions.request({ origins }).then(
    (granted) => {
      if (granted) allowedTabs.add(tab.id);
      refreshBadge(tab.id);
    },
    () => refreshBadge(tab.id),
  );
}

// Menu do ícone (botão direito): uma caixa de marcar por permissão, com o estado desta aba. Clicar num item também é
// gesto (dá activeTab).
const MENU_ABA = "claude-aba";
const MENU_PRINT = "claude-print";
const MENU_OPCOES = "claude-opcoes";
function criarMenus() {
  browser.menus.removeAll().then(() => {
    browser.menus.create({ id: MENU_ABA, type: "checkbox", title: "Claude pode agir nesta aba", contexts: ["browser_action"] });
    browser.menus.create({ id: MENU_PRINT, type: "checkbox", title: "Claude pode tirar print desta página (até ela mudar)", contexts: ["browser_action"] });
    browser.menus.create({ id: "claude-sep", type: "separator", contexts: ["browser_action"] });
    browser.menus.create({ id: MENU_OPCOES, title: "Opções do Claude no Firefox", contexts: ["browser_action"] });
  }).catch(() => {});
}
criarMenus();
browser.menus.onShown.addListener((info, tab) => {
  if (!info.contexts?.includes("browser_action") || !tab) return;
  let web = true;
  try {
    webUrl(tab.url);
  } catch (_) {
    web = false;
  }
  const liberada = allowedTabs.has(tab.id);
  Promise.all([
    browser.menus.update(MENU_ABA, { checked: liberada, enabled: web || liberada }),
    browser.menus.update(MENU_PRINT, { checked: printLiberado.has(tab.id), enabled: web }),
  ]).then(() => browser.menus.refresh()).catch(() => {});
});
browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_OPCOES) return void browser.runtime.openOptionsPage();
  if (!tab) return;
  if (info.menuItemId === MENU_ABA) return alternarAba(tab);
  if (info.menuItemId === MENU_PRINT) {
    if (!info.wasChecked) return liberarPrint(tab.id);
    printLiberado.delete(tab.id);
    refreshBadge(tab.id);
  }
});

browser.tabs.onRemoved.addListener((id) => {
  allowedTabs.delete(id);
  screenshotWanted.delete(id);
  printLiberado.delete(id);
  carregouEm.delete(id);
});
browser.tabs.onUpdated.addListener((id, info) => {
  if (info.status === "loading" || info.url) {
    printLiberado.delete(id); // página nova: o print liberado era da anterior
    refreshBadge(id);
  }
  if (info.status === "complete") carregouEm.set(id, Date.now());
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

// Quando cada aba terminou de carregar (status "complete"): leitura logo depois espera a página assentar.
const carregouEm = new Map();

// Site moderno termina o "load" e só depois busca e desenha o conteúdo. Espera assentar (page-tools: assentar);
// se não der (página fechou, recarregou), segue sem esperar.
async function assentarAba(tabId, maxMs) {
  try {
    await ensureTools(tabId);
    await execTool(tabId, "assentar", { maxMs });
  } catch (_) {}
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
// Espera a aba sair de "loading" (clique que navegou logo antes: no meio da troca a URL pode ser about:blank).
async function esperaCarregar(tabId, ms = 10000) {
  const fim = Date.now() + ms;
  let t = await browser.tabs.get(tabId).catch(() => null);
  while (t && t.status === "loading" && Date.now() < fim) {
    await sleep(150);
    t = await browser.tabs.get(tabId).catch(() => null);
  }
  return t;
}

async function runTool(tabId, name, args, s) {
  await esperaCarregar(tabId);
  await getAllowedTab(tabId, s, { leitura: true }); // só leitura: aceita a aba ativa emprestada do painel
  // Página que acabou de carregar (o usuário clicou num link e pediu "olha isso"): espera assentar antes de ler.
  if (name !== "esperarPor" && name !== "scroll" && Date.now() - (carregouEm.get(tabId) || 0) < 3000) await assentarAba(tabId, 2500);
  await ensureTools(tabId);
  try {
    return await execTool(tabId, name, args);
  } catch (e) {
    if (!/não respondeu/.test(e.message)) throw e;
    // A página trocou no meio: espera a nova e tenta uma vez, com as checagens de aba e site refeitas (a página
    // nova pode ser de outro site).
    await sleep(300);
    await esperaCarregar(tabId);
    await getAllowedTab(tabId, s, { leitura: true });
    await assentarAba(tabId, 2500);
    await ensureTools(tabId);
    return execTool(tabId, name, args);
  }
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
    const [frente] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const mine = [];
    for (const t of tabs.filter((t) => allowedTabs.has(t.id))) {
      // Aba liberada que foi parar num site fora da lista: nem título nem URL vão pro Claude.
      const ok = await checkUrl(t.url).then(() => true, () => false);
      if (ok) noteRead(hostOf(t.url), s); // título também é conteúdo do site
      const info = { ...tabInfo(t), frente: t.id === frente?.id };
      mine.push(ok ? info : { ...info, title: "(bloqueado)", url: "(fora dos sites permitidos)" });
    }
    // A aba que o usuário está olhando, se não está liberada: entra na lista se o painel pode lê-la; senão vai só
    // o motivo (sem título, sem URL, sem id).
    let ativa = null;
    if (frente && !allowedTabs.has(frente.id)) {
      const e = await estadoDaAba(frente, s);
      if (e.legivel) {
        noteRead(hostOf(frente.url), s);
        mine.push({ ...tabInfo(frente), frente: true, soLeitura: true });
      } else {
        ativa = { motivo: e.motivo };
      }
    }
    return { tabs: mine, otherTabsHidden: tabs.length - mine.length - (ativa ? 1 : 0), ativa };
  },

  // Contexto que o programa do painel manda junto de cada mensagem: qual é a aba da frente e se dá pra ler.
  // Sem conteúdo da página (nem título): só id e site quando é legível, só o motivo quando não é.
  async aba_ativa(_, s) {
    if (s !== sessions.chat) throw new Error("Só o painel usa aba_ativa.");
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const e = await estadoDaAba(tab, s);
    return e.legivel
      ? { legivel: true, tabId: e.tabId, host: e.host, liberada: e.liberada }
      : { legivel: false, motivo: e.motivo };
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
    await assentarAba(t.id, 4000);
    return tabInfo(await browser.tabs.get(t.id).catch(() => loaded));
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
    // Caminho relativo (o read_page mostra link do mesmo site assim): resolve contra a página da aba.
    if (typeof url === "string" && /^\/(?!\/)/.test(url)) url = new URL(url, tab.url).href;
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
    await assentarAba(tabId, 4000);
    return tabInfo(await browser.tabs.get(tabId).catch(() => t));
  },

  async screenshot({ tabId }, s) {
    const tab = await getAllowedTab(tabId, s, { leitura: true }); // print é leitura: vale a aba ativa emprestada do painel
    if (!tab.active) {
      await browser.tabs.update(tabId, { active: true });
      await sleep(250);
    }
    let dataUrl;
    try {
      if (!printLiberado.has(tabId)) throw new Error("activeTab: o usuário não liberou o print desta página");
      // scale 1 => 1px da imagem = 1px CSS, então dá pra clicar usando as coordenadas do print.
      dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 75, scale: 1 });
    } catch (e) {
      if (!/activeTab/i.test(String(e?.message || e))) throw e;
      printLiberado.delete(tabId);
      // Sem <all_urls>, o Firefox só deixa tirar print depois de um gesto do usuário nesta página (activeTab).
      screenshotWanted.add(tabId);
      refreshBadge(tabId);
      const host = new URL(tab.url).hostname;
      throw coded(
        "print",
        `PRECISA DO USUÁRIO: o print só funciona depois de um gesto dele com a aba ${tabId} (${host}) na frente: atalho Alt+Shift+P, ` +
        `botão direito no ícone do Claude → marque "Claude pode tirar print desta página", ou clique no ícone (que também abre/fecha o painel). ` +
        `O ícone dessa aba agora mostra 📷. Avise o usuário agora, dizendo exatamente isso, e espere ele confirmar antes de tentar de novo. ` +
        `A permissão vale só até a página mudar; ou use read_page, que não precisa disso.`,
        { tabId, host },
      );
    }
    screenshotWanted.delete(tabId);
    refreshBadge(tabId);
    return { image: dataUrl.split(",")[1], mimeType: "image/jpeg" };
  },

  // maxChars só vem do programa do painel (perguntar_pagina lê a página inteira pro modelo auxiliar): até 150 mil.
  read_page: ({ tabId, filter, maxChars }, s) =>
    runTool(tabId, "readPage", { filter, maxChars: Math.min(150000, Math.max(1000, Number(maxChars) || 40000)) }, s),

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
const TO_HOST = new Set(["list", "open", "send", "interrupt", "permission_answer", "rename", "delete", "new", "modelo_conversa", "continuar_nova"]);
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

// Pasta de trabalho e textos do painel, vindos das opções.
const WORKER_KEYS = ["workerLigado", "workerProvedor", "workerModelo", "workerLocalUrl", "workerLocalModelo"];
const CHAT_KEYS = ["chatWorkdir", "chatEstilo", "chatSobreMim", "chatModelo", "chatEsforco", ...WORKER_KEYS];
async function chatConfig() {
  const { chatWorkdir = "", chatEstilo, chatSobreMim = "", chatModelo = "", chatEsforco = "", ...w } = await browser.storage.local.get(CHAT_KEYS);
  // Modelo auxiliar: o programa do painel valida tudo (provedor, modelo, endpoint só localhost). A chave da API não
  // passa por aqui: vai direto das opções pro programa do painel, que guarda em arquivo.
  const worker = { ligado: w.workerLigado !== false, provedor: w.workerProvedor, modelo: w.workerModelo, localUrl: w.workerLocalUrl, localModelo: w.workerLocalModelo };
  const estilo = typeof chatEstilo === "string" && chatEstilo.trim() ? chatEstilo : globalThis.ESTILO_PADRAO;
  return { type: "config", workdir: chatWorkdir, estilo, sobreMim: chatSobreMim, modelo: chatModelo, esforco: chatEsforco, worker };
}

// Atalhos. Todo atalho da extensão é um gesto do usuário que dá activeTab na aba da frente (o Firefox faz isso
// antes de chamar aqui), e isso é o que libera o print: abrir o painel pelo atalho já libera o print da página, e
// "liberar-print" serve pra quando o painel já está aberto. (O atalho especial _execute_sidebar_action NÃO dá
// activeTab; por isso o painel abre por um comando próprio.) sidebarAction.* tem que ser chamado direto aqui.
browser.commands.onCommand.addListener((name, tab) => {
  if (name === "abrir-painel") browser.sidebarAction.toggle().catch(() => {});
  else if (name === "liberar-print") browser.sidebarAction.open().catch(() => {});
  liberarPrint(tab?.id);
});

// ---------- Aba ativa no painel ----------
// O painel mostra o estado da aba ativa da janela dele: legível? liberada pra agir? E oferece os botões
// "Permitir este site" (o pedido de permissão do Firefox sai do próprio painel) e "Liberar esta aba".
// Pro Claude, nada de título nem URL de aba que ele não pode ler: só o motivo.

async function estadoDaAba(tab, s = sessions.chat) {
  if (!tab) return { tabId: null, legivel: false, liberada: false, motivo: "sem_aba", host: null };
  const base = { tabId: tab.id, liberada: allowedTabs.has(tab.id), print: screenshotWanted.has(tab.id), pedirAba: abaPedida === tab.id };
  try {
    await checkUrl(tab.url);
    return { ...base, legivel: base.liberada || s === sessions.chat, motivo: base.liberada || s === sessions.chat ? null : "nao_liberada", host: hostOf(tab.url) };
  } catch (e) {
    const motivo = ["fora_da_lista", "rede_local", "proibido"].includes(e.code) ? e.code : "pagina_interna";
    // Host só pro site fora da lista (é o que o botão "Permitir este site" pede ao Firefox).
    return { ...base, legivel: false, liberada: false, motivo, host: motivo === "fora_da_lista" ? hostOf(tab.url) : null };
  }
}

let avisoTimer = null;
function avisarPainel() {
  if (avisoTimer || !panelPorts.size) return;
  avisoTimer = setTimeout(async () => {
    avisoTimer = null;
    for (const p of panelPorts) {
      if (!Number.isInteger(p.janela)) continue;
      const [tab] = await browser.tabs.query({ active: true, windowId: p.janela }).catch(() => []);
      if (tab && abaPedida !== null && abaPedida !== tab.id) abaPedida = null; // trocou de aba: o pedido some
      const e = await estadoDaAba(tab);
      try {
        p.postMessage({ type: "aba_estado", ...e });
      } catch (_) {}
    }
  }, 120);
}
browser.tabs.onActivated.addListener(avisarPainel);
browser.windows.onFocusChanged.addListener(avisarPainel);
browser.permissions.onAdded.addListener(avisarPainel);
browser.permissions.onRemoved.addListener(avisarPainel);
browser.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && (ch.blockedDomains || ch.allowPrivateNetwork)) avisarPainel();
});

// Clique no painel em "Permitir este site" (depois que o Firefox concedeu) ou "Liberar esta aba": igual ao clique
// em "Liberar esta aba" no menu do ícone. Só vale pra aba ativa da janela do próprio painel e com o site já permitido.
async function liberarDoPainel(port, tabId) {
  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.active || tab.windowId !== port.janela) return;
  try {
    await checkUrl(tab.url);
  } catch (_) {
    return;
  }
  allowedTabs.add(tab.id);
  if (abaPedida === tab.id) abaPedida = null;
  refreshBadge(tab.id);
}

function ensureNative() {
  if (nativePort) return nativePort;
  const port = browser.runtime.connectNative(NATIVE_HOST);
  nativePort = port;
  port.onMessage.addListener(async (msg) => {
    if (msg?.type === "worker_chave_ok") {
      // Resposta sobre a chave do modelo auxiliar: só pra página de opções que pediu, nunca pro painel.
      chavePendente.get(msg.id)?.(msg);
      chavePendente.delete(msg.id);
      return;
    }
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
    if (msg?.type === "janela") {
      if (Number.isInteger(msg.windowId)) port.janela = msg.windowId;
      avisarPainel();
      return;
    }
    if (msg?.type === "liberar_aba") {
      if (Number.isInteger(msg.tabId)) liberarDoPainel(port, msg.tabId);
      return;
    }
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
