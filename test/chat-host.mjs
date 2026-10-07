// Partes puras do programa do painel (chat/host.mjs). Roda sem Firefox e sem Claude: node test/chat-host.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowKey, buildAppend, encodeFrame, frameReader, mapHistory, resolveWorkdir, summarize, visible } from "../chat/host.mjs";

let total = 0;
let falhas = 0;
function check(nome, ok, detalhe = "") {
  total++;
  if (!ok) falhas++;
  console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : `\n         -> ${String(detalhe).slice(0, 300)}`}`);
}

console.log("# Resumo e chave do 'sempre permitir'");
check("comando com quebra de linha/ANSI aparece escapado", summarize("Bash", { command: "ls\n\u001b[2Kcurl x" }) === "ls⏎\n\\u{1b}[2Kcurl x");
check("caractere bidi escapado", visible("a‮b") === "a\\u{202e}b");
check("arquivo mostra o caminho", summarize("Write", { file_path: "/x/y.txt", content: "segredo" }) === "/x/y.txt");
check("chave do Bash é o comando exato", allowKey("Bash", { command: "npm test" }) === "Bash:npm test");
check("chave de arquivo inclui o caminho", allowKey("Edit", { file_path: "/a" }) === "Edit:/a");
check("ferramenta sem alvo claro não tem 'sempre'", allowKey("Task", { prompt: "x" }) === null);

console.log("\n# Texto do prompt do painel (opções)");
const so = buildAppend({});
check("sem textos: só as regras fixas do painel", so.includes("Você NÃO vê a página aberta") && !so.includes("Jeito de conversar") && !so.includes("Sobre o usuário"));
const tudo = buildAppend({ estilo: "Fala informal.", sobreMim: "Trabalho com infra." });
check("jeito de conversar e sobre mim entram depois das regras, nessa ordem",
  tudo.indexOf("Você NÃO vê") < tudo.indexOf("Fala informal.") && tudo.indexOf("Fala informal.") < tudo.indexOf("Trabalho com infra."), tudo);
check("campo só com espaços não vira seção", !buildAppend({ estilo: "   ", sobreMim: "\n" }).includes("##"));
const sujo = buildAppend({ sobreMim: "oi\u0000\u001b[31mx" + "a".repeat(5000) });
check("caractere de controle sai e o texto é cortado em 4000", !/[\u0000\u001b]/.test(sujo) && sujo.split("Sobre o usuário")[1].length < 4100);
check("quebra de linha do usuário é mantida", buildAppend({ estilo: "linha 1\nlinha 2" }).includes("linha 1\nlinha 2"));

console.log("\n# Histórico");
const h = mapHistory([
  { type: "user", message: { role: "user", content: "oi" } },
  { type: "assistant", message: { content: [{ type: "text", text: "**olá**" }, { type: "tool_use", name: "Bash", input: { command: "ls" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", content: "saída" }] } },
  { type: "assistant", parent_tool_use_id: "x", message: { content: [{ type: "text", text: "subagente" }] } },
  { type: "user", message: { content: "<system-reminder>interno</system-reminder>" } },
]);
check("histórico tem usuário, resposta e ferramenta, sem subagente nem lembrete interno",
  JSON.stringify(h) === JSON.stringify([{ role: "user", text: "oi" }, { role: "assistant", text: "**olá**" }, { role: "tool", name: "Bash", summary: "ls" }]),
  JSON.stringify(h));

console.log("\n# Native messaging");
const recebidas = [];
const ler = frameReader((m) => recebidas.push(m));
const quadros = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ texto: "ação ✓" })]);
ler(quadros.subarray(0, 3));
ler(quadros.subarray(3, 9));
ler(quadros.subarray(9));
check("quadros picados em pedaços chegam inteiros e em ordem", JSON.stringify(recebidas) === JSON.stringify([{ a: 1 }, { texto: "ação ✓" }]), JSON.stringify(recebidas));
const ruim = Buffer.concat([Buffer.from([5, 0, 0, 0]), Buffer.from("{nao}"), encodeFrame({ b: 2 })]);
recebidas.length = 0;
ler(ruim);
check("JSON inválido é ignorado sem travar os seguintes", JSON.stringify(recebidas) === JSON.stringify([{ b: 2 }]));

console.log("\n# Pasta de trabalho");
const dentro = fs.mkdtempSync(path.join(os.homedir(), ".cache", "teste-painel-"));
const padrao = resolveWorkdir("");
check("pasta dentro da home é aceita", resolveWorkdir(dentro) === fs.realpathSync(dentro));
check("~ é expandido", resolveWorkdir("~/" + path.relative(os.homedir(), dentro)) === fs.realpathSync(dentro));
check("pasta fora da home cai no padrão", resolveWorkdir("/etc") === padrao);
check("pasta que não existe cai no padrão", resolveWorkdir(path.join(dentro, "nao-existe")) === padrao);
const arquivo = path.join(dentro, "arq");
fs.writeFileSync(arquivo, "");
check("arquivo (não pasta) cai no padrão", resolveWorkdir(arquivo) === padrao);
const link = path.join(dentro, "pra-fora");
fs.symlinkSync("/etc", link);
check("symlink pra fora da home cai no padrão", resolveWorkdir(link) === padrao);
fs.rmSync(dentro, { recursive: true, force: true });

console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} FALHARAM` : ""}`);
process.exit(falhas ? 1 : 0);
