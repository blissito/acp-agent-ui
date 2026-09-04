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
import type { ConnectPhase, ImagePayload, ModelOption } from "~/hooks/useAcpStream";

// Sin URL no se inventa una: un fallback hardcodeado manda la sesión a la caja de otro y el
// fallo se ve como "el agente no responde" en vez de "te falta configurar esto".
const WS_URL = process.env.ACP_WS_URL ?? "";

// El token del agente REMOTO. `ACP_SECRET` se acepta como alias porque es el nombre que ya
// está en los .env de la gente.
//
// 🔴 NO es el `GOOSE_SERVER__SECRET_KEY` de la caja, como decía este archivo: ése es un
// secreto interno que se genera en cada arranque y nunca sale de la microVM. El de aquí es el
// token del agente — su `embedToken`, o el `ACP_AGENT_TOKEN` que le pusieran al crearlo.
const TOKEN = process.env.ACP_TOKEN ?? process.env.ACP_SECRET ?? "";

// `/data/work` es lo que existe en una caja ghosty-lite y lo único que sobrevive al sueño.
const CWD = process.env.ACP_CWD ?? "/data/work";
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS ?? 10);

// El tope que manda no es éste sino el de la CAJA: el agente rechaza la quinta
// conexión con "esta caja ya atiende 4 conversaciones a la vez". La sesión
// precalentada ocupa una, así que precalentar sin mirar el cupo le robaba el
// hueco a una conversación de verdad.
const MAX_LIVE = Number(process.env.ACP_MAX_LIVE_SESSIONS ?? 4);
const IDLE_MS = Number(process.env.ACP_IDLE_MS ?? 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Ciclo de vida de la caja del agente (app-owned): se despierta al hablarle y
// se suspende al quedar inactiva.
// ---------------------------------------------------------------------------
// Opcionales, y sin fallback por la misma razón que WS_URL: apuntaban a una caja y un snapshot
// concretos, así que un .env a medias operaba recursos ajenos. Sin ellos esto es un cliente ACP
// normal y el ciclo de vida simplemente no corre.
const AGENT_BOX = process.env.AGENT_BOX_ID ?? "";
const AGENT_SNAPSHOT = process.env.AGENT_SNAPSHOT_ID ?? "";
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

/**
 * Despierta la caja del agente ANTES de conectar. Es específico de EasyBits y OPCIONAL: sin
 * `EASYBITS_API_KEY` + `AGENT_BOX_ID` esto no corre y el cliente funciona igual contra
 * cualquier agente ACP — sólo que sin despertarlo él (el agente tiene que estar ya arriba).
 */
export async function ensureAgentBox() {
  if (!AGENT_BOX) return null; // cliente ACP genérico: no hay caja que gestionar
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
  // El self-heal desde snapshot creaba una caja NUEVA —con URL nueva— y acto seguido se
  // conectaba a la ACP_WS_URL vieja, así que nunca pudo funcionar: una recuperación que miente
  // es peor que ninguna. Sólo se intenta si hay snapshot configurado, y se avisa de que la URL
  // hay que cambiarla a mano.
  if (!AGENT_SNAPSHOT) {
    throw new Error(
      "El agente no despertó y no hay AGENT_SNAPSHOT_ID para recrearlo. Levántalo de nuevo y actualiza ACP_WS_URL."
    );
  }
  console.warn("[lifecycle] caja perdida; self-heal desde snapshot");
  const [child] = await eb.sandboxes.forkFromSnapshot(AGENT_SNAPSHOT, {});
  await child.waitUntilReady(90_000);
  console.warn(
    `[lifecycle] caja recreada (${child.id}) — ⚠️ su URL es otra: actualiza ACP_WS_URL o seguirás hablando con la anterior`
  );
  return child;
}

async function suspendAgentBox() {
  if (!AGENT_BOX) return;
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
  | { type: "models"; options: ModelOption[]; current: string | null }
  | { type: "done"; stopReason: string; usage: unknown }
  | { type: "error"; message: string }
  | { type: "warning"; message: string }
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
  images?: ImagePayload[];
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
  models: ModelOption[] = [];
  currentModel: string | null = null;
  title = "Nueva conversación";
  createdAt = Date.now();
  updatedAt = Date.now();
  messages: StoredMessage[] = [];

  private started = false;
  private conn: any = null;
  private session: any = null;
  private queue: { text: string; images?: ImagePayload[] }[] = [];
  private idleTimer: NodeJS.Timeout | null = null;
  private current: string | null = null;
  private modelConfigId: string | null = null;

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
    // Idempotente: la sesión precalentada ya está conectando cuando la adopta
    // una conversación, y un segundo handshake abriría un socket de más contra
    // una caja que cuenta sesiones.
    if (this.started) return;
    this.started = true;
    try {
      // Sin URL no se intenta nada: el error dice qué falta, en vez de dejar al usuario
      // mirando un spinner y luego un timeout genérico.
      if (!this.wsUrl) {
        throw new Error(
          "Falta ACP_WS_URL. Es el `agentUrl` del agente (wss://…/acp); ponlo en el .env."
        );
      }
      this.setPhase("waking");
      // El fallo de ciclo de vida SÍ se cuenta: antes iba sólo a console.warn y la UI pintaba
      // "Despertando la caja" en verde aunque no se hubiera despertado nada, así que el
      // siguiente error parecía venir de otro sitio.
      await ensureAgentBox().catch((e) => {
        console.warn("[lifecycle] ensureAgentBox:", e.message);
        this.emit("event", {
          type: "warning",
          message: `No pude despertar la caja (${e.message}). Sigo: puede que ya esté arriba.`,
        });
      });
      this.setPhase("connecting");
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `El agente no respondió en ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s. Revisa que el agente esté vivo y que ACP_WS_URL sea el suyo.`
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
        ? "El agente rechazó la conexión (401): el token no es el suyo. Es el `embedToken` que devolvió al crearlo — salvo que le hayas puesto un `ACP_AGENT_TOKEN` propio en el `env`, y entonces es ése."
        : /\b(404|502|503)\b/.test(raw)
          ? `Esa URL no está sirviendo un agente (${raw}). Comprueba ACP_WS_URL: la da el propio agente en su campo agentUrl.`
          : raw;
      this.emit("event", { type: "error", message: this.lastError });
    }
  }

  private async handshake() {
    // El token va por las DOS vías que acepta un agente ACP, y por eso funciona con cualquiera:
    //   · `?token=` en la URL — lo único que todo cliente sabe pasar (un WebSocket de navegador
    //     no puede poner cabeceras), y lo que espera ghosty-lite.
    //   · `Authorization: Bearer` — lo correcto cuando el cliente es Node, como éste.
    // Antes iba por `X-Secret-Key`, que el front de la caja DESCARTA: 401 garantizado, con un
    // mensaje que además culpaba al secreto interno de goose. Medido: ?token= → 200,
    // X-Secret-Key con el mismo valor → 401.
    // Si la URL ya trae el token, se respeta: quien la copió entera del panel no se queda fuera.
    const target = new URL(this.wsUrl);
    if (this.secret && !target.searchParams.has("token")) {
      target.searchParams.set("token", this.secret);
    }
    const headers = this.secret ? { Authorization: `Bearer ${this.secret}` } : undefined;
    const stream = createWebSocketStream(target.toString(), { WebSocket, headers } as any);

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

    // El agente refresca su inventario de modelos EN SEGUNDO PLANO después de
    // `session/new` (goose lo hace si la caché tiene más de 24 h), y anuncia la
    // lista nueva con un `config_option_update`. Sin escucharlo aquí, un modelo
    // recién publicado no aparece hasta reiniciar la conversación: el selector
    // enseñaba una foto vieja. El router del SDK deja pasar la notificación
    // (`Handled.no`), así que esto NO le roba updates al turno en vuelo.
    app.onNotification("session/update", ({ params }: any) => {
      const u = params?.update ?? {};
      if (u.sessionUpdate === "config_option_update") {
        this.applyModelOptions(u.configOptions);
      }
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
    this.applyModelOptions(this.session.newSessionResponse?.configOptions);
    this.emit("event", { type: "started", sessionId: this.sessionId });
    this.resetIdle();
    this.pump();
  }

  ask(text: string, images: ImagePayload[] = []) {
    if (this.closed) return;
    this.resetIdle();
    this.messages.push({ role: "user", text, images: images.length ? images : undefined, at: Date.now() });
    if (this.messages.length === 1) this.title = (text || "📷 imagen").slice(0, 60);
    this.updatedAt = Date.now();
    this.queue.push({ text, images: images.length ? images : undefined });
    this.pump();
  }

  // El selector de modelo que ACP publica como session config option
  // (categoría "model", tipo "select"). Aquí se lee y se vuelve a leer
  // después de cambiarlo, porque el agente responde con la lista actualizada.
  private applyModelOptions(configs: any[] | null | undefined) {
    const options = configs ?? this.session?.newSessionResponse?.configOptions ?? [];
    const model = options.find(
      (c: any) => c.category === "model" && c.type === "select"
    );
    if (!model) return;
    this.modelConfigId = model.id;
    this.models = (model.options ?? [])
      .flatMap((o: any) => (Array.isArray(o.options) ? o.options : [o]))
      .map((o: any) => ({ value: o.value, name: o.name }));
    this.currentModel = model.currentValue ?? null;
    this.emit("event", {
      type: "models",
      options: this.models,
      current: this.currentModel,
    });
  }

  async setModel(value: string) {
    if (!this.ready || !this.sessionId || !this.modelConfigId) return;
    const res = await this.conn.agent.request("session/set_config_option", {
      sessionId: this.sessionId,
      configId: this.modelConfigId,
      value,
    });
    this.applyModelOptions(res?.configOptions);
  }

  /** ¿Este modelo puede mirar una imagen? Hoy se reconoce por el nombre. */
  private static seesImages(value: string | null) {
    return Boolean(value && /vision|vl\b|multimodal/i.test(value));
  }

  /**
   * Deja la sesión en un modelo con visión si lo hay. Si el agente no ofrece
   * ninguno, se avisa y el turno sigue: mejor una respuesta pobre y explicada
   * que un error mudo.
   */
  private async ensureVisionModel() {
    if (GooseSession.seesImages(this.currentModel)) return;
    const visual = this.models.find((m) => GooseSession.seesImages(m.value));
    if (!visual) {
      this.emit("event", {
        type: "warning",
        message:
          "El modelo actual no ve imágenes y el agente no ofrece ninguno que sí. Va a responder sólo al texto.",
      });
      return;
    }
    try {
      await this.setModel(visual.value);
      this.emit("event", {
        type: "warning",
        message: `Cambié a ${visual.name} para poder ver la imagen.`,
      });
    } catch (e) {
      this.emit("event", {
        type: "warning",
        message: `No pude cambiar a un modelo con visión (${(e as Error).message}).`,
      });
    }
  }

  private pump() {
    if (!this.ready || this.busy || this.queue.length === 0) return;
    this.busy = true;
    const item = this.queue.shift()!;
    let turnUsage: unknown = null;
    let answer = "";

    (async () => {
      // Una imagen contra un modelo sin visión no falla de forma legible: el
      // agente responde como si no la hubiera visto, o corta el turno con un
      // error del proveedor. Si el turno lleva imágenes y el modelo actual no
      // ve, se cambia al que sí y se avisa — cambiar en silencio sería peor.
      if (item.images?.length) await this.ensureVisionModel();

      // Texto y/o imagen(es) como ContentBlocks: un prompt de ACP no es sólo
      // texto — la imagen viaja base64 en un bloque { type: "image" }.
      const content: unknown =
        item.images?.length
          ? [
              ...(item.text ? [{ type: "text" as const, text: item.text }] : []),
              ...item.images.map((im) => ({
                type: "image" as const,
                data: im.data,
                mimeType: im.mimeType,
              })),
            ]
          : item.text;
      const promptP = this.session.prompt(content);
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
        } else if (u.sessionUpdate === "config_option_update") {
          this.applyModelOptions(u.configOptions);
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

// ---------------------------------------------------------------------------
// Precalentado: el handshake empieza al abrir la app, no al escribir.
// ---------------------------------------------------------------------------
// Despertar la caja, abrir el WebSocket y crear la sesión cuesta segundos que
// hasta ahora se pagaban DESPUÉS del primer mensaje, mirando "Conectando…".
// `prewarm()` los adelanta al momento en que se carga la interfaz, y la primera
// conversación adopta esa sesión ya lista.
//
// Se guarda UNA sola: la caja tiene un tope de sesiones simultáneas y quedarse
// con un puñado abiertas "por si acaso" le quita sitio a las conversaciones de
// verdad. Por eso tampoco se repone sola al adoptarla.
let warm: GooseSession | null = null;

export function prewarm() {
  if (!WS_URL || warm) return;
  // El loader del layout revalida en cada navegación: sin esta guarda, volver al
  // hub tras adoptar la tibia abría otra y, con tres conversaciones abiertas, la
  // cuarta ranura de la caja se la quedaba una sesión que nadie está usando.
  if (conversations.size + 1 >= MAX_LIVE) return;
  const s = new GooseSession(WS_URL, TOKEN, CWD);
  warm = s;
  s.on("event", (e: AcpEvent) => {
    if (e.type === "closed" && warm === s) warm = null;
  });
  void s.connect();
}

// La elección del usuario sobrevive a que la tibia muera o llegue tarde: es una
// preferencia del humano, no un atributo de la conexión.
let preferredModel: string | null = null;

/** Lo que el hub necesita saber de la sesión tibia antes de que exista un chat. */
export interface WarmState {
  configured: boolean;
  present: boolean;
  ready: boolean;
  phase: ConnectPhase;
  error: string | null;
  models: ModelOption[];
  currentModel: string | null;
  slots: { live: number; max: number };
}

export function warmState(): WarmState {
  return {
    configured: Boolean(WS_URL),
    present: Boolean(warm && !warm.closed),
    ready: Boolean(warm?.ready),
    phase: warm?.phase ?? "waking",
    error: warm?.lastError ?? null,
    models: warm?.models ?? [],
    currentModel: warm?.currentModel ?? preferredModel,
    slots: { live: conversations.size, max: MAX_LIVE },
  };
}

/**
 * Suscribe a los eventos de la tibia. Es el hermano reducido de `subscribe()`:
 * en una sesión sin turnos sólo circulan fases, modelos y errores. Devuelve
 * null si no hay tibia, para que el hub distinga "no hay" de "ruta rota".
 *
 * A diferencia del SSE del chat, NO toca `openSse()`: ese contador existe para
 * no dormir la caja mientras alguien lee una conversación, y una pestaña del hub
 * olvidada la mantendría despierta —y facturando— para siempre.
 */
export function subscribeWarm(onEvent: (e: AcpEvent) => void) {
  const s = warm;
  if (!s) return null;
  const handler = (e: AcpEvent) => onEvent(e);
  s.on("event", handler);
  if (s.ready && !s.closed) {
    onEvent({ type: "started", sessionId: s.sessionId ?? "" });
    if (s.models.length) {
      onEvent({ type: "models", options: s.models, current: s.currentModel });
    }
  } else if (!s.closed) {
    onEvent({ type: "status", phase: s.phase });
    if (s.lastError) onEvent({ type: "error", message: s.lastError });
  }
  return () => s.off("event", handler);
}

/**
 * Cambia el modelo desde el hub, antes de que exista conversación. Se guarda
 * SIEMPRE como preferencia —aunque la tibia aún no esté lista o no exista—
 * porque el usuario ya expresó lo que quiere y perderlo por una carrera con el
 * handshake es peor que aplicarlo tarde.
 */
export async function setWarmModel(value: string) {
  preferredModel = value;
  if (!warm || !warm.ready || warm.closed) return false;
  try {
    await warm.setModel(value);
    return true;
  } catch (e) {
    console.warn("[setWarmModel]", (e as Error).message);
    return false;
  }
}

/** Deja la sesión en el modelo preferido, ya sea ahora o cuando esté lista. */
function applyPreferredModel(s: GooseSession) {
  const wanted = preferredModel;
  if (!wanted) return;
  const apply = () => {
    if (s.currentModel === wanted) return;
    void s.setModel(wanted).catch(() => {});
  };
  // `ensureVisionModel()` puede pisar esto en un turno con imágenes: es
  // deliberado — ver la imagen importa más que respetar la preferencia.
  if (s.ready) apply();
  else s.on("event", function once(e: AcpEvent) {
    if (e.type !== "started") return;
    s.off("event", once);
    apply();
  });
}

/** Toma la sesión precalentada si sirve; si falló, la tira y no la reusa. */
function takeWarm(): GooseSession | null {
  const s = warm;
  if (!s) return null;
  warm = null;
  if (s.closed || s.lastError) {
    s.close();
    return null;
  }
  return s;
}

export async function createConversation() {
  if (conversations.size >= MAX_CONVERSATIONS) {
    throw new Error("too many conversations");
  }
  if (conversations.size >= MAX_LIVE) {
    throw new Error(
      `La caja no atiende más de ${MAX_LIVE} conversaciones a la vez. Cierra una para abrir otra.`
    );
  }
  // La caja se despierta DENTRO de connect(): así el navegador aterriza en la
  // conversación al instante y ve las fases, en vez de esperar el POST a ciegas.
  const id = randomUUID();
  const s = takeWarm() ?? new GooseSession(WS_URL, TOKEN, CWD);
  void s.connect(); // no-op si la sesión precalentada ya hizo el handshake
  applyPreferredModel(s);
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

/** Encola un turno; las imágenes van base64 ({ data, mimeType }). */
export function askConversation(id: string, text: string, images: ImagePayload[] = []) {
  const s = conversations.get(id);
  if (!s) return false;
  s.ask(text, images);
  markActivity();
  return true;
}

/** Cambia el modelo de la sesión; devuelve false si la conversación no existe. */
export async function setModel(id: string, value: string) {
  const s = conversations.get(id);
  if (!s) return false;
  try {
    await s.setModel(value);
    return true;
  } catch (e) {
    console.warn("[setModel]", (e as Error).message);
    return false;
  }
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
    if (s.models.length) {
      onEvent({ type: "models", options: s.models, current: s.currentModel });
    }
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
