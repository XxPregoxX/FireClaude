// Marca de "sessão contaminada" (taint-<pid do claude>) e hora da última ferramenta fora do navegador
// (localread-<pid>, gravada pelo hook guard.js). Assim que conteúdo de página entra no contexto, a marca é
// gravada; o hook vê o arquivo e passa a exigir confirmação pra ações no sistema.
import fs from "node:fs";
import path from "node:path";
import { HOST_RE } from "./browser-tools.mjs";

export const TAINT_DIR = path.join(process.env.XDG_RUNTIME_DIR || "/tmp", "claude-firefox");

// Processo `claude` acima deste (o hook procura pelo mesmo nome). Sem achar, devolve o pai.
export function findClaudePid() {
  let pid = process.ppid;
  while (pid > 1) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      if (comm === "claude") return pid;
      pid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    } catch {
      break;
    }
  }
  return process.ppid;
}

// getPid: função porque o painel só sabe o PID depois que o claude sobe. Sem PID, taint() falha (fechado).
export function createSessionMark(getPid, log = () => {}) {
  let taintedAt = null;
  let written = "";
  const readHosts = new Set();

  // Falhar aqui é falhar fechado: quem chama não devolve conteúdo da página se a marca não foi gravada.
  function taint() {
    const pid = getPid();
    const hosts = [...readHosts].join("\n");
    if (taintedAt && `${pid}|${hosts}` === written) return;
    try {
      if (!pid) throw new Error("PID do Claude Code desconhecido");
      // Sem recursive: XDG_RUNTIME_DIR sempre existe, e o mkdir recursivo do Node pode travar em sistema de arquivos
      // estranho (ex.: /proc). Travar aqui seria falhar aberto; erro na hora é falhar fechado.
      try {
        fs.mkdirSync(TAINT_DIR, { mode: 0o700 });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      const at = taintedAt || new Date().toISOString();
      fs.writeFileSync(path.join(TAINT_DIR, `taint-${pid}`), `${at}\n${hosts}\n`);
      taintedAt = at;
      written = `${pid}|${hosts}`;
    } catch (e) {
      log("não consegui gravar a marca de contaminação:", e.message);
      throw new Error(`Não consegui marcar a sessão como contaminada (${e.code || e.message}); por segurança o conteúdo não foi devolvido.`);
    }
  }

  // Hostnames vêm em punycode (ASCII); qualquer outra coisa é descartada antes de ir pra mensagem da trava.
  function addHosts(list) {
    for (const h of Array.isArray(list) ? list : []) {
      if (typeof h === "string" && HOST_RE.test(h)) readHosts.add(h.toLowerCase());
    }
    if (taintedAt) {
      try {
        taint(); // só atualiza a lista de sites; a marca em si já existe
      } catch {}
    }
  }

  // O hook toca localread-<pid> sempre que a sessão contaminada usa ferramenta fora do navegador.
  // A extensão derruba aprovações por tarefa feitas antes disso.
  function localReadAt() {
    const pid = getPid();
    if (!pid) return 0;
    try {
      return fs.statSync(path.join(TAINT_DIR, `localread-${pid}`)).mtimeMs;
    } catch {
      return 0;
    }
  }

  return { taint, addHosts, localReadAt, isTainted: () => taintedAt !== null };
}
