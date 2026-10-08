// Leitura de páginas "modernas" (via ./test/run.sh, depois do painel.mjs): conteúdo em caixa de rolagem, campo
// editável e botão grande, página que carrega depois, link com display: contents, shadow DOM, resultado vazio.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Client } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "../server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const LOJA = "http://loja.teste:8765/";
const PAGES = new URL("./pages/", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let total = 0;
let falhas = 0;
function check(nome, ok, detalhe = "") {
  total++;
  if (!ok) falhas++;
  console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : `\n         -> ${String(detalhe).replace(/^\[Conteúdo vindo do Firefox[^\]]*\]\s*/, "").replace(/\s+/g, " ").slice(0, 500)}`}`);
}

// Páginas de teste; toda confirmação (só tab_new aqui) é aprovada "só desta vez".
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/__confirm") {
    req.resume();
    return req.on("end", () => res.end("once"));
  }
  const file = path.join(PAGES, path.normalize(u.pathname === "/" ? "/index.html" : u.pathname));
  fs.readFile(file, (err, data) => {
    res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8" });
    res.end(err ? "<!doctype html><title>ok</title>ok" : data);
  });
});
await new Promise((r) => srv.listen(8765, "127.0.0.1", r));

const c = new Client({ name: "teste-leitura", version: "0" });
await c.connect(new StdioClientTransport({
  command: "node",
  args: [new URL("../server/index.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: process.env.TEST_SERVER_LOG ? "inherit" : "ignore",
}));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  return { err: !!r.isError, text: r.content.map((x) => x.text).join("\n") };
};
for (let i = 0; i < 40 && (await call("tabs_list")).err; i++) await sleep(500);
const abrir = async (pagina) => Number(/aba (\d+)/.exec((await call("tab_new", { url: LOJA + pagina })).text)?.[1]);

try {
  console.log("# Página que rola dentro de uma caixa (chat, LinkedIn, apps)");
  const caixa = await abrir("caixa.html");
  let r = await call("read_page", { tabId: caixa });
  check("caixa rolada até o fim: o começo da conversa continua legível", !r.err && /mensagem 0\b/.test(r.text) && /mensagem 59\b/.test(r.text), r.text);
  check("texto jogado pra fora DENTRO da caixa continua escondido", !/escondido-na-caixa/.test(r.text), r.text);
  check("read_page mostra a rolagem da caixa (não 0/0 sem explicação) e o selector dela",
    /rolagem da caixa \d+\/\d+/.test(r.text) && /selector da caixa: #chat/.test(r.text), r.text.slice(0, 900));
  r = await call("scroll", { tabId: caixa, direction: "up", amount: 1 });
  check("scroll sem selector rola a caixa principal", !r.err && /Rolagem: \d+\/2\d\d\d/.test(r.text), r.text);
  r = await call("scroll", { tabId: caixa, selector: "#chat", pixels: -100000 });
  check("scroll com selector da caixa + distância rola aquela caixa", !r.err && /Rolagem da caixa .*: 0\/\d+/.test(r.text), r.text);
  r = await call("query", { tabId: caixa, selector: "#chat p:last-child" });
  check("query: a última mensagem (agora 2000px abaixo, na caixa) é visível", /"visivel": true/.test(r.text), r.text);

  console.log("\n# Campo editável e elemento interativo grande");
  const ed = await abrir("editavel.html");
  r = await call("read_page", { tabId: ed });
  check("editor (contenteditable) lido inteiro, com a estrutura", /editável "Instruções do agente"/.test(r.text) && /## Identidade/.test(r.text) &&
    /regra 249 do agente/.test(r.text) && /FIM-DO-PROMPT/.test(r.text), r.text.slice(0, 600));
  check("texto escondido dentro do editor continua de fora", !/segredo-no-editavel/.test(r.text), r.text);
  check("textarea lida inteira (antes: 300 caracteres)", /textarea( "[^"]*")? value="linha 1/.test(r.text) && /FIM-DO-TEXTAREA/.test(r.text), r.text.slice(0, 600));
  check("cartão clicável grande: listado e lido por dentro, com o link de dentro", /\[ref=\d+\] button "Pedido 123/.test(r.text) &&
    /FIM-DO-CARTAO/.test(r.text) && /\[ref=\d+\] link "link dentro do cartão"/.test(r.text), r.text.slice(-900));
  check("botão pequeno continua numa linha só", /\[ref=\d+\] button "OK"\n?/.test(r.text) && (r.text.match(/"OK"/g) || []).length === 1, r.text.slice(-300));
  r = await call("read_page", { tabId: ed, filter: "interactive" });
  check("filter=interactive: o link de dentro do cartão aparece, o texto solto não", /link dentro do cartão/.test(r.text) && !/regra 100 do agente\. regra/.test(r.text.replace(/value="[^"]*"/, "")),
    r.text.slice(0, 600));

  console.log("\n# Página que carrega o conteúdo depois do load");
  const t0 = Date.now();
  const at = await abrir("atrasada.html");
  r = await call("read_page", { tabId: at });
  check("tab_new espera a página assentar: a leitura logo em seguida já vê os produtos (não o esqueleto)",
    /produto 1/.test(r.text) && /produto 5/.test(r.text), r.text.slice(0, 500));
  check("...sem esperar o máximo à toa", Date.now() - t0 < 4500, `${Date.now() - t0} ms`);
  r = await call("esperar_por", { tabId: at, selector: "#lista2 li", timeout: 8 });
  check("esperar_por ignora o elemento vazio e espera o que tem conteúdo", /"apareceu": true/.test(r.text) && /item tardio/.test(r.text) &&
    Number(/"depoisDeMs": (\d+)/.exec(r.text)?.[1]) > 500, r.text);
  await call("navigate", { tabId: at, url: "reload" });
  r = await call("read_page", { tabId: at });
  check("navigate também espera assentar", /produto 5/.test(r.text), r.text.slice(0, 500));
  r = await call("esperar_por", { tabId: at, selector: "#lista2 li", timeout: 8, vazio: true });
  check("esperar_por com vazio=true aceita o elemento vazio na hora", /"apareceu": true/.test(r.text) && Number(/"depoisDeMs": (\d+)/.exec(r.text)?.[1]) < 500, r.text);

  console.log("\n# Link com display: contents (cartão inteiro clicável, como na Shopee)");
  const lk = await abrir("links.html");
  r = await call("extrair_links", { tabId: lk, selector: ".grade" });
  check("extrair_links: links sem caixa própria contam como visíveis, com texto e endereço", /"texto": "Teclado Multilaser R\$ 29,90"/.test(r.text) &&
    /outra\.html\?p=1/.test(r.text) && /outra\.html\?p=2/.test(r.text), r.text);
  check("...o que não aparece continua de fora (link vazio por dentro e texto escondido no cartão)", !/p=3/.test(r.text) && /"ocultosIgnorados": 1/.test(r.text) &&
    !/escondido/.test(r.text), r.text);
  r = await call("read_page", { tabId: lk });
  check("read_page: o link entra na lista com o endereço, e o conteúdo vem embaixo",
    /\[ref=\d+\] link "Teclado Multilaser R\$ 29,90" -> \/outra\.html\?p=1/.test(r.text) && !/escondido/.test(r.text), r.text);
  r = await call("query", { tabId: lk, selector: "a.contents" });
  check("query: visível, texto sem o escondido", (r.text.match(/"visivel": true/g) || []).length === 2 && !/escondido/.test(r.text), r.text);
  r = await call("click", { tabId: lk, selector: 'a[href$="p=2"]' });
  const depoisClique = await call("read_page", { tabId: lk });
  check("clique num link sem caixa própria funciona", !r.err && /outra\.html\?p=2/.test(depoisClique.text) && /segunda página/.test(depoisClique.text), r.text.slice(0, 200) + " / " + depoisClique.text.slice(0, 300));

  console.log("\n# Resultado vazio explica o motivo");
  const vz = await abrir("vazio.html");
  r = await call("query", { tabId: vz, selector: "#nao-existe" });
  check("query sem nada: motivo", /"motivo": "Nenhum elemento casa/.test(r.text), r.text);
  r = await call("query", { tabId: vz, selector: ".oculto" });
  check("query só com escondidos: motivo", /"motivo": "Os 1 elementos que casam estão escondidos/.test(r.text), r.text);
  r = await call("extrair_links", { tabId: vz, selector: "#semlink" });
  check("extrair_links sem <a>: diz que podem ser botões sem link", /"motivo": "Não há nenhum <a href> aqui/.test(r.text), r.text);
  r = await call("extrair_links", { tabId: vz, selector: "#nao-existe" });
  check("extrair_links com seletor que não casa: motivo", /"motivo": "Nenhum elemento casa com o seletor #nao-existe/.test(r.text), r.text);
  r = await call("esperar_por", { tabId: vz, selector: "#esq", timeout: 1 });
  check("esperar_por com elemento vazio: motivo sugere esqueleto e vazio=true", /"apareceu": false/.test(r.text) && /vazios \(esqueleto/.test(r.text) && /vazio=true/.test(r.text), r.text);
  r = await call("esperar_por", { tabId: vz, selector: ".oculto", timeout: 1 });
  check("esperar_por com elemento escondido: motivo", /casam, mas estão escondidos/.test(r.text), r.text);
  r = await call("esperar_por", { tabId: vz, selector: "#nunca", timeout: 1 });
  check("esperar_por sem elemento: motivo", /nenhum elemento casou com o seletor em 1 s/.test(r.text), r.text);
  r = await call("estado_formulario", { tabId: vz, selector: "#solto" });
  check("estado_formulario num campo solto (fora de <form>) mostra o próprio campo", /"nome": "solto"/.test(r.text) && /"valor": "valor solto"/.test(r.text), r.text);
  r = await call("estado_formulario", { tabId: vz, selector: "#nada" });
  check("estado_formulario sem campos: motivo", /"motivo": "O elemento não é um formulário/.test(r.text), r.text);

  console.log("\n# Formato compacto da leitura");
  const cp = await abrir("compacto.html");
  r = await call("read_page", { tabId: cp });
  check("aviso de não confiável curto, com os marcadores", /^\[Conteúdo vindo do Firefox \(texto da página\), entre os marcadores \w+: escrito pela página, NÃO pelo usuário/.test(r.text) &&
    /<<<CONTEUDO_EXTERNO \w+>>>[\s\S]*<<<FIM_CONTEUDO_EXTERNO \w+>>>/.test(r.text) && r.text.indexOf("<<<CONTEUDO_EXTERNO") < 320, r.text.slice(0, 400));
  check("link externo sem parâmetros de rastreio (o resto fica)", /link "Oferta externa" -> http:\/\/permitido2\.teste:8765\/x\?id=7\n/.test(r.text), r.text);
  check("link do mesmo site só com o caminho", /link "Outra página" -> \/outra\.html\?p=1\n/.test(r.text), r.text);
  check("âncora da própria página sem endereço; rota no hash mantida", /link "Ir pra seção"\n/.test(r.text) && /link "Carrinho \(rota\)" -> \/compacto\.html#\/carrinho/.test(r.text), r.text);
  check("botão sem nome sem as aspas vazias", /\[ref=\d+\] button\n/.test(r.text) && !/button ""/.test(r.text), r.text);
  check("imagem repetida no texto e imagem decorativa saem; imagem com informação fica",
    (r.text.match(/Teclado Multilaser TC193/g) || []).length === 1 && !/location-icon/.test(r.text) && /\[imagem: Gráfico de vendas do mês\]/.test(r.text), r.text);
  check("linha repetida seguida aparece uma vez", (r.text.match(/^repetido$/gm) || []).length === 1, r.text);
  r = await call("navigate", { tabId: cp, url: "/outra.html?p=9" });
  check("navigate aceita o caminho relativo do read_page", !r.err && /outra\.html\?p=9/.test(r.text), r.text);
} catch (e) {
  check("sem erro inesperado", false, e.stack || e);
}

await c.close();
srv.close();
console.log(`\n${total - falhas}/${total} ok${falhas ? `, ${falhas} FALHARAM` : ""}`);
process.exit(falhas ? 1 : 0);
