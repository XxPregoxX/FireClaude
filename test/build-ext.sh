#!/bin/sh
# Monta em $1 uma cópia da extensão SÓ PRA TESTE:
#  - porta 47899 (não briga com o Claude Code de verdade na 47823);
#  - loja.teste, permitido2.teste, 127.0.0.1 e localhost já concedidos (simula o usuário aprovando no prompt);
#  - janelas de confirmação abrem de verdade, mas a resposta vem do teste (POST /__confirm), não de um clique;
#  - ao iniciar, abre e libera abas privilegiadas (opções da extensão, about:...), simulando o usuário
#    clicando no ícone nelas, pra provar que nem assim as ferramentas agem nessas páginas.
set -eu
DEST="$1"
SRC="$(cd "$(dirname "$0")/.." && pwd)/extension"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
sed -i 's/ws:\/\/127.0.0.1:47823/ws:\/\/127.0.0.1:47899/' "$DEST/background.js"
# Token de teste (nunca o seu de verdade, que pode ter vindo junto no cp).
printf '{"token":"%s"}\n' "$(cat "$CLAUDE_FIREFOX_TOKEN_FILE")" >"$DEST/token.json"
grep -q 47899 "$DEST/background.js"
# Painel: programa local falso (outro nome, pra não mexer no de verdade) e páginas de teste do painel/Markdown.
sed -i 's/const NATIVE_HOST = "claude_firefox_chat";/const NATIVE_HOST = "claude_firefox_chat_teste";/' "$DEST/background.js"
grep -q claude_firefox_chat_teste "$DEST/background.js"
cp "$(dirname "$0")/extra/"* "$DEST/"
# Num Firefox headless não dá pra abrir a barra lateral; a página de teste do painel abre numa aba e é aceita
# só por isto (o sidebar.html de verdade continua tendo que vir sem aba).
python3 - "$DEST/background.js" <<'EOF'
import sys
p = sys.argv[1]; s = open(p).read()
old = 'typeof port.sender.url === "string" && port.sender.url.startsWith(browser.runtime.getURL("sidebar.html"));'
new = old[:-1] + ' || (port.name === "painel" && port.sender?.url === browser.runtime.getURL("teste-painel.html"));'
assert old in s
open(p, "w").write(s.replace(old, new))
EOF
python3 - "$DEST/manifest.json" <<'EOF'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m["permissions"] += ["*://loja.teste/*", "*://permitido2.teste/*", "*://127.0.0.1/*", "*://localhost/*"]
# A instrumentação conversa com o servidor de teste; imagem continua só 'self' (o teste de Markdown confere).
m["content_security_policy"] = m["content_security_policy"].replace("ws://127.0.0.1:47823", "ws://127.0.0.1:47899 http://loja.teste:8765")
assert "http://loja.teste:8765" in m["content_security_policy"]
open(p, "w").write(json.dumps(m, indent=2))
EOF
cat >> "$DEST/background.js" <<'EOF'

// ===== SÓ NO TESTE (test/build-ext.sh) =====
(async () => {
  const optionsUrl = browser.runtime.getURL("options.html");
  const shared = [];
  for (const url of [optionsUrl, "about:blank", "about:newtab", "about:addons", "about:config", "about:debugging", "about:preferences"]) {
    try {
      const t = await browser.tabs.create({ url, active: false });
      allowedTabs.add(t.id);
      shared.push(url);
    } catch (_) {}
  }
  const info = encodeURIComponent(JSON.stringify({ optionsUrl, shared }));
  const t = await browser.tabs.create({ url: `http://loja.teste:8765/info.html#${info}`, active: false });
  allowedTabs.add(t.id);
})();

// Abrir http://loja.teste:8765/__abrir-painel abre as páginas de teste do painel e do Markdown, e também o
// sidebar.html de verdade numa aba (que o background tem que recusar como painel, por estar numa aba).
browser.tabs.onUpdated.addListener((id, info) => {
  if (!info.url || !info.url.startsWith("http://loja.teste:8765/__abrir-painel")) return;
  for (const f of ["teste-painel.html", "teste-markdown.html", "sidebar.html"]) browser.tabs.create({ url: browser.runtime.getURL(f), active: false });
});
browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "__test_info" || sender.id !== browser.runtime.id) return;
  return Promise.resolve({ panelPorts: [...panelPorts].map((p) => p.sender.url), nativeConnected: !!nativePort });
});

// Abrir http://loja.teste:8765/__ligar-js liga a ferramenta javascript (o teste não tem como clicar nas opções).
browser.tabs.onUpdated.addListener((id, info) => {
  if (info.url && info.url.startsWith("http://loja.teste:8765/__ligar-js")) browser.storage.local.set({ allowJavascript: true });
});

// Confirmação: abre a janela de verdade e responde pelo mesmo caminho do botão (finish), com a decisão do teste.
{
  const realConfirm = confirmAction;
  confirmAction = (details) => {
    const result = realConfirm(details);
    (async () => {
      let entry;
      for (let i = 0; i < 200 && !entry; i++) {
        entry = [...pending.values()].find((e) => e.details === details && e.windowId != null);
        if (!entry) await sleep(50);
      }
      let t = null;
      for (let i = 0; entry && i < 40; i++) {
        [t] = await browser.tabs.query({ windowId: entry.windowId });
        if (t?.url?.startsWith("moz-extension:")) break;
        await sleep(50);
      }
      const r = await fetch("http://loja.teste:8765/__confirm", {
        method: "POST",
        body: JSON.stringify({ ...details, confirmTabId: t ? t.id : null, confirmUrl: t ? t.url : null }),
      });
      entry?.finish(await r.text());
    })();
    return result;
  };
}
EOF
