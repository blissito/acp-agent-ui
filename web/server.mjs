/**
 * server.mjs — SPEC-2 (día 2): backend que consume goose por WSS/ACP con el SDK oficial
 * y streamea al navegador. Node puro (node:http + SSE).
 *
 *   PORT=4000 ACP_WS_URL="wss://sb-<id>-3000.sandboxes.easybits.cloud/acp" node server.mjs
 *
 * Dependencias (solo backend): @agentclientprotocol/sdk + ws.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { client } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const WS_URL = process.env.ACP_WS_URL ?? "wss://sb-48f0a5d0-53d9-419e-bc1d-f1ac90e3d0da-3000.sandboxes.easybits.cloud/acp";
const SECRET = process.env.ACP_SECRET ?? ""; // GOOSE_SERVER__SECRET_KEY del agente (vacío = sin auth)
const CWD = process.env.ACP_CWD ?? "/root";
const AUTO_APPROVE = process.env.ACP_AUTO_APPROVE !== "0";
const PORT = Number(process.env.PORT ?? 4000);
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS ?? 10);
const IDLE_MS = Number(process.env.ACP_IDLE_MS ?? 15 * 60 * 1000); // cerrar sesión inactiva

// ---------------------------------------------------------------------------
// Ciclo de vida de la caja del agente (App-owned) — SDK de EasyBits.
//   ensureAgentBox():  si la caja no está corriendo, la despierta (resume) o la
//   reconstruye desde snapshot (self-heal). Se llama al hablarle al agente.
//   Suspend al idle (sin sockets SSE ni turnos) para pausar el TTL / liberar CPU.
// ---------------------------------------------------------------------------
const AGENT_BOX = process.env.AGENT_BOX_ID ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8";
const AGENT_SNAPSHOT = process.env.AGENT_SNAPSHOT_ID ?? "snap_9f31ad94-09d4-4f93-9439-f43b38825937";
const EB_KEY = process.env.EASYBITS_API_KEY ?? (() => { try { return readFileSync("/root/.ebkey", "utf8").trim(); } catch { return null; } })();
let ebClient = null;
async function getEbClient() {
  if (ebClient) return ebClient;
  if (!EB_KEY) return null;
  try { const { EasybitsClient } = await import("@easybits.cloud/sdk"); ebClient = new EasybitsClient({ apiKey: EB_KEY }); }
  catch (e) { console.warn("[lifecycle] sin SDK/API key:", e.message); ebClient = null; }
  return ebClient;
}
async function ensureAgentBox() {
  const client = await getEbClient();
  if (!client) { console.warn("[lifecycle] sin SDK — no gestiono ciclo de vida"); return null; }
  const sb = await client.sandboxes.get(AGENT_BOX);
  await sb.refresh();
  console.log(`[lifecycle] caja agente status=${sb.status}`);
  if (sb.status === "running") { await sb.extend(3600).catch(() => {}); return sb; }
  if (sb.status === "suspended") await sb.resume().catch(() => {});
  try { await sb.waitUntilReady(90_000); console.log("[lifecycle] caja despierta"); return sb; }
  catch (e) { /* caja perdida → self-heal */ }
  console.warn("[lifecycle] caja perdida; self-heal desde snapshot");
  const [child] = await client.sandboxes.forkFromSnapshot(AGENT_SNAPSHOT, {});
  await child.waitUntilReady(90_000);
  console.log("[lifecycle] caja recreada desde snapshot");
  return child;
}
async function suspendAgentBox() {
  const client = await getEbClient();
  if (!client) return;
  try { const sb = await client.sandboxes.get(AGENT_BOX); await sb.refresh(); if (sb.status === "running") { await sb.suspend(); console.log("[lifecycle] caja suspendida (idle)"); } } catch {}
}

// ---------------------------------------------------------------------------
// GooseSession — 1 conexión ACP por conversación, vía el SDK oficial de ACP.
//   eventos: started {sessionId} · chunk {text} · tool {title, optionId}
//            usage {used,size,cost} · done {stopReason, usage} · error {message} · closed
// ---------------------------------------------------------------------------
class GooseSession extends EventEmitter {
  constructor(wsUrl, secret, cwd, autoApprove) {
    super();
    this.wsUrl = wsUrl;
    this.secret = secret;
    this.cwd = cwd;
    this.autoApprove = autoApprove;
    this.conn = null;
    this.session = null;   // ActiveSession (SDK)
    this.sessionId = null;
    this.busy = false;
    this.ready = false;
    this.queue = [];
    this.cost = 0;
    this.tokens = 0;
    this.closed = false;
    this.idleTimer = null;
  }

  _resetIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  connect() {
    return this._handshake().catch((e) => this.emit("error", { message: e.message }));
  }

  async _handshake() {
    const headers = this.secret ? { "X-Secret-Key": this.secret } : undefined;
    const stream = createWebSocketStream(this.wsUrl, { WebSocket, headers });

    // App cliente: registramos el handler de permisos ANTES de conectar.
    const app = client({ name: "acp-web", version: "2.0.0" });
    app.onRequest("session/request_permission", ({ params }) => {
      const options = params.options ?? [];
      const title = params.toolCall?.title ?? "herramienta";
      const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
      this.emit("tool", { title, optionId: allow?.optionId ?? "?" });
      // auto-aprueba (o en modo manual se aprobaría vía POST, ver §3.1 del spec)
      return { outcome: { outcome: "selected", optionId: allow?.optionId ?? options[0]?.optionId } };
    });

    this.conn = app.connect(stream);
    const ctx = this.conn.agent;

    await ctx.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    this.session = await ctx.buildSession({ cwd: this.cwd, mcpServers: [] }).start();
    this.sessionId = this.session.sessionId;

    this.ready = true;
    this.emit("started", { sessionId: this.sessionId });
    this._resetIdle();
    this._pump();
  }

  ask(text) {
    if (this.closed) return;
    this._resetIdle();
    this.queue.push(text);
    this._pump();
  }

  _pump() {
    if (!this.ready || this.busy || this.queue.length === 0) return;
    this.busy = true;
    const text = this.queue.shift();
    let turnUsage = null;
    const onUsage = (u) => { turnUsage = u; };
    this.on("usage", onUsage);

    (async () => {
      const promptP = this.session.prompt(text);
      // Leer updates hasta el mensaje `stop` (fin del turno).
      while (true) {
        const m = await this.session.nextUpdate();
        if (m.kind === "stop") break;
        if (m.kind !== "session_update") continue;
        const u = m.update ?? {};
        if (u.sessionUpdate === "agent_message_chunk") {
          const t = u.content?.text ?? "";
          if (t) this.emit("chunk", { text: t });
        } else if (u.sessionUpdate === "usage_update") {
          const used = u.used ?? 0, size = u.size ?? 0, cost = u.cost?.amount ?? 0;
          this.tokens = used; this.cost += cost;
          this.emit("usage", { used, size, cost });
        }
      }
      const r = await promptP;
      this.off("usage", onUsage);
      this.emit("done", { stopReason: r.stopReason, usage: turnUsage });
    })()
      .catch((e) => this.emit("error", { message: e.message }))
      .finally(() => { this.busy = false; this._pump(); });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try { this.session?.dispose(); } catch {}
    try { this.conn?.close?.(); } catch {}
    this.emit("closed", { code: 0 });
  }
}

// ---------------------------------------------------------------------------
// Estado + utilidades HTTP
// ---------------------------------------------------------------------------
const conversations = new Map(); // id -> GooseSession
const ATTACH_OPEN = (req, cb) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => { try { cb(b ? JSON.parse(b) : {}); } catch { cb({}); } });
};
const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
};

// ---------------------------------------------------------------------------
// SPA (build de Vite en client/dist) — un solo server sirve web + API
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const SPA_DIR = join(__dirname, "client", "dist");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};
function serveSpa(res, pathname) {
  let fp = join(SPA_DIR, pathname === "/" ? "index.html" : pathname.replace(/^\/+/, ""));
  if (!fp.startsWith(SPA_DIR)) fp = join(SPA_DIR, "index.html"); // anti path-traversal
  if (!existsSync(fp) || statSync(fp).isDirectory()) fp = join(SPA_DIR, "index.html"); // fallback del router
  const ext = extname(fp).toLowerCase();
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "access-control-allow-origin": "*" });
  createReadStream(fp).pipe(res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  // ------- POST /conversations -------
  if (p === "/conversations" && req.method === "POST") {
    if (conversations.size >= MAX_CONVERSATIONS) return json(res, 429, { error: "too many conversations" });
    // despertar la caja del agente al hablarle (espera a que esté running)
    await ensureAgentBox().catch((e) => console.warn("[lifecycle] ensureAgentBox:", e.message));
    const id = randomUUID();
    const s = new GooseSession(WS_URL, SECRET, CWD, AUTO_APPROVE);
    s.connect();
    conversations.set(id, s);
    // limpiar la sesión cuando se cierra (para no llenar el tope)
    s.on("closed", () => { if (conversations.get(id) === s) conversations.delete(id); });
    return json(res, 200, { conversationId: id });
  }

  const m = p.match(/^\/conversations\/([0-9a-f-]+)\/(events|messages)$/);
  if (m) {
    const id = m[1], kind = m[2];
    const s = conversations.get(id);
    if (!s) return json(res, 404, { error: "conversation not found" });

    if (kind === "events" && req.method === "GET") {
      // ---- SSE ----
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(": connected\n\n");
      activeSse++; lastActivity = Date.now();
      const emit = (name, data) => { lastActivity = Date.now(); res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };
      const onStarted = (d) => emit("started", d);
      const onChunk = (d) => emit("chunk", d);
      const onTool = (d) => emit("tool", d);
      const onUsage = (d) => emit("usage", d);
      const onDone = (d) => emit("done", d);
      const onError = (d) => emit("error", d);
      const onClosed = (d) => { emit("closed", d); res.end(); cleanup(); };
      const cleanup = () => {
        activeSse = Math.max(0, activeSse - 1);
        s.off("started", onStarted); s.off("chunk", onChunk); s.off("tool", onTool);
        s.off("usage", onUsage); s.off("done", onDone); s.off("error", onError); s.off("closed", onClosed);
      };
      s.on("started", onStarted); s.on("chunk", onChunk); s.on("tool", onTool);
      s.on("usage", onUsage); s.on("done", onDone); s.on("error", onError); s.on("closed", onClosed);
      req.on("close", cleanup);
      return;
    }

    if (kind === "messages" && req.method === "POST") {
      ATTACH_OPEN(req, (body) => {
        if (!body.text) return json(res, 400, { error: "no text" });
        lastActivity = Date.now();
        s.ask(String(body.text));
        return json(res, 200, { queued: true });
      });
      return;
    }
  }

  // preflight CORS
  if (req.method === "OPTIONS" && req.headers.origin) {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }

  const del = p.match(/^\/conversations\/([0-9a-f-]+)$/);
  if (del && req.method === "DELETE") {
    const s = conversations.get(del[1]);
    if (s) { s.close(); conversations.delete(del[1]); }
    return json(res, 200, { closed: true });
  }

  // ------- SPA build (client/dist) + fallback para las rutas del router (RRv7) -------
  if (req.method === "GET" || req.method === "HEAD") {
    return serveSpa(res, p);
  }

  return json(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`[web] http://localhost:${PORT}`);
  console.log(`[web] ws=${WS_URL} secret=${SECRET ? "set" : "none"} cwd=${CWD} autoApprove=${AUTO_APPROVE} max=${MAX_CONVERSATIONS}`);
  console.log(`[web] lifecycle: agentBox=${AGENT_BOX} snapshot=${AGENT_SNAPSHOT} idleMs=${IDLE_MS}`);
});

// ---------------------------------------------------------------------------
// Suspend al idle: sin sockets SSE ni turnos en vuelo durante IDLE_MS.
// ---------------------------------------------------------------------------
let lastActivity = Date.now();
let activeSse = 0;
setInterval(() => {
  const busy = [...conversations.values()].some((s) => s.busy);
  if (activeSse === 0 && !busy && Date.now() - lastActivity > IDLE_MS) {
    suspendAgentBox().catch(() => {});
    lastActivity = Date.now();
  }
}, 30_000);
