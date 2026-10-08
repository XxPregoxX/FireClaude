// Painel lateral: conversa com o Claude Code (via background ⇄ programa local).
// Tudo que vem do Claude ou da página entra como texto (textContent) ou pelo renderMarkdown (sanitizado).
// Cartões de aprovação só são criados aqui, a partir de mensagens do background, nunca do texto do Claude.

const $ = (id) => document.getElementById(id);
const conversa = $("conversa");
const entrada = $("entrada");

let port = null;
let atual = { sessionId: null, title: "Nova conversa" };
let ocupado = false;
let bolha = null; // { el, texto } da resposta sendo escrita

// ---------- Ligação com o background ----------

function conectar() {
  port = browser.runtime.connect({ name: "painel" });
  port.onMessage.addListener(receber);
  // O background acompanha a aba ativa DESTA janela (cada janela tem o próprio painel).
  browser.windows.getCurrent().then((w) => enviar({ type: "janela", windowId: w.id })).catch(() => {});
  port.onDisconnect.addListener(() => {
    status("desconectado da extensão; tentando de novo…");
    setTimeout(conectar, 1500);
  });
}
const enviar = (msg) => port.postMessage(msg);

function status(t) {
  $("status").textContent = t;
}

function setOcupado(v) {
  ocupado = v;
  $("btnEnviar").hidden = v;
  $("btnParar").hidden = !v;
  if (v) comDigitando();
  else semDigitando();
  if (!v) status(atual.sessionId ? "pronto" : "pronto · conversa nova");
  atualizarUsoBotao();
}

// Tamanho da conversa (o que cada mensagem relê). Acima do limite, sugere continuar numa conversa nova.
let tamanho = 0;
// Aviso de conversa longa fechado no ✕: não volta naquela conversa (guardado, até 100 conversas).
let longaDispensada = [];
browser.storage.local.get("longaDispensada").then(({ longaDispensada: l }) => {
  if (Array.isArray(l)) longaDispensada = l.filter((x) => typeof x === "string").slice(-100);
  if (atual.sessionId && longaDispensada.includes(atual.sessionId)) $("longaAviso").hidden = true;
}).catch(() => {});
function mostrarTamanho(tokens, longa) {
  tamanho = Number.isFinite(tokens) ? tokens : 0;
  $("longaAviso").hidden = !longa || (!!atual.sessionId && longaDispensada.includes(atual.sessionId));
  $("longaTexto").textContent = longa ? `Conversa longa (~${Math.round(tamanho / 1000)}k tokens): cada mensagem relê tudo isso.` : "";
  if (!ocupado) setOcupado(false);
}

// Modelo da conversa atual (vem do programa do painel) e os outros, pra troca rápida no menu.
let modeloInfo = null;

// ---------- Copiar ----------
// navigator.clipboard às vezes falha no painel; aí copia pelo jeito antigo (textarea escondida + execCommand).
async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    return true;
  } catch (_) {}
  const ta = document.createElement("textarea");
  ta.value = texto;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {}
  ta.remove();
  return ok;
}

function botaoCopiar(classe, rotulo, pegarTexto) {
  const b = document.createElement("button");
  b.className = classe;
  b.textContent = rotulo;
  b.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    b.textContent = (await copiar(pegarTexto())) ? "Copiado!" : "Não deu";
    setTimeout(() => (b.textContent = rotulo), 1500);
  });
  return b;
}

// ---------- Renderização ----------

function rolar() {
  conversa.scrollTop = conversa.scrollHeight;
}

function some(el) {
  $("vazio")?.remove();
  conversa.append(el);
  rolar();
  return el;
}

function msgUsuario(texto, anexos = []) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = texto;
  for (const a of anexos) {
    const l = document.createElement("div");
    l.className = "m-anexo";
    l.textContent = `📎 ${rotuloAnexo(a)}`;
    d.append(l);
  }
  d.append(botaoCopiar("copiar-msg", "Copiar", () => texto));
  return some(d);
}

// Links: sem href; clique mostra o destino real e só então abre em aba nova. Código: botão de copiar.
function enfeitar(frag) {
  for (const a of frag.querySelectorAll("a[data-href]")) {
    const href = a.getAttribute("data-href");
    let url = null;
    try {
      url = new URL(href);
    } catch (_) {}
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      a.replaceWith(document.createTextNode(`${a.textContent} (${href})`));
      continue;
    }
    a.title = url.href;
    const dest = document.createElement("span");
    dest.className = "destino";
    dest.textContent = ` ↗ ${url.hostname}`;
    a.after(dest);
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      perguntar("Abrir este endereço numa aba nova?", url.href, "Abrir").then((ok) => ok && browser.tabs.create({ url: url.href }));
    });
  }
  for (const pre of frag.querySelectorAll("pre")) {
    const caixa = document.createElement("div");
    caixa.className = "bloco-codigo";
    pre.replaceWith(caixa);
    caixa.append(pre);
    caixa.append(botaoCopiar("copiar", "Copiar", () => pre.textContent));
  }
  return frag;
}

function pintar(el, texto) {
  el.replaceChildren(enfeitar(renderMarkdown(texto)));
  el.fonte = texto;
  el.append(botaoCopiar("copiar-msg", "Copiar", () => el.fonte));
}

// Seleção do usuário dentro do elemento: não redesenhar agora, senão a seleção some e não dá pra copiar.
function selecionando(el) {
  const sel = getSelection();
  return !!sel && !sel.isCollapsed && el.contains(sel.anchorNode);
}

function msgAssistente(texto = "") {
  const d = document.createElement("div");
  d.className = "msg assistant";
  pintar(d, texto);
  return some(d);
}

let pintura = null;
function delta(t) {
  semDigitando();
  if (!bolha) bolha = { el: msgAssistente(""), texto: "" };
  bolha.texto += t;
  if (!pintura) {
    const tick = () => {
      if (bolha && selecionando(bolha.el)) {
        pintura = setTimeout(tick, 300);
        return;
      }
      pintura = null;
      if (bolha) {
        pintar(bolha.el, bolha.texto);
        rolar();
      }
    };
    pintura = setTimeout(tick, 80);
  }
}

function fimResposta(texto) {
  semDigitando();
  if (!bolha) bolha = { el: msgAssistente(""), texto: "" };
  if (typeof texto === "string") bolha.texto = texto;
  pintar(bolha.el, bolha.texto);
  bolha = null;
  if (ocupado) comDigitando();
  rolar();
}

let digitando = null;
function comDigitando() {
  if (digitando) return;
  digitando = document.createElement("div");
  digitando.className = "digitando";
  digitando.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  some(digitando);
}
function semDigitando() {
  digitando?.remove();
  digitando = null;
}

// Nome em português pra linha de ferramenta; o detalhe técnico fica numa linha só (inteiro ao passar o mouse).
const NOMES_FERRAMENTA = {
  read_page: "Lendo a página", perguntar_pagina: "Perguntando sobre a página", query: "Lendo a página", extrair_tabela: "Lendo uma tabela", extrair_links: "Lendo os links",
  estado_formulario: "Lendo o formulário", esperar_por: "Esperando a página", tabs_list: "Vendo as abas",
  tab_new: "Abrindo uma aba", tab_close: "Fechando uma aba", navigate: "Navegando", click: "Clicando", type: "Digitando",
  press_key: "Apertando uma tecla", select_option: "Escolhendo uma opção", scroll: "Rolando a página",
  screenshot: "Tirando print", console_logs: "Lendo o console", javascript: "Rodando JavaScript", wait: "Esperando",
  Bash: "Rodando um comando", Read: "Lendo um arquivo", Write: "Criando um arquivo", Edit: "Editando um arquivo",
  MultiEdit: "Editando um arquivo", Glob: "Procurando arquivos", Grep: "Procurando nos arquivos",
  WebFetch: "Abrindo uma página da web", WebSearch: "Pesquisando na web", TodoWrite: "Organizando as tarefas",
  Task: "Pedindo ajuda a um subagente", Agent: "Pedindo ajuda a um subagente",
};
const FERRAMENTAS_OCULTAS = new Set(["ToolSearch"]); // bastidor: o Claude carregando ferramentas

function linhaFerramenta(nome, resumo) {
  semDigitando();
  bolha = null; // texto depois da ferramenta vira outra bolha
  const curto = nome.replace(/^mcp__claude-firefox__/, "");
  if (FERRAMENTAS_OCULTAS.has(curto)) {
    if (ocupado) comDigitando();
    return null;
  }
  const d = document.createElement("div");
  d.className = "ferramenta";
  const n = document.createElement("span");
  n.className = "f-nome";
  n.textContent = NOMES_FERRAMENTA[curto] || curto;
  d.append(n);
  if (resumo) {
    const r = document.createElement("span");
    r.className = "f-resumo";
    r.textContent = resumo;
    // Clique abre o detalhe inteiro (e fecha de novo); selecionando texto dentro, não fecha (dá pra copiar).
    const seta = setinha();
    seta.classList.add("f-seta");
    d.append(r, seta);
    d.classList.add("expansivel");
    d.title = "Clique pra ver tudo";
    d.addEventListener("click", () => {
      if (d.classList.contains("aberta") && selecionando(d)) return;
      d.classList.toggle("aberta");
      d.title = d.classList.contains("aberta") ? "" : "Clique pra ver tudo";
    });
  }
  some(d);
  if (ocupado) comDigitando();
  return d;
}

function erro(texto) {
  const d = document.createElement("div");
  d.className = "msg erro";
  d.textContent = texto;
  return some(d);
}

// ---------- Cartões de aprovação ----------

const cartoes = new Map(); // id -> { el, fechar(decisaoTexto) }

function cartao(id, titulo, aviso, campos, botoes, responder) {
  const c = document.createElement("div");
  c.className = "cartao";
  const t = document.createElement("div");
  t.className = "c-titulo";
  t.textContent = titulo;
  c.append(t);
  if (aviso) {
    const a = document.createElement("div");
    a.className = "c-aviso";
    a.textContent = `⚠️ ${aviso}`;
    c.append(a);
  }
  for (const [rotulo, valor] of campos) {
    if (valor == null || valor === "") continue;
    const r = document.createElement("div");
    r.className = "c-rotulo";
    r.textContent = rotulo;
    const p = document.createElement("pre");
    p.textContent = valor;
    c.append(r, p);
  }
  const caixa = document.createElement("div");
  caixa.className = "c-botoes";
  const bs = botoes.map(([rotulo, decisao]) => {
    const b = document.createElement("button");
    b.textContent = rotulo;
    if (decisao === "allow" || decisao === "once") b.className = "permitir";
    b.disabled = true; // evita aprovar sem querer com um clique que era pra outra coisa
    b.addEventListener("click", () => {
      bs.forEach((x) => (x.disabled = true));
      responder(decisao);
    });
    caixa.append(b);
    return b;
  });
  setTimeout(() => bs.forEach((b) => (b.disabled = false)), 700);
  c.append(caixa);
  const fechar = (texto) => {
    bs.forEach((b) => (b.disabled = true));
    c.classList.add("respondido");
    if (texto) {
      const r = document.createElement("div");
      r.className = "c-resposta";
      r.textContent = texto;
      c.append(r);
    }
    cartoes.delete(id);
  };
  cartoes.set(id, { el: c, fechar });
  bolha = null;
  semDigitando();
  return some(c);
}

const AVISOS = {
  envio: "Isso ENVIA um formulário.",
  download: "Isso BAIXA um arquivo pro seu computador.",
  javascript: "Código que roda na página com acesso a tudo que ela vê.",
  outro: "Isso leva pra OUTRO site. Confira o endereço inteiro: dados podem ir junto na URL.",
};
const RESPOSTA = { once: "✓ Permitido só desta vez", window: "✓ Permitido por tempo", allow: "✓ Permitido", always: "✓ Sempre permitido",
  deny: "✗ Negado", timeout: "✗ Expirou" };

function pedidoNavegador({ id, details: d }) {
  const botoes = [["Negar", "deny"], ["Só esta vez", "once"]];
  if (d.windowHost) botoes.push([`Agir em ${d.windowHost} por ${d.minutes} min`, "window"]);
  cartao(id, `Navegador: o Claude quer ${d.action}`, AVISOS[d.kind], [
    ["Site", d.host],
    ["Elemento (texto que aparece na tela)", d.element],
    ["Texto que vai ser digitado", d.text],
    ["Tecla", d.key],
    ["Opção", d.option],
    ["Endereço", d.url],
    ["Código", d.code],
  ], botoes, (decision) => enviar({ type: "confirm_answer", id, decision }));
}

function pedidoComputador(m) {
  const botoes = [["Negar", "deny"], ["Permitir", "allow"]];
  if (m.canAlways) botoes.push(["Sempre permitir este comando", "always"]);
  cartao(m.id, `Computador: o Claude quer usar ${m.tool}`, m.tainted ? "Esta conversa já leu páginas da web (podem ter prompt injection)." : "", [
    ["O que vai rodar", m.summary],
    ["Motivo do pedido", m.reason],
  ], botoes, (decision) => enviar({ type: "permission_answer", id: m.id, decision }));
}

// ---------- Aba ativa (o estado vem do background; título e endereço da página nunca) ----------

let atalhoPrint = "Alt+Shift+P";
browser.commands.getAll().then((cs) => {
  const c = cs.find((x) => x.name === "liberar-print");
  if (c?.shortcut) atalhoPrint = c.shortcut;
}).catch(() => {});

function mostrarAba(e) {
  const botao = $("abaBotao");
  botao.hidden = true;
  botao.onclick = null;
  let texto = "";
  if (e.motivo === "fora_da_lista" && typeof e.host === "string" && /^[a-z0-9.-]{1,253}$/i.test(e.host)) {
    texto = `${e.host} não está liberado pro Claude.`;
    botao.textContent = "Permitir este site";
    botao.hidden = false;
    // O Firefox só mostra o pedido de permissão se ele sair direto do clique (nada de await antes).
    botao.onclick = () => browser.permissions.request({ origins: [`*://${e.host}/*`] }).then(
      (ok) => ok && enviar({ type: "liberar_aba", tabId: e.tabId }),
      () => status("o Firefox não deixou pedir a permissão por aqui; use o botão direito no ícone do Claude → marque 'Claude pode agir nesta aba'"),
    );
  } else if (e.legivel && e.pedirAba && !e.liberada) {
    texto = "Pra agir nesta aba (clicar, digitar, navegar), libere ela pro Claude.";
    botao.textContent = "Liberar esta aba";
    botao.hidden = false;
    botao.onclick = () => enviar({ type: "liberar_aba", tabId: e.tabId });
  } else if (e.print) {
    texto = `📷 O Claude quer ver a tela: aperte ${atalhoPrint} (ou botão direito no ícone do Claude → marque "Claude pode tirar print").`;
  }
  $("abaTexto").textContent = texto;
  $("abaAviso").hidden = !texto;
}

// ---------- Seletor de modelo (como na extensão do Chrome: dentro da caixa de texto) ----------

function mostrarModelos() {
  const menu = $("modeloMenu");
  menu.replaceChildren();
  for (const o of modeloInfo?.modelos || []) {
    const b = document.createElement("button");
    const ok = document.createElement("span");
    ok.className = "m-ok";
    ok.textContent = o.id === modeloInfo.id ? "✓" : "";
    const txt = document.createElement("span");
    txt.className = "m-txt";
    const nome = document.createElement("div");
    nome.className = "m-nome";
    nome.textContent = String(o.nome || o.id).slice(0, 40);
    const desc = document.createElement("div");
    desc.className = "m-desc";
    desc.textContent = String(o.descricao || "").slice(0, 120);
    txt.append(nome, desc);
    b.append(txt, ok);
    b.addEventListener("click", () => {
      menu.hidden = true;
      enviar({ type: "modelo_conversa", modelo: o.id, sessionId: atual.sessionId || undefined });
    });
    menu.append(b);
  }
  const nota = document.createElement("div");
  nota.className = "m-nota";
  nota.textContent = atual.sessionId ? "Vale pra esta conversa (fica gravado nela)." : "Vale pra esta conversa nova. O padrão fica nas opções.";
  menu.append(nota);
  menu.hidden = false;
}
// A setinha acompanha a lista (abre de qualquer jeito: botão; fecha por Esc, clique fora ou escolha).
new MutationObserver(() => {
  const b = $("modeloBotao");
  if (!$("modeloMenu").hidden) {
    b.classList.remove("seta-pronta");
    b.classList.add("aberto");
    return;
  }
  // Fechando: mostra de novo a seta girada (ainda pra cima), força o navegador a desenhar ela assim e só então tira o
  // "aberto"; sem isso não há de onde animar e ela voltava seca.
  if (b.classList.contains("seta-pronta")) {
    b.classList.remove("seta-pronta");
    void b.offsetWidth;
  }
  b.classList.remove("aberto");
}).observe($("modeloMenu"), { attributes: true, attributeFilter: ["hidden"] });
$("modeloBotao").querySelector(".seta-anim").addEventListener("transitionend", (ev) => {
  if (ev.propertyName === "transform" && $("modeloBotao").classList.contains("aberto")) $("modeloBotao").classList.add("seta-pronta");
});
$("modeloBotao").addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (!modeloInfo) return status("abrindo o Claude…");
  if ($("modeloMenu").hidden) mostrarModelos();
  else $("modeloMenu").hidden = true;
});
document.addEventListener("click", (ev) => {
  const menu = $("modeloMenu");
  if (!menu.hidden && !menu.contains(ev.target) && !$("modeloBotao").contains(ev.target)) menu.hidden = true;
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && esperandoApontar) enviar({ type: "apontar_cancelar" });
  if (ev.key === "Escape") $("modeloMenu").hidden = true;
});

// ---------- Marca de segurança (a conversa leu página) ----------

let marcaInfo = null; // { hosts } quando a conversa leu página
let marcaTimer = null;
let pastaTrabalho = "";
// Aviso rápido: sobe, fica uns segundos e desce. Os detalhes ficam no quadro da conversa (gaveta Segurança).
function avisarMarca() {
  const sites = marcaInfo?.hosts?.length ? marcaInfo.hosts.join(", ") : "páginas da web";
  $("marca").textContent = `🛡️ Esta conversa leu ${sites}: agora comandos fora da pasta, programas e rede pedem aprovação.`;
  $("marca").hidden = false;
  clearTimeout(marcaTimer);
  marcaTimer = setTimeout(() => ($("marca").hidden = true), 2800);
}

// ---------- Gasto da conversa (botão na linha de status, quadro e gaveta por modelo) ----------

let usoAtual = null;
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toLocaleString("pt-BR", { maximumFractionDigits: n >= 100000 ? 0 : 1 })}k` : String(Math.round(n || 0)));
const fmtUsd = (v) => `US$ ${(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: v > 0 && v < 0.01 ? 4 : v < 1 ? 3 : 2, maximumFractionDigits: v > 0 && v < 0.01 ? 4 : v < 1 ? 3 : 2 })}`;
const fmtPct = (p) => (typeof p === "number" ? `≈${p.toLocaleString("pt-BR", { maximumFractionDigits: p < 1 ? 2 : 1 })}%` : null);
const fmtHora = (t) => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const fmtReinicio = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  const hoje = new Date().toDateString() === d.toDateString();
  return hoje ? `hoje ${fmtHora(d)}` : d.toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
};
const TAREFAS = { perguntar_pagina: "pergunta sobre a página", saida_bash: "resumo de saída de comando", saida_read: "resumo de arquivo",
  resumo_conversa: "resumo pra continuar", titulo: "título" };

// Gaveta que abre e fecha crescendo/encolhendo (altura até "auto" ainda não anima só com CSS no Firefox): a
// setinha gira na hora; a altura anima 0,16 s; ao fechar, o <details> só fecha depois de encolher.
function gavetaSuave(details, summary, corpo) {
  summary.addEventListener("click", (ev) => {
    ev.preventDefault();
    corpo.getAnimations().forEach((a) => a.cancel());
    if (!details.open) {
      details.open = true;
      details.classList.add("aberta");
      corpo.animate([{ height: "0px", opacity: 0 }, { height: `${corpo.scrollHeight}px`, opacity: 1 }], { duration: 160, easing: "ease-out" });
    } else {
      details.classList.remove("aberta");
      const a = corpo.animate([{ height: `${corpo.scrollHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 160, easing: "ease-out" });
      a.onfinish = () => (details.open = false);
    }
  });
}

function atualizarUsoBotao() {
  const b = $("usoBotao");
  const temUso = usoAtual && (usoAtual.custo > 0 || usoAtual.contexto > 0);
  if (!temUso && !marcaInfo) {
    b.hidden = true;
    return;
  }
  b.hidden = false;
  b.textContent = (marcaInfo ? "🛡️ " : "") + (temUso ? `contexto ~${fmtTok(usoAtual.contexto || tamanho)} · ${fmtUsd(usoAtual.custo)}` : "segurança");
  b.title = marcaInfo ? "Esta conversa leu páginas da web: ver gasto e segurança" : "Ver o gasto desta conversa";
}

function linha(pai, partes, classe = "u-linha") {
  const d = document.createElement("div");
  d.className = classe;
  for (const [txt, forte] of partes) {
    if (forte) {
      const b = document.createElement("b");
      b.textContent = txt;
      d.append(b);
    } else d.append(document.createTextNode(txt));
  }
  pai.append(d);
  return d;
}

const pctTexto = (pct) => [fmtPct(pct?.cinco) && `${fmtPct(pct.cinco)} da janela de 5 h`, fmtPct(pct?.semana) && `${fmtPct(pct.semana)} da semana`].filter(Boolean).join(" · ");

function mostrarQuadroUso() {
  const q = $("usoQuadro");
  q.replaceChildren();
  const u = usoAtual || { contexto: 0, custo: 0, pct: {}, modelos: [], auxiliar: null, plano: null };
  if (!usoAtual && !marcaInfo) {
    q.hidden = true;
    return;
  }
  const topo = document.createElement("div");
  topo.className = "u-topo";
  topo.append(document.createTextNode("Esta conversa"));
  const x = document.createElement("button");
  x.textContent = "✕";
  x.title = "Fechar";
  x.addEventListener("click", () => (q.hidden = true));
  topo.append(x);
  q.append(topo);
  linha(q, [["Contexto: ", false], [`~${fmtTok(u.contexto || tamanho)} tokens`, true], [" (o que cada mensagem relê)", false]]);
  const pt = pctTexto(u.pct);
  linha(q, [["Total: ", false], [fmtUsd(u.custo), true], [pt ? ` · ${pt}` : u.plano ? " · % do plano: ainda aprendendo" : "", false]]);

  const gaveta = (titulo, resumo, itens) => {
    const d = document.createElement("details");
    const s = document.createElement("summary");
    const b = document.createElement("b");
    b.textContent = titulo;
    s.append(setinha(), b, document.createTextNode(` — ${resumo}`));
    const corpo = document.createElement("div");
    corpo.className = "u-corpo";
    for (const it of itens) linha(corpo, [[it, false]], "u-cham");
    d.append(s, corpo);
    gavetaSuave(d, s, corpo);
    q.append(d);
  };
  for (const m of u.modelos || []) {
    const pm = pctTexto(m.pct);
    gaveta(m.nome, `${m.chamadas} chamada${m.chamadas === 1 ? "" : "s"} · ${fmtUsd(m.custo)}${pm ? ` · ${pm}` : ""}`, [
      `${fmtTok(m.lidos)} lidos (${fmtTok(m.doCache)} do cache, que custa 1/10) · ${fmtTok(m.escritos)} escritos`,
      ...(m.detalhes || []).slice().reverse().map((d) => `${fmtHora(d.quando)} · leu ${fmtTok(d.lidos)} (${fmtTok(d.doCache)} do cache) · escreveu ${fmtTok(d.escritos)} · ${fmtUsd(d.custo)}` +
        (d.ferramentas?.length ? ` · ${d.ferramentas.join(", ")}` : "")),
    ]);
  }
  if (u.auxiliar) {
    const a = u.auxiliar;
    const pa = pctTexto(a.pct);
    gaveta(`${a.nome} (modelo auxiliar)`, `${a.chamadas} chamada${a.chamadas === 1 ? "" : "s"} · ${fmtUsd(a.custo)}${pa ? ` · ${pa}` : ""}`,
      (a.detalhes || []).slice().reverse().map((d) => `${fmtHora(d.quando)} · ${TAREFAS[d.tarefa] || d.tarefa} · ${fmtTok(d.entrada)} → ${fmtTok(d.saida)} tokens · ` +
        `${fmtUsd(d.custo)}${d.ms ? ` · ${(d.ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s` : ""}${d.provedor && d.provedor !== "assinatura" ? ` · ${d.provedor}` : ""}`));
  }
  if (u.plano) {
    const p = u.plano;
    const plano = document.createElement("div");
    plano.className = "u-plano";
    q.append(plano);
    linha(plano, [[`Plano${p.tipo ? ` ${p.tipo[0].toUpperCase()}${p.tipo.slice(1)}` : ""} agora (conta inteira):`, true]]);
    if (p.cinco) linha(plano, [[`Janela de 5 horas: ${p.cinco.pct}% usado${p.cinco.reinicia ? ` · reinicia ${fmtReinicio(p.cinco.reinicia)}` : ""}`, false]]);
    if (p.semana) linha(plano, [[`Semana: ${p.semana.pct}% usado${p.semana.reinicia ? ` · reinicia ${fmtReinicio(p.semana.reinicia)}` : ""}`, false]]);
  }
  // Segurança: se a conversa leu página e o que isso muda (resumo na linha; detalhe na gaveta).
  const seg = document.createElement("details");
  seg.className = "u-info u-seg";
  const segTit = document.createElement("summary");
  segTit.append(setinha(), document.createTextNode(marcaInfo
    ? `🛡️ Segurança: leu ${marcaInfo.hosts.length ? marcaInfo.hosts.join(", ") : "páginas da web"}`
    : "Segurança: ainda não leu nenhuma página"));
  const segCorpo = document.createElement("div");
  segCorpo.className = "u-corpo";
  seg.append(segTit, segCorpo);
  gavetaSuave(seg, segTit, segCorpo);
  const pasta = pastaTrabalho ? ` (${pastaTrabalho})` : "";
  const itensSeg = marcaInfo ? [
    "Depois que a conversa lê conteúdo de uma página, ela fica marcada até o fim (e continua marcada se você retomar ela " +
      "depois): o que veio da página pode tentar mandar o Claude fazer coisas (prompt injection).",
    `Passa direto: ler, criar, editar, mover e mandar pra lixeira arquivos dentro da pasta de trabalho${pasta}.`,
    "Pede sua aprovação: arquivo que começa com ponto, CLAUDE.md e arquivos sensíveis (chaves, .env, senhas), rm, rodar " +
      "programa ou script, acesso à rede e qualquer coisa fora da pasta. Os \"sempre permitir\" ficam suspensos.",
    "No navegador: clicar, digitar, enviar e navegar continuam pedindo confirmação; a aprovação \"agir em um site por N min\" " +
      "cai quando o Claude lê outro site ou usa qualquer ferramenta fora do navegador.",
    "O que vem das páginas chega ao Claude marcado como dado, não como instrução. Mesmo assim, confira o que aprova.",
  ] : [
    "Enquanto a conversa não lê página nenhuma, valem as permissões normais do Claude Code (inclusive os \"sempre permitir\").",
    "Na primeira página lida, ela fica marcada até o fim: aí comandos fora da pasta, programas e rede passam a pedir " +
      "aprovação, e um aviso 🛡️ aparece rapidinho em cima da caixa de texto.",
  ];
  for (const t of itensSeg) linha(segCorpo, [[t, false]], "u-nota");
  q.append(seg);

  const info = document.createElement("details");
  info.className = "u-info";
  const infoTit = document.createElement("summary");
  infoTit.append(setinha(), document.createTextNode("Como esses números são calculados"));
  const infoCorpo = document.createElement("div");
  infoCorpo.className = "u-corpo";
  info.append(infoTit, infoCorpo);
  gavetaSuave(info, infoTit, infoCorpo);
  linha(infoCorpo, [["Tokens e US$ são exatos (US$ a preço de API, a régua pra comparar). O plano só informa a % da conta inteira, " +
    "em número inteiro: a % por conversa/modelo (≈) é estimativa, aprendida com quanto a janela sobe a cada mensagem do " +
    "painel; usar o Claude em outro lugar ao mesmo tempo puxa a estimativa pra cima.", false]], "u-nota");
  q.append(info);
  q.hidden = false;
}

$("usoBotao").addEventListener("click", (ev) => {
  ev.stopPropagation();
  if ($("usoQuadro").hidden) mostrarQuadroUso();
  else $("usoQuadro").hidden = true;
});
document.addEventListener("click", (ev) => {
  const q = $("usoQuadro");
  if (!q.hidden && !q.contains(ev.target) && ev.target !== $("usoBotao")) q.hidden = true;
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") $("usoQuadro").hidden = true;
});

function zerarUso() {
  usoAtual = null;
  $("usoQuadro").hidden = true;
  atualizarUsoBotao();
}

// ---------- Mensagens do programa local / background ----------

function receber(m) {
  switch (m?.type) {
    case "aba_estado":
      mostrarAba(m);
      break;
    case "tamanho":
      mostrarTamanho(Number(m.tokens), !!m.longa);
      break;
    case "uso":
      if (m.sessionId && atual.sessionId && m.sessionId !== atual.sessionId) break; // de outra conversa
      usoAtual = m;
      atualizarUsoBotao();
      if (!$("usoQuadro").hidden) mostrarQuadroUso();
      break;
    case "resumindo":
      status("resumindo a conversa pra continuar numa nova…");
      break;
    case "continuada": {
      // A conversa antiga foi resumida e fechada: começa uma nova, mostrando o resumo que vai junto da próxima mensagem.
      limpar();
      zerarUso();
      atual = { sessionId: null, title: "Nova conversa" };
      $("titulo").textContent = atual.title;
      mostrarTamanho(0, false);
      const d = document.createElement("div");
      d.className = "msg assistant resumo";
      pintar(d, `**Continuando de “${String(m.de ?? "").slice(0, 80)}”.** Este resumo vai junto da sua próxima mensagem:\n\n${String(m.resumo ?? "")}`);
      some(d);
      setOcupado(false);
      entrada.focus();
      break;
    }
    case "modelo":
      modeloInfo = typeof m.nome === "string"
        ? { id: String(m.modelo || ""), nome: m.nome.slice(0, 40), modelos: Array.isArray(m.modelos) ? m.modelos.slice(0, 6) : [] }
        : null;
      $("modeloNome").textContent = modeloInfo?.nome || "Modelo";
      if (!$("modeloMenu").hidden) mostrarModelos();
      break;
    case "panel_ready":
      status("abrindo o Claude…");
      enviar({ type: "list" });
      break;
    case "ready":
      pastaTrabalho = String(m.workdir || "");
      status(`pronto · pasta: ${m.workdir}`);
      break;
    case "list":
      mostrarLista(m.sessions || []);
      break;
    case "history":
      abrirConversa(m);
      break;
    case "session":
      atual = { sessionId: m.sessionId, title: m.title || atual.title };
      $("titulo").textContent = atual.title;
      break;
    case "busy":
      setOcupado(!!m.value);
      if (m.value) status("o Claude está trabalhando…");
      break;
    case "delta":
      delta(String(m.text ?? ""));
      break;
    case "assistant":
      fimResposta(m.text);
      break;
    case "tool_use":
      linhaFerramenta(String(m.name ?? ""), String(m.summary ?? ""));
      break;
    case "permission_request":
      pedidoComputador(m);
      break;
    case "permission_closed":
      cartoes.get(m.id)?.fechar(RESPOSTA[m.decision] || "");
      break;
    case "confirm_request":
      pedidoNavegador(m);
      break;
    case "confirm_close":
      cartoes.get(m.id)?.fechar(RESPOSTA[m.decision] || "");
      break;
    case "marked":
      marcaInfo = { hosts: Array.isArray(m.hosts) ? m.hosts.map(String).slice(0, 20) : [] };
      avisarMarca();
      atualizarUsoBotao();
      if (!$("usoQuadro").hidden) mostrarQuadroUso();
      break;
    case "apontando":
    case "anexo":
    case "anexo_falhou":
      receberAnexo(m);
      break;
    case "error":
      erro(String(m.message ?? "erro"));
      setOcupado(false);
      break;
    case "host_down":
      setOcupado(false);
      status("programa do painel parou");
      if (m.error) erro(`O programa do painel não está rodando (${m.error}). Rode ./instalar-extensao.sh --token e recarregue a extensão.`);
      break;
  }
}

// ---------- Conversas ----------

function limpar() {
  conversa.replaceChildren();
  bolha = null;
  cartoes.clear();
  $("marca").hidden = true;
  clearTimeout(marcaTimer);
  marcaInfo = null;
}

function novaConversa() {
  limpar();
  zerarUso();
  mostrarTamanho(0, false);
  atual = { sessionId: null, title: "Nova conversa" };
  $("titulo").textContent = atual.title;
  enviar({ type: "new" });
  setOcupado(false);
  entrada.focus();
}

function abrirConversa(m) {
  limpar();
  atual = { sessionId: m.sessionId, title: m.title || "Conversa" };
  $("titulo").textContent = atual.title;
  for (const it of m.messages || []) {
    if (it.role === "user") msgUsuario(it.text);
    else if (it.role === "tool") linhaFerramenta(it.name, it.summary);
    else msgAssistente(it.text);
    bolha = null;
  }
  if (m.marked) receber({ type: "marked", hosts: m.hosts });
  usoAtual = m.uso && typeof m.uso === "object" ? m.uso : null;
  mostrarTamanho(Number(m.tokens) || 0, !!m.longa);
  setHistorico(false);
  conversa.hidden = false;
  setOcupado(false);
  // As mensagens foram montadas com a conversa escondida (rolar não tinha efeito): agora vai pro fim, sem animação.
  requestAnimationFrame(() => conversa.scrollTo({ top: conversa.scrollHeight, behavior: "instant" }));
}

function mostrarLista(lista) {
  const ul = $("listaHist");
  ul.replaceChildren();
  if (!lista.length) {
    const li = document.createElement("li");
    li.textContent = "Nenhuma conversa ainda.";
    ul.append(li);
  }
  for (const c of lista) {
    const li = document.createElement("li");
    const t = document.createElement("div");
    t.className = "h-titulo";
    t.textContent = c.title || "(sem título)";
    const d = document.createElement("div");
    d.className = "h-data";
    d.textContent = c.updatedAt ? new Date(c.updatedAt).toLocaleString("pt-BR") : "";
    const acoes = document.createElement("div");
    acoes.className = "h-acoes";
    const b = (rotulo, fn) => {
      const x = document.createElement("button");
      x.textContent = rotulo;
      x.addEventListener("click", fn);
      acoes.append(x);
    };
    b("Abrir", () => enviar({ type: "open", sessionId: c.sessionId }));
    b("Renomear", () => renomear(c.sessionId, t));
    b("Apagar", () =>
      perguntar("Apagar esta conversa de vez?", c.title || "", "Apagar").then((ok) => ok && enviar({ type: "delete", sessionId: c.sessionId })));
    li.append(t, d, acoes);
    ul.append(li);
  }
}

function renomear(sessionId, alvo) {
  const atualTitulo = alvo.textContent;
  const input = document.createElement("input");
  input.value = atualTitulo;
  input.maxLength = 120;
  alvo.replaceChildren(input);
  input.focus();
  input.select();
  let feito = false;
  const fim = (salvar) => {
    if (feito) return;
    feito = true;
    const novo = input.value.trim();
    alvo.textContent = salvar && novo ? novo : atualTitulo;
    if (salvar && novo && novo !== atualTitulo) {
      enviar({ type: "rename", sessionId, title: novo });
      if (sessionId === atual.sessionId) atual.title = novo;
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fim(true);
    if (e.key === "Escape") fim(false);
  });
  input.addEventListener("blur", () => fim(true));
}

// ---------- Modal simples (sem prompt/confirm do navegador) ----------

function perguntar(texto, detalhe, rotuloOk) {
  return new Promise((resolve) => {
    $("modalTexto").textContent = texto;
    $("modalDetalhe").textContent = detalhe;
    $("modalOk").textContent = rotuloOk;
    $("modal").hidden = false;
    const fim = (v) => {
      $("modal").hidden = true;
      $("modalOk").onclick = $("modalCancelar").onclick = null;
      resolve(v);
    };
    $("modalOk").onclick = () => fim(true);
    $("modalCancelar").onclick = () => fim(false);
  });
}

// ---------- Trechos apontados na página (seletor de elemento ou texto selecionado) ----------
// O conteúdo fica no background; aqui só rótulo, tamanho e prévia. Na hora de mandar vão os ids.

let anexosPendentes = []; // { id, tipo, host, rotulo, chars, cortado, previa }
let esperandoApontar = false;
let falhaApontar = "";
let falhaTimer = null;
const fmtChars = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(".", ",")}k caracteres` : `${n} caracteres`);
const rotuloAnexo = (a) =>
  `${a.tipo === "selecao" ? "Seleção" : a.rotulo || "Elemento"} · ${a.host} · ${fmtChars(a.chars)}${a.cortado ? " (cortado)" : ""}`;

function etiqueta(classe, texto, titulo, aoFechar) {
  const e = document.createElement("div");
  e.className = `anexo ${classe}`;
  const t = document.createElement("span");
  t.textContent = texto;
  e.title = titulo;
  e.append(t);
  if (aoFechar) {
    const x = document.createElement("button");
    x.textContent = "✕";
    x.title = "Tirar";
    x.addEventListener("click", aoFechar);
    e.append(x);
  }
  return e;
}

function mostrarAnexos() {
  const box = $("anexos");
  box.replaceChildren();
  if (esperandoApontar) {
    box.append(etiqueta("esperando", "🎯 Escolha na página o que o Claude vai ler…", "Na página: roda ou ↑/↓ muda o elemento, clique ou Enter escolhe, Esc cancela",
      () => enviar({ type: "apontar_cancelar" })));
  }
  for (const a of anexosPendentes) {
    box.append(etiqueta("", `📎 ${rotuloAnexo(a)}`, a.previa || "", () => {
      anexosPendentes = anexosPendentes.filter((x) => x.id !== a.id);
      mostrarAnexos();
    }));
  }
  if (falhaApontar) box.append(etiqueta("falhou", falhaApontar, "", null));
  box.hidden = !box.childElementCount;
}

function receberAnexo(m) {
  clearTimeout(falhaTimer);
  falhaApontar = "";
  if (m.type === "apontando") esperandoApontar = true;
  else if (m.type === "anexo") {
    esperandoApontar = false;
    if (typeof m.id === "string" && !anexosPendentes.some((a) => a.id === m.id)) {
      anexosPendentes = [...anexosPendentes, {
        id: m.id, tipo: m.tipo === "selecao" ? "selecao" : "elemento", host: String(m.host || "").slice(0, 120),
        rotulo: String(m.rotulo || "").slice(0, 80), chars: Number(m.chars) || 0, cortado: !!m.cortado, previa: String(m.previa || "").slice(0, 200),
      }].slice(-5);
    }
    entrada.focus();
  } else {
    esperandoApontar = false;
    if (!m.cancelado) {
      falhaApontar = String(m.message || "Não deu pra pegar o trecho.").slice(0, 200);
      falhaTimer = setTimeout(() => {
        falhaApontar = "";
        mostrarAnexos();
      }, 7000);
    }
  }
  mostrarAnexos();
}
$("btnApontar").addEventListener("click", () => enviar({ type: "apontar" }));

// ---------- Eventos da interface ----------

function mandar() {
  const digitado = entrada.value.trim();
  if ((!digitado && !anexosPendentes.length) || ocupado) return;
  const anexos = anexosPendentes;
  anexosPendentes = [];
  mostrarAnexos();
  const texto = digitado || (anexos.length > 1 ? "Lê esses trechos que eu apontei." : "Lê esse trecho que eu apontei.");
  entrada.value = "";
  ajustarAltura();
  msgUsuario(texto, anexos);
  bolha = null;
  setOcupado(true);
  status("enviando…");
  enviar({ type: "send", sessionId: atual.sessionId, text: texto, ...(anexos.length ? { anexos: anexos.map((a) => a.id) } : {}) });
}

function ajustarAltura() {
  entrada.style.height = "auto";
  entrada.style.height = `${Math.max(32, Math.min(entrada.scrollHeight, 180))}px`;
}
entrada.addEventListener("input", ajustarAltura);

$("btnEnviar").addEventListener("click", mandar);
$("btnTema").addEventListener("click", async () => {
  const t = await trocarTema();
  status(`tema: ${{ auto: "automático (segue o sistema)", escuro: "escuro", claro: "claro" }[t]}`);
});
$("btnParar").addEventListener("click", () => enviar({ type: "interrupt" }));
entrada.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    mandar();
  }
});
// Nova conversa fica no topo da lista de conversas (☰), como no claude.ai.
$("btnNova").addEventListener("click", () => {
  setHistorico(false);
  conversa.hidden = false;
  novaConversa();
});
$("longaFechar").addEventListener("click", () => {
  $("longaAviso").hidden = true;
  if (!atual.sessionId || longaDispensada.includes(atual.sessionId)) return;
  longaDispensada = [...longaDispensada, atual.sessionId].slice(-100);
  browser.storage.local.set({ longaDispensada }).catch(() => {});
});
$("btnContinuar").addEventListener("click", () => {
  if (ocupado) return;
  $("longaAviso").hidden = true;
  enviar({ type: "continuar_nova" });
});
// O ajuste da barra lateral (firefox/claude-firefox.css) esconde o cabeçalho do Firefox (⌄ ✕) neste painel; então o painel tem o próprio ✕.
$("btnFechar").addEventListener("click", () => browser.sidebarAction.close());
// Lista de conversas: o ☰ abre e fecha (vira X com ela aberta).
function setHistorico(aberto) {
  $("historico").hidden = !aberto;
  // Ao fechar, as linhas giradas reaparecem ainda em X e só então voltam pro ☰ animando (mesmo cuidado da setinha).
  if (!aberto && $("btnHistorico").classList.contains("x-pronto")) {
    $("btnHistorico").classList.remove("x-pronto");
    void $("btnHistorico").offsetWidth;
  }
  $("btnHistorico").classList.remove("x-pronto");
  document.body.classList.toggle("hist-aberto", aberto);
  $("btnHistorico").setAttribute("aria-expanded", String(aberto));
  $("btnHistorico").title = aberto ? "Fechar a lista de conversas" : "Conversas anteriores";
  if (!aberto) conversa.hidden = false;
}

// Terminou de girar com a lista aberta: troca pelo X fixo (igual ao ✕ de fechar).
$("btnHistorico").querySelector(".l1").addEventListener("transitionend", (ev) => {
  if (ev.propertyName === "transform" && document.body.classList.contains("hist-aberto")) $("btnHistorico").classList.add("x-pronto");
});
$("btnHistorico").addEventListener("click", () => {
  if (!$("historico").hidden) return setHistorico(false);
  setHistorico(true); // a lista fica por cima da conversa (camada), sem esconder ela
  enviar({ type: "list" });
});
$("titulo").addEventListener("click", () => {
  if (atual.sessionId) renomear(atual.sessionId, $("titulo"));
});

conectar();
