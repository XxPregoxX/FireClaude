const list = document.getElementById("list");
const allowJs = document.getElementById("allowJs");
const allowPrivate = document.getElementById("allowPrivate");
const sites = document.getElementById("sites");
const newSite = document.getElementById("newSite");
const addMsg = document.getElementById("addMsg");
const ok = document.getElementById("ok");

browser.storage.local.get(["blockedDomains", "allowJavascript", "allowPrivateNetwork"]).then(
  ({ blockedDomains = [], allowJavascript = false, allowPrivateNetwork = false }) => {
    list.value = blockedDomains.join("\n");
    allowJs.checked = allowJavascript;
    allowPrivate.checked = allowPrivateNetwork;
  },
);

allowJs.addEventListener("change", () => browser.storage.local.set({ allowJavascript: allowJs.checked }));

const workdir = document.getElementById("chatWorkdir");
browser.storage.local.get("chatWorkdir").then(({ chatWorkdir = "" }) => (workdir.value = chatWorkdir));
workdir.addEventListener("change", async () => {
  await browser.storage.local.set({ chatWorkdir: workdir.value.trim() });
  document.getElementById("dirOk").textContent = "Salvo! (o painel valida e cai no padrão se a pasta não servir)";
  setTimeout(() => (document.getElementById("dirOk").textContent = ""), 3000);
});

// Modelo das conversas novas do painel (vazio = padrão, Sonnet).
const modeloSel = document.getElementById("chatModelo");
browser.storage.local.get("chatModelo").then(({ chatModelo }) => {
  if (chatModelo && [...modeloSel.options].some((o) => o.value === chatModelo)) modeloSel.value = chatModelo;
});
modeloSel.addEventListener("change", async () => {
  await browser.storage.local.set({ chatModelo: modeloSel.value === "claude-sonnet-5-5" ? "" : modeloSel.value });
  document.getElementById("modeloOk").textContent = "Salvo! Vale pras conversas novas.";
  setTimeout(() => (document.getElementById("modeloOk").textContent = ""), 3000);
});

// Esforço das conversas novas (vazio = padrão, médio).
const esforcoSel = document.getElementById("chatEsforco");
esforcoSel.value = "medium";
browser.storage.local.get("chatEsforco").then(({ chatEsforco }) => {
  if (chatEsforco && [...esforcoSel.options].some((o) => o.value === chatEsforco)) esforcoSel.value = chatEsforco;
});
esforcoSel.addEventListener("change", async () => {
  await browser.storage.local.set({ chatEsforco: esforcoSel.value === "medium" ? "" : esforcoSel.value });
  document.getElementById("esforcoOk").textContent = "Salvo! Vale pras conversas novas.";
  setTimeout(() => (document.getElementById("esforcoOk").textContent = ""), 3000);
});

// Modelo auxiliar (worker). A chave da API não fica aqui: vai pro programa do painel, que guarda em arquivo.
const $w = (id) => document.getElementById(id);
const avisoW = (id, t) => {
  $w(id).textContent = t;
  setTimeout(() => ($w(id).textContent = ""), 4000);
};
browser.storage.local.get(["workerLigado", "workerProvedor", "workerModelo", "workerLocalUrl", "workerLocalModelo"]).then((w) => {
  $w("workerLigado").checked = w.workerLigado !== false;
  if (["assinatura", "api", "local"].includes(w.workerProvedor)) $w("workerProvedor").value = w.workerProvedor;
  $w("workerModelo").value = w.workerModelo || "";
  $w("workerLocalUrl").value = w.workerLocalUrl || "";
  $w("workerLocalModelo").value = w.workerLocalModelo || "";
});
const localValido = (u) => {
  try {
    const x = new URL(u);
    return /^https?:$/.test(x.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname);
  } catch (_) {
    return false;
  }
};
$w("salvarWorker").addEventListener("click", async () => {
  const modelo = $w("workerModelo").value.trim();
  const url = $w("workerLocalUrl").value.trim();
  if (modelo && !/^claude-[a-z0-9-]{3,60}$/.test(modelo)) return avisoW("workerOk", "Modelo tem que ser um id claude-... (vazio = Haiku 5.5).");
  if (url && !localValido(url)) return avisoW("workerOk", "O endereço local tem que ser 127.0.0.1 ou localhost.");
  await browser.storage.local.set({ workerLigado: $w("workerLigado").checked, workerProvedor: $w("workerProvedor").value, workerModelo: modelo,
    workerLocalUrl: url, workerLocalModelo: $w("workerLocalModelo").value.trim().slice(0, 100) });
  avisoW("workerOk", "Salvo!");
});
const pedirChave = (pedido) => browser.runtime.sendMessage({ type: "worker_chave", ...pedido }).catch((e) => ({ erro: String(e?.message || e) }));
const mostrarChave = (r) => {
  $w("chaveStatus").textContent = r?.erro ? `Erro: ${r.erro}` : r?.final ? `Chave salva (…${r.final})` : "Nenhuma chave salva";
};
pedirChave({ acao: "status" }).then(mostrarChave);
$w("salvarChave").addEventListener("click", async () => {
  const chave = $w("workerChave").value.trim();
  $w("workerChave").value = "";
  if (!chave) return mostrarChave({ erro: "cole a chave no campo" });
  mostrarChave(await pedirChave({ acao: "gravar", chave }));
});
$w("apagarChave").addEventListener("click", async () => mostrarChave(await pedirChave({ acao: "gravar", chave: "" })));

// Textos do painel: jeito de conversar (vazio = padrão) e "sobre mim".
const estilo = document.getElementById("chatEstilo");
const sobreMim = document.getElementById("chatSobreMim");
const textosOk = (t) => {
  document.getElementById("textosOk").textContent = t;
  setTimeout(() => (document.getElementById("textosOk").textContent = ""), 3000);
};
browser.storage.local.get(["chatEstilo", "chatSobreMim"]).then(({ chatEstilo, chatSobreMim = "" }) => {
  estilo.value = typeof chatEstilo === "string" && chatEstilo.trim() ? chatEstilo : globalThis.ESTILO_PADRAO;
  sobreMim.value = chatSobreMim;
});
document.getElementById("salvarTextos").addEventListener("click", async () => {
  // Igual ao padrão = guarda vazio, pra quem não mexeu receber melhorias futuras do texto padrão.
  const e = estilo.value.trim() === globalThis.ESTILO_PADRAO.trim() ? "" : estilo.value.slice(0, 4000);
  await browser.storage.local.set({ chatEstilo: e, chatSobreMim: sobreMim.value.slice(0, 4000) });
  textosOk("Salvo! Vale pras conversas novas.");
});
document.getElementById("restaurarEstilo").addEventListener("click", () => {
  estilo.value = globalThis.ESTILO_PADRAO;
  textosOk("Texto padrão de volta no campo (clique em Salvar textos).");
});

const minutes = document.getElementById("grantMinutes");
browser.storage.local.get("grantMinutes").then(({ grantMinutes = 15 }) => (minutes.value = grantMinutes));
minutes.addEventListener("change", async () => {
  const v = Math.min(120, Math.max(1, Math.round(Number(minutes.value) || 15)));
  minutes.value = v;
  await browser.storage.local.set({ grantMinutes: v });
  document.getElementById("minOk").textContent = "Salvo!";
  setTimeout(() => (document.getElementById("minOk").textContent = ""), 2000);
});
allowPrivate.addEventListener("change", () => browser.storage.local.set({ allowPrivateNetwork: allowPrivate.checked }));

// ---------- Sites permitidos (permissões de host da extensão) ----------

async function renderSites() {
  const { origins = [] } = await browser.permissions.getAll();
  const items = origins.map((o) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = o.replace(/^\*:\/\//, "").replace(/\/\*$/, "");
    const rm = document.createElement("button");
    rm.textContent = "Remover";
    rm.addEventListener("click", () => browser.permissions.remove({ origins: [o] }));
    li.append(name, rm);
    return li;
  });
  if (!items.length) {
    const li = document.createElement("li");
    li.textContent = "(nenhum site ainda)";
    items.push(li);
  }
  sites.replaceChildren(...items);
}

function toPattern(input) {
  const host = input.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return `*://${host}/*`;
}

document.getElementById("addForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const pattern = toPattern(newSite.value);
  if (!pattern) {
    addMsg.textContent = "Endereço inválido.";
    return;
  }
  // Chamado direto no clique: o Firefox mostra o prompt de permissão.
  browser.permissions.request({ origins: [pattern] }).then((granted) => {
    addMsg.textContent = granted ? "Adicionado!" : "Não autorizado.";
    if (granted) newSite.value = "";
    setTimeout(() => (addMsg.textContent = ""), 2500);
  });
});

browser.permissions.onAdded.addListener(renderSites);
browser.permissions.onRemoved.addListener(renderSites);
renderSites();

// ---------- Sites proibidos ----------

document.getElementById("save").addEventListener("click", async () => {
  const blockedDomains = list.value
    .split("\n")
    .map((l) => l.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  await browser.storage.local.set({ blockedDomains });
  list.value = blockedDomains.join("\n");
  ok.textContent = "Salvo!";
  setTimeout(() => (ok.textContent = ""), 2000);
});
