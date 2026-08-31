/**
 * Cuánto tarda una caja goose en quedar hablando ACP por WSS.
 * Todo contra la REST de EasyBits (https://www.easybits.cloud/api/v2), sin SDK.
 * Cronometra cada fase por separado para ver dónde se va el tiempo.
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
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const t0 = Date.now();
let prev = 0;
const mark = (label) => {
  const at = Date.now() - t0;
  console.log(
    `  ${(at / 1000).toFixed(1).padStart(6)}s  (+${((at - prev) / 1000).toFixed(1)}s)  ${label}`
  );
  prev = at;
};

const SECRET = "audit-" + Math.random().toString(36).slice(2);
let id = null;

try {
  console.log("Auditoría REST: caja goose → ACP por WSS\n");

  // 1. Crear sin esperar, para cronometrar el arranque aparte.
  const created = await rest("/sandboxes", {
    method: "POST",
    body: {
      template: "goose",
      name: "goose-audit",
      timeoutSeconds: 1800,
      waitForReady: false,
    },
  });
  id = created.sandboxId ?? created.sandbox?.sandboxId ?? created.id;
  mark(`POST /sandboxes → ${id} (status=${created.status ?? created.sandbox?.status})`);

  // 2. Sondear hasta running.
  let status = created.status ?? "starting";
  const limiteBoot = Date.now() + 180_000;
  while (status !== "running" && Date.now() < limiteBoot) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await rest(`/sandboxes/${id}`);
    status = s.status ?? s.sandbox?.status;
    if (["error", "stopped", "lost"].includes(status)) throw new Error(`status=${status}`);
  }
  if (status !== "running") throw new Error("no llegó a running en 180s");
  mark("status=running — la microVM arrancó");

  // 3. ¿La plantilla ya trae goose?
  const v = await rest(`/sandboxes/${id}/exec`, {
    method: "POST",
    body: { command: "goose --version 2>&1 | head -1 || echo AUSENTE" },
  });
  mark(`goose en la imagen: ${(v.stdout || v.stderr || "").trim() || "?"}`);

  // 4. Levantar el servidor ACP.
  await rest(`/sandboxes/${id}/bg`, {
    method: "POST",
    body: {
      // Por defecto escucha en 127.0.0.1:3284, que el proxy del sandbox no
      // alcanza. Hay que sacarlo a 0.0.0.0 y al puerto que se va a exponer.
      command: `GOOSE_SERVER__SECRET_KEY=${SECRET} goose serve --host 0.0.0.0 --port 3000 > /tmp/serve.log 2>&1`,
    },
  });
  mark("POST /bg — 'goose serve' lanzado");

  // 5. Publicar el puerto.
  const exposed = await rest(`/sandboxes/${id}/expose`, {
    method: "POST",
    body: { port: 3000 },
  });
  const url = exposed.url ?? exposed.exposed?.url;
  mark(`POST /expose 3000 → ${url}`);

  // 6. Handshake ACP: reintentar hasta que el WSS acepte el initialize.
  const wsUrl = url.replace(/^https/, "wss") + "/acp";
  let intentos = 0;
  let listo = false;
  let ultimoError = "";
  const limite = Date.now() + 150_000;
  while (Date.now() < limite && !listo) {
    intentos++;
    try {
      const stream = createWebSocketStream(wsUrl, {
        WebSocket,
        headers: { "X-Secret-Key": SECRET },
      });
      const conn = client({ name: "audit" }).connect(stream);
      await conn.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      listo = true;
      conn.close?.();
    } catch (e) {
      ultimoError = e.message;
      if (intentos === 5) {
        const l = await rest(`/sandboxes/${id}/exec`, {
          method: "POST",
          body: { command: "tail -5 /tmp/serve.log; ss -ltnp 2>/dev/null | head -5" },
        });
        console.log("    [diag]", (l.stdout || l.stderr || "").trim().replace(/\n/g, " | "));
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!listo) throw new Error(`el WSS nunca aceptó el initialize (${ultimoError})`);
  mark(`ACP initialize OK — ${intentos} intento${intentos > 1 ? "s" : ""}`);

  const log = await rest(`/sandboxes/${id}/exec`, {
    method: "POST",
    body: { command: "tail -3 /tmp/serve.log" },
  });
  console.log("\n  serve.log:", (log.stdout || "").trim().replace(/\n/g, " | "));
  console.log(`\n  TOTAL: ${((Date.now() - t0) / 1000).toFixed(1)}s de cero a ACP\n`);
} catch (e) {
  console.error("\nFALLÓ:", e.message);
} finally {
  if (id) {
    await rest(`/sandboxes/${id}`, { method: "DELETE" }).catch((e) =>
      console.error("no se pudo destruir:", e.message)
    );
    console.log(`caja ${id} destruida`);
  }
}
