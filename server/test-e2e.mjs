// Teste ponta a ponta: sobe o servidor MCP, espera a extensão conectar e chama as ferramentas.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import fs from "node:fs";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BASE = process.argv[2] || "http://loja.teste:8765"; // ver test/run.sh
const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("./index.js", import.meta.url).pathname],
  env: { ...process.env },
  stderr: "inherit",
});
const c = new Client({ name: "teste", version: "0" });
await c.connect(transport);

const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args });
  const t = r.content.map((x) => (x.type === "text" ? x.text : `<${x.type} ${x.mimeType} ${x.data.length} bytes b64>`)).join("\n");
  console.log(`\n===== ${name} ${JSON.stringify(args)}${r.isError ? " [ERRO]" : ""}\n${t}`);
  return { r, t };
};

for (let i = 0; i < 40; i++) {
  const r = await c.callTool({ name: "tabs_list", arguments: {} });
  if (!r.isError) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log("ferramentas:", (await c.listTools()).tools.map((t) => t.name).join(", "));

await call("tabs_list");
const { t } = await call("tab_new", { url: BASE + "/" });
const tabId = Number(/aba (\d+)/.exec(t)[1]);
await call("read_page", { tabId });
await call("type", { tabId, selector: "#q", text: "caneca azul" });
await call("click", { tabId, selector: "button" });
await call("javascript", { tabId, code: "document.getElementById('out').textContent" });
await call("javascript", { tabId, code: "const x = segredoDaPagina; return x * 2" });
await call("javascript", { tabId, code: "typeof browser + ' ' + typeof chrome" });
await call("select_option", { tabId, selector: "#s", value: "Grande" });
await call("console_logs", { tabId });
const shot = await call("screenshot", { tabId });
if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, Buffer.from(shot.r.content[0].data, "base64"));
await call("navigate", { tabId, url: "file:///etc/passwd" });
await call("navigate", { tabId, url: "https://www.itau.com.br/" });
await call("tabs_list");
await call("read_page", { tabId: 1 });
const rp = await call("read_page", { tabId, filter: "interactive" });
const ref = Number(/\[ref=(\d+)\] link/.exec(rp.t)[1]);
await call("click", { tabId, ref });
await call("wait", { seconds: 1 });
await call("read_page", { tabId });
await call("navigate", { tabId, url: "back" });
await call("tab_close", { tabId });
await c.close();
