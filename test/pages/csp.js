// Script permitido pela CSP (script-src 'self'). Guarda segredos onde as ferramentas de leitura não podem ir.
document.cookie = "sessao_teste=cookie-secreto-123";
localStorage.setItem("chave", "localstorage-secreto-456");
sessionStorage.setItem("chave", "sessionstorage-secreto-789");
const itens = document.getElementById("itens");
for (let i = 0; i < 100; i++) {
  const p = document.createElement("p");
  p.className = "item";
  p.textContent = `item ${i} ` + "texto ".repeat(70);
  itens.appendChild(p);
}
setTimeout(() => {
  const d = document.createElement("div");
  d.id = "atrasado";
  d.textContent = "Chegou!";
  document.body.prepend(d);
}, 1500);
