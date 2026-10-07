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
