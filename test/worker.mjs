// Modelo auxiliar (chat/worker.mjs), sem Firefox: node test/worker.mjs
// Com WORKER_REAL=1 faz também uma chamada de verdade pela assinatura (Haiku 5.5; custa ~US$ 0,001).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "worker-"));
process.env.XDG_CONFIG_HOME = path.join(tmp, "config");
process.env.XDG_CACHE_HOME = path.join(tmp, "cache");
const W = await import("../chat/worker.mjs");

let total = 0;
let falhas = 0;
function check(nome, ok, detalhe = "") {
  total++;
  if (!ok) falhas++;
  console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : `\n         -> ${String(detalhe).slice(0, 400)}`}`);
}
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("# Prompt e limites");
let p = W.montarPrompt({ instrucao: "Resuma.", conteudo: "abc", formato: "uma linha" });
check("prompt tem instrução, formato e conteúdo marcados", /<instrucao>\nResuma\.\n<\/instrucao>/.test(p.prompt) && /<formato>/.test(p.prompt) &&
  /<conteudo>\nabc\n<\/conteudo>/.test(p.prompt) && !p.cortado);
p = W.montarPrompt({ instrucao: "x", conteudo: "a".repeat(400000) });
check("conteúdo enorme é cortado pra caber em ~50 mil tokens, com aviso", p.cortado && p.prompt.length <= W.MAX_CHARS_PROMPT &&
  /\[conteúdo cortado: só os primeiros \d+ de 400000 caracteres couberam\]/.test(p.prompt), p.prompt.length);
check("teto: 50 mil tokens", W.MAX_TOKENS_PROMPT === 50000);

console.log("\n# Configuração");
check("padrão: ligado, pela assinatura, Haiku 5.5", JSON.stringify(W.normalizarConfig({})) === JSON.stringify(W.CONFIG_PADRAO) &&
  W.CONFIG_PADRAO.modelo === "claude-haiku-5-5" && W.CONFIG_PADRAO.provedor === "assinatura");
check("endpoint local só em localhost", W.urlLocalValida("http://127.0.0.1:11434/v1") && W.urlLocalValida("http://localhost:8080/v1") &&
  !W.urlLocalValida("http://192.168.0.5:11434/v1") && !W.urlLocalValida("https://exemplo.com/v1") && !W.urlLocalValida("file:///etc/passwd"));
const c = W.normalizarConfig({ provedor: "local", localUrl: "http://evil.com/v1", modelo: "gpt-4", ligado: "sim" });
check("valor inválido cai no padrão (URL de fora, modelo que não é claude, ligado não-booleano)",
  c.localUrl === W.CONFIG_PADRAO.localUrl && c.modelo === "claude-haiku-5-5" && c.ligado === true && c.provedor === "local", JSON.stringify(c));

console.log("\n# Chave da API");
let erro = null;
try {
  W.gravarChave("minha-senha");
} catch (e) {
  erro = e;
}
check("recusa o que não parece chave da Anthropic", /não parece uma chave/.test(erro?.message));
check("grava a chave em arquivo 0600 e devolve só o final", W.gravarChave("sk-ant-api03-" + "x".repeat(40) + "abcd") === "abcd" &&
  (fs.statSync(W.ARQUIVO_CHAVE).mode & 0o777) === 0o600 && W.lerChave().endsWith("abcd"));
W.gravarChave("");
check("chave vazia apaga o arquivo", !fs.existsSync(W.ARQUIVO_CHAVE));

console.log("\n# Execução (provedor falso)");
const vistos = [];
const falso = {
  assinatura: async (cfg, prompt, o) => {
    vistos.push({ prompt, o });
    if (prompt.includes("demora")) await new Promise((r, rej) => o.sinal.addEventListener("abort", () => rej(new Error("abortado"))));
    if (prompt.includes("falha")) throw new Error("caiu");
    return { texto: `ok: ${prompt.length}`, uso: { entrada: 10, saida: 2 } };
  },
};
const w = W.criarWorker({ provedores: falso });
let r = await w.executar({ instrucao: "i", conteudo: "c", tarefa: "teste" });
check("devolve texto, provedor e modelo", /^ok: \d+$/.test(r.texto) && r.provedor === "assinatura" && r.modelo === "claude-haiku-5-5");
check("o provedor só recebe o prompt (instrução + conteúdo), nunca conversa", Object.keys(vistos[0].o).sort().join() === "chave,claudeBin,fetchImpl,maxSaida,sinal" &&
  vistos[0].o.maxSaida === 1500);
const t0 = Date.now();
erro = null;
try {
  await w.executar({ instrucao: "demora", conteudo: "x", timeoutMs: 5000 });
} catch (e) {
  erro = e;
}
check("timeout vira erro (quem chama cai no comportamento sem worker)", /tempo esgotado \(5 s\)/.test(erro?.message) && Date.now() - t0 < 7000, erro?.message);
erro = null;
try {
  await w.executar({ instrucao: "falha", conteudo: "x" });
} catch (e) {
  erro = e;
}
check("falha do provedor vira erro", erro?.message === "caiu");
let ordem = [];
const lento = W.criarWorker({ provedores: { assinatura: async (cfg, prompt) => {
  ordem.push(`início ${prompt.includes("A") ? "A" : "B"}`);
  await espera(150);
  ordem.push("fim");
  return { texto: "ok" };
} } });
await Promise.all([lento.executar({ instrucao: "A", conteudo: "" }), lento.executar({ instrucao: "B", conteudo: "" })]);
check("um worker por vez (fila)", ordem.join(",") === "início A,fim,início B,fim", ordem.join(","));
w.configurar({ ligado: false });
erro = null;
try {
  await w.executar({ instrucao: "i", conteudo: "c" });
} catch (e) {
  erro = e;
}
check("desligado: não chama nada e dá erro", /desligado/.test(erro?.message));
const usoLog = fs.readFileSync(path.join(process.env.XDG_CACHE_HOME, "claude-firefox", "worker-uso.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
check("uso registrado (sucesso e erro) pra medição", usoLog.some((u) => u.tarefa === "teste" && u.entrada === 10) && usoLog.some((u) => u.erro === "caiu"));

console.log("\n# Provedor API (SDK oficial, fetch falso)");
W.gravarChave("sk-ant-api03-" + "y".repeat(40));
let corpo = null;
let cabecalhos = null;
const fetchApi = async (url, init) => {
  corpo = JSON.parse(init.body);
  cabecalhos = Object.fromEntries(new Headers(init.headers));
  return new Response(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn",
    content: [{ type: "text", text: "resposta da API" }], usage: { input_tokens: 50, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
};
const wa = W.criarWorker({ fetchImpl: fetchApi });
wa.configurar({ provedor: "api" });
r = await wa.executar({ instrucao: "Pergunta?", conteudo: "texto da página", maxSaida: 800 });
check("API: resposta volta", r.texto === "resposta da API" && r.provedor === "api");
check("API: modelo, limite de saída, sem ferramentas, sem raciocínio estendido, esforço baixo", corpo?.model === "claude-haiku-5-5" && corpo.max_tokens === 800 &&
  !("tools" in corpo) && corpo.thinking?.type === "disabled" && corpo.output_config?.effort === "low", JSON.stringify(corpo).slice(0, 300));
check("API: uma mensagem só (instrução + conteúdo), nada de conversa", corpo?.messages?.length === 1 && /texto da página/.test(corpo.messages[0].content));
check("API: a chave vai só no cabeçalho da requisição", cabecalhos?.["x-api-key"]?.startsWith("sk-ant-api03-yy"), JSON.stringify(Object.keys(cabecalhos || {})));
W.gravarChave("");
erro = null;
try {
  await wa.executar({ instrucao: "i", conteudo: "c" });
} catch (e) {
  erro = e;
}
check("API sem chave: erro claro", /sem chave da API/.test(erro?.message));

console.log("\n# Provedor local (compatível com OpenAI)");
let urlLocal = null;
const fetchLocal = async (url, init) => {
  urlLocal = url;
  corpo = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: "resposta local" } }], usage: { prompt_tokens: 9, completion_tokens: 2 } }), { status: 200 });
};
const wl = W.criarWorker({ fetchImpl: fetchLocal });
wl.configurar({ provedor: "local", localUrl: "http://127.0.0.1:11434/v1", localModelo: "qwen2.5:7b" });
r = await wl.executar({ instrucao: "i", conteudo: "c" });
check("local: chama /chat/completions no localhost com o modelo local", r.texto === "resposta local" && urlLocal === "http://127.0.0.1:11434/v1/chat/completions" &&
  corpo.model === "qwen2.5:7b" && corpo.messages.length === 2 && !("tools" in corpo), urlLocal);

console.log("\n# perguntar_pagina (ferramenta do painel, extensão e worker falsos)");
const { browserTools } = await import("../server/browser-tools.mjs");
let marcou = 0;
let pedidoExt = null;
let pedidoWorker = null;
const pagina = { url: "http://loja.teste/p", title: "Produto", text: "Teclado TC193. Preço: R$ 29,90. " + "outro texto ".repeat(50) };
const marca = { taint: () => marcou++ };
const send = async (cmd, a) => {
  pedidoExt = { cmd, a };
  return pagina;
};
let respostaWorker = async (p) => {
  pedidoWorker = p;
  return { texto: 'R$ 29,90. Trechos: "Preço: R$ 29,90"', modelo: "claude-haiku-5-5", cortado: false };
};
let ligadoW = true;
const ferr = browserTools({ send, mark: marca, painel: true, worker: { ligado: () => ligadoW, executar: (p) => respostaWorker(p) } });
const pp = ferr.find((t) => t.name === "perguntar_pagina");
check("só existe com worker (terminal não tem)", !!pp && !browserTools({ send, mark: marca }).some((t) => t.name === "perguntar_pagina"));
let saida = (await pp.handler({ tabId: 3, pergunta: "Qual o preço?" })).content[0].text;
check("lê a página inteira (até 150 mil caracteres) e marca a conversa", pedidoExt?.cmd === "read_page" && pedidoExt.a.maxChars === 150000 && marcou === 1);
check("worker recebe a pergunta e a página (e só isso)", /Qual o preço\?/.test(pedidoWorker.instrucao) && /Preço: R\$ 29,90/.test(pedidoWorker.conteudo) &&
  !("historico" in pedidoWorker) && !("mensagens" in pedidoWorker));
check("resposta do worker vem marcada como não confiável, com aviso fora do bloco", /<<<CONTEUDO_EXTERNO \w+>>>\nR\$ 29,90/.test(saida) &&
  /resposta do modelo auxiliar sobre a página/.test(saida) && /<<<FIM_CONTEUDO_EXTERNO \w+>>>\n\(Lido pelo modelo auxiliar claude-haiku-5-5/.test(saida), saida);
respostaWorker = async () => {
  throw new Error("tempo esgotado (60 s)");
};
saida = (await pp.handler({ tabId: 3, pergunta: "Qual o preço?" })).content[0].text;
check("worker falhou: cai na página inteira (comportamento de antes), marcada, com o motivo", /\(texto da página\)/.test(saida) && /Teclado TC193/.test(saida) &&
  /O modelo auxiliar não respondeu \(tempo esgotado/.test(saida), saida.slice(0, 300));
ligadoW = false;
saida = (await pp.handler({ tabId: 3, pergunta: "Qual o preço?" })).content[0].text;
check("worker desligado: página inteira", /Teclado TC193/.test(saida) && /desligado/.test(saida));

console.log("\n# Saída grande de comando ou arquivo (hook PostToolUse)");
const { condensarSaida, LIMITE_SAIDA_BASH } = await import("../chat/host.mjs");
const pastaS = path.join(tmp, "saidas");
let pedidoS = null;
const exec = async (p2) => {
  pedidoS = p2;
  return { texto: "Deu certo: 3 arquivos copiados.", modelo: "claude-haiku-5-5" };
};
check("saída pequena de Bash passa inteira", (await condensarSaida({ tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a\nb", stderr: "" } }, exec, pastaS)) === null);
const grandeS = "linha\n".repeat(3000);
let novoS = await condensarSaida({ tool_name: "Bash", tool_input: { command: "rsync -av x y" }, tool_response: { stdout: grandeS, stderr: "aviso", interrupted: false } }, exec, pastaS);
const arqS = /A saída completa está em (\S+) /.exec(novoS?.stdout || "")?.[1];
check("saída grande de Bash vira resumo + caminho do arquivo completo, no formato da ferramenta", novoS && novoS.stderr === "" && novoS.interrupted === false &&
  /resumida pelo modelo auxiliar claude-haiku-5-5: pode faltar detalhe ou ter erro/.test(novoS.stdout) && /\]\nDeu certo/.test(novoS.stdout), novoS?.stdout);
check("conversa que não leu página: sem bloco de conteúdo de página (nem 'vindo do Firefox')", !/CONTEUDO_EXTERNO|Firefox/.test(novoS?.stdout || ""), novoS?.stdout);
const execAlarme = async () => ({ texto: "O script roda rm -rf ~/build e lê .env e settings.json.", modelo: "claude-haiku-5-5" });
let semAlarme = await condensarSaida({ tool_name: "Bash", tool_input: { command: "cat build.sh" }, tool_response: { stdout: grandeS } }, execAlarme, pastaS);
check("...e sem alarme falso de prompt injection em saída comum", !/PROMPT INJECTION|🚨/.test(semAlarme?.stdout || ""), semAlarme?.stdout);
let marcadaS = await condensarSaida({ tool_name: "Bash", tool_input: { command: "curl x" }, tool_response: { stdout: grandeS } },
  async () => ({ texto: "Deu certo: página baixada.", modelo: "claude-haiku-5-5" }), pastaS, { marcada: true });
check("conversa que já leu página: o resumo vai marcado (pode carregar texto de página), com a origem certa",
  /<<<CONTEUDO_EXTERNO \w+>>>\nDeu certo/.test(marcadaS?.stdout || "") && /vindo de um comando\/arquivo numa conversa que já leu páginas/.test(marcadaS.stdout) &&
  !/escrito pela página/.test(marcadaS.stdout), marcadaS?.stdout);
check("arquivo completo guardado (0600), com stdout e stderr", arqS && fs.readFileSync(arqS, "utf8") === `${grandeS}\n[stderr]\naviso` &&
  (fs.statSync(arqS).mode & 0o777) === 0o600 && /^saida-[0-9a-f]{16}\.txt$/.test(path.basename(arqS)));
check("worker recebe o comando na instrução e a saída como conteúdo", /rsync -av x y/.test(pedidoS.instrucao) && pedidoS.conteudo.startsWith("linha"));
const persist = path.join(tmp, "persistida.txt");
fs.writeFileSync(persist, "z".repeat(LIMITE_SAIDA_BASH + 10));
novoS = await condensarSaida({ tool_name: "Bash", tool_input: { command: "x" }, tool_response: { stdout: "zz", persistedOutputPath: persist, persistedOutputSize: 9 } }, exec, pastaS);
check("saída que o Claude Code já guardou: o resumo usa a saída inteira e some a prévia", novoS && pedidoS.conteudo.length === LIMITE_SAIDA_BASH + 10 &&
  novoS.persistedOutputPath === undefined);
novoS = await condensarSaida({ tool_name: "Read", tool_input: { file_path: "/p/a.js" }, tool_response: { type: "text", file: { filePath: "/p/a.js", content: "c".repeat(50000), numLines: 900 } } }, exec, pastaS);
check("arquivo grande lido vira resumo + caminho pra ler com offset/limit", novoS?.type === "text" && novoS.file.numLines === 900 &&
  /leia \/p\/a\.js com Read usando offset\/limit/.test(novoS.file.content) && !/<<<CONTEUDO_EXTERNO/.test(novoS.file.content));
check("trecho pequeno de arquivo passa inteiro", (await condensarSaida({ tool_name: "Read", tool_input: {}, tool_response: { type: "text", file: { content: "pequeno" } } }, exec, pastaS)) === null);
let erroS = null;
try {
  await condensarSaida({ tool_name: "Bash", tool_input: {}, tool_response: { stdout: grandeS } }, async () => {
    throw new Error("caiu");
  }, pastaS);
} catch (e) {
  erroS = e;
}
check("worker falhou: o erro sobe (o hook deixa a saída original passar)", erroS?.message === "caiu");

if (process.env.WORKER_REAL === "1") {
  console.log("\n# Chamada de verdade pela assinatura (Haiku 5.5)");
  const real = W.criarWorker({ claudeBin: path.join(os.homedir(), ".local", "bin", "claude") });
  r = await real.executar({ instrucao: "Qual é o preço? Cite o trecho.", conteudo: "Teclado TC193. Preço: R$ 189. Frete grátis." + " ruído".repeat(300), tarefa: "teste-real" });
  check("assinatura: Haiku 5.5 responde certo", /189/.test(r.texto) && r.modelo === "claude-haiku-5-5", r.texto);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} FALHARAM` : ""}`);
process.exit(falhas ? 1 : 0);
