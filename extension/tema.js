// Tema do painel e da janelinha de confirmação: "auto" (segue o sistema), "claro" ou "escuro".
// Aplica cedo (antes do resto da página) pra não piscar no tema errado.
(() => {
  const aplicar = (tema) => {
    if (tema === "claro" || tema === "escuro") document.documentElement.dataset.tema = tema;
    else delete document.documentElement.dataset.tema;
  };
  browser.storage.local.get("tema").then(({ tema = "auto" }) => aplicar(tema));
  browser.storage.onChanged.addListener((ch, area) => {
    if (area === "local" && ch.tema) aplicar(ch.tema.newValue);
  });
  globalThis.trocarTema = async () => {
    const { tema = "auto" } = await browser.storage.local.get("tema");
    const proximo = { auto: "escuro", escuro: "claro", claro: "auto" }[tema] || "auto";
    await browser.storage.local.set({ tema: proximo });
    return proximo;
  };
})();
