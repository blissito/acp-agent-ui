/**
 * Motor ACP del lado servidor — portado de web/server.mjs (SPEC-2).
 *
 * Una conversación = una conexión ACP contra el goose que corre dentro de la
 * caja de EasyBits. El navegador nunca habla ACP: consume los eventos por SSE.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EventEmitter } from "node:events";
import { client } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";
import { mcpServersParaAcp, type Extension, aMcpServer } from "./extensions";
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
/** Lo único que este Cliente le impone al Agente. Se manda una vez por hilo. */
const IDIOMA =
  process.env.ACP_IDIOMA ??
  "Contesta siempre en español, aunque la pregunta venga en otro idioma.";

const CWD = process.env.ACP_CWD ?? "/data/work";
const MAX_CONVERSATIONS = Number(process.env.MAX_CONVERSATIONS ?? 10);

// El tope que manda no es éste sino el de la CAJA: el agente rechaza la quinta
// conexión con "esta caja ya atiende 4 conversaciones a la vez". La sesión
// precalentada ocupa una, así que precalentar sin mirar el cupo le robaba el
// hueco a una conversación de verdad.
const MAX_LIVE = Number(process.env.ACP_MAX_LIVE_SESSIONS ?? 4);
// De las ranuras de la caja, una se reserva para el servicio: la conexión tibia
// o la lectora. Las demás son para conversar. Sin esta reserva, leer historial
// con el cupo lleno rompía conversaciones ajenas.
const MAX_CHAT = Math.max(1, MAX_LIVE - 1);
const IDLE_MS = Number(process.env.ACP_IDLE_MS ?? 15 * 60 * 1000);

// ---------------------------------------------------------------------------
// Ciclo de vida de la caja del agente (app-owned): se despierta al hablarle y
// se suspende al quedar inactiva.
// ---------------------------------------------------------------------------
// Opcionales, y sin fallback por la misma razón que WS_URL: apuntaban a una caja y un snapshot
// concretos, así que un .env a medias operaba recursos ajenos. Sin ellos esto es un cliente ACP
// normal y el ciclo de vida simplemente no corre.
const AGENT_BOX = process.env.AGENT_BOX_ID ?? "";
/** Tope de cada llamada REST al host, y de esperar a que la caja arranque. */
const REST_TIMEOUT_MS = Number(process.env.ACP_REST_TIMEOUT_MS ?? 10_000);
const WAKE_TIMEOUT_MS = Number(process.env.ACP_WAKE_TIMEOUT_MS ?? 45_000);
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
  // Cada llamada al host lleva tope. Sin él, un REST que no contesta deja la
  // pantalla en "despertando la caja" durante minutos, y el tope del handshake
  // ni siquiera llega a contar porque esto pasa antes.
  const sb: any = await conTimeout(eb.sandboxes.get(AGENT_BOX), REST_TIMEOUT_MS);
  await conTimeout(sb.refresh(), REST_TIMEOUT_MS);
  console.log(`[lifecycle] caja agente status=${sb.status}`);
  if (sb.status === "running") {
    // Extender el TTL no es requisito para hablar con el agente: va suelto,
    // sin hacer esperar a nadie. (Y `POST /extend` sabe dar 500 en una caja
    // con el TTL vencido.)
    void sb.extend(3600).catch((e: Error) =>
      console.warn("[lifecycle] extend falló:", e.message)
    );
    return sb;
  }
  if (sb.status === "suspended") await conTimeout(sb.resume(), REST_TIMEOUT_MS).catch(() => {});
  try {
    await sb.waitUntilReady(WAKE_TIMEOUT_MS);
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
  await child.waitUntilReady(WAKE_TIMEOUT_MS);
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
  | { type: "title"; title: string }
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
  // Un turno que entró por otro canal (WhatsApp): el navegador lo pinta etiquetado.
  | { type: "user"; text: string; via: Canal; from?: string; images?: ImagePayload[] }
  // Una imagen o un audio que devolvió una herramienta MCP: cuelga del mensaje del agente.
  | { type: "image"; image: ImagePayload }
  | { type: "audio"; audio: ImagePayload }
  | { type: "closed" };

/** Por dónde entró un turno. El chat web es un canal más. */
export type Canal = "web" | "whatsapp";

/** Modo con el que se abre cada hilo. Con claude-acp, cualquier otro cuelga las
 *  herramientas: ghosty reenvía `session/request_permission` pero al contestar tira
 *  "No task waiting for confirmation" y la tool nunca vuelve. */
const MODE = process.env.ACP_MODE ?? "auto";


// Un handshake que no responde no debe dejar la UI esperando para siempre:
// un 401 del WSS (secret ausente) o una caja que no contesta se ven así.
const CONNECT_TIMEOUT_MS = Number(process.env.ACP_CONNECT_TIMEOUT_MS ?? 60_000);

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  images?: ImagePayload[];
  /** Audios que devolvieron las herramientas (mismo par base64 + mime). */
  audios?: ImagePayload[];
  /** Las herramientas que usó el agente en este turno. Se guardan aquí y no
   *  sólo se emiten al vivo: si no, al reabrir el hilo la conversación
   *  aparece sin rastro de lo que el agente hizo. */
  tools?: ToolEntry[];
  /** Por dónde entró (sólo se guarda si no fue por la web). */
  via?: Canal;
  /** Quién lo escribió en ese canal. */
  from?: string;
  at: number;
}

export interface ToolEntry {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  path?: string;
}

/** Mete o actualiza una herramienta en el último turno del agente. Llega
 *  varias veces con el mismo id: `tool_call` la crea y `tool_call_update` la
 *  avanza, con sólo los campos que cambiaron. */
export function upsertTool(msgs: StoredMessage[], entry: ToolEntry) {
  let last = msgs[msgs.length - 1];
  if (last?.role !== "assistant") {
    last = { role: "assistant", text: "", at: Date.now() };
    msgs.push(last);
  }
  const tools = (last.tools ??= []);
  const i = tools.findIndex((t) => t.id === entry.id);
  if (i === -1) tools.push(entry);
  else tools[i] = { ...tools[i], ...entry };
}

/** Dobla un `session/update` de replay dentro de una lista de mensajes.
 *  Lo comparten la conversación que reanuda y la conexión lectora.
 *  Devuelve true si consumió la notificación. */
export function applyReplayChunk(msgs: StoredMessage[], u: any): boolean {
  const c = u?.content ?? {};
  // Una imagen del hilo vuelve como content.type === "image" con su base64:
  // se rearma el adjunto que el chat ya sabe pintar.
  if (c.type === "image" && c.data) {
    const img = { mimeType: c.mimeType ?? "image/png", data: c.data };
    const last = msgs[msgs.length - 1];
    if (last?.role === "user") (last.images ??= []).push(img);
    else msgs.push({ role: "user", text: "", images: [img], at: Date.now() });
    return true;
  }
  const txt = c.text ?? "";
  if (u?.sessionUpdate === "user_message_chunk" && txt) {
    // El primer turno viajó con la instrucción de idioma pegada delante; el
    // agente la guardó tal cual. Aquí se quita: es nuestra, no del humano, y
    // si no acaba siendo el título de todos los hilos.
    const limpio = txt.startsWith(IDIOMA) ? txt.slice(IDIOMA.length).trimStart() : txt;
    msgs.push({ role: "user", text: limpio, at: Date.now() });
    return true;
  }
  if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") {
    const entry: ToolEntry = { id: u.toolCallId };
    if (u.title) entry.title = u.title;
    if (u.kind) entry.kind = u.kind;
    if (u.status) entry.status = u.status;
    const path = u.locations?.[0]?.path;
    if (path) entry.path = path;
    upsertTool(msgs, entry);
    return true;
  }
  if (u?.sessionUpdate === "agent_message_chunk" && txt) {
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant") last.text += txt;
    else msgs.push({ role: "assistant", text: txt, at: Date.now() });
    return true;
  }
  return false;
}

/** El nombre legible de un hilo: el que ya guardamos, si no el primer mensaje
 *  del usuario, si no lo que diga el agente. */
export function pickTitle(
  sessionId: string | null,
  msgs: StoredMessage[],
  delAgente?: string | null,
): string {
  const guardado = titles[sessionId ?? ""];
  if (guardado) return guardado;
  const primero = msgs.find((m) => m.role === "user")?.text?.trim();
  const generico = !delAgente || /^new chat$/i.test(delAgente);
  if (primero && generico) return primero.slice(0, 60);
  return delAgente || "Sin título";
}

/** Una promesa con techo: si el agente no contesta, no dejamos colgado a nadie. */
function conTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout tras ${ms} ms`)), ms)),
  ]);
}

// ---------------------------------------------------------------------------
// La conexión: una, y se queda.
// ---------------------------------------------------------------------------
// Abrir el WebSocket y hacer `initialize` cuesta unos tres segundos. Hacerlo en
// cada cambio de hilo es pagar ese peaje por mirar el historial. La conexión es
// del agente, no del hilo: se abre una vez y las sesiones van y vienen por
// dentro. (Es lo que hace Zed: una conexión por agente, multiplexando.)
// ---------------------------------------------------------------------------
const REPLAY_TAIL = Number(process.env.ACP_REPLAY_TAIL ?? 0) || 0;

let conexion: { conn: any; caps: any; socket?: any } | null = null;
let conectando: Promise<{ conn: any; caps: any; socket?: any }> | null = null;

/** OPEN según el estándar de WebSocket. */
const SOCKET_ABIERTO = 1;

async function conexionCompartida() {
  // Un socket que ya no está abierto no sirve, aunque el objeto siga en pie.
  if (conexion && conexion.socket && conexion.socket.readyState !== SOCKET_ABIERTO) {
    conexion = null;
  }
  if (conexion) return conexion;
  if (conectando) return conectando;
  conectando = (async () => {
    // El token va por las DOS vías que acepta un agente ACP, y por eso funciona
    // con cualquiera: `?token=` en la URL —lo único que sabe pasar un WebSocket
    // de navegador, y lo que espera ghosty-lite— y `Authorization: Bearer`, lo
    // correcto cuando el cliente es Node, como éste.
    const target = new URL(WS_URL);
    if (TOKEN && !target.searchParams.has("token")) target.searchParams.set("token", TOKEN);
    const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : undefined;

    // El socket queda a la vista para saber si sigue vivo: una caja que se
    // duerme mata la conexión sin avisar, y reusar esa conexión muerta deja la
    // pantalla en "Abriendo el canal ACP" con un error que no dice nada.
    let socket: any = null;
    // El socket se construye DENTRO de createWebSocketStream, o sea antes de que
    // exista `conn`. Los handlers no pueden cerrar sobre esa constante: si la
    // caja está dormida, el `error` llega durante el connect y leerla revienta
    // con ReferenceError dentro de un listener, que nadie atrapa y tumba el
    // proceso. Se guarda aquí y se llena cuando ya hay conexión.
    const propio: { conn: any } = { conn: null };
    const caida = () => {
      if (conexion && propio.conn && conexion.conn === propio.conn) conexion = null;
      // El hilo abierto se quedó sin canal: su turno no puede seguir.
      actual?.notificarCaida();
    };
    class WSVigilado extends WebSocket {
      constructor(...args: any[]) {
        // @ts-expect-error el SDK construye con (url, protocols, opciones)
        super(...args);
        socket = this;
        this.on("close", caida);
        this.on("error", caida);
      }
    }
    const stream = createWebSocketStream(target.toString(), { WebSocket: WSVigilado, headers } as any);

    // Los handlers se registran ANTES de conectar, y hablan con el hilo abierto
    // en ese momento: la conexión sobrevive a las sesiones.
    const app = client({ name: "acp-web3" } as any);
    app.onRequest("session/request_permission", ({ params }: any) => {
      const options = params.options ?? [];
      const allow = options.find((o: any) => o.kind === "allow_once") ?? options[0];
      const optionId = allow?.optionId ?? options[0]?.optionId;
      // Se auto-aprueba (tema de la sesión 4), pero la petición se enseña.
      actual?.emit("event", {
        type: "tool",
        id: params.toolCall?.toolCallId ?? "?",
        title: params.toolCall?.title ?? "herramienta",
        status: "pending",
      });
      return { outcome: { outcome: "selected", optionId } };
    });
    app.onNotification("session/update", ({ params }: any) => {
      actual?.onSessionUpdate(params?.update ?? {});
    });

    const conn = app.connect(stream);
    propio.conn = conn;
    const init: any = await conTimeout(
      conn.agent.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          // Sin terminal del lado del cliente: el agente corre el shell en su
          // propia caja. Con true, goose pide terminal/create y, como no lo
          // implementamos, cada shell termina en failed.
          terminal: false,
        },
      }),
      CONNECT_TIMEOUT_MS,
    );
    conexion = { conn, caps: init?.agentCapabilities ?? null, socket };
    console.log("[acp] agentCapabilities:", JSON.stringify(conexion.caps));
    return conexion;
  })().finally(() => {
    conectando = null;
  });
  return conectando;
}

/** La conexión murió o hay que renovarla: la próxima sesión abrirá otra. */
function soltarConexion() {
  const c = conexion;
  conexion = null;
  try {
    c?.conn?.close?.();
  } catch {}
}

/**
 * Una sesión reanudada, hablada a pelo.
 *
 * El SDK sólo entrega su `ActiveSession` —la del `prompt()` y el `nextUpdate()`—
 * cuando la sesión nace de un `session/new`. Un hilo que se reabre con
 * `session/load` no pasa por ahí, así que se le pone delante este adaptador con
 * la misma forma: los `session/update` que llegan por notificación se encolan, y
 * `prompt` es la petición cruda.
 */
/**
 * ¿El agente dejó de reconocer nuestra sesión? Pasa cuando la caja se suspende
 * a media conversación: al despertar, goose arranca sin las sesiones vivas y
 * cualquier `session/prompt` con el id anterior cae en Invalid params (-32602).
 */
function sesionPerdida(e: Error & { code?: number }): boolean {
  const m = (e?.message ?? "").toLowerCase();
  return (
    e?.code === -32602 ||
    m.includes("invalid params") ||
    m.includes("session not found") ||
    m.includes("unknown session")
  );
}

/** Marca interna: el WebSocket con la caja se cortó a media conversación.
 *  No es un error del agente ni un cancel del humano: el turno se reabre. */
const CONEXION_CORTADA = "conexión con la caja cortada";

function conexionPerdida(e: Error): boolean {
  return sesionPerdida(e) || e?.message === CONEXION_CORTADA;
}

/** Se llama una vez al cerrar el turno, con todo el texto y las imágenes. */
export type OnAnswer = (answer: string, error: Error | null, images: ImagePayload[], audios: ImagePayload[]) => void;

export interface AskOpts {
  via?: Canal;
  from?: string;
  onAnswer?: OnAnswer;
}

/** Las imágenes y audios que trae un `tool_call_update` de una extensión, ya colgados
 *  del último mensaje del agente. Vacío si la tool no es `mcp:`. */
function mediaDeTool(msgs: StoredMessage[], u: any): { images: ImagePayload[]; audios: ImagePayload[] } {
  const vacio = { images: [], audios: [] };
  if (u?.sessionUpdate !== "tool_call_update" || !Array.isArray(u.content)) return vacio;
  const last = msgs[msgs.length - 1];
  const tool = last?.tools?.find((t) => t.id === u.toolCallId);
  const title = u.title ?? tool?.title ?? "";
  if (!/^mcp:/i.test(title)) return vacio;
  // Qué devuelve de verdad el adaptador: la spec de ACP admite image/audio/resource,
  // pero cada agente reenvía lo que quiere. El log es la única prueba.
  console.log(
    `[acp] ${title} →`,
    u.content.map((c: any) => (c?.type === "content" ? `content/${c.content?.type}` : c?.type)).join(", "),
  );
  const images: ImagePayload[] = [];
  const audios: ImagePayload[] = [];
  for (const c of u.content) {
    const b = c?.type === "content" ? c.content : c;
    if (typeof b?.data !== "string" || !b.data) continue;
    if (b.type === "image") images.push({ mimeType: b.mimeType ?? "image/png", data: b.data });
    else if (b.type === "audio") audios.push({ mimeType: b.mimeType ?? "audio/ogg", data: b.data });
  }
  if (last?.role === "assistant") {
    if (images.length) (last.images ??= []).push(...images);
    if (audios.length) (last.audios ??= []).push(...audios);
  }
  return { images, audios };
}

class SesionCruda {
  private cola: any[] = [];
  private esperando: ((m: any) => void) | null = null;

  constructor(
    private conn: any,
    public readonly sessionId: string,
  ) {}

  /** Le entrega un update al turno en curso (o lo guarda hasta que lo pidan). */
  push(m: any) {
    const w = this.esperando;
    if (w) {
      this.esperando = null;
      w(m);
    } else {
      this.cola.push(m);
    }
  }

  prompt(content: unknown) {
    const bloques =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    return Promise.resolve(
      this.conn.agent.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: bloques,
      }),
    ).finally(() => this.push({ kind: "stop" }));
  }

  nextUpdate(): Promise<any> {
    const ya = this.cola.shift();
    if (ya) return Promise.resolve(ya);
    return new Promise((res) => (this.esperando = res));
  }

  dispose() {
    this.cola = [];
    this.esperando = null;
  }
}

// ---------------------------------------------------------------------------
// GooseSession — una conexión ACP por conversación.
// ---------------------------------------------------------------------------
class GooseSession extends EventEmitter {
  sessionId: string | null = null;
  agentCapabilities: any = null;
  /** Si viene, en vez de abrir un hilo nuevo se reanuda éste (`session/load`). */
  resumeSessionId: string | null = null;
  /** Con qué modelo arrancar, si el humano ya eligió uno antes. */
  modeloPreferido: string | null = null;
  /** El nombre que el agente tiene guardado, para no pisarlo si es de verdad. */
  titleFromAgent: string | null = null;
  private replaying = false;
  /** El humano pidió cortar el turno; un error de cierre se cuenta como cancel. */
  private cancelSolicitado = false;
  /** Rompe la espera de `nextUpdate` cuando el canal muere o el humano corta. */
  private abortTurno: ((razon: Error) => void) | null = null;
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
  private queue: { text: string; images?: ImagePayload[]; onAnswer?: OnAnswer }[] = [];
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
    this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
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
      // Con una conexión viva la caja está despierta por definición: preguntarle
      // al host en cada cambio de hilo es un segundo de peaje por nada.
      if (conexion) {
        this.setPhase("connecting");
        await this.handshakeConTope();
        return;
      }
      // El fallo de ciclo de vida SÍ se cuenta: antes iba sólo a console.warn y la UI pintaba
      // "Despertando la caja" en verde aunque no se hubiera despertado nada, así que el
      // siguiente error parecía venir de otro sitio.
      // Techo de toda la fase, no sólo de cada llamada: despertar la caja es
      // un favor, no un requisito. Si tarda más que esto se intenta conectar
      // igual, porque muchas veces ya estaba arriba.
      await conTimeout(ensureAgentBox(), WAKE_TIMEOUT_MS + REST_TIMEOUT_MS).catch((e) => {
        console.warn("[lifecycle] ensureAgentBox:", e.message);
        this.emit("event", {
          type: "warning",
          message: `No pude despertar la caja (${e.message}). Sigo: puede que ya esté arriba.`,
        });
      });
      this.setPhase("connecting");
      await this.handshakeConTope();
    } catch (e) {
      // Un handshake roto deja la conexión inservible: la próxima abre otra.
      soltarConexion();
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

  /** Vuelve a abrir el hilo después de que la caja durmiera. */
  private async reabrirTrasSiesta() {
    soltarConexion();
    this.conn = null;
    this.ready = false;
    // El hilo sigue en el sessions.db de la caja: se reabre por id en vez de
    // empezar uno nuevo, y así el agente no pierde lo hablado.
    if (this.sessionId) this.resumeSessionId = this.sessionId;
    await conTimeout(ensureAgentBox(), WAKE_TIMEOUT_MS + REST_TIMEOUT_MS).catch(() => {});
    this.setPhase("connecting");
    await this.handshakeConTope();
  }

  /** El handshake con tope. Si vence, se suelta la conexión compartida: un
   *  socket abierto contra una caja que ya no contesta envenena a todos los
   *  hilos siguientes, que se quedan otros 60 s en "despertando la caja". */
  private async handshakeConTope() {
    try {
      await Promise.race([this.handshake(), this.timeoutDeConexion()]);
    } catch (e) {
      soltarConexion();
      throw e;
    }
  }

  private timeoutDeConexion(): Promise<never> {
    return new Promise<never>((_, reject) => {
      const t = setTimeout(
        () =>
          reject(
            new Error(
              `El agente no respondió en ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s. Revisa que el agente esté vivo y que ACP_WS_URL sea el suyo.`
            )
          ),
        CONNECT_TIMEOUT_MS
      );
      t.unref?.();
    });
  }

  private async handshake() {
    const { conn, caps } = await conexionCompartida();
    this.conn = conn;
    this.agentCapabilities = caps;

    this.setPhase("session");
    const ctx = conn.agent;
    // Las extensiones se resuelven una vez por handshake. El log no es adorno:
    // es la única prueba de que el Cliente mandó lo que cree que mandó, antes
    // de ponerse a buscar herramientas nuevas en el chat.
    const servidores = mcpServersParaAcp();
    console.log("[acp] mcpServers:", servidores.map((m: any) => m.name).join(", ") || "(ninguno)");
    if (this.resumeSessionId) {
      // El agente repite el hilo como notificaciones `session/update` ANTES de
      // responder a esta petición; por eso la bandera se baja después.
      this.replaying = true;
      // `replayTail` recorta el replay a los últimos N turnos, cortando en
      // frontera de turno para no partir un par tool-request/response. Sólo
      // acelera la carga del hilo: el contexto que el agente le pasa al modelo
      // no cambia. Apagado por defecto; se enciende con ACP_REPLAY_TAIL.
      const cargado: any = await ctx.request("session/load", {
        sessionId: this.resumeSessionId,
        cwd: this.cwd,
        // En `session/load` los servidores se SUMAN a los que el Agente ya
        // guardó para este hilo: por eso un hilo revivido puede traer una
        // extensión que aquí ya se borró.
        mcpServers: servidores,
        ...(REPLAY_TAIL ? { _meta: { replayTail: REPLAY_TAIL } } : {}),
      });
      this.replaying = false;
      this.sessionId = this.resumeSessionId;
      await this.ponerModo(cargado?.modes);
      // El SDK sólo entrega su sesión "activa" cuando nace de un `session/new`;
      // un hilo reabierto habla por el canal crudo.
      this.session = new SesionCruda(this.conn, this.resumeSessionId) as any;
      this.title = pickTitle(this.sessionId, this.messages, this.titleFromAgent);
      recordTitle(this.sessionId, this.title);
    } else {
      try {
        this.session = await ctx.buildSession({ cwd: this.cwd, mcpServers: servidores }).start();
      } catch (e) {
        // Una extensión mal escrita no puede llevarse por delante el chat: si
        // la sesión no arranca con ellas, se abre sin ninguna y se avisa.
        if (!servidores.length) throw e;
        console.warn("[acp] la sesión no arrancó con extensiones:", (e as Error).message);
        this.emit("event", {
          type: "error",
          message: `No pude arrancar con las extensiones (${(e as Error).message}). El hilo abre sin ellas.`,
        });
        this.session = await ctx.buildSession({ cwd: this.cwd, mcpServers: [] }).start();
      }
      this.sessionId = this.session.sessionId;
      await this.ponerModo(this.session?.newSessionResponse?.modes);
    }
    this.ready = true;
    this.applyModelOptions(this.session?.newSessionResponse?.configOptions);
    if (this.modeloPreferido && this.modeloPreferido !== this.currentModel) {
      void this.setModel(this.modeloPreferido).catch(() => {});
    }
    this.emit("event", { type: "started", sessionId: this.sessionId });
    this.resetIdle();
    this.pump();
  }

  /** Deja el hilo en `MODE` si el agente ofrece modos y no está ya en él. */
  private async ponerModo(modes: any) {
    if (!MODE || !modes || modes.currentModeId === MODE) return;
    const hay = (modes.availableModes ?? []).some((m: any) => (m.id ?? m.modeId) === MODE);
    if (!hay) return;
    try {
      await conTimeout(
        this.conn.agent.request("session/set_mode", { sessionId: this.sessionId, modeId: MODE }),
        10_000,
      );
      console.log(`[acp] modo ${modes.currentModeId} → ${MODE}`);
    } catch (e) {
      console.warn("[acp] session/set_mode:", (e as Error).message);
    }
  }

  ask(text: string, images: ImagePayload[] = [], opts: AskOpts = {}) {
    if (this.closed) {
      opts.onAnswer?.("", new Error("el hilo ya está cerrado"), [], []);
      return;
    }
    this.resetIdle();
    // El primer turno lleva pegada la instrucción de idioma. ACP no tiene
    // campo para el prompt de sistema y el método de goose que lo pone
    // (`session/system-prompt/set`) no está documentado; esto es explícito y
    // funciona con cualquier agente. Sin ello DeepSeek contesta en chino.
    const prefijo = this.messages.length === 0 ? IDIOMA + "\n\n" : "";
    const msg: StoredMessage = { role: "user", text, images: images.length ? images : undefined, at: Date.now() };
    if (opts.via && opts.via !== "web") {
      msg.via = opts.via;
      msg.from = opts.from;
      // El navegador no mandó este turno: se le avisa para que lo pinte.
      this.emit("event", { type: "user", text, via: opts.via, from: opts.from, images: msg.images });
    }
    this.messages.push(msg);
    if (this.messages.length === 1) {
      this.title = (text || "📷 imagen").slice(0, 60);
      recordTitle(this.sessionId, this.title);
    }
    this.updatedAt = Date.now();
    this.queue.push({ text: prefijo + text, images: images.length ? images : undefined, onAnswer: opts.onAnswer });
    this.pump();
  }

  /** Corta el turno en curso. `session/cancel` es notificación: no hay
   *  respuesta; el corte se ve cuando el agente cierra el turno (y el pump
   *  emite `done`). Si el agente contesta con error, se cuenta como cancel.
   *  Si el canal ya está muerto, el aviso no llega: se corta en local. */
  cancelar() {
    if (!this.busy || !this.sessionId) return;
    this.cancelSolicitado = true;
    // `conexion` es la referencia viva; `this.conn` puede quedar apuntando a un
    // socket que ya se cayó. Si el canal no está abierto, mandar el aviso es
    // tirarlo a un agujero negro y el turno no se cerraría nunca.
    const canalVivo = Boolean(conexion && conexion.socket && conexion.socket.readyState === SOCKET_ABIERTO);
    if (canalVivo && this.conn) {
      try {
        const agente = this.conn.agent;
        const notify = agente?.notify ?? agente?.sendNotification;
        notify?.call(agente, "session/cancel", { sessionId: this.sessionId });
      } catch (e) {
        console.warn("[cancel]", (e as Error).message);
      }
      return;
    }
    // Canal muerto: se corta la espera local y el `catch` del pump lo cuenta
    // como cancel. Así el botón de parar sigue sirviendo con la caja dormida.
    this.abortTurno?.(new Error("turno cortado"));
  }

  /** El socket con la caja se cayó a media conversación: corta la espera para
   *  que el pump reabra el hilo en vez de quedarse colgado para siempre. */
  notificarCaida() {
    if (!this.busy) return;
    this.abortTurno?.(new Error(CONEXION_CORTADA));
  }

  /** Espera el siguiente update del turno, dejándose cortar por un cancel del
   *  humano o por la caída del canal. Sin esto, un `nextUpdate` sobre un socket
   *  muerto cuelga para siempre y `busy` no se limpia. */
  private siguienteUpdate(): Promise<any> {
    // La caída pudo llegar antes de que hubiera una espera que cortar: si el
    // canal ya no está, se falla aquí en vez de esperar a un agente que no oye.
    if (!conexion || !conexion.socket || conexion.socket.readyState !== SOCKET_ABIERTO) {
      return Promise.reject(new Error(CONEXION_CORTADA));
    }
    return Promise.race([
      this.session.nextUpdate(),
      new Promise<never>((_, rej) => {
        this.abortTurno = rej;
      }),
    ]);
  }

  /** Cierra las herramientas que quedaron a medias. Un turno cortado (o que
   *  falla) deja `tool_call` sin su `tool_call_update` final, y el spinner de
   *  esa fila giraría para siempre. */
  private cerrarToolsPendientes(status: string) {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== "assistant") return;
    for (const t of last.tools ?? []) {
      if (t.status === "completed" || t.status === "failed") continue;
      t.status = status;
      this.emit("event", { type: "tool", id: t.id, status });
    }
  }

  /** Espera a que el turno en curso cierre. No falla nunca: si el agente no
   *  contesta a tiempo se sigue adelante, porque colgar la navegación sería
   *  peor que perder unas líneas. */
  private esperarTurno(ms: number): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => {
      const listo = () => {
        clearTimeout(t);
        this.off("event", alEvento);
        resolve();
      };
      const alEvento = (e: AcpEvent) => {
        if (e.type === "done" || e.type === "error") listo();
      };
      const t = setTimeout(listo, ms);
      this.on("event", alEvento);
    });
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
    // El schema nuevo lo llama `configId`; goose todavía emite `id`.
    this.modelConfigId = model.configId ?? model.id;
    this.models = (model.options ?? [])
      .flatMap((o: any) => (Array.isArray(o.options) ? o.options : [o]))
      .map((o: any) => ({ value: o.value, name: o.name }));
    this.currentModel = model.currentValue ?? null;
    // El catálogo se recuerda: la portada lo necesita cuando no hay sesión.
    recordModels(this.models, this.currentModel);
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
    // La señal de corte es por turno: la del anterior ya no vale.
    this.abortTurno = null;
    const item = this.queue.shift()!;
    let turnUsage: unknown = null;
    let answer = "";
    // Las imágenes que devuelven las herramientas de extensiones en este turno.
    const imagenes: ImagePayload[] = [];
    const audios: ImagePayload[] = [];

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
      const correrTurno = async () => {
      const promptP = this.session.prompt(content);
      // Si el turno se corta antes de que el agente conteste (canal muerto),
      // esta promesa se queda sin dueño; su rechazo sería un unhandled
      // rejection. El manejador de aquí no estorba al `await` de abajo.
      promptP.catch(() => {});
      // Lo que el agente escriba después de una herramienta abre párrafo.
      let trasHerramienta = false;
      while (true) {
        const m = await this.siguienteUpdate();
        if (m.kind === "stop") break;
        if (m.kind !== "session_update") continue;
        const u = m.update ?? {};
        if (u.sessionUpdate === "agent_message_chunk") {
          let t = u.content?.text ?? "";
          if (t) {
            // El agente retoma la frase después de usar una herramienta y el
            // texto queda pegado al de antes: "…espero el resultado.Confirmado:
            // encontré…". Son dos momentos distintos, así que se separan con
            // punto y aparte.
            if (trasHerramienta && answer && !/\n\s*$/.test(answer)) {
              answer += "\n\n";
              this.emit("event", { type: "chunk", text: "\n\n" });
            }
            trasHerramienta = false;
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
          const { type: _t, ...entry } = ev;
          upsertTool(this.messages, entry as ToolEntry);
          trasHerramienta = true;
          this.emit("event", ev);
          // Las imágenes viajan por ACP en `tool_call_update.content[]`. Sólo cuentan
          // las de extensiones (`mcp:`): un `Read` de un PNG también devuelve imagen,
          // pero ésa la leyó el agente, no la generó.
          const media = mediaDeTool(this.messages, u);
          for (const im of media.images) {
            imagenes.push(im);
            this.emit("event", { type: "image", image: im });
          }
          for (const au of media.audios) {
            audios.push(au);
            this.emit("event", { type: "audio", audio: au });
          }
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
      return await promptP;
      };

      let r;
      try {
        r = await correrTurno();
      } catch (e) {
        // La caja durmió a media conversación: goose arrancó de cero y el
        // sessionId que teníamos ya no existe del otro lado. Se reabre el hilo
        // y se manda el turno otra vez. Sólo si aún no llegó texto: repetir con
        // media respuesta pintada la duplicaría.
        if (!conexionPerdida(e as Error) || answer) throw e;
        this.emit("event", {
          type: "warning",
          message: "La caja había dormido; reabro el hilo y lo mando de nuevo.",
        });
        await this.reabrirTrasSiesta();
        r = await correrTurno();
      }
      // El texto va al mismo turno que ya abrieron las herramientas: si se
      // empuja uno nuevo, las tools se quedan colgando de un mensaje anterior
      // y el turno se parte en dos en la pantalla.
      const abierto = this.messages[this.messages.length - 1];
      if (abierto?.role === "assistant" && !abierto.text) abierto.text = answer;
      else this.messages.push({ role: "assistant", text: answer, at: Date.now() });
      this.updatedAt = Date.now();
      // Ni "lista" ni "falló": el agente no dijo cómo acabó, y suponerlo sería
      // inventar. Se marca como sin cerrar y el spinner para.
      this.cerrarToolsPendientes("cancelled");
      this.emit("event", { type: "done", stopReason: r.stopReason, usage: turnUsage });
      item.onAnswer?.(answer, null, imagenes, audios);
    })()
      .catch((e) => {
        // El agente suele cerrar el cancel con stopReason, pero algunos cortes
        // responden al prompt con error: eso no es una falla, es el cancel.
        if (this.cancelSolicitado) {
          this.cerrarToolsPendientes("cancelled");
          this.emit("event", { type: "done", stopReason: "cancelled", usage: null });
          item.onAnswer?.(answer, new Error("turno cortado"), imagenes, audios);
        } else {
          this.cerrarToolsPendientes("failed");
          this.emit("event", { type: "error", message: e.message });
          item.onAnswer?.(answer, e, imagenes, audios);
        }
      })
      .finally(() => {
        this.cancelSolicitado = false;
        this.busy = false;
        this.pump();
      });
  }

  /** Un `session/update` del agente para el hilo abierto. */
  onSessionUpdate(u: any) {
    // Durante el replay estos chunks son el historial, no un turno en vivo:
    // se guardan como mensajes en vez de emitirse al navegador.
    if (this.replaying && applyReplayChunk(this.messages, u)) return;
    // En un hilo reanudado el turno vive de estas notificaciones: el SDK no las
    // está enrutando por nosotros.
    if (!this.replaying && this.session instanceof SesionCruda) {
      this.session.push({ kind: "session_update", update: u });
    }
    if (u.sessionUpdate === "config_option_update") {
      this.applyModelOptions(u.configOptions);
    } else if (u.sessionUpdate === "session_info_update" && u.title) {
      // El título es del agente: goose lo genera con un LLM leyendo los
      // primeros mensajes y lo empuja por aquí. El Cliente sólo lo guarda,
      // salvo cuando el agente tituló con la instrucción de idioma que le
      // pegamos al primer turno: ahí manda lo que escribió el humano.
      if (u.title.startsWith(IDIOMA.slice(0, 24))) {
        const propio = this.messages.find((m) => m.role === "user")?.text?.trim();
        if (propio) {
          this.title = propio.slice(0, 60);
          recordTitle(this.sessionId, this.title);
          this.emit("event", { type: "title", title: this.title });
          return;
        }
      }
      this.title = u.title;
      this.titleFromAgent = u.title;
      recordTitle(this.sessionId, u.title);
      this.emit("event", { type: "title", title: u.title });
    }
  }

  /** Devuelve la ranura antes de colgar. El agente cuenta las sesiones abiertas
   *  y no se entera de que el socket murió: sin `session/close` la caja se queda
   *  con la sesión ocupada y a las cuatro empieza a rechazar conexiones. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve();

    // Un turno en vuelo se corta primero y se espera a que cierre: así lo que
    // el agente llevaba escrito queda guardado en el hilo. Cerrar de golpe lo
    // tira, y al volver la conversación aparece sin respuesta.
    if (this.busy && this.ready) {
      this.cancelar();
      return this.esperarTurno(3000).then(() => this.cerrarDeVerdad());
    }
    return this.cerrarDeVerdad();
  }

  private cerrarDeVerdad(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);

    const sid = this.sessionId;
    const conn = this.conn;
    const adios = (async () => {
      // Sin handshake completo no hay sesión que cerrar, y la petición se
      // quedaría colgada hasta el timeout.
      if (!sid || !conn || !this.ready) return;
      // Un agente que no anuncia `close` no tiene por qué entender la petición:
      // ahí el cierre del socket es todo lo que hay.
      if (this.agentCapabilities && !this.agentCapabilities.sessionCapabilities?.close) return;
      try {
        await conTimeout(conn.agent.request("session/close", { sessionId: sid }), 3000);
      } catch (e) {
        const msg = String((e as Error).message);
        console.warn("[acp] session/close:", msg.slice(0, 120));
        // Si el cierre ni siquiera llegó, la conexión está muerta (la caja
        // durmió). Guardarla condena a los siguientes hilos a esperar 3 s por
        // cada `session/close` que nadie va a contestar.
        if (/closed|timeout/i.test(msg)) soltarConexion();
      }
    })();

    return adios.finally(() => {
      try {
        this.session?.dispose();
      } catch {}
      // La conexión NO se cierra: es del agente, no del hilo, y la siguiente
      // sesión la reusa sin volver a pagar el handshake.
      this.emit("event", { type: "closed" });
    });
  }
}

// ---------------------------------------------------------------------------
// Una sola sesión viva.
// ---------------------------------------------------------------------------
// La app es un alumno, una caja, un hilo a la vez: nadie conversa en paralelo.
// Así que hay UNA conexión y UNA sesión. Abrir un hilo es cerrar el anterior y
// cargar el nuevo; leerlo y seguirlo son la misma cosa.
//
// No es una limitación de esta app: Cline cierra la sesión activa antes de
// abrir otra tarea, Continue aborta el stream al cargar una sesión, y los CLIs
// son un proceso por conversación. Los que permiten varias las acotan con un
// tope pequeño (Zed retiene 5 hilos inactivos). Nadie mantiene una sesión viva
// por fila del historial.
//
// Y aquí importa el doble: una sesión abierta impide que la microVM hiberne, y
// la caja cobra por estar despierta.
// ---------------------------------------------------------------------------

/** El hilo que se está viendo. Puede estar conectando, listo o muerto. */
let actual: GooseSession | null = null;

/** Id de ruta de un hilo que el agente todavía no ha bautizado. */
export const HILO_NUEVO = "nuevo";

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
  /** El que está abierto ahora mismo. */
  activo?: boolean;
}

const summarize = (s: GooseSession): ConversationSummary => ({
  id: s.sessionId ?? HILO_NUEVO,
  title: s.title,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  messageCount: s.messages.length,
  tokens: s.tokens,
  contextSize: s.contextSize,
  cost: s.cost,
  busy: s.busy,
  closed: s.closed,
  activo: true,
});

/**
 * Deja abierto el hilo pedido y devuelve su sesión. `HILO_NUEVO` abre uno en
 * blanco; cualquier otro id es un `sessionId` del agente y se reabre con
 * `session/load`.
 */
export async function abrirHilo(id: string): Promise<GooseSession> {
  // Ya es el que está abierto: no se toca nada.
  if (actual && !actual.closed) {
    const mismo = id === HILO_NUEVO ? !actual.sessionId : actual.sessionId === id;
    if (mismo) return actual;
    // Cerrar de verdad, no sólo colgar: `close()` manda `session/close` y le
    // devuelve la ranura a la caja para que pueda hibernar.
    const anterior = actual;
    actual = null;
    await anterior.close();
  }

  // Dos intentos: la caja se duerme sola cuando nadie la usa, y al despertar el
  // primer socket puede llegar antes que el agente. Reintentar es lo normal
  // aquí, no una excepción — por eso no se le pide al humano que le dé a un
  // botón de "Reintentar".
  let ultimo: Error | null = null;
  for (let intento = 0; intento < 2; intento++) {
    const s = new GooseSession(WS_URL, TOKEN, CWD);
    if (id !== HILO_NUEVO) s.resumeSessionId = id;
    if (preferredModel) s.modeloPreferido = preferredModel;
    actual = s;
    s.on("event", (e: AcpEvent) => {
      if (e.type === "closed" && actual === s) actual = null;
    });
    await s.connect();
    // `connect()` no relanza: emite el error y sigue. Sin mirar `lastError`
    // devolveríamos una sesión muerta y la pantalla se quedaría conectando.
    if (!s.lastError) {
      invalidarLista();
      return s;
    }
    ultimo = new Error(s.lastError);
    actual = null;
    soltarConexion();
    void s.close();
  }
  throw ultimo ?? new Error("no pude abrir el hilo");
}

/** La sesión abierta, si la hay y sigue viva. */
export function sesionActual(): GooseSession | null {
  return actual && !actual.closed ? actual : null;
}

/** ¿Es `id` el hilo que está abierto? */
function esElActual(id: string) {
  const s = sesionActual();
  if (!s) return false;
  return id === HILO_NUEVO ? !s.sessionId : s.sessionId === id;
}

export function getMessages(id: string): StoredMessage[] {
  return esElActual(id) ? (actual?.messages ?? []) : [];
}

export async function askConversation(id: string, text: string, images: ImagePayload[] = []) {
  // Mandar un mensaje a un hilo que ya no está vivo lo reabre. Antes devolvía
  // 404 y el navegador se quedaba enseñando un mensaje que nadie recibió: la
  // caja se había dormido entre que se leyó la página y se pulsó enviar.
  if (!esElActual(id)) {
    try {
      await abrirHilo(id);
    } catch {
      return false;
    }
    if (!esElActual(id)) return false;
  }
  actual!.ask(text, images);
  markActivity();
  invalidarLista();
  return true;
}

/**
 * Un turno que llega por otro canal. Va al hilo abierto —una sola sesión viva:
 * dos clientes, una conversación— o abre uno nuevo si no hay ninguno. Resuelve
 * con el texto entero y las imágenes que devolvieron las herramientas.
 */
export async function askFromChannel(
  text: string,
  via: Canal,
  from?: string,
  images: ImagePayload[] = [],
): Promise<{ text: string; images: ImagePayload[]; audios: ImagePayload[] }> {
  let s = sesionActual();
  if (!s || !s.ready) s = await abrirHilo(s?.sessionId ?? HILO_NUEVO);
  markActivity();
  invalidarLista();
  return new Promise((resolve, reject) => {
    s!.ask(text, images, {
      via,
      from,
      onAnswer: (answer, error, imgs, auds) => {
        markActivity();
        // Con texto ya escrito, un error de cierre no borra la respuesta.
        if (error && !answer && !imgs.length && !auds.length) reject(error);
        else resolve({ text: answer, images: imgs, audios: auds });
      },
    });
  });
}

/** Pide al agente que corte el turno en curso (`session/cancel`). */
export function cancelarTurno(id: string) {
  if (!esElActual(id)) return false;
  actual!.cancelar();
  markActivity();
  invalidarLista();
  return true;
}

export async function setModel(id: string, value: string) {
  preferredModel = value;
  guardarModelos();
  if (!esElActual(id)) return false;
  try {
    await actual!.setModel(value);
  } catch (e) {
    console.warn("[setModel]", (e as Error).message);
  }
  return true;
}

export function subscribe(id: string, onEvent: (e: AcpEvent) => void) {
  const s = sesionActual();
  if (!s || !esElActual(id)) return null;
  const handler = (e: AcpEvent) => onEvent(e);
  s.on("event", handler);
  // Quien llega tarde (recarga, segunda pestaña) no vio el `started` original:
  // se le repite para que el input no se quede en "Conectando…".
  if (s.ready && s.sessionId && !s.closed) {
    onEvent({ type: "started", sessionId: s.sessionId });
    if (s.models.length) {
      onEvent({ type: "models", options: s.models, current: s.currentModel });
    }
    // Si el SSE se cayó a media respuesta y volvió cuando el turno ya había
    // terminado, este cliente se quedó con el spinner girando y el botón de
    // parar no tenía nada que cortar. El `done` de reencuentro lo desatasca:
    // sin turno en vuelo, la pantalla no tiene por qué creer que lo hay.
    if (!s.busy) {
      onEvent({ type: "done", stopReason: "completed", usage: null });
    }
  } else if (!s.closed) {
    onEvent({ type: "status", phase: s.phase });
    if (s.lastError) onEvent({ type: "error", message: s.lastError });
  }
  return () => s.off("event", handler);
}

/** Cierra el hilo abierto: la caja se queda sin sesiones y puede hibernar. */
export async function cerrarActual() {
  const s = actual;
  actual = null;
  await s?.close();
}

// ---------------------------------------------------------------------------
// El modelo elegido y su catálogo.
// ---------------------------------------------------------------------------
// ACP no tiene forma de listar modelos sin sesión: los `configOptions` sólo
// viajan en las respuestas de `session/new` y compañía. Antes se abría una
// conexión "tibia" nada más para poder pintar el selector en la portada, y esa
// conexión impedía hibernar. Se guarda la última lista conocida y se refresca
// sola cuando se abre cualquier hilo.
// ---------------------------------------------------------------------------
const MODELS_PATH = process.env.ACP_MODELS_PATH ?? ".data/models.json";
let modelosCache: ModelOption[] = [];
let preferredModel: string | null = null;
try {
  const guardado = JSON.parse(readFileSync(MODELS_PATH, "utf8"));
  modelosCache = guardado.models ?? [];
  preferredModel = guardado.current ?? null;
} catch {
  // primera vez: el selector sale vacío hasta el primer hilo
}

function guardarModelos() {
  try {
    mkdirSync(dirname(MODELS_PATH), { recursive: true });
    writeFileSync(
      MODELS_PATH,
      JSON.stringify({ models: modelosCache, current: preferredModel }, null, 2),
    );
  } catch (e) {
    console.warn("[acp] no pude guardar los modelos:", String(e).slice(0, 100));
  }
}

/** La sesión acaba de anunciar su catálogo: se recuerda para la próxima. */
export function recordModels(models: ModelOption[], current: string | null) {
  if (!models.length) return;
  modelosCache = models;
  if (current) preferredModel = current;
  guardarModelos();
}

/** Lo que la portada necesita saber sin tener ninguna sesión abierta. */
export interface HubState {
  configured: boolean;
  models: ModelOption[];
  currentModel: string | null;
  activo: string | null;
}

export function hubState(): HubState {
  const s = sesionActual();
  return {
    configured: Boolean(WS_URL),
    models: s?.models.length ? s.models : modelosCache,
    currentModel: s?.currentModel ?? preferredModel,
    activo: s?.sessionId ?? null,
  };
}

// ---------------------------------------------------------------------------
// El historial: se lo preguntamos al agente.
// ---------------------------------------------------------------------------
// La lista vive en la caja, no aquí: es la misma decisión que toma el escritorio
// de goose, que también pide `session/list` en vez de llevar su propio índice.
// Sólo se guarda un caché corto para que navegar entre pantallas no dispare una
// llamada por vista.
// ---------------------------------------------------------------------------
const LISTA_TTL_MS = Number(process.env.ACP_LIST_TTL_MS ?? 10_000);
const LISTA_PATH = process.env.ACP_LIST_PATH ?? ".data/hilos.json";

// El historial vive en la caja, pero la pantalla no puede depender de que haya
// una sesión abierta para pintarlo: si no, la lista aparece, desaparece y baila
// según qué esté conectado en ese instante. Se guarda la última lista conocida y
// se refresca por detrás.
let hilos: ConversationSummary[] = [];
let hilosAt = 0;
try {
  hilos = JSON.parse(readFileSync(LISTA_PATH, "utf8"));
} catch {
  // primera vez
}

function guardarHilos() {
  try {
    mkdirSync(dirname(LISTA_PATH), { recursive: true });
    writeFileSync(LISTA_PATH, JSON.stringify(hilos, null, 2));
  } catch {}
}

const invalidarLista = () => (hilosAt = 0);

export async function listAgentSessions(): Promise<any> {
  const s = sesionActual();
  if (!s) return { error: "sin sesión abierta" };
  const caps = s.agentCapabilities;
  if (caps && !caps.sessionCapabilities?.list) return { sessions: [] };
  // Socket ya cerrado → la caja se durmió; preguntar colgaría 15 s. La copia
  // guardada sirve mientras tanto y abrir un hilo reconecta y despierta.
  if ((conexion?.socket?.readyState ?? 1) !== 1) {
    return { error: "sin conexión con la caja" };
  }
  try {
    return await conTimeout((s as any).conn.agent.request("session/list", {}), 15_000);
  } catch (e) {
    // La caja se suspendió sin avisar: la conexión quedó half-open y toda
    // petición esperaría el timeout. Se entierra la sesión y se suelta la
    // conexión: la pantalla se sirve de la copia guardada y el próximo uso
    // reconecta (y despierta) solo.
    if (sesionActual() === s) actual = null;
    soltarConexion();
    void s.close();
    return { error: (e as Error).message };
  }
}

/** Trae la lista del agente y la guarda. Silencioso: si falla, se queda la vieja. */
async function refrescarHilos() {
  const remoto: any = await listAgentSessions().catch(() => null);
  if (!remoto?.sessions) return;
  hilos = remoto.sessions.map((r: any) => ({
    id: r.sessionId,
    title: titles[r.sessionId] || r.title || "Sin título",
    createdAt: Date.parse(r._meta?.createdAt ?? r.updatedAt),
    // El `updatedAt` del agente se mueve cada vez que alguien ABRE el hilo:
    // ordenar por él hace bailar la lista con sólo pasear por el historial.
    updatedAt: Date.parse(r._meta?.lastMessageAt ?? r.updatedAt),
    messageCount: r._meta?.messageCount ?? 0,
    tokens: 0,
    contextSize: 0,
    cost: 0,
    busy: false,
    closed: true,
  }));
  hilosAt = Date.now();
  guardarHilos();
}

export async function listHistory(): Promise<ConversationSummary[]> {
  const viva = sesionActual();

  // Con sesión y la lista vencida, se espera al agente: es rápido y así el hilo
  // recién creado aparece de inmediato. Sin sesión, se sirve lo guardado.
  if (viva && Date.now() - hilosAt > LISTA_TTL_MS) await refrescarHilos();

  const items = hilos.map((h) => {
    if (!viva || viva.sessionId !== h.id) return h;
    // El hilo abierto aporta lo que sólo él sabe (tokens, si está respondiendo),
    // pero NO su hora: el reloj de este proceso avanza cada vez que lo abres, y
    // con eso la fila se movería de sitio sólo por mirarla. La hora es la del
    // agente, salvo que el hilo tenga mensajes nuevos que él aún no registra.
    const v = summarize(viva);
    return { ...v, updatedAt: v.messageCount > h.messageCount ? v.updatedAt : h.updatedAt };
  });
  // Un hilo recién estrenado todavía no está en la lista del agente, así que se
  // pone a mano. Pero sólo si tiene algo dentro: uno vacío —o un id que en esta
  // caja no existe— sería una fila fantasma que además se cuela arriba.
  const yaEsta = viva && items.some((i) => i.id === (viva.sessionId ?? HILO_NUEVO));
  if (viva && !yaEsta && viva.messages.length > 0) {
    items.unshift(summarize(viva));
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ---------------------------------------------------------------------------
// Skills: la memoria procedimental, vista desde fuera.
// ---------------------------------------------------------------------------
// En la spec de ACP no hay nada de skills, pero goose sí las expone — con otro
// nombre: `_goose/unstable/sources/*`. Es extensión propietaria, así que si el
// agente no la entiende la pantalla se queda vacía en vez de romperse.
//
// `SourceType` separa lo que trae el binario (`builtinSkill`) de lo que pone el
// proyecto (`skill`), que es justo la distinción que importa: las del proyecto
// viven en el repo y vuelven solas si la caja muere.
// ---------------------------------------------------------------------------

export interface Skill {
  name: string;
  description: string;
  location: string;
  builtin: boolean;
  /** Puesta por el proyecto: ésa es la que viaja con el repo. */
  delProyecto: boolean;
}

export async function listSkills(): Promise<{ skills: Skill[]; error?: string }> {
  const s = sesionActual() ?? (await abrirHilo(HILO_NUEVO).catch(() => null));
  if (!s) return { skills: [], error: "sin agente al que preguntar" };

  const pedir = async (type: "skill" | "builtinSkill") => {
    const r: any = await conTimeout(
      (s as any).conn.agent.request("_goose/unstable/sources/list", { type, projectDir: CWD }),
      15_000,
    );
    return (r?.sources ?? []).map((f: any) => ({
      name: f.name,
      description: f.description ?? "",
      location: f.path ?? `builtin://skills/${f.name}`,
      builtin: type === "builtinSkill",
      delProyecto: type === "skill",
    }));
  };

  try {
    const [propias, fabrica] = await Promise.all([pedir("skill"), pedir("builtinSkill")]);
    return { skills: [...propias, ...fabrica] };
  } catch (e) {
    // Un agente que no sea goose no conoce este método: no es un fallo.
    return { skills: [], error: `este agente no expone sus skills (${(e as Error).message})` };
  }
}

export const config = { wsUrl: WS_URL, cwd: CWD, agentBox: AGENT_BOX, idleMs: IDLE_MS };

// ---------------------------------------------------------------------------
// Títulos: la única memoria que es nuestra.
// ---------------------------------------------------------------------------
// El agente guarda todos los hilos como "New Chat" y no acepta renombrarlos
// (`list`, `delete`, `close`; no hay rename). El nombre legible lo pone el
// Cliente, así que también le toca guardarlo: si sólo vive en el proceso, cada
// reinicio devuelve la lista a "New Chat".
const TITLES_PATH = process.env.ACP_TITLES_PATH ?? ".data/titles.json";
let titles: Record<string, string> = {};
try {
  titles = JSON.parse(readFileSync(TITLES_PATH, "utf8"));
} catch {
  // primera vez, o el archivo se fue con la caja
}

function recordTitle(sessionId: string | null, title: string) {
  if (!sessionId || !title || titles[sessionId] === title) return;
  titles[sessionId] = title;
  try {
    mkdirSync(dirname(TITLES_PATH), { recursive: true });
    writeFileSync(TITLES_PATH, JSON.stringify(titles, null, 2));
  } catch (e) {
    console.log("[acp] no se pudo guardar el título:", String(e).slice(0, 100));
  }
}

// ---------------------------------------------------------------------------
// Cerrar al morir. El agente cuenta las conversaciones abiertas y no se entera
// de que el Cliente desapareció: si el proceso muere sin despedirse —un
// reinicio del dev server, un deploy— las sesiones siguen ocupando ranura del
// lado de la caja, y la sesión fantasma le impide hibernar hasta que alguien
// reinicia el agente.
// ---------------------------------------------------------------------------
let despidiendose = false;
async function cerrarTodo() {
  if (despidiendose) return;
  despidiendose = true;
  // Techo corto: despedirse es cortesía, colgar el Ctrl-C no.
  await Promise.race([
    cerrarActual(),
    new Promise((r) => setTimeout(r, 4000)),
  ]);
  soltarConexion();
}

for (const senal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(senal, () => {
    cerrarTodo().finally(() => process.exit(0));
  });
}
process.once("beforeExit", cerrarTodo);

// ---------------------------------------------------------------------------
// Suspend al idle: sin sockets SSE ni turnos en vuelo durante IDLE_MS.
// ---------------------------------------------------------------------------
let lastActivity = Date.now();
let activeSse = 0;
export const markActivity = () => (lastActivity = Date.now());
export const openSse = () => {
  activeSse++;
  markActivity();
  if (process.env.ACP_DEBUG_SSE) console.log("[sse] abiertos:", activeSse);
};
export const closeSse = () => {
  activeSse = Math.max(0, activeSse - 1);
  if (process.env.ACP_DEBUG_SSE) console.log("[sse] abiertos:", activeSse);
};

setInterval(() => {
  if (activeSse === 0 && !sesionActual()?.busy && Date.now() - lastActivity > IDLE_MS) {
    // Despedirse ANTES de la siesta. Suspender la caja no limpia las sesiones
    // del lado del agente: quedan contando para siempre, y a las cuatro la caja
    // rechaza todo hasta que alguien reinicia el agente.
    void cerrarActual()
      .catch(() => {})
      .then(() => {
        soltarConexion();
        return suspendAgentBox().catch(() => {});
      });
    lastActivity = Date.now();
  }
}, 30_000).unref?.();


// ---------------------------------------------------------------------------
// Extensiones MCP
//
// Dos verdades distintas, y ésa es la lección de la sesión 4: la base sqlite
// guarda lo que este Cliente DECLARA; el Agente reporta lo que tiene
// CONECTADO. No siempre coinciden, y el juez final es preguntarle al agente
// qué herramientas ve.
// ---------------------------------------------------------------------------

export interface AgentExtension {
  name: string;
  description: string;
  /** platform/builtin son las que trae el binario; mcp, las que conectamos. */
  kind: string;
  propia: boolean;
}

/** Lo que el Agente tiene conectado en la sesión viva. */
export async function listAgentExtensions(): Promise<{
  extensions: AgentExtension[];
  error?: string;
}> {
  const s = sesionActual();
  // Sin sesión abierta no se despierta la caja sólo para pintar una lista.
  if (!s?.sessionId || !(s as any).conn) return { extensions: [] };
  if (conexion?.socket && conexion.socket.readyState !== SOCKET_ABIERTO) {
    return { extensions: [], error: "el canal con el agente está cerrado" };
  }
  try {
    const r: any = await conTimeout(
      (s as any).conn.agent.request("_goose/unstable/session/extensions/list", {
        sessionId: s.sessionId,
      }),
      15_000,
    );
    return {
      extensions: (r?.extensions ?? []).map((e: any) => ({
        name: e.name ?? e.server?.name ?? "?",
        description: e.description ?? "",
        kind: e.type ?? "?",
        propia: e.type === "mcp",
      })),
    };
  } catch (e) {
    // Otro agente no conoce este método: la pantalla no se rompe por eso.
    return { extensions: [], error: `este agente no lista sus extensiones (${(e as Error).message})` };
  }
}

/** Conecta una extensión a la sesión que está abierta, sin reiniciar el hilo.
 *
 *  `session/extensions/add` no está en la spec de ACP: es de goose, y pide su
 *  propio envoltorio `GooseExtension::Mcp`, que lleva dentro el `McpServer`
 *  de ACP en el campo `server`. */
export async function conectarExtensionEnVivo(
  e: Extension,
): Promise<{ ok: boolean; error?: string }> {
  const s = sesionActual();
  if (!s?.sessionId || !(s as any).conn) return { ok: false, error: "no hay ningún hilo abierto" };
  try {
    await conTimeout(
      (s as any).conn.agent.request("_goose/unstable/session/extensions/add", {
        sessionId: s.sessionId,
        extension: {
          type: "mcp",
          name: e.name,
          description: `Dada de alta desde la web`,
          display_name: e.name,
          timeout: 60,
          bundled: false,
          available_tools: [],
          envKeys: [],
          server: aMcpServer(e),
        },
      }),
      30_000,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
