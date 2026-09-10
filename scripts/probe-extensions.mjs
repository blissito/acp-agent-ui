/** Sonda: qué entienden de verdad los métodos de extensiones del Agente.
 *  Uso: node --env-file=.env scripts/probe-extensions.mjs
 *  -32601 = el método no existe. Otro error = existe y no le gustaron los params. */
import { client } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

const WS_URL = process.env.ACP_WS_URL;
const TOKEN = process.env.ACP_TOKEN ?? process.env.ACP_SECRET;
const CWD = process.env.ACP_CWD ?? "/data/work";

const target = new URL(WS_URL);
if (TOKEN && !target.searchParams.has("token")) target.searchParams.set("token", TOKEN);
const stream = createWebSocketStream(target.toString(), {
  WebSocket,
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined,
});
const app = client({ name: "probe" });
app.onNotification("session/update", () => {});
app.onRequest("session/request_permission", () => ({ outcome: { outcome: "cancelled" } }));
const conn = app.connect(stream);

const init = await conn.agent.request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});
console.log("agentCapabilities:", JSON.stringify(init.agentCapabilities));

const ses = await conn.agent.request("session/new", { cwd: CWD, mcpServers: [] });
const sessionId = ses.sessionId;
console.log("sessionId:", sessionId);

const probar = async (metodo, params) => {
  try {
    const r = await conn.agent.request(metodo, params);
    console.log(`✓ ${metodo}`, JSON.stringify(r).slice(0, 400));
  } catch (e) {
    console.log(`✗ ${metodo} → ${e.code ?? ""} ${String(e.message ?? e).slice(0, 200)}`);
  }
};

await probar("_goose/unstable/session/extensions/list", { sessionId });
await probar("_goose/unstable/extensions/available", {});
await probar("_goose/unstable/config/extensions/list", {});
await probar("_goose/unstable/session/system-prompt/set", { sessionId, mode: "append", prompt: "X", persist: false });
await probar("_goose/unstable/session/system-prompt/set", { sessionId, mode: "append", content: "X", persist: false });
await probar("_goose/unstable/session/system-prompt/set", { sessionId, mode: "append", text: "X", persist: false });
await probar("_goose/unstable/session/system-prompt/set", { sessionId, mode: "append", systemPrompt: "X", persist: false });
await probar("_goose/unstable/session/system-prompt/set", { sessionId, mode: "append", prompt: "X", extend: false });
await probar("_goose/unstable/session/system-prompt/set", { sessionId, mode: "append", prompt: "X", source: "client" });

process.exit(0);
