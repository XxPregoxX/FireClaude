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
    const reply = m.cmd === "tabs_list"
      ? { ok: true, result: { tabs: [{ tabId: 7, title: "Página de teste", url: "http://exemplo.teste/", active: true }], otherTabsHidden: 0 } }
      : { ok: false, error: "não implementado no teste", code: null };
    host.stdin.write(encodeFrame({ type: "tool_result", id: m.id, hosts: ["exemplo.teste"], ...reply }));
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

  console.log("# Conversa simples");
  let ev = await turno("Responda só com a palavra: banana");
  check("abre sessão nova", !!sessionId, JSON.stringify(ev.slice(0, 3)));
  check("resposta chega (texto)", ev.some((m) => m.type === "assistant" && /banana/i.test(m.text)), JSON.stringify(ev.filter((m) => m.type !== "delta")));
  check("resposta chega em pedaços (streaming)", ev.some((m) => m.type === "delta"));

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

  console.log("\n# A marca entra quando lê página");
  check("ainda sem marca", taints().length === 0, taints().join(" "));
  ev = await turno("Use a ferramenta mcp__claude-firefox__tabs_list e me diga o título da aba.");
  check("ferramenta do navegador passa pela ponte nativa", ev.some((m) => m.type === "tool" && m.cmd === "tabs_list"), JSON.stringify(ev.filter((m) => m.type !== "delta")));
  check("painel avisa que a conversa foi marcada", ev.some((m) => m.type === "marked" && m.hosts.includes("exemplo.teste")));
  const taint = taints()[0];
  check("marca gravada pro PID do claude do painel", !!taint && fs.readFileSync(path.join(marcas, taint), "utf8").includes("exemplo.teste"), taints().join(" "));

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
  ev = await turno("Responda só com a palavra: laranja");
  check("conversa retomada continua (mesma sessão)", ev.some((m) => m.type === "assistant" && /laranja/i.test(m.text)));
  check("conversa retomada já começa marcada", taints().length >= 2, taints().join(" "));
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
