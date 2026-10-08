#!/usr/bin/env node
// Hook PreToolUse do Claude Code. Se esta sessão já recebeu conteúdo do Firefox (arquivo taint-<pid do claude>),
// ferramenta que mexe no sistema ou fala com o mundo exige confirmação do usuário. Leitura simples dentro do
// projeto (ls/cat/grep/head/tail/wc, Read, Glob, Grep) passa sem perguntar, fora arquivos sensíveis.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SAFE = /^(mcp__claude-firefox__|AskUserQuestion$|ToolSearch$)/;
const dir = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "claude-firefox");

function claudePid() {
  let pid = process.ppid;
  while (pid > 1) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")) === "claude") return pid;
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------- Leitura simples dentro do projeto ----------

// Mesmo dentro do projeto, estes sempre perguntam.
const SENSITIVE =
  /^\.env|\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc|sqlite|db)$|^id_|credential|secret|token|passw|senha|^\.(npmrc|pypirc|netrc|pgpass|htpasswd)$|^(logins\.json|key4\.db|cookies\.sqlite)$/i;

// Raiz do projeto (realpath). Sessão aberta na home ou acima dela não tem "projeto": seria a máquina toda.
export function projectRoot(dirPath) {
  if (!dirPath) return null;
  let real;
  try {
    real = fs.realpathSync(dirPath);
  } catch {
    return null;
  }
  const home = fs.realpathSync(os.homedir());
  if (real === "/" || real === home || home.startsWith(real + path.sep)) return null;
  return real;
}

// Caminho real (seguindo symlinks) dentro do projeto, fora de pasta escondida (.git, .ssh...) e não sensível.
function pathOk(p, cwd, root) {
  let real;
  try {
    real = fs.realpathSync(path.resolve(cwd, p));
  } catch {
    return false;
  }
  if (real !== root && !real.startsWith(root + path.sep)) return false;
  let isDir;
  try {
    isDir = fs.statSync(real).isDirectory();
  } catch {
    return false;
  }
  const parts = path.relative(root, real).split(path.sep).filter(Boolean);
  if ((isDir ? parts : parts.slice(0, -1)).some((d) => d.startsWith("."))) return false;
  if (SENSITIVE.test(path.basename(real)) || SENSITIVE.test(path.basename(p))) return false;
  return true;
}

// Separa em palavras aceitando só aspas simples/duplas literais. Qualquer coisa que o shell interpretaria
// (; | & $ ` > < ( ) { } * ? [ ] ~ # ! \ quebra de linha) devolve null.
function splitWords(cmd) {
  const words = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === "'" || ch === '"') {
      const j = cmd.indexOf(ch, i + 1);
      if (j < 0) return null;
      const s = cmd.slice(i + 1, j);
      if (ch === '"' && /[$`\\!]/.test(s)) return null;
      cur += s;
      inWord = true;
      i = j;
    } else if (ch === " " || ch === "\t") {
      if (inWord) words.push(cur);
      cur = "";
      inWord = false;
    } else if (/[;&|<>()$`\\*?[\]{}~#!\n\r]/.test(ch)) {
      return null;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
}

const COMMANDS = {
  ls: { flags: /^-[laAhR1tSrdFi]+$/ },
  cat: { flags: /^-[nbsETAv]+$/ },
  head: { flags: /^-[nc]?\d+$/, value: /^-[nc]$/ },
  tail: { flags: /^-[nc]?\d+$/, value: /^-[nc]$/ },
  wc: { flags: /^-[lwcmL]+$/ },
  grep: { flags: /^-[inrlLcvwoEFHhsxqZ]+$/, value: /^-[eABCm]$/, long: /^--(include|exclude|exclude-dir)=./ },
};

function bashReadOnly(cmd, cwd, root) {
  const w = splitWords(cmd.trim());
  if (!w || !w.length) return false;
  const name = w[0];
  const spec = COMMANDS[name];
  if (!spec) return false;
  const flags = [];
  const operands = [];
  let explicitPattern = false;
  let endOfFlags = false;
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (!endOfFlags && a === "--") {
      endOfFlags = true;
    } else if (!endOfFlags && a.startsWith("-") && a !== "-") {
      if (spec.value?.test(a)) {
        const v = w[++i];
        if (v === undefined) return false;
        if (a === "-e") explicitPattern = true;
        else if (!/^\d+$/.test(v)) return false;
      } else if (!spec.long?.test(a)) {
        if (!spec.flags.test(a)) return false;
        flags.push(a);
      }
    } else {
      operands.push(a);
    }
  }
  let paths = operands;
  if (name === "grep") {
    if (!explicitPattern) {
      if (!paths.length) return false;
      paths = paths.slice(1);
    }
    if (flags.some((f) => f.includes("r"))) {
      // Recursivo só listando nomes/contagens: com conteúdo, passaria por arquivos sensíveis da pasta.
      if (!flags.some((f) => /[lLc]/.test(f))) return false;
      if (!paths.length) paths = ["."];
    }
  }
  if (name === "ls" && !paths.length) paths = ["."];
  return paths.every((p) => pathOk(p, cwd, root));
}

export function isReadOnlyInProject(tool, input, cwd, root) {
  if (!root) return false;
  input = input || {};
  cwd = cwd || root;
  switch (tool) {
    case "Read":
      return typeof input.file_path === "string" && pathOk(input.file_path, cwd, root);
    case "Glob": {
      const pat = String(input.pattern || "");
      if (pat.startsWith("/") || pat.startsWith("~") || pat.split("/").includes("..")) return false;
      return pathOk(input.path || ".", cwd, root);
    }
    case "Grep": {
      const target = input.path || ".";
      if (!pathOk(target, cwd, root)) return false;
      if (input.output_mode !== "content") return true; // só nomes de arquivo ou contagem
      return fs.statSync(path.resolve(cwd, target)).isFile();
    }
    case "Bash":
      return typeof input.command === "string" && bashReadOnly(input.command, cwd, root);
    default:
      return false;
  }
}

// ---------- Chat do painel: arquivos dentro da pasta de trabalho ----------
// Só na sessão do painel (CLAUDE_FIREFOX_CHAT=1) e depois da marca: criar, editar, mover, renomear, copiar e
// mandar pra lixeira (gio trash) dentro da pasta passam. Nome com ponto, CLAUDE.md e arquivo sensível pedem:
// .claude/settings*.json e .git/hooks rodam comando sozinhos; CLAUDE.md planta instrução pra depois.

const protectedName = (n) => n.startsWith(".") || /^claude\.md$/i.test(n) || SENSITIVE.test(n);
const inside = (real, root) => real === root || real.startsWith(root + path.sep);
const relParts = (root, real) => path.relative(root, real).split(path.sep).filter(Boolean);

// Pode escrever/criar/apagar ESTE caminho? Pastas que faltam (mkdir -p, Write cria) não podem ter nome protegido;
// a pasta existente mais próxima tem que estar (de verdade, seguindo symlink) dentro do projeto.
function writeTargetOk(p, cwd, root) {
  const abs = path.resolve(cwd, p);
  const novos = [];
  let cur = abs;
  for (;;) {
    let st = null;
    try {
      st = fs.lstatSync(cur);
    } catch {}
    if (st) break;
    novos.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
  if (novos.some(protectedName)) return false;
  let real;
  try {
    real = fs.realpathSync(cur); // symlink quebrado ou pra fora: cai aqui ou no inside()
  } catch {
    return false;
  }
  if (!inside(real, root)) return false;
  const parts = relParts(root, real);
  if (cur === abs) {
    // Alvo já existe: o nome digitado e o nome real (se for symlink) não podem ser protegidos.
    if (protectedName(path.basename(abs)) || (parts.length && protectedName(parts[parts.length - 1]))) return false;
    return !parts.slice(0, -1).some((d) => d.startsWith("."));
  }
  return !parts.some((d) => d.startsWith("."));
}

// Pasta inteira sendo movida/copiada/apagada: nada protegido dentro (limite de 5000 itens, senão pede).
function treeOk(p, cwd) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (++n > 5000 || protectedName(e.name)) return false;
      if (e.isDirectory() && !walk(path.join(d, e.name))) return false;
    }
    return true;
  };
  const abs = path.resolve(cwd, p);
  try {
    return !fs.lstatSync(abs).isDirectory() || walk(abs);
  } catch {
    return false;
  }
}

const FILE_COMMANDS = {
  mkdir: /^-[pv]+$/,
  touch: /^-c+$/,
  mv: /^-[fnv]+$/,
  cp: /^-[rRfnvp]+$/,
};

function bashFileOp(cmd, cwd, root) {
  const w = splitWords(cmd.trim());
  if (!w || !w.length) return false;
  let name = w[0];
  let args = w.slice(1);
  if (name === "gio") {
    if (args[0] !== "trash") return false;
    name = "gio trash";
    args = args.slice(1).filter((a) => a !== "-f" && a !== "--force");
  } else if (!Object.hasOwn(FILE_COMMANDS, name)) {
    return false;
  }
  const operands = [];
  let endOfFlags = false;
  for (const a of args) {
    if (!endOfFlags && a === "--") endOfFlags = true;
    else if (!endOfFlags && a.startsWith("-")) {
      if (name === "gio trash" || !FILE_COMMANDS[name].test(a)) return false;
    } else operands.push(a);
  }
  if (!operands.length) return false;
  if (name === "mkdir" || name === "touch") return operands.every((p) => writeTargetOk(p, cwd, root));
  if (name === "gio trash") return operands.every((p) => writeTargetOk(p, cwd, root) && treeOk(p, cwd));
  // mv/cp: origens legíveis e sem nada protegido; destino gravável (dentro da pasta destino, se for pasta).
  if (operands.length < 2) return false;
  const dest = operands[operands.length - 1];
  const sources = operands.slice(0, -1);
  let destIsDir = false;
  try {
    destIsDir = fs.statSync(path.resolve(cwd, dest)).isDirectory();
  } catch {}
  if (sources.length > 1 && !destIsDir) return false;
  return sources.every((src) => {
    if (!pathOk(src, cwd, root) || protectedName(path.basename(path.resolve(cwd, src))) || !treeOk(src, cwd)) return false;
    if (name === "mv" && !writeTargetOk(src, cwd, root)) return false; // mover também "apaga" a origem
    const target = destIsDir ? path.join(dest, path.basename(path.resolve(cwd, src))) : dest;
    return writeTargetOk(target, cwd, root);
  });
}

export function isFileOpInWorkdir(tool, input, cwd, root) {
  if (!root) return false;
  input = input || {};
  cwd = cwd || root;
  switch (tool) {
    case "Write":
    case "Edit":
    case "MultiEdit":
      return typeof input.file_path === "string" && writeTargetOk(input.file_path, cwd, root);
    case "NotebookEdit":
      return typeof input.notebook_path === "string" && writeTargetOk(input.notebook_path, cwd, root);
    case "Bash":
      return typeof input.command === "string" && bashFileOp(input.command, cwd, root);
    default:
      return false;
  }
}

// ---------- Mensagem da confirmação ----------

// Mostra caracteres de controle/invisíveis em vez de deixar o terminal interpretar (quebra de linha, \r, ANSI...).
const CONTROL = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁩﻿]/g;
export function visible(s) {
  return String(s).replace(CONTROL, (c) => (c === "\n" ? "⏎" : c === "\t" ? "⇥" : `\\u{${c.codePointAt(0).toString(16)}}`));
}

export function askReason(tool, input, hosts, header) {
  input = input || {};
  const raw = tool === "Bash" ? input.command
    : typeof input.file_path === "string" ? input.file_path
    : JSON.stringify(input);
  const what = String(raw ?? "");
  const warns = [];
  if (what.length > 300) warns.push(`⚠️ É longo (${what.length} caracteres): leia até o fim.`);
  if (/ {8,}/.test(what)) warns.push("⚠️ Tem uma sequência longa de espaços (pode esconder o resto).");
  if (/[\n\r]/.test(what)) warns.push("⚠️ Tem quebra de linha (⏎): pode ser mais de um comando.");
  return [
    header || `🛡️ Claude no Firefox: esta sessão leu conteúdo de ${hosts.length ? hosts.join(", ") : "página(s) do Firefox"}, que pode ter prompt injection.`,
    `${tool}: ${visible(what)}`,
    ...warns,
    "Aprove só se foi VOCÊ que pediu isso. (Pra zerar a trava, comece uma sessão nova.)",
  ].join("\n");
}

function hostsFrom(taintFile) {
  try {
    return fs.readFileSync(taintFile, "utf8").split("\n").slice(1).filter((h) => /^[a-z0-9.\-:[\]]{1,253}$/i.test(h));
  } catch {
    return [];
  }
}

// ---------- Decisão ----------
// Na dúvida, pergunta: toda falha da trava (pedido ilegível, processo do Claude Code não encontrado, erro
// inesperado) vira "ask". Falha ao gravar a marca localread vira "deny", porque perguntar não resolveria:
// a aprovação por tarefa da extensão continuaria valendo depois da leitura.

const ask = (reason) => ({ decision: "ask", reason });

// Saídas grandes que o programa do painel guardou (o Claude recebeu só um resumo do modelo auxiliar): ler com Read é
// livre. São saídas que a própria conversa já produziu; nada novo entra. Só Read, só arquivo comum com o nome que o
// painel gera, direto nessa pasta (sem symlink pra fora).
const NOME_SAIDA = /^saida-[0-9a-f]{16}\.txt$/;
export function isLeituraDeSaida(tool, input, taintDir) {
  if (tool !== "Read" || typeof input?.file_path !== "string" || !path.isAbsolute(input.file_path)) return false;
  try {
    const pasta = fs.realpathSync(path.join(taintDir, "saidas"));
    const real = fs.realpathSync(input.file_path);
    return path.dirname(real) === pasta && NOME_SAIDA.test(path.basename(real)) && fs.statSync(real).isFile();
  } catch {
    return false;
  }
}

export function decide({ raw, pid, dir: taintDir, projectDir, chat = false }) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return ask("🛡️ Claude no Firefox: a trava não conseguiu ler o pedido do Claude Code. Por segurança, confirme se foi você que pediu isso.");
  }
  const tool = typeof input?.tool_name === "string" ? input.tool_name : "";
  if (SAFE.test(tool)) return null;
  if (!pid) {
    return ask(askReason(tool, input.tool_input, [],
      "🛡️ Claude no Firefox: não identifiquei o processo do Claude Code (nome \"claude\"), então não dá pra saber se esta sessão leu páginas. Por segurança, toda ação pede confirmação."));
  }
  const taintFile = path.join(taintDir, `taint-${pid}`);
  if (!fs.existsSync(taintFile)) return null;

  // Qualquer ferramenta fora do navegador numa sessão marcada derruba a "aprovação por tarefa" da extensão
  // (o servidor MCP lê a hora deste arquivo). Assim não dá pra ler um arquivo e digitar no site sem perguntar.
  try {
    fs.writeFileSync(path.join(taintDir, `localread-${pid}`), "");
  } catch (e) {
    return {
      decision: "deny",
      reason: `🛡️ Claude no Firefox: não consegui gravar a marca que derruba a aprovação por tarefa no Firefox (${e.code || e.message}). ` +
        `Bloqueado por segurança. Feche esta sessão e abra outra.`,
    };
  }
  const root = projectRoot(projectDir);
  if (chat) {
    // No painel, o que é livre depois da marca passa com "allow": sem isso o Claude Code ainda perguntaria
    // (no modo padrão ele pergunta toda edição), e a regra combinada é não perguntar.
    if (isReadOnlyInProject(tool, input.tool_input, input.cwd, root) || isFileOpInWorkdir(tool, input.tool_input, input.cwd, root)) {
      return { decision: "allow", reason: "Claude no Firefox: dentro da pasta de trabalho, sem arquivo protegido." };
    }
    if (isLeituraDeSaida(tool, input.tool_input, taintDir)) {
      return { decision: "allow", reason: "Claude no Firefox: saída completa de um comando desta conversa (o resumo já veio)." };
    }
  } else if (isReadOnlyInProject(tool, input.tool_input, input.cwd, root)) {
    return null;
  }
  return ask(askReason(tool, input.tool_input, hostsFrom(taintFile)));
}

// Comando do hook em ~/.claude/settings.json (README). Se o node faltar, quebrar ou passar de 8 s, sai com 2,
// que pro Claude Code BLOQUEIA a ferramenta (qualquer outro código de saída deixaria passar).
export const hookCommand = (guardPath, seconds = 8) =>
  `timeout ${seconds} node ${guardPath} || { echo "🛡️ Trava do Claude no Firefox falhou ou demorou; bloqueado por segurança." >&2; exit 2; }`;

function main() {
  let out;
  try {
    out = decide({
      raw: fs.readFileSync(0, "utf8"),
      pid: claudePid(),
      dir,
      projectDir: process.env.CLAUDE_PROJECT_DIR,
      chat: process.env.CLAUDE_FIREFOX_CHAT === "1",
    });
  } catch (e) {
    out = ask(`🛡️ Claude no Firefox: a trava deu erro (${visible(e?.message || e)}). Por segurança, confirme se foi você que pediu isso.`);
  }
  if (!out) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: out.decision, permissionDecisionReason: out.reason },
  }));
}

const runAsScript = (() => {
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (runAsScript) main();
