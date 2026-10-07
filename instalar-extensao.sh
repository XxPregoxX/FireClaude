#!/bin/sh
# Gera o token da ponte (se ainda não existe), empacota a extensão e instala no escopo de sistema do Firefox
# (onde o Fedora aceita extensão sem assinatura). Rode de novo sempre que mudar algo em extension/.
#   ./instalar-extensao.sh          token + instala (pede sudo)
#   ./instalar-extensao.sh --token  só token + programa do painel, sem sudo (pra carregar como temporária)
set -e
cd "$(dirname "$0")"
ID="claude-firefox@local"
DEST="/usr/lib64/mozilla/extensions/{ec8030f7-c20a-464f-9b0e-13a3a9e97384}"
TOKEN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-firefox"

# Token compartilhado entre a extensão e o servidor MCP. Só você lê (0600); nunca trafega na conexão.
umask 077
mkdir -p "$TOKEN_DIR"
if [ ! -s "$TOKEN_DIR/token" ]; then
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' >"$TOKEN_DIR/token"
  echo "Token novo gerado em $TOKEN_DIR/token"
fi
printf '{"token":"%s"}\n' "$(cat "$TOKEN_DIR/token")" >extension/token.json
echo "extension/token.json atualizado (fora do git)."

# Painel lateral: programa local que o Firefox abre via native messaging (só esta extensão pode chamar).
# O Firefox abre o programa com PATH mínimo, então os caminhos vão absolutos.
NODE="$(command -v node)"
CLAUDE="$(command -v claude || echo "$HOME/.local/bin/claude")"
[ -d chat/node_modules ] || (cd chat && npm install --no-audit --no-fund)
printf '{"claude":"%s","node":"%s","path":"%s"}\n' "$CLAUDE" "$NODE" "$PATH" >chat/config.json
printf '#!/bin/sh\nexec "%s" "%s/chat/host.mjs"\n' "$NODE" "$(pwd)" >chat/host.sh
chmod 700 chat/host.sh
for d in "$HOME/.mozilla/native-messaging-hosts" "$HOME/.config/mozilla/native-messaging-hosts"; do
  mkdir -p "$d"
  printf '{\n  "name": "claude_firefox_chat",\n  "description": "Painel do Claude no Firefox",\n  "path": "%s/chat/host.sh",\n  "type": "stdio",\n  "allowed_extensions": ["%s"]\n}\n' "$(pwd)" "$ID" >"$d/claude_firefox_chat.json"
done
echo "Programa do painel registrado (native messaging, só pra $ID)."

# Ajuste visual da barra lateral do Firefox (firefox/claude-firefox.css), num arquivo próprio importado pelo
# userChrome.css de cada perfil. Perfil cujo chrome/ é link pra um tema fica de fora:
# o tema é quem cuida do userChrome.css dele.
for base in "$HOME/.config/mozilla/firefox" "$HOME/.mozilla/firefox"; do
  [ -d "$base" ] || continue
  for prof in "$base"/*/; do
    prof="${prof%/}"
    [ -f "$prof/prefs.js" ] || continue
    if [ -L "$prof/chrome" ]; then
      echo "Barra lateral: $(basename "$prof") usa o chrome/ de um tema; não mexi (o tema cuida disso)."
      continue
    fi
    mkdir -p "$prof/chrome"
    cp firefox/claude-firefox.css "$prof/chrome/claude-firefox.css"
    uc="$prof/chrome/userChrome.css"
    if ! grep -qs 'claude-firefox\.css' "$uc"; then
      # @import tem que vir antes de qualquer outra regra.
      { echo '@import url("claude-firefox.css"); /* claude-firefox: barra lateral */'; cat "$uc" 2>/dev/null || true; } >"$uc.novo"
      mv "$uc.novo" "$uc"
    fi
    # O Firefox só lê userChrome.css com esta opção ligada.
    if ! grep -qs 'toolkit.legacyUserProfileCustomizations.stylesheets' "$prof/user.js"; then
      echo 'user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true); // claude-firefox: barra lateral' >>"$prof/user.js"
    fi
    echo "Barra lateral ajustada no perfil $(basename "$prof") (vale depois de reiniciar o Firefox)."
  done
done
[ "${1:-}" = "--token" ] && exit 0

OUT="$(mktemp -d)"
(cd extension && zip -qr -X "$OUT/$ID.xpi" . -x '*.DS_Store')
echo "Copiando pra $DEST (vai pedir senha)..."
# Dono root, grupo seu, sem leitura pra outros usuários: o .xpi leva o token.
sudo install -m 640 -o root -g "$(id -gn)" "$OUT/$ID.xpi" "$DEST/$ID.xpi"
rm -rf "$OUT"
echo "Pronto. Reinicie o Firefox; na primeira vez ele pergunta se você quer ativar a extensão \"Claude no Firefox\"."
