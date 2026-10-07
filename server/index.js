#!/usr/bin/env node
// Servidor MCP (stdio) que repassa comandos pra extensão "Claude no Firefox" via WebSocket local.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ExtensionError, browserTools, instructions } from "./browser-tools.mjs";
import { createSessionMark, findClaudePid } from "./session-mark.mjs";

const PORT = Number(process.env.CLAUDE_FIREFOX_PORT || 47823);
const log = (...a) => console.error("[claude-firefox]", ...a);

const CLAUDE_PID = findClaudePid();
const mark = createSessionMark(() => CLAUDE_PID, log);

// ---------- Ponte WebSocket com a extensão ----------

let socket = null;
const pending = new Map();
let nextId = 1;

// ---------- Autenticação da ponte (M1) ----------
// 1. Origin tem que ser exatamente moz-extension://<UUID que o Firefox deu a esta extensão>, lido do prefs.js
//    (outra extensão do navegador não consegue forjar a Origin).
// 2. Desafio-resposta com HMAC-SHA256 sobre um token gerado na instalação (instalar-extensao.sh), nos dois
//    sentidos: o servidor prova que conhece o token pra extensão e vice-versa. O token nunca trafega.
//    Processo local que forja a Origin não passa daqui sem o token; servidor falso não engana a extensão.
// 3. Já tem extensão autenticada? A conexão nova é recusada, em vez de derrubar a que existe.

const EXTENSION_ID = "claude-firefox@local";
const TOKEN_FILE = process.env.CLAUDE_FIREFOX_TOKEN_FILE || path.join(os.homedir(), ".config", "claude-firefox", "token");

function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, "utf8").trim();
    return /^[0-9a-f]{64}$/.test(t) ? Buffer.from(t, "hex") : null;
  } catch {
    return null;
  }
}

// UUID muda a cada instalação; o Firefox guarda o atual na pref extensions.webextensions.uuids de cada perfil.
function extensionOrigins() {
  const profiles = [];
  for (const root of [path.join(os.homedir(), ".mozilla", "firefox"), path.join(os.homedir(), ".config", "mozilla", "firefox")]) {
    try {
      for (const d of fs.readdirSync(root)) profiles.push(path.join(root, d));
    } catch {}
  }
  if (process.env.CLAUDE_FIREFOX_PROFILE) profiles.push(process.env.CLAUDE_FIREFOX_PROFILE);
  const origins = new Set();
  for (const p of profiles) {
    let prefs;
    try {
      prefs = fs.readFileSync(path.join(p, "prefs.js"), "utf8");
    } catch {
      continue;
    }
    const m = /user_pref\("extensions\.webextensions\.uuids",\s*"((?:[^"\\]|\\.)*)"\);/.exec(prefs);
    if (!m) continue;
    try {
      const uuid = JSON.parse(JSON.parse(`"${m[1]}"`))[EXTENSION_ID];
      if (/^[0-9a-f-]{36}$/.test(uuid)) origins.add(`moz-extension://${uuid}`);
    } catch {}
  }
  return origins;
}

const hmac = (key, text) => crypto.createHmac("sha256", key).update(text).digest();

function listen() {
  const wss = new WebSocketServer({
    host: "127.0.0.1",
    port: PORT,
    verifyClient: ({ origin }, done) => {
      if (typeof origin !== "string" || !extensionOrigins().has(origin)) {
        log(`conexão recusada: Origin ${JSON.stringify(origin)} não é a desta extensão`);
        return done(false, 403);
      }
      if (socket) return done(false, 409, "Ja existe uma extensao conectada");
      done(true);
    },
    maxPayload: 64 * 1024 * 1024,
  });
  wss.on("listening", () => log(`esperando a extensão em ws://127.0.0.1:${PORT}`));
  wss.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      log("porta ocupada (outra sessão do Claude Code está usando a extensão); tento de novo em 5s");
      setTimeout(listen, 5000);
    } else log("erro no WebSocket:", e.message);
  });
  wss.on("connection", (ws) => {
    const token = readToken();
    if (!token) {
      log(`sem token em ${TOKEN_FILE}; rode instalar-extensao.sh`);
      ws.close(4003, "sem token");
      return;
    }
    const serverNonce = crypto.randomBytes(32).toString("hex");
    let authed = false;
    const authTimer = setTimeout(() => ws.terminate(), 5000);
    ws.send(JSON.stringify({ type: "hello", nonce: serverNonce }));

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!authed) {
        const ok =
          msg?.type === "auth" && typeof msg.nonce === "string" && /^[0-9a-f]{64}$/.test(msg.nonce) &&
          typeof msg.mac === "string" && /^[0-9a-f]{64}$/.test(msg.mac) &&
          crypto.timingSafeEqual(Buffer.from(msg.mac, "hex"), hmac(token, `claude-firefox ext ${serverNonce} ${msg.nonce}`));
        if (!ok || socket) {
          log(ok ? "recusada: já existe extensão conectada" : "conexão recusada: token errado");
          ws.close(ok ? 4009 : 4001, ok ? "ja conectado" : "token errado");
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        ws.send(JSON.stringify({ type: "ok", mac: hmac(token, `claude-firefox srv ${msg.nonce} ${serverNonce}`).toString("hex") }));
        socket = ws;
        log("extensão conectada e autenticada");
        return;
      }
      mark.addHosts(msg.hosts);
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.ok ? p.resolve(msg.result) : p.reject(new ExtensionError(msg));
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (socket !== ws) return;
      socket = null;
      // Nada fica pendurado esperando uma extensão que já foi embora.
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("A extensão do Firefox desconectou no meio do comando."));
      }
      pending.clear();
    });
    // Conexão morta (Firefox fechou sem avisar) não pode prender a vaga pra sempre.
    let alive = true;
    ws.on("pong", () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 15000);
    ws.on("close", () => clearInterval(ping));
  });
}

// 180s: ações podem ficar esperando o usuário responder a janela de confirmação (a extensão desiste em 150s).
function send(cmd, params = {}, timeoutMs = 180000) {
  if (!socket || socket.readyState !== 1) {
    return Promise.reject(
      new Error("A extensão do Firefox não está conectada. O Firefox está aberto com a extensão \"Claude no Firefox\" ativa?"),
    );
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`A extensão não respondeu a tempo (${cmd}).`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, cmd, params, ctx: { localReadAt: mark.localReadAt() } }));
  });
}

// ---------- Ferramentas MCP ----------

const server = new McpServer({ name: "claude-firefox", version: "0.1.0" }, { instructions: instructions("numa janela do Firefox") });
for (const t of browserTools({ send, mark })) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.shape }, t.handler);
}

listen();
await server.connect(new StdioServerTransport());
// Claude Code fechou (stdin acabou): sai, senão o WebSocket mantém o processo vivo prendendo a porta.
process.stdin.on("close", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
