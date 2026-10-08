#!/bin/sh
# Teste de segurança ponta a ponta: UM Firefox headless com perfil temporário, fechado no final.
# Uso: ./test/run.sh        (./test/run.sh e2e roda também o server/test-e2e.mjs)
set -eu
cd "$(dirname "$0")/.."

avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
if [ "$avail" -lt 1500 ]; then
  echo "Só ${avail} MB de memória livre; precisa de 1500 (o Firefox de teste usa uns 400 MB e o notebook não aguenta aperto)."
  exit 1
fi

TMP=$(mktemp -d)
HTTP="" WEBEXT=""
cleanup() {
  # Mata o Firefox pelo perfil: matar só o web-ext deixa o Firefox órfão.
  pkill -f -- "-profile $TMP/profile" 2>/dev/null || true
  [ -n "$WEBEXT" ] && kill "$WEBEXT" 2>/dev/null || true
  [ -n "$HTTP" ] && kill "$HTTP" 2>/dev/null || true
  i=0
  while pgrep -f -- "-profile $TMP/profile" >/dev/null && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  pkill -9 -f -- "-profile $TMP/profile" 2>/dev/null || true
  rm -f "$HOME/.mozilla/native-messaging-hosts/claude_firefox_chat_teste.json" "$HOME/.config/mozilla/native-messaging-hosts/claude_firefox_chat_teste.json"
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

# Trava do Claude Code e programa do painel (sem Firefox): falham aqui antes de gastar memória abrindo o navegador.
node test/guard.mjs >"$TMP/guard.log" || { cat "$TMP/guard.log"; exit 1; }
echo "trava: $(tail -1 "$TMP/guard.log")"
node test/chat-host.mjs >"$TMP/chat.log" || { cat "$TMP/chat.log"; exit 1; }
echo "programa do painel: $(tail -1 "$TMP/chat.log")"
node test/worker.mjs >"$TMP/worker.log" || { cat "$TMP/worker.log"; exit 1; }
echo "modelo auxiliar: $(tail -1 "$TMP/worker.log")"
# CSS: comentário no meio de uma lista de seletores ("a, /* … */ b { … }") junta regras sem querer (já tirou a conversa
# da tela uma vez).
if grep -nPzo ',\s*/\*' extension/*.css >/dev/null; then echo "CSS: comentário dentro de lista de seletores"; grep -nP ',\s*/\*' extension/*.css; exit 1; fi

# Token e perfil só do teste: o servidor lê o token daqui e o UUID da extensão do prefs.js deste perfil.
export CLAUDE_FIREFOX_TOKEN_FILE="$TMP/token" CLAUDE_FIREFOX_PROFILE="$TMP/profile"
od -An -tx1 -N32 /dev/urandom | tr -d ' \n' >"$TMP/token"
sh test/build-ext.sh "$TMP/ext"
# Programa local FALSO do painel (nome _teste; o de verdade não é tocado). Sai no cleanup.
printf '#!/bin/sh\nexec "%s" "%s/test/fake-host.mjs"\n' "$(command -v node)" "$(pwd)" >"$TMP/fake-host.sh"
chmod 700 "$TMP/fake-host.sh"
for d in "$HOME/.mozilla/native-messaging-hosts" "$HOME/.config/mozilla/native-messaging-hosts"; do
  mkdir -p "$d"
  printf '{"name":"claude_firefox_chat_teste","description":"teste","path":"%s","type":"stdio","allowed_extensions":["claude-firefox@local"]}\n' \
    "$TMP/fake-host.sh" >"$d/claude_firefox_chat_teste.json"
done
mkdir -p "$TMP/profile" "$TMP/downloads"
mkdir -m 700 "$TMP/run" # XDG_RUNTIME_DIR do teste (o de verdade sempre existe)
tools/node_modules/.bin/web-ext run -s "$TMP/ext" --no-reload --no-input --arg=--headless \
  --firefox-profile "$TMP/profile" --keep-profile-changes \
  --pref network.dns.localDomains=loja.teste,outro.teste,permitido2.teste --pref dom.security.https_first=false \
  --pref browser.download.folderList=2 --pref "browser.download.dir=$TMP/downloads" --pref browser.download.useDownloadDir=true \
  --pref browser.download.always_ask_before_handling_new_types=false \
  >"$TMP/ff.log" 2>&1 &
WEBEXT=$!

i=0
until grep -q "Installed" "$TMP/ff.log"; do
  i=$((i + 1))
  if [ $i -gt 60 ]; then cat "$TMP/ff.log"; exit 1; fi
  sleep 0.5
done

export CLAUDE_FIREFOX_PORT=47899 XDG_RUNTIME_DIR="$TMP/run" DOWNLOAD_DIR="$TMP/downloads" # marca de contaminação fica no temporário
node test/seguranca.mjs # sobe o servidor das páginas de teste na 8765
node test/ponte.mjs     # autenticação da ponte WebSocket (M1)
node test/painel.mjs    # painel lateral: ponte nativa, confirmações na conversa, Markdown seguro
node test/leitura.mjs   # leitura de páginas modernas: caixa de rolagem, editável, carregamento, shadow DOM
if [ "${1:-}" = e2e ]; then
  python3 -m http.server 8765 -b 127.0.0.1 -d test/pages >/dev/null 2>&1 &
  HTTP=$!
  node server/test-e2e.mjs http://loja.teste:8765
fi
