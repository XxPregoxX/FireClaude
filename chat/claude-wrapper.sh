#!/bin/sh
# O SDK chama este script no lugar do claude. Ele grava o próprio PID (que continua o mesmo depois do exec)
# pro painel saber qual sessão marcar como contaminada, e roda o claude de verdade pelo link "claude", pro
# processo se chamar "claude" (é por esse nome que a trava hooks/guard.js acha a sessão).
set -eu
if [ -n "${CLAUDE_FIREFOX_PIDFILE:-}" ]; then
  umask 077
  printf '%s' "$$" >"$CLAUDE_FIREFOX_PIDFILE"
fi
exec "${CLAUDE_FIREFOX_BIN:?caminho do claude}" "$@"
