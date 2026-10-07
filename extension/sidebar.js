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
}

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

function msgUsuario(texto) {
  const d = document.createElement("div");
  d.className = "msg user";
  d.textContent = texto;
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
  read_page: "Lendo a página", query: "Lendo a página", extrair_tabela: "Lendo uma tabela", extrair_links: "Lendo os links",
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
    d.append(r);
    d.title = `${curto}: ${resumo}`;
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

// ---------- Mensagens do programa local / background ----------

function receber(m) {
  switch (m?.type) {
    case "panel_ready":
      status("abrindo o Claude…");
      enviar({ type: "list" });
      break;
    case "ready":
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
      $("marca").hidden = false;
      $("marca").textContent = `🛡️ Esta conversa leu: ${(m.hosts || []).join(", ") || "páginas da web"}. Comandos fora da pasta, programas e rede pedem aprovação.`;
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
}

function novaConversa() {
  limpar();
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
  $("historico").hidden = true;
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

// ---------- Eventos da interface ----------

function mandar() {
  const texto = entrada.value.trim();
  if (!texto || ocupado) return;
  entrada.value = "";
  ajustarAltura();
  msgUsuario(texto);
  bolha = null;
  setOcupado(true);
  status("enviando…");
  enviar({ type: "send", sessionId: atual.sessionId, text: texto });
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
$("btnNova").addEventListener("click", novaConversa);
// O ajuste da barra lateral (firefox/claude-firefox.css) esconde o cabeçalho do Firefox (⌄ ✕) neste painel; então o painel tem o próprio ✕.
$("btnFechar").addEventListener("click", () => browser.sidebarAction.close());
$("btnHistorico").addEventListener("click", () => {
  $("historico").hidden = false;
  conversa.hidden = true;
  enviar({ type: "list" });
});
$("btnFecharHist").addEventListener("click", () => {
  $("historico").hidden = true;
  conversa.hidden = false;
});
$("titulo").addEventListener("click", () => {
  if (atual.sessionId) renomear(atual.sessionId, $("titulo"));
});

conectar();
