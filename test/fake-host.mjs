// SÓ NO TESTE: programa local falso do painel. O Firefox abre via native messaging; tudo que a extensão manda vai
// pro teste (POST /__host/in) e o que o teste quer mandar vem de GET /__host/out.
import { encodeFrame, frameReader } from "../chat/host.mjs";
const BASE = "http://127.0.0.1:8765";
process.stdin.on("data", frameReader((m) => fetch(`${BASE}/__host/in`, { method: "POST", body: JSON.stringify(m) }).catch(() => {})));
process.stdin.on("end", () => process.exit(0));
for (;;) {
  let lista = [];
  try {
    lista = await (await fetch(`${BASE}/__host/out`)).json();
  } catch {
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const m of lista) process.stdout.write(encodeFrame(m));
}
