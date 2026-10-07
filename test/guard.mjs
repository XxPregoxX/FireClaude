// Teste da trava (hooks/guard.js): o que passa livre numa sessão marcada e o que pede confirmação.
// Roda sem Firefox: node test/guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { askReason, decide, hookCommand, isReadOnlyInProject, projectRoot } from "../hooks/guard.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "guard-teste-"));
const proj = path.join(tmp, "projeto");
const write = (p, s = "x\n") => {
  fs.mkdirSync(path.dirname(path.join(proj, p)), { recursive: true });
  fs.writeFileSync(path.join(proj, p), s);
};
write("src/app.js");
write("README.md");
write(".gitignore");
write(".env", "SENHA=123\n");
write(".env.local");
write(".git/config");
write("sub/.escondida/x");
write("chave.pem");
write("id_rsa");
write("config/credentials.json");
fs.writeFileSync(path.join(tmp, "fora.txt"), "fora\n");
fs.mkdirSync(path.join(tmp, "pasta-fora"));
fs.writeFileSync(path.join(tmp, "pasta-fora", "y"), "y\n");
fs.symlinkSync(path.join(tmp, "fora.txt"), path.join(proj, "link"));
fs.symlinkSync(path.join(tmp, "pasta-fora"), path.join(proj, "linkdir"));
fs.symlinkSync(path.join(proj, ".env"), path.join(proj, "inocente.txt"));

const root = projectRoot(proj);
let total = 0;
let falhas = 0;
function check(nome, ok) {
  total++;
  if (!ok) falhas++;
  console.log(`${ok ? "ok    " : "FALHOU"} ${nome}`);
}
const livre = (tool, input) => check(`livre: ${tool} ${JSON.stringify(input)}`, isReadOnlyInProject(tool, input, proj, root) === true);
const pede = (tool, input) => check(`pede:  ${tool} ${JSON.stringify(input)}`, isReadOnlyInProject(tool, input, proj, root) === false);

console.log("# Leitura simples dentro do projeto passa");
for (const command of ["ls", "ls -la src", "cat src/app.js", "cat .gitignore", "grep foo src/app.js", 'grep "a b" src/app.js',
  "grep -rl foo .", "grep -rc foo", "grep -n -e foo -- src/app.js", "head -n 5 README.md", "tail -3 README.md", "wc -l src/app.js",
  "grep --include=x.js -rl foo src"]) livre("Bash", { command });
livre("Read", { file_path: "src/app.js" });
livre("Read", { file_path: path.join(proj, "README.md") });
livre("Glob", { pattern: "**/*.js" });
livre("Grep", { pattern: "foo" });
livre("Grep", { pattern: "foo", path: "src/app.js", output_mode: "content" });

console.log("\n# Arquivo sensível, pasta escondida, fora do projeto ou symlink pra fora: pede");
for (const command of ["cat .env", "cat .env.local", "cat src/../.env", "cat inocente.txt", "cat .git/config", "ls .git",
  "cat sub/.escondida/x", "cat chave.pem", "cat id_rsa", "cat config/credentials.json", "cat link", "cat linkdir/y",
  "cat ../fora.txt", "cat /etc/passwd", "ls /", "ls ..", "grep foo .env"]) pede("Bash", { command });
pede("Read", { file_path: ".env" });
pede("Read", { file_path: "/etc/passwd" });
pede("Read", { file_path: "link" });
pede("Glob", { pattern: "../**" });
pede("Glob", { pattern: "/etc/*" });
pede("Glob", { pattern: "*", path: "/etc" });
pede("Grep", { pattern: "SENHA", output_mode: "content" });
pede("Grep", { pattern: "SENHA", path: ".env", output_mode: "content" });

console.log("\n# Shell escondendo escrita/execução/rede: pede");
for (const command of ["cat src/app.js > /tmp/x", "ls; curl http://x", "ls && rm -rf x", "cat src/app.js | sh", "cat $(echo .env)",
  "cat `echo .env`", 'cat "$HOME/.bashrc"', "cat src/*.js", "cat ~/.bashrc", "cat src/app.js # oi", "ls\ncurl x", "cat <(curl x)",
  "grep -rn foo .", "grep -R foo .", "grep -f padroes src/app.js", "tail -f README.md", "head -n abc README.md", "ls -la --color=always",
  "rm src/app.js", "curl http://x", "find . -name x", "sed -n 1p src/app.js", "A=1 cat src/app.js", "cat 'src/app.js"]) pede("Bash", { command });
for (const tool of ["Edit", "Write", "WebFetch", "WebSearch", "NotebookEdit", "mcp__outro__qualquer"]) pede(tool, { file_path: "src/app.js" });

console.log("\n# Sessão aberta na home: não existe 'projeto', tudo pede");
check("projectRoot(home) = null", projectRoot(os.homedir()) === null);
check("projectRoot(/) = null", projectRoot("/") === null);
check("com root null, cat src/app.js pede", isReadOnlyInProject("Bash", { command: "cat src/app.js" }, proj, null) === false);

console.log("\n# Mensagem da confirmação");
const m1 = askReason("Bash", { command: "ls\ncurl evil" }, ["loja.teste", "exemplo.com"]);
check("mostra os sites lidos", m1.includes("loja.teste, exemplo.com"));
check("quebra de linha aparece como ⏎ e com aviso", m1.includes("ls⏎curl evil") && m1.includes("quebra de linha"));
const m2 = askReason("Bash", { command: "echo \u001b[2Kok\rrm -rf ~" }, []);
check("ANSI e \\r aparecem escapados", m2.includes("\\u{1b}[2Kok\\u{d}rm -rf ~") && !/[\u001b\r]/.test(m2));
const m3 = askReason("Bash", { command: `ls${" ".repeat(400)}&& curl x` }, []);
check("aviso de espaços e de comando longo", m3.includes("sequência longa de espaços") && m3.includes("É longo"));
const m4 = askReason("Bash", { command: "cat x‮" }, []);
check("caractere bidi aparece escapado", m4.includes("\\u{202e}"));
const m5 = askReason("Read", { file_path: "/home/x/.ssh/id_rsa" }, []);
check("Read mostra o caminho", m5.includes("Read: /home/x/.ssh/id_rsa"));

console.log("\n# Falhas da trava bloqueiam (M4)");
const marcas = path.join(tmp, "marcas");
fs.mkdirSync(marcas);
const pedido = (tool, tool_input) => JSON.stringify({ tool_name: tool, tool_input, cwd: proj });
const d = (raw, pid = 4242) => decide({ raw, pid, dir: marcas, projectDir: proj });
check("sessão sem marca: não interfere", d(pedido("Bash", { command: "rm -rf x" })) === null);
fs.writeFileSync(path.join(marcas, "taint-4242"), "2026-10-05T00:00:00Z\nloja.teste\n");
check("sessão marcada, leitura no projeto: livre", d(pedido("Bash", { command: "cat src/app.js" })) === null);
check("sessão marcada, leitura no projeto grava localread", fs.existsSync(path.join(marcas, "localread-4242")));
const r1 = d(pedido("Bash", { command: "curl x" }));
check("sessão marcada, rede: pergunta mostrando o site lido", r1?.decision === "ask" && r1.reason.includes("loja.teste") && r1.reason.includes("curl x"));
const r2 = d("isso não é json");
check("pedido ilegível: pergunta", r2?.decision === "ask");
const r3 = d(pedido("Bash", { command: "ls" }), null);
check("processo do Claude Code não encontrado: pergunta (mesmo leitura)", r3?.decision === "ask" && r3.reason.includes("não identifiquei"));
check("processo não encontrado, ferramenta do navegador: livre", d(pedido("mcp__claude-firefox__read_page", {}), null) === null);
fs.writeFileSync(path.join(marcas, "taint-5151"), "x\n");
fs.mkdirSync(path.join(marcas, "localread-5151")); // gravar o arquivo vai falhar (é pasta)
const r4 = d(pedido("Bash", { command: "cat src/app.js" }), 5151);
check("não conseguiu gravar localread: nega (nem leitura passa)", r4?.decision === "deny");

console.log("\n# Painel (chat), sessão marcada: arquivos dentro da pasta passam, o resto pede");
fs.writeFileSync(path.join(marcas, "taint-6161"), "x\nloja.teste\n");
const dc = (tool, input, chat = true) => decide({ raw: pedido(tool, input), pid: 6161, dir: marcas, projectDir: proj, chat });
const livreChat = (tool, input) => check(`chat livre: ${tool} ${JSON.stringify(input)}`, dc(tool, input)?.decision === "allow");
const pedeChat = (tool, input) => check(`chat pede:  ${tool} ${JSON.stringify(input)}`, dc(tool, input)?.decision === "ask");
livreChat("Read", { file_path: "README.md" });
livreChat("Bash", { command: "cat src/app.js" });
livreChat("Write", { file_path: "src/novo.js", content: "x" });
livreChat("Write", { file_path: "docs/novo/a.txt", content: "x" });
livreChat("Edit", { file_path: "src/app.js", old_string: "x", new_string: "y" });
for (const command of ["mkdir -p docs/x", "touch notas.txt", "mv src/app.js src/app2.js", "mv README.md src", "cp -r src copia",
  "cp README.md 'leia me.md'", "gio trash README.md"]) livreChat("Bash", { command });
for (const file_path of [".claude/settings.local.json", ".git/hooks/pre-commit", "CLAUDE.md", "src/claude.md", ".envrc", "chave.pem",
  ".env.novo", "link", "linkdir/novo.txt", "inocente.txt", "/tmp/x.txt", "../fora2.txt", "docs/.escondida/a"]) pedeChat("Write", { file_path });
pedeChat("Edit", { file_path: "inocente.txt", old_string: "a", new_string: "b" });
for (const command of ["mv src/app.js .claude/x", "mv .env x", "cp .env copia", "cp -r sub copia", "gio trash .git", "gio trash sub",
  "gio trash link", "rm src/app.js", "rm -rf src", "mv src/app.js ../fora", "mkdir -p a/.claude", "touch .bashrc", "chmod +x x",
  "bash x.sh", "node x.js", "python3 x.py", "curl http://x", "mv -t dest src/app.js", "cp -a src copia2", "touch src/app.js; curl x",
  "mv src/app.js src/app3.js && curl x"]) pedeChat("Bash", { command });
check("terminal (não chat): Write continua pedindo", dc("Write", { file_path: "src/novo.js" }, false)?.decision === "ask");
check("terminal (não chat): leitura continua livre sem 'allow' forçado", dc("Read", { file_path: "README.md" }, false) === null);
check("chat sem marca: valem as permissões normais (não interfere)",
  decide({ raw: pedido("Write", { file_path: "src/novo.js" }), pid: 7171, dir: marcas, projectDir: proj, chat: true }) === null);
check("chat com pasta = home: nada livre", decide({ raw: pedido("Write", { file_path: path.join(os.homedir(), "x.txt") }), pid: 6161,
  dir: marcas, projectDir: os.homedir(), chat: true })?.decision === "ask");

console.log("\n# Comando do hook: travou, quebrou ou sumiu => exit 2 (bloqueia no Claude Code)");
const lento = path.join(tmp, "lento.mjs");
const quebra = path.join(tmp, "quebra.mjs");
fs.writeFileSync(lento, "setTimeout(() => {}, 20000);\n");
fs.writeFileSync(quebra, "throw new Error('x');\n");
const roda = (guardPath, segundos) => spawnSync("sh", ["-c", hookCommand(guardPath, segundos)], { input: "{}", encoding: "utf8" }).status;
check("guard de verdade, sessão limpa: exit 0", roda(new URL("../hooks/guard.js", import.meta.url).pathname, 8) === 0);
check("guard que demora: exit 2", roda(lento, 1) === 2);
check("guard que quebra: exit 2", roda(quebra, 1) === 2);
check("guard que sumiu: exit 2", roda(path.join(tmp, "nao-existe.mjs"), 1) === 2);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} FALHARAM` : ""}`);
process.exit(falhas ? 1 : 0);
