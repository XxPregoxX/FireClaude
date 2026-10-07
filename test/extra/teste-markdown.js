// SÓ NO TESTE: renderiza Markdown malicioso com o mesmo markdown.js do painel e manda o resultado pro teste.
const casos = {
  html: 'oi <img src="http://loja.teste:8765/__pixel?html" onerror="alert(1)"><script>alert(2)</script><b onclick="x()">negrito</b>',
  imagem: "![segredo](http://loja.teste:8765/__pixel?md=SEGREDO)",
  link: "[clique](http://loja.teste:8765/__pixel?link) e <http://loja.teste:8765/__pixel?auto>",
  jslink: "[x](javascript:alert(1)) [y](data:text/html,<script>alert(1)</script>)",
  tabela: "| a | b |\n|---|---|\n| **1** | `2` |",
  codigo: "```js\nconst x = '<img src=x onerror=alert(1)>';\n```",
  estilo: '<div style="background:url(http://loja.teste:8765/__pixel?css)">x</div>',
  svg: '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  lista: "- [x] feito\n- [ ] falta\n1. um\n2. dois",
};
const out = {};
for (const [nome, md] of Object.entries(casos)) {
  const div = document.createElement("div");
  div.append(renderMarkdown(md));
  document.getElementById("saida").append(div); // no DOM de verdade: se algo fosse carregar, carregaria aqui
  out[nome] = div.innerHTML;
}
// A CSP da página da extensão também tem que barrar imagem remota, mesmo se alguma escapasse do Markdown.
const img = new Image();
img.src = "http://loja.teste:8765/__pixel?csp";
document.body.append(img);
setTimeout(() => {
  fetch("http://loja.teste:8765/__md", { method: "POST", body: JSON.stringify(out) });
}, 1500);
