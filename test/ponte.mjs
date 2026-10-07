// Teste da ponte WebSocket (M1): Origin exata, token nos dois sentidos, segunda conexão recusada.
// Roda com ./test/run.sh, depois do seguranca.mjs, no mesmo Firefox de teste.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import WebSocket, { WebSocketServer } from "../server/node_modules/ws/wrapper.mjs";
import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const PORT = Number(process.env.CLAUDE_FIREFOX_PORT);
const URL_WS = `ws://127.0.0.1:${PORT}`;
const TOKEN = fs.readFileSync(process.env.CLAUDE_FIREFOX_TOKEN_FILE, "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let total = 0;
let falhas = 0;
function check(nome, ok, detalhe = "") {
  total++;
  if (!ok) falhas++;
  console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : `\n         -> ${String(detalhe).replace(/^\[Conteúdo vindo do Firefox[^\]]*\]\s*/, "").replace(/\s+/g, " ").slice(0, 400)}`}`);
}

// Qualquer pedido de confirmação ou visita a /__squatter = a extensão obedeceu um servidor falso.
const visitas = [];
const srv = http.createServer((req, res) => {
  visitas.push(req.url);
  res.end(req.url === "/__confirm" ? "deny" : "ok");
});
await new Promise((r) => srv.listen(8765, "127.0.0.1", r));

function prefsUuid() {
  const prefs = fs.readFileSync(path.join(process.env.CLAUDE_FIREFOX_PROFILE, "prefs.js"), "utf8");
  const m = /user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\);/.exec(prefs);
  return JSON.parse(JSON.parse(`"${m[1]}"`))["claude-firefox@local"];
}
const ORIGIN = `moz-extension://${prefsUuid()}`;

async function startMcp(env = {}) {
  const c = new Client({ name: "teste-ponte", version: "0" });
  await c.connect(new StdioClientTransport({
    command: "node",
    args: [new URL("../server/index.js", import.meta.url).pathname],
    env: { ...process.env, ...env },
    stderr: process.env.TEST_SERVER_LOG ? "inherit" : "ignore", // TEST_SERVER_LOG=1 mostra o log do servidor
  }));
  return c;
}
const tabsList = async (c) => {
  const r = await c.callTool({ name: "tabs_list", arguments: {} });
  return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};
async function esperaConectar(c, ms = 15000) {
  for (let t = 0; t < ms; t += 500) {
    if (!(await tabsList(c)).err) return true;
    await sleep(500);
  }
  return false;
}

// Tenta conectar como cliente; devolve como terminou.
function tentar(headers, onOpen) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL_WS, { headers });
    const msgs = [];
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.on("open", () => onOpen?.(ws, msgs));
    ws.on("message", (d) => msgs.push(JSON.parse(d.toString())));
    ws.on("close", (code) => resolve({ closed: code, msgs }));
    ws.on("error", () => {});
    setTimeout(() => {
      ws.terminate();
      resolve({ timeout: true, msgs });
    }, 8000);
  });
}

// Servidor falso na porta da extensão: registra tudo que a extensão manda.
async function servidorFalso(nome, comportamento, ms = 9000) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
  const recebidas = [];
  let conexoes = 0;
  let fechouPelaExtensao = false;
  wss.on("connection", (ws) => {
    conexoes++;
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      recebidas.push(m);
      comportamento.onMessage?.(ws, m);
    });
    ws.on("close", () => (fechouPelaExtensao = true));
    comportamento.onConnect(ws);
  });
  await sleep(ms);
  await new Promise((r) => {
    for (const cl of wss.clients) cl.terminate();
    wss.close(r);
  });
  return { recebidas, conexoes, fechouPelaExtensao };
}

// ---------- Fase 1: servidor de verdade, extensão conectada ----------
console.log("\n# Servidor de verdade com a extensão conectada");
let c = await startMcp();
check("extensão conecta e autentica com o token", await esperaConectar(c));
let r = await tentar({ Origin: "http://loja.teste:8765" });
check("Origin de site: recusada (403)", r.status === 403, JSON.stringify(r));
r = await tentar({ Origin: `moz-extension://${crypto.randomUUID()}` });
check("Origin de outra extensão: recusada (403)", r.status === 403, JSON.stringify(r));
r = await tentar({});
check("sem Origin: recusada (403)", r.status === 403, JSON.stringify(r));
r = await tentar({ Origin: ORIGIN });
check("Origin certa com extensão já conectada: recusada (409), sem derrubar a primeira", r.status === 409, JSON.stringify(r));
check("extensão continua conectada e funcionando", !(await tabsList(c)).err);
await c.close();
await sleep(1000);

// ---------- Fase 2: servidor falso sem token ----------
console.log("\n# Servidor falso ocupando a porta (sem conhecer o token)");
let f = await servidorFalso("comando direto", {
  onConnect: (ws) => ws.send(JSON.stringify({ id: 1, cmd: "tab_new", params: { url: "http://loja.teste:8765/__squatter" } })),
});
check("extensão tentou conectar no servidor falso", f.conexoes >= 1, JSON.stringify(f));
check("comando sem handshake: extensão não responde e fecha", f.recebidas.length === 0 && f.fechouPelaExtensao, JSON.stringify(f));

f = await servidorFalso("handshake com prova falsa", {
  onConnect: (ws) => ws.send(JSON.stringify({ type: "hello", nonce: crypto.randomBytes(32).toString("hex") })),
  onMessage: (ws, m) => {
    if (m.type !== "auth") return;
    ws.send(JSON.stringify({ type: "ok", mac: crypto.randomBytes(32).toString("hex") }));
    ws.send(JSON.stringify({ id: 2, cmd: "tab_new", params: { url: "http://loja.teste:8765/__squatter" } }));
  },
});
const auths = f.recebidas.filter((m) => m.type === "auth");
check("extensão responde o desafio só com nonce e HMAC", auths.length >= 1 && auths.every((m) => Object.keys(m).sort().join() === "mac,nonce,type"),
  JSON.stringify(f.recebidas));
check("o token nunca trafega", !JSON.stringify(f.recebidas).includes(TOKEN));
check("prova falsa do servidor: extensão não executa nada", f.recebidas.every((m) => m.type === "auth") && f.fechouPelaExtensao,
  JSON.stringify(f.recebidas));
check("nenhum comando do servidor falso chegou a rodar", !visitas.some((v) => v.includes("__squatter") || v === "/__confirm"), visitas.join(" "));

// ---------- Fase 3: servidor de verdade com token errado ----------
console.log("\n# Servidor de verdade com outro token");
const tokenErrado = path.join(path.dirname(process.env.CLAUDE_FIREFOX_TOKEN_FILE), "token-errado");
fs.writeFileSync(tokenErrado, crypto.randomBytes(32).toString("hex"));
c = await startMcp({ CLAUDE_FIREFOX_TOKEN_FILE: tokenErrado });
check("extensão com token diferente não autentica", !(await esperaConectar(c, 8000)));
r = await tentar({ Origin: ORIGIN }, (ws, msgs) => {
  const tryAuth = () => {
    const hello = msgs.find((m) => m.type === "hello");
    if (!hello) return setTimeout(tryAuth, 50);
    ws.send(JSON.stringify({ type: "auth", nonce: crypto.randomBytes(32).toString("hex"), mac: crypto.randomBytes(32).toString("hex") }));
  };
  tryAuth();
});
check("cliente com Origin forjada e HMAC errado: fechado (4001) ou recusado", r.closed === 4001 || r.status === 409, JSON.stringify(r));
await c.close();
await sleep(1000);

// ---------- Fase 4: volta ao normal ----------
console.log("\n# Servidor de verdade de novo");
c = await startMcp();
check("extensão reconecta sozinha", await esperaConectar(c));
await c.close();
await sleep(1000);

// ---------- Fase 5 (M4): não dá pra gravar a marca da sessão ----------
console.log("\n# Marca da sessão não pode ser gravada (M4)");
c = await startMcp({ XDG_RUNTIME_DIR: process.env.CLAUDE_FIREFOX_TOKEN_FILE }); // é um arquivo: mkdir falha com ENOTDIR
let lista;
for (let t = 0; t < 15000; t += 500) {
  lista = await tabsList(c);
  if (!/não está conectada/.test(lista.text)) break;
  await sleep(500);
}
check("sem marca, tabs_list não devolve títulos/URLs", lista.err && /Não consegui marcar a sessão/.test(lista.text) && !/loja\.teste|Loja/.test(lista.text),
  lista.text);
const erroExt = await c.callTool({ name: "read_page", arguments: { tabId: 999999 } });
const textoErro = erroExt.content.map((x) => x.text).join("\n");
check("sem marca, erro da extensão vem sem detalhes", erroExt.isError && /detalhes .* foram omitidos/.test(textoErro), textoErro);
await c.close();
srv.close();
console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} FALHARAM` : ""}`);
process.exit(falhas ? 1 : 0);
