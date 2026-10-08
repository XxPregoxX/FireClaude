// Integração do programa do painel com o Claude Code DE VERDADE (gasta um pouco de uso do seu plano; modelo Haiku).
// Este script faz o papel do Firefox + extensão: fala native messaging com chat/host.mjs, responde as ferramentas
// do navegador com dados falsos e clica nos cartões de aprovação. Sem Firefox. Uso: node test/chat-integracao.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { encodeFrame, frameReader } from "../chat/host.mjs";

const free = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync("/proc/meminfo", "utf8"))[1]) / 1024;
if (free < 1000) {
  console.log(`Só ${Math.round(free)} MB livres; precisa de 1000 (o Claude Code usa uns 300 MB).`);
  process.exit(1);
}

const base = fs.mkdtempSync(path.join(os.homedir(), ".cache", "claude-firefox-teste-"));
const work = path.join(base, "projeto");
const conf = path.join(base, "config");
const run = path.join(base, "run");
fs.mkdirSync(path.join(work, ".claude"), { recursive: true });
fs.mkdirSync(conf);
fs.mkdirSync(run, { mode: 0o700 });
fs.writeFileSync(path.join(work, "README.md"), "projeto de teste\n");
// Regra "sempre permitir" já existente nas configurações do projeto: depois da marca, a trava tem que perguntar mesmo assim.
fs.writeFileSync(path.join(work, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(node --version)"] } }));
const fora = path.join(base, "fora.txt");
const marcas = path.join(run, "claude-firefox");
const taints = () => (fs.existsSync(marcas) ? fs.readdirSync(marcas).filter((f) => f.startsWith("taint-")) : []);

const host = spawn("node", [new URL("../chat/host.mjs", import.meta.url).pathname], {
  env: { ...process.env, XDG_CONFIG_HOME: conf, XDG_RUNTIME_DIR: run, CLAUDE_FIREFOX_CHAT_MODEL: "claude-haiku-4-5-20251001" },
  stdio: ["pipe", "pipe", "inherit"],
});
const eventos = [];
let esperando = null;
host.stdout.on("data", frameReader((m) => {
  eventos.push(m);
  if (m.type === "tool") {
    // Extensão falsa: tabs_list devolve uma aba de um site qualquer (isso é "conteúdo de página").
    // aba_ativa (vai junto de toda mensagem) não lê conteúdo: não devolve site lido.
    const RESPOSTAS = {
      tabs_list: { tabs: [{ tabId: 7, title: "Página de teste", url: "http://exemplo.teste/", active: true, frente: true }], otherTabsHidden: 0 },
      aba_ativa: { legivel: true, tabId: 7, host: "exemplo.teste", liberada: false },
      read_page: { url: "http://exemplo.teste/", title: "Página de teste", viewport: { w: 1000, h: 700 }, scroll: { y: 0, max: 0 },
        text: "# Feira\nPromoção de abacaxi: 3 por 10 reais.", truncated: false, hiddenBlocksSkipped: 0, caixa: null },
    };
    const reply = Object.hasOwn(RESPOSTAS, m.cmd) ? { ok: true, result: RESPOSTAS[m.cmd] } : { ok: false, error: "não implementado no teste", code: null };
    host.stdin.write(encodeFrame({ type: "tool_result", id: m.id, hosts: m.cmd === "aba_ativa" ? [] : ["exemplo.teste"], ...reply }));
  }
  if (m.type === "permission_request") {
    const d = respostas.shift() || "deny";
    m.respondido = d;
    host.stdin.write(encodeFrame({ type: "permission_answer", id: m.id, decision: d }));
  }
  if (esperando && esperando.test(m)) {
    const r = esperando.resolve;
    esperando = null;
    r(m);
  }
}));
const send = (m) => host.stdin.write(encodeFrame(m));
const espera = (test, ms = 120000) => new Promise((resolve, reject) => {
  esperando = { test, resolve };
  setTimeout(() => reject(new Error("tempo esgotado esperando o programa do painel")), ms);
});
let respostas = [];

let total = 0;
let falhas = 0;
function check(nome, ok, detalhe = "") {
  total++;
  if (!ok) falhas++;
  console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : `\n         -> ${String(detalhe).replace(/\s+/g, " ").slice(0, 400)}`}`);
}

let sessionId = null;
// Manda uma mensagem e devolve os eventos até o Claude terminar.
async function turno(texto, fila = []) {
  respostas = [...fila];
  const n = eventos.length;
  send({ type: "send", sessionId, text: texto });
  await espera((m) => m.type === "busy" && m.value === false);
  const novos = eventos.slice(n);
  const s = novos.find((m) => m.type === "session");
  if (s) sessionId = s.sessionId;
  return novos;
}
const pedidos = (ev) => ev.filter((m) => m.type === "permission_request");

try {
  send({ type: "config", workdir: work });
  await espera((m) => m.type === "ready");
  await new Promise((r) => setTimeout(r, 300));
  const mod0 = eventos.find((m) => m.type === "modelo");
  check("seletor de modelo já aparece antes da primeira mensagem, com os modelos e descrições", mod0?.modelos?.length === 3 &&
    mod0.modelos.every((x) => x.id && x.nome && x.descricao) && mod0.modelo === "claude-sonnet-5-5", JSON.stringify(mod0));

  console.log("# Conversa simples");
  let ev = await turno("Responda só com a palavra: banana");
  check("abre sessão nova", !!sessionId, JSON.stringify(ev.slice(0, 3)));
  check("resposta chega (texto)", ev.some((m) => m.type === "assistant" && /banana/i.test(m.text)), JSON.stringify(ev.filter((m) => m.type !== "delta")));
  check("resposta chega em pedaços (streaming)", ev.some((m) => m.type === "delta"));
  for (let t = 0; t < 40 && !eventos.some((m) => m.type === "session" && m.title !== "Responda só com a palavra: banana"); t++) await new Promise((r) => setTimeout(r, 500));
  const tit = eventos.filter((m) => m.type === "session").at(-1)?.title;
  check("título curto pelo modelo auxiliar depois da 1ª resposta", !!tit && tit !== "Responda só com a palavra: banana" && tit.length <= 60, tit);
  const usoEv = eventos.filter((m) => m.type === "uso").at(-1);
  check("gasto da conversa chega no painel: modelo principal e auxiliar, com tokens e custo", usoEv?.custo > 0 && usoEv.modelos?.[0]?.chamadas >= 1 &&
    usoEv.modelos[0].lidos > 1000 && usoEv.auxiliar?.chamadas >= 1, JSON.stringify(usoEv).slice(0, 400));
  check("situação do plano (assinatura) chega junto", typeof usoEv?.plano?.semana?.pct === "number" && typeof usoEv?.plano?.cinco?.pct === "number", JSON.stringify(usoEv?.plano));

  console.log("\n# Antes da marca: permissões normais do Claude Code");
  ev = await turno(`Use a ferramenta Bash pra rodar exatamente este comando, sem mudar nada: touch ${fora}`, ["deny"]);
  let p = pedidos(ev);
  check("comando fora da pasta pede aprovação no painel", p.length >= 1 && p[0].summary.includes("touch"), JSON.stringify(p));
  check("antes da marca oferece 'sempre permitir'", p[0]?.canAlways === true && p[0]?.tainted === false, JSON.stringify(p[0]));
  check("negado: o arquivo não foi criado", !fs.existsSync(fora));
  const CMD = 'node -e "console.log(6*7)"';
  ev = await turno(`Use a ferramenta Bash pra rodar exatamente: ${CMD}`, ["always"]);
  check("'sempre permitir' aceito", pedidos(ev).length === 1 && pedidos(ev)[0].respondido === "always", JSON.stringify(pedidos(ev)));
  ev = await turno(`Use a ferramenta Bash pra rodar exatamente de novo: ${CMD}`);
  check("depois do 'sempre', o mesmo comando não pergunta (ainda sem marca)", pedidos(ev).length === 0, JSON.stringify(pedidos(ev)));
  ev = await turno("Use a ferramenta Bash pra rodar exatamente: node --version");
  check("regra de permissão do projeto vale antes da marca", pedidos(ev).length === 0, JSON.stringify(pedidos(ev)));

  console.log("\n# Saída grande numa conversa que não leu página");
  ev = await turno('Use a ferramenta Bash pra rodar exatamente: python3 -c "print(\'c\'*20000)" e depois responda só: feito', ["allow"]);
  check("resumo do modelo auxiliar sem bloco de página nem alarme", (() => {
    const tr = fs.readdirSync(path.join(os.homedir(), ".claude", "projects")).map((d) => path.join(os.homedir(), ".claude", "projects", d, `${sessionId}.jsonl`)).find((f) => fs.existsSync(f));
    const rs = tr ? fs.readFileSync(tr, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      const c = JSON.parse(l).message?.content;
      return Array.isArray(c) ? c.filter((b) => b.type === "tool_result") : [];
    }) : [];
    const u = rs.at(-1);
    const t = u ? (typeof u.content === "string" ? u.content : u.content.map((x) => x.text || "").join("")) : "";
    return /resumida pelo modelo auxiliar/.test(t) && !/CONTEUDO_EXTERNO|🚨/.test(t);
  })());

  console.log("\n# A marca entra quando lê página");
  check("ainda sem marca (nem depois da saída grande resumida)", taints().length === 0, taints().join(" "));
  ev = await turno("Use a ferramenta mcp__claude-firefox__tabs_list e me diga o título da aba.");
  check("ferramenta do navegador passa pela ponte nativa", ev.some((m) => m.type === "tool" && m.cmd === "tabs_list"), JSON.stringify(ev.filter((m) => m.type !== "delta")));
  check("ferramentas do navegador já carregadas: nada de ToolSearch", !ev.some((m) => m.type === "tool_use" && /ToolSearch/.test(m.name)),
    JSON.stringify(ev.filter((m) => m.type === "tool_use")));
  check("cada mensagem pergunta a aba ativa à extensão (bloco <aba-ativa>)", ev.some((m) => m.type === "tool" && m.cmd === "aba_ativa"));
  check("painel avisa que a conversa foi marcada", ev.some((m) => m.type === "marked" && m.hosts.includes("exemplo.teste")));
  const taint = taints()[0];
  check("marca gravada pro PID do claude do painel", !!taint && fs.readFileSync(path.join(marcas, taint), "utf8").includes("exemplo.teste"), taints().join(" "));

  ev = await turno("O que tem nessa página?");
  const leu = ev.find((m) => m.type === "tool" && m.cmd === "read_page");
  check("'nessa página': lê direto a aba do bloco <aba-ativa>, sem ToolSearch", leu?.params?.tabId === 7 &&
    !ev.some((m) => m.type === "tool_use" && /ToolSearch/.test(m.name)), JSON.stringify(ev.filter((m) => m.type === "tool" || m.type === "tool_use")));
  check("...e responde com o que leu", ev.some((m) => m.type === "assistant" && /abacaxi/i.test(m.text)), JSON.stringify(ev.filter((m) => m.type === "assistant")));

  console.log("\n# Depois da marca");
  ev = await turno("Use a ferramenta Write pra criar o arquivo notas.txt na pasta atual com o texto: oi");
  check("criar arquivo na pasta passa sem perguntar", pedidos(ev).length === 0 && fs.existsSync(path.join(work, "notas.txt")), JSON.stringify(pedidos(ev)));
  ev = await turno(`Use a ferramenta Bash pra rodar exatamente: ${CMD}`, ["allow"]);
  p = pedidos(ev);
  check("'sempre permitir' fica suspenso depois da marca", p.length === 1 && p[0].canAlways === false && p[0].tainted === true, JSON.stringify(p));
  check("pedido mostra os sites lidos", /exemplo\.teste/.test(p[0]?.reason || ""), p[0]?.reason);
  ev = await turno("Use a ferramenta Bash pra rodar exatamente: node --version", ["allow"]);
  check("regra 'sempre permitir' do projeto NÃO passa por cima da trava", pedidos(ev).length === 1, JSON.stringify(pedidos(ev)));
  ev = await turno('Use a ferramenta Write pra criar o arquivo .claude/settings.local.json com o conteúdo {"hooks":{}}', ["deny"]);
  check("escrever em .claude pede aprovação", pedidos(ev).length >= 1, JSON.stringify(pedidos(ev)));
  check("negado: settings.local.json continua o original", fs.readFileSync(path.join(work, ".claude", "settings.local.json"), "utf8").includes("node --version"));

  console.log("\n# Histórico");
  send({ type: "rename", sessionId, title: "Teste de integração" });
  let l = await espera((m) => m.type === "list");
  check("renomear aparece na lista", l.sessions.some((s) => s.sessionId === sessionId && s.title === "Teste de integração"), JSON.stringify(l));
  send({ type: "new" });
  send({ type: "open", sessionId });
  const hist = await espera((m) => m.type === "history");
  check("retomar mostra as mensagens anteriores", hist.messages.some((m) => m.role === "user" && /banana/.test(m.text)) && hist.marked === true,
    JSON.stringify(hist).slice(0, 300));
  console.log("\n# Saída de comando grande");
  ev = await turno('Use a ferramenta Bash pra rodar exatamente: python3 -c "print(\'b\'*20000)" e depois responda só: feito', ["allow"]);
  const transcrito = fs.readdirSync(path.join(os.homedir(), ".claude", "projects"))
    .map((d) => path.join(os.homedir(), ".claude", "projects", d, `${sessionId}.jsonl`)).find((f) => fs.existsSync(f));
  const resultados = transcrito ? fs.readFileSync(transcrito, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    const c = JSON.parse(l).message?.content;
    return Array.isArray(c) ? c.filter((b) => b.type === "tool_result") : [];
  }) : [];
  const ultimo = resultados.at(-1);
  const texto = ultimo ? (typeof ultimo.content === "string" ? ultimo.content : ultimo.content.map((x) => x.text || "").join("")) : "";
  const arqCompleto = /A saída completa está em (\S+) /.exec(texto)?.[1];
  check("saída de 20k não entra inteira: resumo do modelo auxiliar (Haiku 5.5) + arquivo com a saída completa",
    texto.length > 0 && texto.length < 4000 && /resumida pelo modelo auxiliar claude-haiku-5-5/.test(texto) && /<<<CONTEUDO_EXTERNO/.test(texto) && !!arqCompleto &&
    fs.existsSync(arqCompleto) && fs.readFileSync(arqCompleto, "utf8").length >= 20000, `${texto.length} caracteres: ${texto.slice(0, 300)}`);

  ev = await turno("Responda só com a palavra: laranja");
  check("conversa retomada continua (mesma sessão)", ev.some((m) => m.type === "assistant" && /laranja/i.test(m.text)));
  check("conversa retomada já começa marcada", taints().length >= 2, taints().join(" "));
  console.log("\n# Continuar em conversa nova");
  const antiga = sessionId;
  const n0 = eventos.length;
  send({ type: "continuar_nova" });
  const cont = await espera((m) => m.type === "continuada" || m.type === "error");
  check("gera um resumo e abre conversa nova", cont.type === "continuada" && cont.resumo.length > 20, JSON.stringify(cont).slice(0, 300));
  check("o pedido de resumo e a resposta não aparecem como conversa no painel",
    !eventos.slice(n0).some((m) => m.type === "assistant" || m.type === "delta" || m.type === "tool_use"), JSON.stringify(eventos.slice(n0).map((m) => m.type)));
  check("tamanho da conversa chega no painel", eventos.some((m) => m.type === "tamanho" && m.tokens > 1000 && m.longa === false));
  sessionId = null;
  ev = await turno("Responda só com a palavra: kiwi");
  const nova = sessionId;
  check("primeira mensagem abre outra sessão", !!nova && nova !== antiga && ev.some((m) => m.type === "assistant" && /kiwi/i.test(m.text)));
  check("a conversa nova já nasce marcada (a antiga tinha lido página)", ev.some((m) => m.type === "marked"), JSON.stringify(ev.map((m) => m.type)));
  const trNova = fs.readdirSync(path.join(os.homedir(), ".claude", "projects"))
    .map((d) => path.join(os.homedir(), ".claude", "projects", d, `${nova}.jsonl`)).find((f) => fs.existsSync(f));
  const primeira = trNova ? fs.readFileSync(trNova, "utf8").split("\n").filter(Boolean).map((x) => JSON.parse(x)).find((x) => x.type === "user") : null;
  check("o resumo vai junto da primeira mensagem da conversa nova", JSON.stringify(primeira?.message?.content || "").includes("<resumo-da-conversa-anterior>"),
    JSON.stringify(primeira?.message?.content || "").slice(0, 300));
  send({ type: "delete", sessionId: nova });
  await espera((m) => m.type === "list");
  sessionId = antiga;

  send({ type: "delete", sessionId });
  l = await espera((m) => m.type === "list");
  check("apagar tira da lista", !l.sessions.some((s) => s.sessionId === sessionId));
} catch (e) {
  check("sem erro inesperado", false, e.stack || e);
} finally {
  host.stdin.end();
  await new Promise((r) => setTimeout(r, 3000));
  host.kill();
  fs.rmSync(base, { recursive: true, force: true });
}
// O Claude Code guarda as sessões por pasta; a do teste não pode ficar pra trás (o "apagar" já devia ter tirado).
const pastaSessoes = path.join(os.homedir(), ".claude", "projects", fs.realpathSync(path.dirname(base)).replace(/[^a-zA-Z0-9]/g, "-") + "-" + path.basename(base).replace(/[^a-zA-Z0-9]/g, "-") + "-projeto");
const sobra = fs.existsSync(pastaSessoes) ? fs.readdirSync(pastaSessoes).filter((f) => f.endsWith(".jsonl")) : [];
check("apagar não deixou registro da conversa no disco", sobra.length === 0, sobra.join(" "));
fs.rmSync(pastaSessoes, { recursive: true, force: true });
console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} FALHARAM` : ""}`);
process.exit(falhas ? 1 : 0);
