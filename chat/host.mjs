#!/usr/bin/env node
// Programa local do painel lateral. O Firefox abre este processo via native messaging (só a extensão
// claude-firefox@local pode, pelo allowed_extensions do manifesto) e fala com ele por stdin/stdout.
//
//   painel ⇄ background ⇄ [este programa] ⇄ Claude Code (SDK, com o claude de verdade via claude-wrapper.sh)
//
// - Ferramentas do navegador: as mesmas do servidor do terminal (server/browser-tools.mjs), indo pela ponte
//   nativa em vez do WebSocket. Confirmações delas aparecem como botões na conversa (feito pelo background).
// - Permissões do computador: canUseTool manda um cartão pro painel e espera o clique.
// - A conversa NÃO nasce marcada: a marca (taint-<pid do claude>) entra quando o Claude lê conteúdo de página.
//   Depois dela, "sempre permitir" fica suspenso nesta conversa, e reabrir uma conversa marcada já começa marcada.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSdkMcpServer, deleteSession, getSessionMessages, query, renameSession, tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import { ExtensionError, browserTools, instructions } from "../server/browser-tools.mjs";
import { TAINT_DIR, createSessionMark } from "../server/session-mark.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const CONF_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "claude-firefox");
const STATE_FILE = path.join(CONF_DIR, "chat-sessions.json");
const ALLOW_FILE = path.join(CONF_DIR, "chat-allow.json");
const LOG_FILE = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, ".cache"), "claude-firefox", "chat-host.log");
const IDLE_MS = 15 * 60 * 1000;
const MAX_FRAME = 900 * 1024; // o Firefox recusa mensagem do programa local acima de 1 MB

// ---------- Utilidades puras (testadas em test/chat-host.mjs) ----------

// Mostra caracteres de controle/invisíveis em vez de deixar o painel interpretar.
// Quebra de linha vira "⏎" + quebra: o cartão mostra que são vários comandos sem esconder nada.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
export const visible = (s) =>
  String(s ?? "").replace(CONTROL, (c) => (c === "\n" ? "⏎\n" : `\\u{${c.codePointAt(0).toString(16)}}`));

// Resumo do que a ferramenta vai fazer, pro cartão de aprovação e pra linha "🔧".
export function summarize(toolName, input = {}) {
  let s;
  if (toolName === "Bash") s = input.command;
  else if (typeof input.file_path === "string") s = input.file_path;
  else if (typeof input.notebook_path === "string") s = input.notebook_path;
  else if (typeof input.url === "string") s = input.url;
  else if (typeof input.pattern === "string") s = `${input.pattern}${input.path ? ` em ${input.path}` : ""}`;
  else s = JSON.stringify(input);
  return visible(String(s ?? "")).slice(0, 4000);
}

// Chave do "sempre permitir": comando exato (Bash), endereço (WebFetch) ou arquivo; sem chave = sem "sempre".
export function allowKey(toolName, input = {}) {
  if (toolName === "Bash" && typeof input.command === "string") return `Bash:${input.command}`;
  if (toolName === "WebFetch" && typeof input.url === "string") return `WebFetch:${input.url}`;
  if (typeof input.file_path === "string") return `${toolName}:${input.file_path}`;
  return null;
}

// Mensagens gravadas pelo Claude Code → itens pro painel (texto do usuário, resposta, ferramentas usadas).
export function mapHistory(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.parent_tool_use_id || m.parent_agent_id) continue; // subagente
    const msg = m.message || {};
    const content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
    if (m.type === "user") {
      const text = content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text && !text.startsWith("<")) out.push({ role: "user", text: text.slice(0, 50000) });
    } else if (m.type === "assistant") {
      for (const b of content) {
        if (b.type === "text" && b.text.trim()) out.push({ role: "assistant", text: b.text.slice(0, 100000) });
        else if (b.type === "tool_use") out.push({ role: "tool", name: b.name, summary: summarize(b.name, b.input).slice(0, 300) });
      }
    }
  }
  return out;
}

// Native messaging: cada mensagem é um tamanho de 4 bytes (little-endian) + JSON em UTF-8.
export function encodeFrame(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

export function frameReader(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      try {
        onMessage(JSON.parse(body.toString("utf8")));
      } catch (_) {}
    }
  };
}

// Pasta de trabalho: tem que existir, ser pasta e ficar dentro da home. Vazio = ~/Documentos/Projetos (ou a home).
export function resolveWorkdir(dir) {
  const fallback = [path.join(HOME, "Documentos", "Projetos"), HOME].find((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  if (!dir) return fallback;
  try {
    const real = fs.realpathSync(dir.startsWith("~") ? path.join(HOME, dir.slice(1)) : dir);
    const home = fs.realpathSync(HOME);
    if (fs.statSync(real).isDirectory() && (real === home || real.startsWith(home + path.sep))) return real;
  } catch {}
  return fallback;
}

// Texto que vai no fim do prompt do Claude Code do painel. As regras de funcionamento são fixas; o jeito de
// conversar e o "sobre mim" são do usuário (opções da extensão). Nenhum deles muda segurança ou permissões:
// isso é a extensão (confirmações, sites permitidos) e a trava (hooks/guard.js) que garantem.
const REGRAS_DO_PAINEL =
  "Você está no painel lateral do Firefox, conversando com o usuário. Escreva em Markdown. " +
  "Você NÃO vê a página aberta: só leia uma página quando o usuário pedir, usando as ferramentas do claude-firefox " +
  "(read_page, query, extrair_tabela, extrair_links, estado_formulario). Pedidos de aprovação aparecem como botões " +
  "na conversa. Pra apagar arquivo use `gio trash <caminho>` (vai pra lixeira); rm sempre pede aprovação. Imagens " +
  "remotas não aparecem pro usuário; links ele abre clicando.";

const limpaTexto = (t) =>
  String(t ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 4000);

export function buildAppend({ estilo = "", sobreMim = "" } = {}) {
  const partes = [REGRAS_DO_PAINEL];
  if (limpaTexto(estilo)) partes.push(`## Jeito de conversar (definido pelo usuário)\n\n${limpaTexto(estilo)}`);
  if (limpaTexto(sobreMim)) partes.push(`## Sobre o usuário (escrito por ele)\n\n${limpaTexto(sobreMim)}`);
  return partes.join("\n\n");
}

// ---------- Estado em disco (só você lê: 0600) ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function log(...a) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if ((fs.statSync(LOG_FILE, { throwIfNoEntry: false })?.size || 0) > 1_000_000) fs.truncateSync(LOG_FILE, 0);
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${a.map(String).join(" ")}\n`);
  } catch {}
}

// ---------- Programa ----------

export function main() {
  const config = readJson(path.join(HERE, "config.json"), {});
  const CLAUDE_BIN = config.claude || path.join(HOME, ".local", "bin", "claude");
  const WRAPPER = path.join(HERE, "claude-wrapper.sh");
  const state = readJson(STATE_FILE, { sessions: {} });
  const allowList = new Set(readJson(ALLOW_FILE, []));
  const saveState = () => writeJson(STATE_FILE, state);

  let workdir = resolveWorkdir("");
  let textos = { estilo: "", sobreMim: "" }; // das opções da extensão (chega em "config")
  let chat = null; // conversa rodando (um processo claude)
  const toolCalls = new Map(); // id -> { resolve, reject, timer }
  const perms = new Map(); // id -> { msg, resolve }

  const post = (msg) => {
    let frame = encodeFrame(msg);
    if (frame.length > MAX_FRAME) frame = encodeFrame({ type: "error", message: "Mensagem grande demais pro painel; parte foi omitida." });
    process.stdout.write(frame);
  };

  // ---------- Ferramentas do navegador (pela ponte nativa) ----------

  let nextTool = 1;
  function sendTool(cmd, params, mark) {
    const id = `t${nextTool++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        toolCalls.delete(id);
        reject(new Error(`A extensão não respondeu a tempo (${cmd}).`));
      }, 180000);
      toolCalls.set(id, { resolve, reject, timer, mark });
      post({ type: "tool", id, cmd, params, ctx: { localReadAt: mark.localReadAt() } });
    });
  }

  function onToolResult(msg) {
    const p = toolCalls.get(msg.id);
    if (!p) return;
    toolCalls.delete(msg.id);
    clearTimeout(p.timer);
    p.mark.addHosts(msg.hosts);
    msg.ok ? p.resolve(msg.result) : p.reject(new ExtensionError(msg));
  }

  // ---------- Conversa ----------

  const sessionInfo = (id) => (id && state.sessions[id]) || null;

  function noteMarked(c) {
    if (c.marked) return;
    c.marked = true;
    if (c.sessionId && state.sessions[c.sessionId]) {
      state.sessions[c.sessionId].marked = true;
      saveState();
    }
    post({ type: "marked", hosts: c.hostsRead() });
  }

  function startChat(resumeId) {
    try {
      fs.mkdirSync(TAINT_DIR, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    const pidFile = path.join(TAINT_DIR, `chatpid-${process.pid}-${crypto.randomUUID()}`);
    let pid = null;
    const getPid = () => {
      if (!pid) {
        const v = Number(readFileOr(pidFile, ""));
        if (Number.isInteger(v) && v > 1) pid = v;
      }
      return pid;
    };
    const hosts = new Set();
    const base = createSessionMark(getPid, log);
    const c = {
      sessionId: resumeId || null,
      marked: false,
      busy: false,
      idle: null,
      pidFile,
      getPid,
      hostsRead: () => [...hosts],
      input: inputQueue(),
      abort: new AbortController(),
    };
    c.done = new Promise((r) => (c.finished = r)); // resolve quando o processo do claude terminou
    // Marca da sessão com aviso pro painel na primeira vez.
    const mark = {
      taint() {
        base.taint();
        noteMarked(c);
      },
      addHosts(list) {
        for (const h of Array.isArray(list) ? list : []) if (typeof h === "string") hosts.add(h);
        base.addHosts(list);
      },
      localReadAt: () => base.localReadAt(),
      isTainted: () => base.isTainted(),
    };
    c.mark = mark;

    const tools = browserTools({ send: (cmd, params) => sendTool(cmd, params, mark), mark });
    const server = createSdkMcpServer({
      name: "claude-firefox",
      version: "1.0.0",
      instructions: instructions("aqui na conversa do painel"),
      tools: tools.map((t) => sdkTool(t.name, t.description, t.shape, t.handler)),
    });

    c.q = query({
      prompt: c.input.iterable,
      options: {
        cwd: workdir,
        resume: resumeId || undefined,
        pathToClaudeCodeExecutable: WRAPPER,
        env: {
          ...process.env,
          PATH: config.path || process.env.PATH,
          CLAUDE_FIREFOX_CHAT: "1",
          CLAUDE_FIREFOX_PIDFILE: pidFile,
          CLAUDE_FIREFOX_BIN: CLAUDE_BIN,
        },
        model: process.env.CLAUDE_FIREFOX_CHAT_MODEL || undefined, // o teste de integração usa um modelo barato
        // Explícito: sem isto o SDK pode escolher o modo automático e pular as aprovações.
        permissionMode: "default",
        includePartialMessages: true,
        settingSources: ["user", "project", "local"], // carrega o hook da trava e as permissões normais
        strictMcpConfig: true, // só o servidor do navegador daqui (o do terminal brigaria pela porta)
        mcpServers: { "claude-firefox": server },
        canUseTool: (name, input, opts) => canUseTool(c, name, input, opts),
        abortController: c.abort,
        // Preset do Claude Code + nosso texto (regras fixas do painel, jeito de conversar e "sobre mim").
        // snapshot padrão: o texto fica gravado na conversa, então mudança nas opções vale pra conversas novas.
        systemPrompt: { type: "preset", preset: "claude_code", append: buildAppend(textos) },
      },
    });
    consume(c);
    return c;
  }

  function readFileOr(file, fallback) {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return fallback;
    }
  }

  async function waitPid(c, ms = 15000) {
    for (let t = 0; t < ms; t += 100) {
      if (c.getPid()) return c.getPid();
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  async function consume(c) {
    let text = "";
    try {
      for await (const m of c.q) {
        if (m.type === "system" && m.subtype === "init") {
          c.sessionId = m.session_id;
          if (!state.sessions[c.sessionId]) {
            state.sessions[c.sessionId] = { title: c.firstTitle || "Conversa", createdAt: Date.now(), updatedAt: Date.now(), workdir, marked: c.marked };
          }
          state.sessions[c.sessionId].marked ||= c.marked;
          saveState();
          post({ type: "session", sessionId: c.sessionId, title: state.sessions[c.sessionId].title });
          if (c.firstTitle) renameSession(c.sessionId, state.sessions[c.sessionId].title, { dir: workdir }).catch(() => {});
          c.firstTitle = null;
        } else if (m.type === "stream_event" && !m.parent_tool_use_id) {
          const e = m.event;
          if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") post({ type: "delta", text: e.delta.text });
        } else if (m.type === "assistant" && !m.parent_tool_use_id) {
          text = "";
          for (const b of m.message?.content || []) {
            if (b.type === "text") text += b.text;
          }
          if (text.trim()) post({ type: "assistant", text });
          for (const b of m.message?.content || []) {
            if (b.type === "tool_use") post({ type: "tool_use", name: b.name, summary: summarize(b.name, b.input).slice(0, 300) });
          }
        } else if (m.type === "result") {
          c.busy = false;
          if (c.sessionId && state.sessions[c.sessionId]) {
            state.sessions[c.sessionId].updatedAt = Date.now();
            saveState();
          }
          if (m.subtype !== "success" && !c.interrupted) post({ type: "error", message: `O Claude parou: ${m.subtype}` });
          c.interrupted = false;
          post({ type: "busy", value: false });
          armIdle(c);
        }
      }
    } catch (e) {
      log("conversa terminou com erro:", e?.stack || e);
      if (chat === c) post({ type: "error", message: `O Claude Code parou: ${e?.message || e}` });
    }
    if (chat === c) {
      chat = null;
      post({ type: "busy", value: false });
    }
    try {
      fs.unlinkSync(c.pidFile);
    } catch {}
    c.finished();
  }

  function armIdle(c) {
    clearTimeout(c.idle);
    // Parado há 15 min: fecha o processo (libera ~300 MB). A próxima mensagem retoma pelo ID da sessão.
    c.idle = setTimeout(() => {
      if (chat === c && !c.busy) closeChat();
    }, IDLE_MS);
  }

  // Devolve uma promessa que resolve quando o processo terminou de fato (até 8 s).
  function closeChat() {
    const c = chat;
    if (!c) return Promise.resolve();
    chat = null;
    clearTimeout(c.idle);
    for (const [id, p] of perms) {
      p.resolve("deny");
      perms.delete(id);
    }
    c.input.end();
    c.abort.abort();
    return Promise.race([c.done, new Promise((r) => setTimeout(r, 8000))]);
  }

  async function canUseTool(c, name, input, opts) {
    // Ferramentas do navegador registradas AQUI (source "sdk"): as ações já pedem confirmação na extensão.
    if (opts?.mcpServer?.source === "sdk" && name.startsWith("mcp__claude-firefox__")) return { behavior: "allow", updatedInput: input };
    const key = allowKey(name, input);
    const podeSempre = !c.marked && !!key && !opts?.suppressAlwaysAllowRule;
    // "Sempre permitir" só vale antes da marca: depois de ler página, tudo que pedir aprovação pergunta de novo.
    if (podeSempre && allowList.has(key)) return { behavior: "allow", updatedInput: input };
    const id = crypto.randomUUID();
    const msg = {
      type: "permission_request",
      id,
      tool: visible(name).slice(0, 200),
      summary: summarize(name, input),
      reason: visible(opts?.decisionReason || opts?.title || "").slice(0, 4000),
      canAlways: podeSempre,
      tainted: c.marked,
    };
    const decision = await new Promise((resolve) => {
      perms.set(id, { msg, resolve });
      opts?.signal?.addEventListener("abort", () => resolve("deny"), { once: true });
      post(msg);
    });
    perms.delete(id);
    post({ type: "permission_closed", id, decision });
    if (decision === "always" && podeSempre) {
      allowList.add(key);
      writeJson(ALLOW_FILE, [...allowList]);
    }
    if (decision === "allow" || (decision === "always" && podeSempre)) return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "O usuário negou no painel." };
  }

  async function send(sessionId, text) {
    if (typeof text !== "string" || !text.trim()) return;
    if (chat && chat.sessionId !== (sessionId || null) && !(chat.sessionId === null && !sessionId)) closeChat();
    if (chat?.busy) return post({ type: "error", message: "Espere o Claude terminar (ou clique em Parar)." });
    let c = chat;
    if (!c) {
      const info = sessionInfo(sessionId);
      if (sessionId && !info) return post({ type: "error", message: "Conversa não encontrada." });
      c = chat = startChat(sessionId || null);
      if (!sessionId) c.firstTitle = text.trim().replace(/\s+/g, " ").slice(0, 60);
      // Conversa que já leu página: o contexto tem conteúdo da web, então começa marcada (antes da 1ª mensagem).
      if (info?.marked) {
        const pid = await waitPid(c);
        try {
          if (!pid) throw new Error("o Claude Code não informou o PID");
          c.mark.taint();
        } catch (e) {
          closeChat();
          return post({ type: "error", message: `Não consegui marcar a conversa como contaminada (${e.message}); por segurança ela não foi retomada.` });
        }
      }
    }
    clearTimeout(c.idle);
    c.busy = true;
    post({ type: "busy", value: true });
    c.input.push(text);
  }

  function list() {
    const sessions = Object.entries(state.sessions)
      .map(([sessionId, s]) => ({ sessionId, title: s.title, updatedAt: s.updatedAt }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    post({ type: "list", sessions });
    for (const p of perms.values()) post(p.msg); // pedido pendente reaparece se o painel foi reaberto
    post({ type: "ready", workdir });
  }

  async function open(sessionId) {
    const info = sessionInfo(sessionId);
    if (!info) return post({ type: "error", message: "Conversa não encontrada." });
    if (chat && chat.sessionId !== sessionId) closeChat();
    let messages = [];
    try {
      messages = mapHistory(await getSessionMessages(sessionId, { dir: info.workdir || workdir }));
    } catch (e) {
      log("histórico:", e?.message || e);
    }
    // Cabe num quadro do native messaging: corta as mais antigas se precisar.
    let payload = { type: "history", sessionId, title: info.title, messages, marked: !!info.marked };
    while (encodeFrame(payload).length > MAX_FRAME && payload.messages.length > 1) {
      payload = { ...payload, messages: payload.messages.slice(Math.ceil(payload.messages.length / 4)) };
    }
    post(payload);
  }

  async function onMessage(msg) {
    try {
      switch (msg?.type) {
        case "config": {
          textos = { estilo: msg.estilo, sobreMim: msg.sobreMim };
          const novo = resolveWorkdir(typeof msg.workdir === "string" ? msg.workdir : "");
          if (novo !== workdir) {
            closeChat();
            workdir = novo;
          }
          post({ type: "ready", workdir });
          break;
        }
        case "tool_result":
          onToolResult(msg);
          break;
        case "list":
          list();
          break;
        case "open":
          await open(String(msg.sessionId || ""));
          break;
        case "new":
          closeChat();
          break;
        case "send":
          await send(msg.sessionId ? String(msg.sessionId) : null, msg.text);
          break;
        case "interrupt":
          if (chat?.busy) {
            chat.interrupted = true;
            await chat.q.interrupt().catch(() => {});
          }
          break;
        case "permission_answer": {
          const p = perms.get(msg.id);
          if (p && ["allow", "always", "deny"].includes(msg.decision)) p.resolve(msg.decision);
          break;
        }
        case "rename": {
          const info = sessionInfo(msg.sessionId);
          const title = String(msg.title || "").replace(CONTROL, "").trim().slice(0, 120);
          if (info && title) {
            info.title = title;
            saveState();
            renameSession(msg.sessionId, title, { dir: info.workdir || workdir }).catch(() => {});
          }
          list();
          break;
        }
        case "delete": {
          const info = sessionInfo(msg.sessionId);
          if (info) {
            // Espera o claude dessa conversa sair: ao fechar ele ainda grava metadados no arquivo da sessão,
            // e apagar antes disso deixava um resto no disco.
            if (chat?.sessionId === msg.sessionId) await closeChat();
            await deleteSession(msg.sessionId, { dir: info.workdir || workdir }).catch((e) => log("apagar:", e?.message || e));
            delete state.sessions[msg.sessionId];
            saveState();
          }
          list();
          break;
        }
      }
    } catch (e) {
      log("erro tratando", msg?.type, e?.stack || e);
      post({ type: "error", message: `Erro no programa do painel: ${e?.message || e}` });
    }
  }

  process.stdin.on("data", frameReader(onMessage));
  process.stdin.on("end", () => {
    closeChat();
    setTimeout(() => process.exit(0), 3000).unref();
  });
  process.on("uncaughtException", (e) => log("exceção:", e?.stack || e));
  log("programa do painel iniciado, pasta", workdir);
}

// Fila de mensagens do usuário pro SDK (modo streaming: o processo fica vivo entre as mensagens).
function inputQueue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(text) {
      items.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" });
      wake?.();
    },
    end() {
      ended = true;
      wake?.();
    },
    iterable: (async function* () {
      for (;;) {
        while (items.length) yield items.shift();
        if (ended) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    })(),
  };
}

const runAsScript = (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (runAsScript) main();
