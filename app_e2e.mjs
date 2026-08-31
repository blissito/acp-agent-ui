// App E2E: conversación nueva a través del server desplegado (TODO el path del app).
// Crea conversación -> abre SSE -> manda mensaje que obliga a ejecutar shell -> verifica salida.
const base = "http://127.0.0.1:4000";

const c = await (await fetch(base + "/conversations", { method: "POST" })).json();
const id = c.conversationId;
console.error("ID=" + id);

const ctrl = new AbortController();
const resp = await fetch(base + "/conversations/" + id + "/events", { signal: ctrl.signal });
const rd = resp.body.getReader();
const dec = new TextDecoder();
let buf = "", txt = "", tools = new Set();

(async () => {
  for (;;) {
    const { value, done } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("data: ")) !== -1) {
      const nl = buf.indexOf("\n", i);
      if (nl === -1) break;
      const line = buf.slice(i + 6, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const j = JSON.parse(line);
        if (j.text != null) txt += j.text;
        if (j.name) tools.add(j.name);
      } catch {}
    }
  }
})();

await new Promise((r) => setTimeout(r, 1500)); // dar tiempo a que SSE se conecte
await fetch(base + "/conversations/" + id + "/messages", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Ejecuta este comando de shell y responde SOLO con su salida: `echo APP_BASH_OK`. No agregues nada mas." }),
});
await new Promise((r) => setTimeout(r, 60000));

console.log("\n=== RESULT ===");
console.log(txt.trim() || "(vacio)");
console.log("TOOLS=" + [...tools].join(","));
console.log("APP_BASH_OK=" + txt.includes("APP_BASH_OK"));
process.exit(0);
