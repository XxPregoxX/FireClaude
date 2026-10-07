// Markdown das respostas do Claude → DOM seguro, pro painel lateral.
// - HTML cru desligado: qualquer tag no texto vira texto escapado (o renderer "html" escapa).
// - Imagem nunca carrega: vira um aviso com o endereço (sem <img>; a CSP das páginas da extensão também barra).
// - Link não tem href: vai em data-href e só abre por clique, depois de mostrar o destino real (sidebar.js).
// - DOMPurify por cima, com lista fechada de tags e atributos, devolvendo DOM (sem innerHTML no painel).
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const md = new marked.Marked({ gfm: true, breaks: true, async: false });
  md.use({
    renderer: {
      html(token) {
        return esc(token.text);
      },
      image(token) {
        return `<span class="img-bloqueada">[imagem não carregada: ${esc(token.text || "sem descrição")} · ${esc(token.href)}]</span>`;
      },
      link(token) {
        return `<a data-href="${esc(token.href)}">${this.parser.parseInline(token.tokens)}</a>`;
      },
      checkbox(token) {
        return token.checked ? "☑ " : "☐ ";
      },
    },
  });

  const ALLOWED_TAGS = ["p", "br", "strong", "em", "del", "code", "pre", "blockquote", "ul", "ol", "li", "table", "thead",
    "tbody", "tr", "th", "td", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a", "span"];
  const ALLOWED_ATTR = ["data-href", "class", "align", "start"];

  globalThis.renderMarkdown = (text) =>
    DOMPurify.sanitize(md.parse(String(text ?? "")), {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      RETURN_DOM_FRAGMENT: true,
    });
})();
