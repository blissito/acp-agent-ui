/**
 * Motor ACP del lado servidor — portado de web/server.mjs (SPEC-2).
 *
 * Una conversación = una conexión ACP contra el goose que corre dentro de la
 * caja de EasyBits. El navegador nunca habla ACP: consume los eventos por SSE.
 */
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { client } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import type { ConnectPhase } from "~/hooks/useAcpStream";

const WS_URL =
  process.env.ACP_WS_URL ??
  "wss://sb-48f0a5d0-53d9-419e-bc1d-f1ac90e3d0da-3000.sandboxes.easybits.cloud/acp";
const SECRET = process.env.ACP_SECRET ?? ""; // GOOSE_SERVER__SECRET_KEY del agente
const CWD = process.env.ACP_CWD ?? "/root";
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS ?? 10);
const IDLE_MS = Number(process.env.ACP_IDLE_MS ?? 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Ciclo de vida de la caja del agente (app-owned): se despierta al hablarle y
// se suspende al quedar inactiva.
// ---------------------------------------------------------------------------
const AGENT_BOX = process.env.AGENT_BOX_ID ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8";
const AGENT_SNAPSHOT =
  process.env.AGENT_SNAPSHOT_ID ?? "snap_9f31ad94-09d4-4f93-9439-f43b38825937";
const EB_KEY =
  process.env.EASYBITS_API_KEY ??
  (() => {
    try {
      return readFileSync("/root/.ebkey", "utf8").trim();
    } catch {
      return null;
    }
  })();

let ebClient: any = null;
async function getEbClient() {
  if (ebClient) return ebClient;
  if (!EB_KEY) return null;
  try {
    // El SDK es opcional: sin él la app funciona, sólo no gestiona la caja.
    // @ts-ignore -- dependencia opcional, puede no estar instalada
    const { EasybitsClient } = await import("@easybits.cloud/sdk");
    ebClient = new EasybitsClient({ apiKey: EB_KEY });
  } catch (e: any) {
    console.warn("[lifecycle] sin SDK/API key:", e.message);
    ebClient = null;
  }
  return ebClient;
}

export async function ensureAgentBox() {
  const eb = await getEbClient();
  if (!eb) {
    console.warn("[lifecycle] sin SDK — no gestiono ciclo de vida");
    return null;
  }
  const sb = await eb.sandboxes.get(AGENT_BOX);
  await sb.refresh();
  console.log(`[lifecycle] caja agente status=${sb.status}`);
  if (sb.status === "running") {
    await sb.extend(3600).catch((e: Error) =>
      console.warn("[lifecycle] extend falló:", e.message)
    );
    return sb;
  }
  if (sb.status === "suspended") await sb.resume().catch(() => {});
  try {
    await sb.waitUntilReady(90_000);
    console.log("[lifecycle] caja despierta");
    return sb;
  } catch {
    // caja perdida → self-heal desde snapshot
  }
  console.warn("[lifecycle] caja perdida; self-heal desde snapshot");
  const [child] = await eb.sandboxes.forkFromSnapshot(AGENT_SNAPSHOT, {});
  await child.waitUntilReady(90_000);
  console.log("[lifecycle] caja recreada desde snapshot");
  return child;
}

async function suspendAgentBox() {
  const eb = await getEbClient();
  if (!eb) return;
  try {
    const sb = await eb.sandboxes.get(AGENT_BOX);
    await sb.refresh();
    if (sb.status === "running") {
      await sb.suspend();
      console.log("[lifecycle] caja suspendida (idle)");
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Tipos de los eventos que viajan al navegador
// ---------------------------------------------------------------------------
export type AcpEvent =
  | { type: "started"; sessionId: string }
  | { type: "chunk"; text: string }
  | { type: "thought"; text: string }
  | {
      // Una herramienta del agente: tool_call la crea, tool_call_update la
      // avanza. El mismo id llega varias veces; el navegador hace upsert.
      type: "tool";
      id: string;
      title?: string;
      kind?: string;
      status?: string;
      path?: string;
    }
  | { type: "usage"; used: number; size: number; cost: number }
  | { type: "done"; stopReason: string; usage: unknown }
  | { type: "error"; message: string }
  // Por dónde va la conexión, para que la UI no diga "Conectando…" a secas
  // durante los ~15s que tarda despertar una caja dormida.
  | { type: "status"; phase: ConnectPhase }
  | { type: "closed" };


// Un handshake que no responde no debe dejar la UI esperando para siempre:
// un 401 del WSS (secret ausente) o una caja que no contesta se ven así.
const CONNECT_TIMEOUT_MS = Number(process.env.ACP_CONNECT_TIMEOUT_MS ?? 60_000);

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  at: number;
}

// ---------------------------------------------------------------------------
// GooseSession — una conexión ACP por conversación.
// ---------------------------------------------------------------------------
class GooseSession extends EventEmitter {
  sessionId: string | null = null;
  busy = false;
  ready = false;
  closed = false;
  phase: ConnectPhase = "waking";
  lastError: string | null = null;
  cost = 0;
  tokens = 0;
  contextSize = 0;
  title = "Nueva conversación";
  createdAt = Date.now();
  updatedAt = Date.now();
  messages: StoredMessage[] = [];

  private conn: any = null;
  private session: any = null;
  private queue: string[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private current: string | null = null;

  constructor(
    private wsUrl: string,
    private secret: string,
    private cwd: string
  ) {
    super();
  }

  private resetIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.closed) return;
    this.idleTimer = setTimeout(() => this.close(), IDLE_MS);
    this.idleTimer.unref?.();
  }

  private setPhase(phase: ConnectPhase) {
    this.phase = phase;
    this.emit("event", { type: "status", phase });
  }

  async connect() {
    try {
      this.setPhase("waking");
      await ensureAgentBox().catch((e) =>
        console.warn("[lifecycle] ensureAgentBox:", e.message)
      );
      this.setPhase("connecting");
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `El agente no respondió en ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s. Revisa que la caja esté viva y que ACP_SECRET sea el de esa caja.`
              )
            ),
          CONNECT_TIMEOUT_MS
        );
        timer.unref?.();
      });
      await Promise.race([this.handshake(), timeout]);
      if (timer) clearTimeout(timer);
    } catch (e) {
      const raw = (e as Error).message;
      // "Unexpected server response: 401" no le dice nada a quien lo ve.
      this.lastError = /\b401\b/.test(raw)
        ? "La caja rechazó la conexión (401): ACP_SECRET no es el GOOSE_SERVER__SECRET_KEY de esa caja."
        : /\b(404|502|503)\b/.test(raw)
          ? `La caja no está sirviendo el agente (${raw}). ¿Está viva y con goose escuchando en :3000?`
          : raw;
      this.emit("event", { type: "error", message: this.lastError });
    }
  }

  private async handshake() {
    const headers = this.secret ? { "X-Secret-Key": this.secret } : undefined;
    const stream = createWebSocketStream(this.wsUrl, { WebSocket, headers } as any);

    // El handler de permisos se registra ANTES de conectar.
    const app = client({ name: "acp-web3" } as any);
    app.onRequest("session/request_permission", ({ params }: any) => {
      const options = params.options ?? [];
      const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
      const optionId = allow?.optionId ?? options[0]?.optionId;
      // Se auto-aprueba (tema de la sesión 4), pero la petición se enseña.
      this.emit("event", {
        type: "tool",
        id: params.toolCall?.toolCallId ?? "?",
        title: params.toolCall?.title ?? "herramienta",
        status: "pending",
      });
      return { outcome: { outcome: "selected", optionId } };
    });

    this.conn = app.connect(stream);
    const ctx = this.conn.agent;

    await ctx.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        // Sin terminal del lado del cliente: el agente corre el shell en su
        // propia caja. Con true, goose pide terminal/create y, como no lo
        // implementamos, cada shell termina en failed.
        terminal: false,
      },
    });
    this.setPhase("session");
    this.session = await ctx.buildSession({ cwd: this.cwd, mcpServers: [] }).start();
    this.sessionId = this.session.sessionId;
    this.ready = true;
    this.emit("event", { type: "started", sessionId: this.sessionId });
    this.resetIdle();
    this.pump();
  }

  ask(text: string) {
    if (this.closed) return;
    this.resetIdle();
    this.messages.push({ role: "user", text, at: Date.now() });
    if (this.messages.length === 1) this.title = text.slice(0, 60);
    this.updatedAt = Date.now();
    this.queue.push(text);
    this.pump();
  }

  private pump() {
    if (!this.ready || this.busy || this.queue.length === 0) return;
    this.busy = true;
    this.queue.shift();
    let turnUsage: unknown = null;
    let answer = "";

    (async () => {
      const promptP = this.session.prompt(this.messages[this.messages.length - 1].text);
      while (true) {
        const m = await this.session.nextUpdate();
        if (m.kind === "stop") break;
        if (m.kind !== "session_update") continue;
        const u = m.update ?? {};
        if (u.sessionUpdate === "agent_message_chunk") {
          const t = u.content?.text ?? "";
          if (t) {
            answer += t;
            this.emit("event", { type: "chunk", text: t });
          }
        } else if (u.sessionUpdate === "agent_thought_chunk") {
          const t = u.content?.text ?? "";
          if (t) this.emit("event", { type: "thought", text: t });
        } else if (
          u.sessionUpdate === "tool_call" ||
          u.sessionUpdate === "tool_call_update"
        ) {
          // En el update sólo viajan los campos que cambiaron; los null se omiten.
          const ev: AcpEvent = { type: "tool", id: u.toolCallId };
          if (u.title) ev.title = u.title;
          if (u.kind) ev.kind = u.kind;
          if (u.status) ev.status = u.status;
          const path = u.locations?.[0]?.path;
          if (path) ev.path = path;
          this.emit("event", ev);
        } else if (u.sessionUpdate === "usage_update") {
          const used = u.used ?? 0;
          const size = u.size ?? 0;
          const cost = u.cost?.amount ?? 0;
          this.tokens = used;
          this.contextSize = size;
          this.cost += cost;
          turnUsage = { used, size, cost };
          this.emit("event", { type: "usage", used, size, cost });
        }
      }
      const r = await promptP;
      this.messages.push({ role: "assistant", text: answer, at: Date.now() });
      this.updatedAt = Date.now();
      this.emit("event", { type: "done", stopReason: r.stopReason, usage: turnUsage });
    })()
      .catch((e) => this.emit("event", { type: "error", message: e.message }))
      .finally(() => {
        this.busy = false;
        this.pump();
      });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    try {
      this.session?.dispose();
    } catch {}
    try {
      this.conn?.close?.();
    } catch {}
    this.emit("event", { type: "closed" });
  }
}

// ---------------------------------------------------------------------------
// Registro de conversaciones. Vive en el módulo, así que sobrevive entre
// peticiones — pero no entre reinicios del server (el POC no persiste).
// ---------------------------------------------------------------------------
const conversations = new Map<string, GooseSession>();

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tokens: number;
  contextSize: number;
  cost: number;
  busy: boolean;
  closed: boolean;
}

const summarize = (id: string, s: GooseSession): ConversationSummary => ({
  id,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  messageCount: s.messages.length,
  tokens: s.tokens,
  contextSize: s.contextSize,
  cost: s.cost,
  busy: s.busy,
  closed: s.closed,
});

export async function createConversation() {
  if (conversations.size >= MAX_CONVERSATIONS) {
    throw new Error("too many conversations");
  }
  // La caja se despierta DENTRO de connect(): así el navegador aterriza en la
  // conversación al instante y ve las fases, en vez de esperar el POST a ciegas.
  const id = randomUUID();
  const s = new GooseSession(WS_URL, SECRET, CWD);
  void s.connect();
  conversations.set(id, s);
  s.on("event", (e: AcpEvent) => {
    if (e.type === "closed" && conversations.get(id) === s) conversations.delete(id);
  });
  return id;
}

export function getConversation(id: string) {
  return conversations.get(id) ?? null;
}

export function listConversations(): ConversationSummary[] {
  return [...conversations.entries()]
    .map(([id, s]) => summarize(id, s))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getMessages(id: string): StoredMessage[] {
  return conversations.get(id)?.messages ?? [];
}

export function closeConversation(id: string) {
  const s = conversations.get(id);
  if (!s) return false;
  s.close();
  conversations.delete(id);
  return true;
}

export function askConversation(id: string, text: string) {
  const s = conversations.get(id);
  if (!s) return false;
  s.ask(text);
  markActivity();
  return true;
}

/** Suscribe a los eventos de una conversación; devuelve la baja. */
export function subscribe(id: string, onEvent: (e: AcpEvent) => void) {
  const s = conversations.get(id);
  if (!s) return null;
  const handler = (e: AcpEvent) => onEvent(e);
  s.on("event", handler);
  // Quien llega tarde (recarga, segunda pestaña) no vio el started original:
  // se le repite para que el input no se quede en "Conectando…".
  if (s.ready && s.sessionId && !s.closed) {
    onEvent({ type: "started", sessionId: s.sessionId });
  } else if (!s.closed) {
    onEvent({ type: "status", phase: s.phase });
    if (s.lastError) onEvent({ type: "error", message: s.lastError });
  }
  return () => s.off("event", handler);
}

export const config = { wsUrl: WS_URL, cwd: CWD, agentBox: AGENT_BOX, idleMs: IDLE_MS };

// ---------------------------------------------------------------------------
// Suspend al idle: sin sockets SSE ni turnos en vuelo durante IDLE_MS.
// ---------------------------------------------------------------------------
let lastActivity = Date.now();
let activeSse = 0;
export const markActivity = () => (lastActivity = Date.now());
export const openSse = () => {
  activeSse++;
  markActivity();
};
export const closeSse = () => {
  activeSse = Math.max(0, activeSse - 1);
};

setInterval(() => {
  const busy = [...conversations.values()].some((s) => s.busy);
  if (activeSse === 0 && !busy && Date.now() - lastActivity > IDLE_MS) {
    suspendAgentBox().catch(() => {});
    lastActivity = Date.now();
  }
}, 30_000).unref?.();
