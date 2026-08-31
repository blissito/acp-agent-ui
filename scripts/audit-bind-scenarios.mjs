/**
 * ¿Basta con exponer el puerto que goose usa por defecto (3284), o hace falta
 * además sacarlo de 127.0.0.1? Tres escenarios, una caja por escenario.
 */
import { client } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");

async function rest(path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
}

const ESCENARIOS = [
  { nombre: "A) todo por defecto, expongo 3284", flags: "", puerto: 3284 },
  { nombre: "B) --host 0.0.0.0, puerto por defecto", flags: "--host 0.0.0.0", puerto: 3284 },
  { nombre: "C) --host 0.0.0.0 --port 3000", flags: "--host 0.0.0.0 --port 3000", puerto: 3000 },
];

for (const esc of ESCENARIOS) {
  let id = null;
  const t0 = Date.now();
  try {
    const c = await rest("/sandboxes", {
      method: "POST",
      body: { template: "goose", name: "goose-esc", timeoutSeconds: 900, waitForReady: false },
    });
    id = c.sandboxId ?? c.sandbox?.sandboxId;
    let status = c.status ?? "starting";
    while (status !== "running" && Date.now() - t0 < 120_000) {
      await new Promise((r) => setTimeout(r, 1200));
      status = (await rest(`/sandboxes/${id}`)).status;
    }

    const secret = "esc-" + Math.random().toString(36).slice(2);
    await rest(`/sandboxes/${id}/bg`, {
      method: "POST",
      body: { command: `GOOSE_SERVER__SECRET_KEY=${secret} goose serve ${esc.flags} > /tmp/serve.log 2>&1` },
    });
    const exp = await rest(`/sandboxes/${id}/expose`, { method: "POST", body: { port: esc.puerto } });

    // Dar margen a que levante, luego intentar el handshake.
    await new Promise((r) => setTimeout(r, 4000));
    let veredicto = "";
    try {
      const conn = client({ name: "esc" }).connect(
        createWebSocketStream(exp.url.replace(/^https/, "wss") + "/acp", {
          WebSocket, headers: { "X-Secret-Key": secret },
        })
      );
      await conn.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      veredicto = "✅ ACP responde";
      conn.close?.();
    } catch (e) {
      veredicto = `❌ ${e.message}`;
    }

    // Qué quedó escuchando de verdad, visto desde dentro.
    const ss = await rest(`/sandboxes/${id}/exec`, {
      method: "POST",
      body: { command: "ss -ltn 2>/dev/null | grep -E '3284|3000' || echo 'nada escuchando'" },
    });

    console.log(`\n${esc.nombre}`);
    console.log(`   ${veredicto}`);
    console.log(`   escuchando: ${(ss.stdout || "").trim().replace(/\s+/g, " ") || "—"}`);
  } catch (e) {
    console.log(`\n${esc.nombre}\n   error de la prueba: ${e.message}`);
  } finally {
    if (id) await rest(`/sandboxes/${id}`, { method: "DELETE" }).catch(() => {});
  }
}
console.log("\ncajas destruidas");
