#!/usr/bin/env python3
"""Medidas das conversas do painel (as conversas salvas pelo Claude Code em ~/.claude/projects).

Só lê arquivos locais. Por padrão mostra só números, nada do conteúdo das conversas.

  python3 test/analise-conversas.py                      medidas de todas as conversas do painel
  python3 test/analise-conversas.py --desde 2026-10-07T18:00 --ate ...   só um período (hora local)
  python3 test/analise-conversas.py --comparar 2026-10-07T18:00          antes x depois de uma data
  python3 test/analise-conversas.py --trace <id da conversa>             ferramenta por ferramenta (mostra conteúdo)
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime

HOME = os.path.expanduser("~")
ESTADO = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(HOME, ".config"), "claude-firefox", "chat-sessions.json")
NAVEGADOR = "mcp__claude-firefox__"
NAO_CONSIGO = re.compile(
    r"n[ãa]o (consigo|d[áa] pra) (ver|ler|enxergar|acessar)|n[ãa]o (est[áa]|foi) liberad|clica no [íi]cone|clique no [íi]cone|"
    r"n[ãa]o est[áa] leg[íi]vel|Permitir este site|Liberar esta aba", re.I)


def ler_jsonl(caminho):
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            try:
                yield json.loads(linha)
            except json.JSONDecodeError:
                continue


def blocos(m):
    c = (m.get("message") or {}).get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return c if isinstance(c, list) else []


def texto_resultado(b):
    c = b.get("content")
    if isinstance(c, list):
        return " ".join(x.get("text", "") for x in c if isinstance(x, dict))
    return str(c or "")


def quando(m):
    ts = m.get("timestamp") or ""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def conversas_do_painel():
    try:
        estado = json.load(open(ESTADO, encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        sys.exit(f"Não achei {ESTADO} (o painel ainda não foi usado?).")
    for sid in estado.get("sessions", {}):
        achados = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{sid}.jsonl"))
        if achados:
            yield sid, achados[0]


# US$ por milhão de tokens (preço de API, 2026-10): entrada, escrita de cache 5 min, escrita 1 h, leitura de cache, saída.
# Plano por assinatura não cobra assim, mas o limite de uso pesa mais ou menos na mesma proporção.
# Haiku 5.5: preço até 100 mil tokens de prompt (o modelo auxiliar nunca passa de 50 mil).
PRECOS = {
    "claude-opus-5-5": (4.0, 5.0, 8.0, 0.20, 20.0),
    "claude-sonnet-5-5": (2.0, 2.5, 4.0, 0.10, 10.0),
    "claude-haiku-5-5": (0.10, 0.125, 0.20, 0.01, 0.50),
    "claude-haiku-4-5": (1.0, 1.25, 2.0, 0.10, 5.0),
}
USO_WORKER = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.join(HOME, ".cache"), "claude-firefox", "worker-uso.jsonl")


def chamadas_worker():
    """Chamadas do modelo auxiliar (registro do programa do painel): (sessão, quando, custo US$, tarefa)."""
    out = []
    try:
        linhas = open(USO_WORKER, encoding="utf-8").read().splitlines()
    except OSError:
        return out
    for l in linhas:
        try:
            d = json.loads(l)
        except json.JSONDecodeError:
            continue
        if d.get("erro"):
            continue
        if d.get("provedor") == "local":
            c = 0.0
        elif isinstance(d.get("custoUsd"), (int, float)):
            c = float(d["custoUsd"])  # pela assinatura o Claude Code já informa o custo
        else:
            c = custo(d.get("modelo"), {"input_tokens": d.get("entrada") or 0, "output_tokens": d.get("saida") or 0,
                                        "cache_creation_input_tokens": d.get("escritaCache") or 0, "cache_read_input_tokens": d.get("leituraCache") or 0})
        try:
            q = datetime.fromisoformat(d["quando"].replace("Z", "+00:00")).astimezone()
        except (KeyError, ValueError):
            continue
        out.append((d.get("sessionId"), q, c, d.get("tarefa")))
    return out


def custo(modelo, u):
    p = next((v for k, v in PRECOS.items() if (modelo or "").startswith(k)), None)
    if not p:
        return 0.0
    cc = u.get("cache_creation") or {}
    h1 = cc.get("ephemeral_1h_input_tokens", 0)
    m5 = cc.get("ephemeral_5m_input_tokens", u.get("cache_creation_input_tokens", 0) - h1)
    return (u.get("input_tokens", 0) * p[0] + m5 * p[1] + h1 * p[2] + u.get("cache_read_input_tokens", 0) * p[3] +
            u.get("output_tokens", 0) * p[4]) / 1e6


def turnos(caminho, worker=()):
    """Divide a conversa em turnos: uma mensagem do usuário + o que veio até a próxima. worker: chamadas do modelo
    auxiliar desta conversa, somadas na mensagem em que aconteceram."""
    lista = list(_turnos(caminho))
    for i, t in enumerate(lista):
        fim = lista[i + 1]["quando"] if i + 1 < len(lista) else None
        t["custo_worker"] = sum(c for _, q, c, _ in worker if t["quando"] and q >= t["quando"] and (fim is None or q < fim))
    return lista


def _turnos(caminho):
    atual = None
    vistos = set()  # a mesma chamada à API aparece em várias linhas (uma por bloco)
    for m in ler_jsonl(caminho):
        bs = blocos(m)
        msg = m.get("message") or {}
        if m.get("type") == "assistant" and msg.get("usage") and msg.get("id") not in vistos:
            vistos.add(msg.get("id"))
            if atual:
                atual["custo"] += custo(msg.get("model"), msg["usage"])
        if m.get("type") == "user":
            digitado = [b.get("text", "") for b in bs if b.get("type") == "text" and not b.get("text", "").lstrip().startswith("<")]
            digitado = [t for t in digitado if t.strip() and not t.startswith("[Request interrupted")]
            if digitado:
                if atual:
                    yield atual
                atual = {"quando": quando(m), "ferramentas": [], "resultados": [], "respostas": [], "custo": 0.0}
                continue
        if not atual:
            continue
        for b in bs:
            if b.get("type") == "tool_use":
                atual["ferramentas"].append((b.get("name", ""), b.get("input") or {}))
            elif b.get("type") == "tool_result":
                atual["resultados"].append((bool(b.get("is_error")), texto_resultado(b)))
            elif m.get("type") == "assistant" and b.get("type") == "text":
                atual["respostas"].append(b.get("text", ""))
    if atual:
        yield atual


def medir(lista):
    """lista: turnos (de todas as conversas do período)."""
    md = {k: 0 for k in [
        "turnos", "turnos_com_pagina", "chamadas_navegador", "toolsearch", "tabs_list", "tabs_list_sem_aba_ativa",
        "read_page", "read_page_rolagem_0_0", "read_page_caixa", "read_page_muito_escondido", "read_page_cortado",
        "screenshot", "print_pediu_gesto", "erros_navegador", "vazios_sem_motivo", "respostas_nao_consigo"]}
    voltas = []
    custo_total = custo_nav = custo_w = custo_w_nav = 0.0
    for t in lista:
        md["turnos"] += 1
        custo_total += t["custo"]
        custo_w += t.get("custo_worker", 0)
        nav = [(n, i) for n, i in t["ferramentas"] if n.startswith(NAVEGADOR)]
        # ToolSearch só pra carregar ferramenta do navegador (os de outras ferramentas, tipo WebSearch, não contam).
        busca_nav = sum(1 for n, i in t["ferramentas"] if n == "ToolSearch" and "claude-firefox" in json.dumps(i))
        md["toolsearch"] += busca_nav
        if nav:
            md["turnos_com_pagina"] += 1
            voltas.append(len(nav) + busca_nav)
            custo_nav += t["custo"]
            custo_w_nav += t.get("custo_worker", 0)
        md["chamadas_navegador"] += len(nav)
        for n, _ in nav:
            curto = n[len(NAVEGADOR):]
            if curto in ("tabs_list", "read_page", "screenshot"):
                md[curto] += 1
        for erro, txt in t["resultados"]:
            if "Conteúdo vindo do Firefox" not in txt and "Erro:" not in txt:
                continue
            if erro:
                md["erros_navegador"] += 1
            if "títulos e URLs das abas" in txt:
                # Formato antigo: nenhuma aba marcada "(ativa" e abas ocultas. Novo: aviso explícito.
                if ("(ativa" not in txt and re.search(r"[1-9]\d* outra\(s\) aba\(s\)", txt)) or "NÃO está legível" in txt or "não foi liberada" in txt:
                    md["tabs_list_sem_aba_ativa"] += 1
            if "(texto da página)" in txt:
                if re.search(r"rolagem: 0/0(?!.*rolagem da caixa)", txt) and "rolagem da caixa" not in txt:
                    md["read_page_rolagem_0_0"] += 1
                if "rolagem da caixa" in txt:
                    md["read_page_caixa"] += 1
                h = re.search(r"\((\d+) bloco\(s\) de texto escondido", txt)
                if h and int(h.group(1)) > 20:
                    md["read_page_muito_escondido"] += 1
                if "texto cortado" in txt:
                    md["read_page_cortado"] += 1
            if "PRECISA DO USUÁRIO" in txt:
                md["print_pediu_gesto"] += 1
            if re.search(r'"links": \[\]|"apareceu": false|"total": 0|"campos": \[\]', txt) and '"motivo"' not in txt:
                md["vazios_sem_motivo"] += 1
        if any(NAO_CONSIGO.search(r) for r in t["respostas"]):
            md["respostas_nao_consigo"] += 1
    md["media_chamadas_por_turno_com_pagina"] = round(sum(voltas) / len(voltas), 1) if voltas else 0
    md["custo_total"] = f"{custo_total:.2f}"
    md["custo_por_mensagem"] = f"{custo_total / md['turnos']:.3f}" if md["turnos"] else "0"
    md["custo_por_mensagem_navegador"] = f"{custo_nav / md['turnos_com_pagina']:.3f}" if md["turnos_com_pagina"] else "0"
    md["custo_worker"] = f"{custo_w:.3f}"
    n = md["turnos"] or 1
    md["custo_por_mensagem_com_worker"] = f"{(custo_total + custo_w) / n:.3f}"
    md["custo_por_mensagem_navegador_com_worker"] = (f"{(custo_nav + custo_w_nav) / md['turnos_com_pagina']:.3f}"
                                                    if md["turnos_com_pagina"] else "0")
    return md


ROTULOS = [
    ("custo_total", "custo total (US$, preço de API)"),
    ("custo_por_mensagem", "custo por mensagem (US$)"),
    ("custo_por_mensagem_navegador", "custo por mensagem que usou o navegador (US$)"),
    ("custo_worker", "custo do modelo auxiliar (US$, à parte)"),
    ("custo_por_mensagem_com_worker", "custo por mensagem, somando o modelo auxiliar"),
    ("custo_por_mensagem_navegador_com_worker", "  ...só as que usaram o navegador, somando ele"),
    ("turnos", "mensagens do usuário"),
    ("turnos_com_pagina", "mensagens que usaram o navegador"),
    ("media_chamadas_por_turno_com_pagina", "chamadas por mensagem que usou o navegador (+ToolSearch)"),
    ("toolsearch", "ToolSearch pra carregar ferramenta do navegador"),
    ("respostas_nao_consigo", "respostas tipo 'não consigo ver / libera a aba'"),
    ("tabs_list", "tabs_list"),
    ("tabs_list_sem_aba_ativa", "  ...em que a aba que o usuário olhava não dava pra ler"),
    ("read_page", "read_page"),
    ("read_page_rolagem_0_0", "  ...com 'rolagem 0/0' sem explicação"),
    ("read_page_caixa", "  ...mostrando a rolagem da caixa"),
    ("read_page_muito_escondido", "  ...com mais de 20 blocos 'escondidos' ignorados"),
    ("read_page_cortado", "  ...cortado pelo limite"),
    ("screenshot", "screenshot"),
    ("print_pediu_gesto", "  ...que precisou de gesto do usuário (📷)"),
    ("erros_navegador", "erros das ferramentas do navegador"),
    ("vazios_sem_motivo", "resultados vazios sem motivo"),
]


def mostrar(colunas):
    nomes = list(colunas)
    print(f"{'':58}" + "".join(f"{n:>12}" for n in nomes))
    for chave, rotulo in ROTULOS:
        print(f"{rotulo:58}" + "".join(f"{colunas[n][chave]:>12}" for n in nomes))


def data(s):
    return datetime.fromisoformat(s).astimezone() if s else None


def trace(sid, limite):
    achados = glob.glob(os.path.join(HOME, ".claude", "projects", "*", f"{sid}.jsonl"))
    if not achados:
        sys.exit("Conversa não encontrada.")
    for m in ler_jsonl(achados[0]):
        hora = (m.get("timestamp") or "")[11:19]
        for b in blocos(m):
            tp = b.get("type")
            if m.get("type") == "user" and tp == "text":
                print(hora, "USUÁRIO:", b["text"].strip().replace("\n", " ")[:limite])
            elif m.get("type") == "assistant" and tp == "text":
                print(hora, "  CLAUDE:", b["text"].strip().replace("\n", " ")[:limite])
            elif tp == "tool_use":
                print(hora, "  ->", b.get("name", "").replace(NAVEGADOR, ""), json.dumps(b.get("input"), ensure_ascii=False)[:160])
            elif tp == "tool_result":
                s = texto_resultado(b)
                corpo = re.search(r"<<<CONTEUDO_EXTERNO \w+>>>(.*?)<<<FIM_CONTEUDO_EXTERNO", s, re.S)
                fora = s[s.rfind(">>>") + 3:].strip() if ">>>" in s else ""
                print(hora, "     <-", "ERRO" if b.get("is_error") else "ok", len(s), "|",
                      (corpo.group(1) if corpo else s).strip().replace("\n", " ⏎ ")[:limite], f"|| {fora[:200]}" if fora else "")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--desde")
    ap.add_argument("--ate")
    ap.add_argument("--comparar", metavar="DATA")
    ap.add_argument("--trace", metavar="ID")
    ap.add_argument("--limite", type=int, default=250, help="caracteres por linha no --trace")
    a = ap.parse_args()
    if a.trace:
        return trace(a.trace, a.limite)
    w = chamadas_worker()
    todos = [t for sid, caminho in conversas_do_painel() for t in turnos(caminho, [x for x in w if x[0] == sid]) if t["quando"]]
    if a.comparar:
        corte = data(a.comparar)
        antes = [t for t in todos if t["quando"] < corte]
        depois = [t for t in todos if t["quando"] >= corte]
        return mostrar({"antes": medir(antes), "depois": medir(depois)})
    desde, ate = data(a.desde), data(a.ate)
    sel = [t for t in todos if (not desde or t["quando"] >= desde) and (not ate or t["quando"] < ate)]
    mostrar({"conversas": medir(sel)})


if __name__ == "__main__":
    main()
