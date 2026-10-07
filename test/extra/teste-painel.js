// SÓ NO TESTE: faz o papel do painel lateral (que num Firefox headless não dá pra abrir) e repassa tudo pro teste.
const port = browser.runtime.connect({ name: "painel" });
const manda = (m) => fetch("http://loja.teste:8765/__panel/in", { method: "POST", body: JSON.stringify(m) }).catch(() => {});
port.onMessage.addListener(manda);
port.onDisconnect.addListener(() => manda({ type: "__desconectado" }));
(async () => {
  for (;;) {
    let lista = [];
    try {
      lista = await (await fetch("http://loja.teste:8765/__panel/out")).json();
    } catch (_) {
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const m of lista) {
      if (m.__info) manda({ type: "__info", info: await browser.runtime.sendMessage({ type: "__test_info" }) });
      else if (m.__fechar) port.disconnect();
      else port.postMessage(m);
    }
  }
})();
