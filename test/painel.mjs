// Teste do painel lateral no Firefox de teste (via ./test/run.sh, depois do ponte.mjs):
// ponte nativa (programa local falso), confirmações do navegador na conversa, separação terminal × painel,
// e Markdown seguro (sem HTML cru, sem imagem remota, link sem href).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const LOJA = "http://loja.teste:8765/";
const PAGES = new URL("./pages/", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let total = 0;
let falhas = 0;
function check(nome, ok, detalhe = "") {
  total++;
  if (!ok) falhas++;
  console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : `\n         -> ${String(detalhe).replace(/^\[Conteúdo vindo do Firefox[^\]]*\]\s*/, "").replace(/\s+/g, " ").slice(0, 400)}`}`);
}

// ---------- Servidor: páginas + filas do painel/programa local falsos + contadores ----------
const fila = { panel: [], host: [] }; // pro painel / pro programa local
const recebido = { panel: [], host: [] }; // do painel / do programa local (= o que a extensão mandou)
const pixels = [];
const popups = [];
let respostaPopup = [];
let md = null;
let respostaChave = null;

function corpo(req) {
  return new Promise((r) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => r(b));
  });
}
const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const m = /^\/__(panel|host)\/(in|out)$/.exec(u.pathname);
  if (m && m[2] === "in") {
    recebido[m[1]].push(JSON.parse(await corpo(req)));
    return res.end("ok");
  }
  if (m && m[2] === "out") {
    for (let t = 0; t < 3000 && !fila[m[1]].length; t += 50) await sleep(50);
    return res.end(JSON.stringify(fila[m[1]].splice(0)));
  }
  if (u.pathname === "/__pixel") {
    pixels.push(u.search);
    return res.end("");
  }
  if (u.pathname === "/__chave") {
    respostaChave = JSON.parse(await corpo(req));
    return res.end("ok");
  }
  if (u.pathname === "/__md") {
    md = JSON.parse(await corpo(req));
    return res.end("ok");
  }
  if (u.pathname === "/__confirm") {
    popups.push(JSON.parse(await corpo(req)));
    return res.end(respostaPopup.shift() || "deny");
  }
  const file = path.join(PAGES, path.normalize(u.pathname === "/" ? "/index.html" : u.pathname));
  fs.readFile(file, (err, data) => {
    res.writeHead(err ? 200 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(err ? "<!doctype html><title>ok</title>ok" : data);
  });
});
await new Promise((r) => srv.listen(8765, "127.0.0.1", r));

async function espera(lado, teste, ms = 15000) {
  for (let t = 0; t < ms; t += 50) {
    const achou = recebido[lado].find(teste);
    if (achou) return achou;
    await sleep(50);
  }
  return null;
}
let nTool = 0;
// Programa local falso pede uma ferramenta do navegador, como o Claude do painel faria.
function ferramenta(cmd, params) {
  const id = `t${++nTool}`;
  fila.host.push({ type: "tool", id, cmd, params, ctx: { localReadAt: 0 } });
  return id;
}

// ---------- Claude do terminal (pra comparar) ----------
const c = new Client({ name: "teste-painel", version: "0" });
await c.connect(new StdioClientTransport({
  command: "node",
  args: [new URL("../server/index.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: process.env.TEST_SERVER_LOG ? "inherit" : "ignore",
}));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};
for (let i = 0; i < 40 && (await call("tabs_list")).err; i++) await sleep(500);

try {
  console.log("# Abrindo o painel (página de teste) e o teste de Markdown");
  respostaPopup = ["once"];
  await call("tab_new", { url: LOJA + "__abrir-painel" });
  check("painel conecta no background", !!(await espera("panel", (m) => m.type === "panel_ready")));
  await sleep(3000); // o sidebar.html de verdade (aberto numa aba) tenta conectar e tem que ser recusado
  fila.panel.push({ __info: true });
  const info = (await espera("panel", (m) => m.type === "__info"))?.info;
  check("só a página do painel ficou conectada; sidebar.html numa aba (como conteúdo de página faria) é recusado",
    info?.panelPorts?.length === 1 && info.panelPorts[0].endsWith("/teste-painel.html"), JSON.stringify(info));

  console.log("\n# Markdown seguro");
  for (let t = 0; t < 10000 && !md; t += 100) await sleep(100);
  check("teste de Markdown rodou", !!md);
  const todos = Object.values(md || {}).join("\n");
  // Atributo perigoso só conta se estiver dentro de uma tag DE VERDADE ("<..."), não no texto escapado ("&lt;...").
  const tagCom = (re) => new RegExp(`<[a-z][^>]*${re}`, "i");
  check("HTML cru vira texto (sem tag img/script/b, sem on*= em tag)", !/<(img|script|b)[\s>]/i.test(md?.html) && !tagCom("\\son\\w+=").test(md?.html) &&
    /&lt;img/.test(md?.html), md?.html);
  check("imagem Markdown não vira <img> e mostra o endereço", !/<img/i.test(md?.imagem) && /imagem não carregada/.test(md?.imagem) && /SEGREDO/.test(md?.imagem), md?.imagem);
  check("link não tem href (só data-href, abre por clique)", /<a data-href="http:\/\/loja\.teste:8765\/__pixel\?link">/.test(md?.link) && !/\shref=/.test(todos), md?.link);
  check("javascript:/data: não viram link clicável", !/\shref=/.test(md?.jslink), md?.jslink);
  check("tabela, negrito e código inline", /<table>/.test(md?.tabela) && /<strong>1<\/strong>/.test(md?.tabela) && /<code>2<\/code>/.test(md?.tabela), md?.tabela);
  check("bloco de código com HTML dentro fica escapado", /<pre><code class="language-js">/.test(md?.codigo) && /&lt;img/.test(md?.codigo), md?.codigo);
  check("estilo inline (url() remota) não vira atributo", !tagCom("style=").test(md?.estilo) && !/<div/i.test(md?.estilo), md?.estilo);
  check("SVG com link javascript não vira tag", !/<(svg|a|text)[\s>]/i.test(md?.svg) && !tagCom("xlink").test(md?.svg), md?.svg);
  check("lista de tarefas vira ☑/☐ (sem <input>)", /☑/.test(md?.lista) && /☐/.test(md?.lista) && !/<input/.test(md?.lista) && /<ol>/.test(md?.lista), md?.lista);
  await sleep(1500);
  check("nenhuma imagem remota carregou (nem pelo Markdown, nem forçada: CSP)", pixels.length === 0, pixels.join(" "));

  console.log("\n# Ponte nativa");
  fila.panel.push({ type: "list" });
  check("background abre o programa local e manda a configuração", !!(await espera("host", (m) => m.type === "config")));
  check("mensagem do painel chega no programa local", !!(await espera("host", (m) => m.type === "list")));
  fila.panel.push({ type: "tool", id: "falso", cmd: "tabs_list", params: {} }, { type: "tool_result", id: "x", ok: true }, { type: "config", workdir: "/" });
  await sleep(1500);
  check("painel não consegue mandar tool/tool_result/config pro programa local",
    !recebido.host.some((m) => m.id === "falso" || m.id === "x" || (m.type === "config" && m.workdir === "/")), JSON.stringify(recebido.host));
  const cfg0 = recebido.host.find((m) => m.type === "config");
  check("configuração leva o modelo e o esforço das opções (vazio = padrão do programa do painel)", cfg0 && "modelo" in cfg0 && "esforco" in cfg0, JSON.stringify(cfg0));
  fila.panel.push({ type: "modelo_conversa", modelo: "claude-opus-5-5", sessionId: "s-123" });
  check("seletor de modelo do painel chega no programa local (com a conversa aberta)", !!(await espera("host", (m) => m.type === "modelo_conversa" &&
    m.modelo === "claude-opus-5-5" && m.sessionId === "s-123")));
  fila.host.push({ type: "modelo", modelo: "claude-opus-5-5", nome: "Opus 5.5", modelos: [{ id: "claude-sonnet-5-5", nome: "Sonnet 5.5", descricao: "x" }, { id: "claude-opus-5-5", nome: "Opus 5.5", descricao: "y" }] });
  check("aviso de modelo do programa local chega no painel", !!(await espera("panel", (m) => m.type === "modelo" && m.nome === "Opus 5.5")));
  check("configuração leva o modelo auxiliar (padrão ligado)", cfg0?.worker?.ligado === true, JSON.stringify(cfg0?.worker));
  respostaPopup = ["once"];
  await call("tab_new", { url: LOJA + "__worker-chave" });
  const pedidoChave = await espera("host", (m) => m.type === "worker_chave");
  check("chave do modelo auxiliar vai das opções direto pro programa local", pedidoChave?.acao === "gravar" && /^sk-ant-api03-chave-de-teste/.test(pedidoChave.chave) &&
    typeof pedidoChave.id === "string", JSON.stringify(pedidoChave));
  fila.host.push({ type: "worker_chave_ok", id: pedidoChave?.id, final: "abcd" });
  for (let t = 0; t < 5000 && !respostaChave; t += 100) await sleep(100);
  check("resposta volta pra quem pediu (só o final da chave)", respostaChave?.final === "abcd" && !respostaChave.erro, JSON.stringify(respostaChave));
  await sleep(500);
  check("nem a chave nem a resposta sobre ela aparecem no painel", !recebido.panel.some((m) => /sk-ant|worker_chave/.test(JSON.stringify(m))));
  fila.panel.push({ type: "worker_chave", acao: "gravar", chave: "sk-ant-do-painel" });
  await sleep(1200);
  check("o painel não consegue mandar chave pro programa local", !recebido.host.some((m) => m.type === "worker_chave" && /do-painel/.test(m.chave || "")));
  fila.panel.push({ type: "continuar_nova" });
  check("'continuar em conversa nova' do painel chega no programa local", !!(await espera("host", (m) => m.type === "continuar_nova")));
  fila.host.push({ type: "assistant", text: "**oi**" });
  check("evento do programa local chega no painel", !!(await espera("panel", (m) => m.type === "assistant" && m.text === "**oi**")));

  console.log("\n# Confirmação do navegador na conversa (sessão do painel)");
  const popupsAntes = popups.length;
  let id = ferramenta("tab_new", { url: LOJA });
  let pedido = await espera("panel", (m) => m.type === "confirm_request" && m.details.url === LOJA);
  check("abrir aba pelo painel pede confirmação NA CONVERSA", !!pedido && pedido.details.windowHost === "loja.teste", JSON.stringify(pedido));
  check("...e não na janelinha", popups.length === popupsAntes);
  fila.panel.push({ type: "confirm_answer", id: pedido?.id, decision: "window" });
  let r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("aprovado: ferramenta roda e devolve os sites lidos", r?.ok === true && r.hosts?.includes("loja.teste"), JSON.stringify(r));
  check("painel vê o cartão fechar", !!(await espera("panel", (m) => m.type === "confirm_close" && m.id === pedido?.id && m.decision === "window")));
  const tab = r?.result?.tabId;

  id = ferramenta("click", { tabId: tab, selector: "#q" });
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("com 'agir por N min' na conversa, clique no mesmo site passa", r?.ok === true && !recebido.panel.some((m) => m.type === "confirm_request" && m !== pedido), JSON.stringify(r));

  respostaPopup = ["deny"];
  const t = await call("click", { tabId: tab, selector: "#q" });
  check("a aprovação do painel NÃO vale pro Claude do terminal (pergunta na janelinha)", t.err && /NEGOU/.test(t.text) && popups.length === popupsAntes + 1, t.text);

  id = ferramenta("type", { tabId: tab, selector: "#fx", text: "segredo", submit: true });
  pedido = await espera("panel", (m) => m.type === "confirm_request" && m.details.kind === "envio");
  check("envio de formulário pergunta na conversa, mostrando o texto, sem 'por N min'",
    pedido?.details.text === "segredo" && pedido?.details.windowHost === null, JSON.stringify(pedido));
  fila.panel.push({ type: "confirm_answer", id: pedido?.id, decision: "deny" });
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("negado na conversa: ferramenta falha com código 'negado'", r?.ok === false && r.code === "negado", JSON.stringify(r));

  id = ferramenta("constructor", {});
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("comando com nome de propriedade do Object é recusado", r?.ok === false && /desconhecido/.test(r.error), JSON.stringify(r));

  console.log("\n# Aba ativa: o painel lê sem clique; agir continua exigindo a aba liberada");
  let desde = recebido.panel.length;
  const novoEstado = (teste, ms) => espera("panel", (m) => m.type === "aba_estado" && recebido.panel.indexOf(m) >= desde && teste(m), ms);
  const resultado = async (cmd, params) => {
    const i = ferramenta(cmd, params);
    return espera("host", (m) => m.type === "tool_result" && m.id === i);
  };
  const abaSolta = async (url) => {
    desde = recebido.panel.length;
    respostaPopup = ["once"];
    await call("tab_new", { url: LOJA + "__aba-solta?url=" + encodeURIComponent(url) });
  };
  await abaSolta(LOJA + "outra.html");
  let e = await novoEstado((m) => m.legivel && !m.liberada && m.host === "loja.teste");
  check("aba ativa não liberada de site permitido: painel recebe 'legível, não liberada', sem título nem URL",
    !!e && !("title" in e) && !("url" in e) && e.motivo === null, JSON.stringify(e));
  const abaA = e?.tabId;
  r = await resultado("read_page", { tabId: abaA });
  check("painel lê a aba ativa sem clique no ícone", r?.ok === true && /outra\.html/.test(r.result?.url), JSON.stringify(r).slice(0, 300));
  r = await resultado("screenshot", { tabId: abaA });
  check("print na aba ativa emprestada esbarra só no gesto do Firefox (activeTab), não na liberação", r?.ok === false && r.code === "print", JSON.stringify(r).slice(0, 300));
  r = await resultado("tabs_list", {});
  const naLista = r?.result?.tabs?.find((t) => t.tabId === abaA);
  check("tabs_list do painel inclui a aba ativa como 'só leitura' e 'a que o usuário está olhando'", naLista?.soLeitura === true && naLista?.frente === true &&
    !r.result.ativa, JSON.stringify(r?.result).slice(0, 400));
  r = await resultado("aba_ativa", {});
  check("aba_ativa: legível, com id e site", r?.ok && r.result.legivel === true && r.result.tabId === abaA && r.result.host === "loja.teste" &&
    r.result.liberada === false, JSON.stringify(r));
  const tA = await call("read_page", { tabId: abaA });
  check("o Claude do terminal não lê a aba ativa sem ela ser liberada", tA.err && /não está liberada/.test(tA.text), tA.text);
  check("...e a orientação é o menu do ícone (não mais 'clique no ícone')", /botão direito no ícone do Claude → marque 'Claude pode agir nesta aba'/.test(tA.text) &&
    !/clicar no ícone|clique no ícone/.test(tA.text), tA.text);
  desde = recebido.panel.length;
  r = await resultado("click", { tabId: abaA, selector: "body" });
  check("agir na aba ativa emprestada NÃO passa (código nao_liberada)", r?.ok === false && r.code === "nao_liberada", JSON.stringify(r));
  e = await novoEstado((m) => m.tabId === abaA && m.pedirAba === true);
  check("...e o painel recebe o pedido pra mostrar 'Liberar esta aba'", !!e, JSON.stringify(recebido.panel.filter((m) => m.type === "aba_estado").slice(-3)));

  await abaSolta("http://outro.teste:8765/");
  e = await novoEstado((m) => m.motivo === "fora_da_lista");
  check("aba ativa de site fora da lista: motivo e host (pro botão 'Permitir este site'), sem título nem URL",
    e?.host === "outro.teste" && e.legivel === false && !("title" in e) && !("url" in e), JSON.stringify(e));
  const abaB = e?.tabId;
  r = await resultado("tabs_list", {});
  check("tabs_list do painel com a aba ativa fora da lista: só o motivo, sem título nem URL nem id",
    r?.result?.ativa?.motivo === "fora_da_lista" && !r.result.tabs.some((t) => t.tabId === abaB || /^http:\/\/outro\.teste/.test(t.url)),
    JSON.stringify(r?.result).slice(0, 400));
  const tl = await call("tabs_list");
  check("tabs_list do terminal diz que a aba da frente não está legível, sem o site", /NÃO está legível/.test(tl.text) && !/\| http:\/\/outro\.teste/.test(tl.text), tl.text.slice(-400));
  r = await resultado("aba_ativa", {});
  check("aba_ativa: ilegível, só o motivo", r?.ok && JSON.stringify(r.result) === JSON.stringify({ legivel: false, motivo: "fora_da_lista" }), JSON.stringify(r));
  r = await resultado("read_page", { tabId: abaB });
  check("painel não lê site fora da lista, mesmo na aba ativa (código fora_da_lista)", r?.ok === false && r.code === "fora_da_lista", JSON.stringify(r));
  r = await resultado("read_page", { tabId: abaA });
  check("aba que deixou de ser a ativa (e não foi liberada) não é mais legível", r?.ok === false && r.code === "nao_liberada", JSON.stringify(r));
  desde = recebido.panel.length;
  fila.panel.push({ type: "liberar_aba", tabId: abaB });
  const liberouB = await novoEstado((m) => m.tabId === abaB && m.liberada, 2500);
  check("'liberar_aba' do painel não libera site que o Firefox não permitiu", !liberouB, JSON.stringify(liberouB));

  await abaSolta("http://127.0.0.1:8765/");
  e = await novoEstado((m) => m.motivo === "rede_local");
  check("aba ativa de rede local: motivo, sem host", !!e && e.host === null && e.legivel === false, JSON.stringify(e));

  await abaSolta(LOJA);
  e = await novoEstado((m) => m.legivel && !m.liberada && m.host === "loja.teste");
  const abaD = e?.tabId;
  desde = recebido.panel.length;
  fila.panel.push({ type: "liberar_aba", tabId: abaD });
  e = await novoEstado((m) => m.tabId === abaD && m.liberada);
  check("'Liberar esta aba' no painel libera a aba ativa de site permitido", !!e, JSON.stringify(recebido.panel.filter((m) => m.type === "aba_estado").slice(-3)));
  // (o tabs_list do painel leu títulos de outro site: a aprovação por tarefa de loja.teste já caiu)
  id = ferramenta("click", { tabId: abaD, selector: "#q" });
  pedido = await espera("panel", (m) => m.type === "confirm_request" && m.details.action === "clicar" && recebido.panel.indexOf(m) >= desde);
  check("aba liberada pelo painel: clicar pede confirmação na conversa", pedido?.details.host === "loja.teste", JSON.stringify(pedido));
  fila.panel.push({ type: "confirm_answer", id: pedido?.id, decision: "once" });
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("...e aprovado, roda", r?.ok === true, JSON.stringify(r));
  id = ferramenta("type", { tabId: abaD, selector: "#fx", text: "oi", submit: true });
  pedido = await espera("panel", (m) => m.type === "confirm_request" && m.details.kind === "envio" && m.details.text === "oi");
  check("aba liberada pelo painel: envio continua pedindo confirmação", !!pedido, JSON.stringify(pedido));
  fila.panel.push({ type: "confirm_answer", id: pedido?.id, decision: "deny" });
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("...e negar funciona", r?.code === "negado", JSON.stringify(r));

  console.log("\n# Menu do ícone: revogar a aba");
  // (a abaD foi liberada pelo painel lá em cima)
  respostaPopup = ["once"];
  await call("tab_new", { url: LOJA + "__menu-aba?tab=" + abaD });
  await sleep(800);
  r = await resultado("click", { tabId: abaD, selector: "#q" });
  check("desmarcar 'Claude pode agir nesta aba' (menu do ícone): a aba deixa de estar liberada pra agir", r?.ok === false && r.code === "nao_liberada", JSON.stringify(r));

  console.log("\n# Apontar na página o que o Claude lê (elemento ou seleção)");
  id = ferramenta("tab_new", { url: LOJA + "apontar.html" });
  pedido = await espera("panel", (m) => m.type === "confirm_request" && m.details.url === LOJA + "apontar.html");
  fila.panel.push({ type: "confirm_answer", id: pedido?.id, decision: "once" });
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  const abaP = r?.result?.tabId;
  const gancho = async (caminho) => {
    respostaPopup = ["once"];
    await call("tab_new", { url: LOJA + caminho });
  };
  let desdeP = recebido.panel.length;
  const doPainel = (teste) => espera("panel", (m) => recebido.panel.indexOf(m) >= desdeP && teste(m));
  await gancho(`__apontar?tab=${abaP}&sel=%23cartao`);
  let anexo = await doPainel((m) => m.type === "anexo");
  check("elemento escolhido: o painel recebe rótulo, site, tamanho e prévia (sem o texto escondido)",
    anexo?.tipo === "elemento" && anexo.rotulo === "div#cartao.card.destaque" && anexo.host === "loja.teste" && anexo.chars > 20 &&
    /texto-visivel-do-cartao/.test(anexo.previa) && !/segredo/.test(anexo.previa), JSON.stringify(anexo));
  let desdeH = recebido.host.length;
  fila.panel.push({ type: "send", text: "o que diz aí?", anexos: [anexo?.id, "id-inventado"] });
  let envio = await espera("host", (m) => recebido.host.indexOf(m) >= desdeH && m.type === "send");
  const a1 = envio?.anexos?.[0];
  check("mandar: o conteúdo vai pro programa local junto da mensagem (id inventado não vira nada)", envio?.anexos?.length === 1 &&
    a1.tipo === "elemento" && a1.host === "loja.teste" && /apontar\.html$/.test(a1.url) && /Cartão escolhido/.test(a1.texto), JSON.stringify(envio).slice(0, 400));
  check("...só o elemento, sem o texto escondido (display:none, aria-hidden) e com a senha mascarada",
    /texto-visivel-do-cartao/.test(a1?.texto) && !/texto-fora-do-cartao|segredo|senha-de-verdade/.test(a1?.texto), a1?.texto);
  desdeH = recebido.host.length;
  fila.panel.push({ type: "send", text: "de novo", anexos: [anexo?.id] });
  envio = await espera("host", (m) => recebido.host.indexOf(m) >= desdeH && m.type === "send");
  check("cada trecho vai uma vez só", envio?.anexos?.length === 0, JSON.stringify(envio));

  desdeP = recebido.panel.length;
  await gancho(`__selecionar?tab=${abaP}&sel=%23frase`);
  anexo = await doPainel((m) => m.type === "anexo");
  desdeH = recebido.host.length;
  fila.panel.push({ type: "send", text: "e isso?", anexos: [anexo?.id] });
  envio = await espera("host", (m) => recebido.host.indexOf(m) >= desdeH && m.type === "send");
  const a2 = envio?.anexos?.[0];
  check("seleção: só o trecho selecionado, sem o escondido dentro dele", anexo?.tipo === "selecao" && /começo da frase meio-selecionado fim da frase/.test(a2?.texto) &&
    !/segredo|texto-fora|Cartão/.test(a2?.texto), JSON.stringify(a2));

  desdeP = recebido.panel.length;
  await gancho(`__apontar?tab=${abaP}&sel=%23vazio`);
  let falha = await doPainel((m) => m.type === "anexo_falhou");
  check("elemento só com texto escondido: avisa que não tem texto visível", /não tem texto visível/.test(falha?.message), JSON.stringify(falha));
  desdeP = recebido.panel.length;
  await gancho(`__apontar?tab=${abaB}&sel=body`);
  falha = await doPainel((m) => m.type === "anexo_falhou" || m.type === "anexo");
  check("site fora da lista: não lê, e diz pra permitir", falha?.type === "anexo_falhou" && /não está na lista de sites permitidos/.test(falha.message), JSON.stringify(falha));

  console.log("\n# Painel fechado");
  id = ferramenta("navigate", { tabId: tab, url: "http://permitido2.teste:8765/" });
  pedido = await espera("panel", (m) => m.type === "confirm_request" && m.details.kind === "outro");
  check("ir pra outro site pergunta na conversa", !!pedido);
  fila.panel.push({ __fechar: true });
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("fechar o painel com pedido pendente = negado", r?.ok === false && r.code === "negado", JSON.stringify(r));
  const antes2 = popups.length;
  respostaPopup = ["deny"];
  id = ferramenta("type", { tabId: tab, selector: "#fx", text: "x", submit: true });
  r = await espera("host", (m) => m.type === "tool_result" && m.id === id);
  check("sem painel aberto, o pedido do Claude do painel cai na janelinha", popups.length === antes2 + 1 && r?.code === "negado", JSON.stringify(r));
} catch (e) {
  check("sem erro inesperado", false, e.stack || e);
}

await c.close();
srv.close();
console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} FALHARAM` : ""}`);
process.exit(falhas ? 1 : 0);
