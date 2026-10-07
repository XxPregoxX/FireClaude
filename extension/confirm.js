// Janela de confirmação. Tudo vira texto (textContent): nada da página ou do Claude é interpretado como HTML.
const AVISOS = {
  envio: "Isso ENVIA um formulário.",
  download: "Isso BAIXA um arquivo pro seu computador.",
  javascript: "Código que roda na página com acesso a tudo que ela vê (sessão, cookies sem HttpOnly, campos preenchidos).",
  outro: "Isso leva pra OUTRO site. Confira o endereço inteiro: dados podem ir junto na URL.",
};

const $ = (id) => document.getElementById(id);
const buttons = [$("negar"), $("uma"), $("janela")];
buttons.forEach((b) => (b.disabled = true));

const answer = (decision) => browser.runtime.sendMessage({ type: "confirm:answer", decision });
$("negar").addEventListener("click", () => answer("deny"));
$("uma").addEventListener("click", () => answer("once"));
$("janela").addEventListener("click", () => answer("window"));

browser.runtime.sendMessage({ type: "confirm:get" }).then((d) => {
  if (!d) {
    $("titulo").textContent = "Pedido expirado.";
    return;
  }
  $("titulo").textContent = `O Claude quer ${d.action}`;
  $("host").textContent = d.host || "(desconhecido)";
  if (AVISOS[d.kind]) {
    $("aviso").textContent = `⚠️ ${AVISOS[d.kind]}`;
    $("aviso").hidden = false;
  }
  const rows = [
    ["Elemento (texto que aparece na tela)", d.element],
    ["Texto que vai ser digitado", d.text],
    ["Tecla", d.key],
    ["Opção", d.option],
    ["Endereço", d.url],
    ["Código", d.code],
  ];
  for (const [label, value] of rows) {
    if (value == null || value === "") continue;
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    const pre = document.createElement("pre");
    pre.textContent = value;
    dd.append(pre);
    $("detalhes").append(dt, dd);
  }
  if (d.windowHost) {
    $("janela").textContent = `Permitir agir em ${d.windowHost} por ${d.minutes} min`;
    $("janela").hidden = false;
  }
  // Atraso curto: evita aprovar sem querer com um clique que era pra outra janela.
  setTimeout(() => buttons.forEach((b) => (b.disabled = false)), 800);
});
