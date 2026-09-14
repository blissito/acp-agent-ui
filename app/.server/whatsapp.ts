/**
 * El canal de WhatsApp: un número vinculado a esta app, que escucha en grupos
 * y convierte cada mensaje en un turno del mismo motor ACP que usa la web.
 *
 * Baileys habla el protocolo de WhatsApp Web: esta app ES un "dispositivo
 * vinculado" más, como la pestaña del navegador. No hay webhook ni API de
 * Meta; el socket vive en este proceso y el teléfono lo ve como una sesión.
 *
 * Estados: disconnected → connecting → qr_pending | pairing → connected | failed.
 * Las credenciales van a sqlite para sobrevivir al reinicio sin volver a
 * escanear. El QR nunca se guarda: caduca en segundos.
 */
import { EventEmitter } from "node:events";
import { Boom } from "@hapi/boom";
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  fetchLatestWaWebVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationState,
  type WASocket,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { abrir } from "./extensions";
import { askFromChannel } from "./acp";

export type WaStatus = "disconnected" | "connecting" | "qr_pending" | "pairing" | "connected" | "failed";

export interface WaState {
  status: WaStatus;
  /** Data URL del QR, sólo en qr_pending. */
  qr: string | null;
  /** Código de 8 caracteres (XXXX-XXXX), sólo en pairing. */
  pairingCode: string | null;
  phone: string | null;
  /** Nombre y número del teléfono vinculado, ya conectado. */
  me: { id: string; name: string } | null;
  connectedAt: number | null;
  reason: string | null;
  attempt: number;
}

export interface WaGroup {
  id: string;
  subject: string;
  enabled: boolean;
}

const MAX_RECONNECT = 5;
const GROUP_CACHE_MS = 60_000;
// Varios mensajes seguidos en el grupo son UNA petición, no N: se juntan y va
// un solo turno. Si no, cada línea abre un turno y el agente contesta N veces.
const COALESCE_MS = 1500;

const silent: any = { level: "silent", child: () => silent };
for (const m of ["trace", "debug", "info", "warn", "error", "fatal"]) silent[m] = () => {};

// ---------------------------------------------------------------------------
// Tablas: credenciales (una fila por tipo) y grupos (allowlist)
// ---------------------------------------------------------------------------
function db() {
  const d = abrir();
  d.exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_auth (
      name  TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      jid     TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      seen_at INTEGER NOT NULL
    )
  `);
  return d;
}
const leerAuth = (name: string): unknown => {
  const r = db().prepare("SELECT value FROM whatsapp_auth WHERE name = ?").get(name) as any;
  return r ? JSON.parse(r.value, BufferJSON.reviver) : null;
};
const guardarAuth = (name: string, value: unknown) =>
  db()
    .prepare("INSERT INTO whatsapp_auth (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value")
    .run(name, JSON.stringify(value, BufferJSON.replacer));
const borrarAuth = () => db().exec("DELETE FROM whatsapp_auth");

/** Auth de Baileys sobre sqlite. Las llaves de señal llegan a ráfagas durante
 *  el pairing: se escriben con debounce, porque escribir todas de golpe rompe
 *  el handshake (lo pagó easybits). */
function useSqliteAuthState(): { state: AuthenticationState; saveCreds: () => Promise<void> } {
  const creds = (leerAuth("creds") as any) ?? initAuthCreds();
  const keys: Record<string, Record<string, unknown>> = (leerAuth("keys") as any) ?? {};
  let flushTimer: NodeJS.Timeout | null = null;
  const flushKeys = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      try { guardarAuth("keys", keys); } catch (e) { log(`keys no se guardaron: ${(e as Error).message}`); }
    }, 600);
    flushTimer.unref?.();
  };
  const rawKeys = {
    get: (type: string, ids: string[]) => {
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        let v = keys[type]?.[id];
        if (type === "app-state-sync-key" && v) v = proto.Message.AppStateSyncKeyData.fromObject(v as any);
        if (v !== undefined) out[id] = v;
      }
      return out as any;
    },
    set: (data: any) => {
      for (const type in data) {
        keys[type] = keys[type] || {};
        Object.assign(keys[type], data[type]);
      }
      flushKeys();
    },
  };
  return {
    state: { creds, keys: makeCacheableSignalKeyStore(rawKeys as any, silent) },
    saveCreds: async () => { guardarAuth("creds", creds); },
  };
}

// ---------------------------------------------------------------------------
// Estado en memoria + eventos para el SSE de /whatsapp
// ---------------------------------------------------------------------------
const bus = new EventEmitter();
let state: WaState = {
  status: "disconnected", qr: null, pairingCode: null, phone: null,
  me: null, connectedAt: null, reason: null, attempt: 0,
};
let sock: WASocket | null = null;
let pairingPhone: string | undefined;
let attempts = 0;
let groupCache: { at: number; groups: WaGroup[] } | null = null;
// ids de lo que mandamos nosotros, para no contestarnos solos
const sentIds = new Set<string>();

const log = (m: string) => console.log(`[whatsapp] ${m}`);

function setState(patch: Partial<WaState>) {
  state = { ...state, ...patch };
  bus.emit("state", state);
}

export const waState = () => state;
export function subscribeWa(fn: (s: WaState) => void) {
  bus.on("state", fn);
  fn(state);
  return () => bus.off("state", fn);
}

/** ¿Hay credenciales guardadas? Si sí, al arrancar la app se reconecta sola. */
export const tieneCredenciales = () => !!(leerAuth("creds") as any)?.registered;

// ---------------------------------------------------------------------------
// Conectar / vincular / desvincular
// ---------------------------------------------------------------------------
export async function conectar(opts: { phone?: string } = {}): Promise<void> {
  const phone = opts.phone?.replace(/[^0-9]/g, "") || undefined;
  if (state.status === "connecting" || state.status === "pairing" || state.status === "qr_pending") {
    // Pedir código a medio QR (o al revés) cancela el intento anterior: los dos
    // son el mismo handshake y el teléfono sólo acepta uno vivo.
    if (!phone && !pairingPhone) return;
  }
  if (state.status === "connected" && !phone) return;
  cerrarSocket();
  if (phone && (phone.length < 10 || phone.length > 15)) {
    setState({ status: "failed", reason: "El número va con lada, sin espacios: 521XXXXXXXXXX." });
    return;
  }
  pairingPhone = phone;
  setState({ status: "connecting", qr: null, pairingCode: null, phone: phone ?? null, reason: null });

  const auth = useSqliteAuthState();
  const version = await Promise.race([
    fetchLatestWaWebVersion({}).then((r) => r.version).catch(() => undefined),
    new Promise<undefined>((res) => setTimeout(() => res(undefined), 5000)),
  ]);
  const s = makeWASocket({
    version,
    auth: auth.state,
    logger: silent,
    printQRInTerminal: false,
    browser: Browsers.macOS("Chrome"),
  });
  sock = s;
  s.ev.on("creds.update", auth.saveCreds);

  // Con número: el código de 8 caracteres en vez del QR. Mismo handshake, otra
  // forma de teclearlo — y en la práctica vincula mejor que la cámara.
  if (phone && !auth.state.creds.registered) {
    setTimeout(async () => {
      if (sock !== s) return;
      try {
        const code = await s.requestPairingCode(phone);
        const bonito = code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
        log(`código ${bonito}`);
        setState({ status: "pairing", pairingCode: bonito, qr: null });
      } catch (e) {
        log(`requestPairingCode falló: ${e}`);
        setState({ status: "failed", reason: "WhatsApp no dio código. Espera un minuto y vuelve a intentar." });
      }
    }, 1500);
  }

  s.ev.on("connection.update", async (u) => {
    if (sock !== s) return;
    if (u.qr && !phone) {
      const qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      setState({ status: "qr_pending", qr, pairingCode: null });
    }
    if (u.connection === "open") {
      attempts = 0;
      const me = s.user ? { id: s.user.id.split(":")[0].split("@")[0], name: s.user.name ?? "" } : null;
      log(`conectado como ${me?.id}`);
      setState({ status: "connected", qr: null, pairingCode: null, me, connectedAt: Date.now(), attempt: 0 });
      groupCache = null;
    }
    if (u.connection === "close") {
      const code = (u.lastDisconnect?.error as Boom)?.output?.statusCode;
      // 515 es el reinicio normal justo después de vincular: no cuenta como fallo.
      if (code === DisconnectReason.restartRequired) {
        log("restart required → reconecto");
        setTimeout(() => void conectar({ phone: pairingPhone }).catch(() => {}), 500);
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        log("el teléfono cerró la sesión");
        cerrarSocket();
        borrarAuth();
        setState({ status: "disconnected", me: null, connectedAt: null, reason: "El teléfono cerró la sesión. Vuelve a vincular." });
        return;
      }
      attempts += 1;
      if (attempts > MAX_RECONNECT) {
        cerrarSocket();
        setState({ status: "failed", reason: "Se cayó la conexión y no volvió tras 5 intentos." });
        return;
      }
      const backoff = Math.min(30_000, 1000 * 2 ** attempts);
      log(`cerrado (${code}) → reintento ${attempts} en ${backoff} ms`);
      setState({ status: "connecting", attempt: attempts });
      setTimeout(() => void conectar({ phone: pairingPhone }).catch(() => {}), backoff);
    }
  });

  s.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify" || sock !== s) return;
    for (const m of messages) void recibir(s, m);
  });
}

function cerrarSocket() {
  if (!sock) return;
  try { sock.ev.removeAllListeners("connection.update"); sock.end(undefined); } catch {}
  sock = null;
}

/** Desvincular: cierra sesión en el teléfono y tira las credenciales. */
export async function desvincular() {
  try { await sock?.logout(); } catch {}
  cerrarSocket();
  borrarAuth();
  pairingPhone = undefined;
  attempts = 0;
  groupCache = null;
  setState({ status: "disconnected", qr: null, pairingCode: null, phone: null, me: null, connectedAt: null, reason: null, attempt: 0 });
}

/** Al arrancar el servidor: si hay credenciales, reconecta sin pedir nada. */
let rehidratado = false;
export function rehidratar() {
  if (rehidratado) return;
  rehidratado = true;
  if (tieneCredenciales() && state.status === "disconnected") {
    log("credenciales guardadas → reconecto");
    void conectar().catch((e) => log(`no reconectó: ${e}`));
  }
}

// ---------------------------------------------------------------------------
// Grupos: los que ve el número + los que ya escribieron; allowlist en sqlite
// ---------------------------------------------------------------------------
export async function listarGrupos(opts: { live?: boolean } = {}): Promise<WaGroup[]> {
  const d = db();
  const enabled = new Set(
    (d.prepare("SELECT jid FROM whatsapp_groups WHERE enabled = 1").all() as any[]).map((r) => r.jid)
  );
  const merged = new Map<string, string>();
  if (sock && state.status === "connected") {
    const fresco = groupCache && Date.now() - groupCache.at < GROUP_CACHE_MS;
    // El poll del navegador nunca dispara la consulta al socket: WhatsApp
    // castiga esa IQ repetida con rate-overlimit. Sólo la carga de la página.
    if (!fresco && opts.live !== false) {
      try {
        const g = await sock.groupFetchAllParticipating();
        const groups = Object.values(g).map((x: any) => ({ id: x.id, subject: x.subject || x.id, enabled: false }));
        groupCache = { at: Date.now(), groups };
        const up = d.prepare(
          "INSERT INTO whatsapp_groups (jid, subject, enabled, seen_at) VALUES (?, ?, 0, ?) ON CONFLICT(jid) DO UPDATE SET subject = excluded.subject"
        );
        for (const x of groups) up.run(x.id, x.subject, Date.now());
      } catch (e) {
        log(`groupFetch falló: ${e}`);
      }
    }
    for (const x of groupCache?.groups ?? []) merged.set(x.id, x.subject);
  }
  for (const r of d.prepare("SELECT jid, subject FROM whatsapp_groups").all() as any[]) {
    if (!merged.has(r.jid)) merged.set(r.jid, r.subject);
  }
  return [...merged]
    .map(([id, subject]) => ({ id, subject, enabled: enabled.has(id) }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

export function setGrupo(jid: string, enabled: boolean) {
  db()
    .prepare("INSERT INTO whatsapp_groups (jid, subject, enabled, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(jid) DO UPDATE SET enabled = excluded.enabled")
    .run(jid, jid, enabled ? 1 : 0, Date.now());
}
const grupoActivo = (jid: string) =>
  !!(db().prepare("SELECT enabled FROM whatsapp_groups WHERE jid = ? AND enabled = 1").get(jid));

async function anotarGrupoVisto(s: WASocket, jid: string) {
  const d = db();
  if (d.prepare("SELECT 1 FROM whatsapp_groups WHERE jid = ?").get(jid)) return;
  let subject = jid;
  try { subject = (await s.groupMetadata(jid)).subject || jid; } catch {}
  d.prepare("INSERT OR IGNORE INTO whatsapp_groups (jid, subject, enabled, seen_at) VALUES (?, ?, 0, ?)").run(jid, subject, Date.now());
}

// ---------------------------------------------------------------------------
// Entrada: un mensaje del grupo → un turno del motor → la respuesta al grupo
// ---------------------------------------------------------------------------
type Pendiente = { items: { text: string; from: string; key: proto.IMessageKey }[]; timer: NodeJS.Timeout | null; running: boolean };
const buffers = new Map<string, Pendiente>();

async function recibir(s: WASocket, m: proto.IWebMessageInfo) {
  const key = m.key;
  const jid = key?.remoteJid;
  if (!key || !jid || !jid.endsWith("@g.us")) return; // sólo grupos
  if (key.id && sentIds.has(key.id)) return;
  if (key.fromMe) return; // lo que escribe el propio número no es una orden
  const text = m.message?.conversation ?? m.message?.extendedTextMessage?.text ?? "";
  if (!text.trim()) return;
  await anotarGrupoVisto(s, jid);
  if (!grupoActivo(jid)) {
    log(`mensaje en ${jid} ignorado: grupo apagado`);
    return;
  }
  const from = m.pushName || (key.participant ?? "").split("@")[0] || "alguien";
  log(`${from} en ${jid}: "${text.slice(0, 50)}"`);
  let buf = buffers.get(jid);
  if (!buf) { buf = { items: [], timer: null, running: false }; buffers.set(jid, buf); }
  buf.items.push({ text, from, key });
  if (buf.running) return; // al terminar el turno en vuelo se vacía lo que llegó
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => void vaciar(s, jid), COALESCE_MS);
}

async function vaciar(s: WASocket, jid: string) {
  const buf = buffers.get(jid);
  if (!buf || buf.running || buf.items.length === 0) return;
  buf.timer = null;
  buf.running = true;
  const batch = buf.items.splice(0);
  const last = batch[batch.length - 1];
  const from = last.from;
  // Si escribieron varias personas, se dice quién dijo qué.
  const varios = new Set(batch.map((b) => b.from)).size > 1;
  const text = batch.map((b) => (varios ? `${b.from}: ${b.text}` : b.text)).join("\n");

  // 👀 = "te leí"; la burbuja de escribiendo mientras piensa; ✅ al contestar.
  s.sendMessage(jid, { react: { text: "👀", key: last.key } }).catch(() => {});
  s.sendPresenceUpdate("composing", jid).catch(() => {});
  const typing = setInterval(() => s.sendPresenceUpdate("composing", jid).catch(() => {}), 8000);
  try {
    const answer = await askFromChannel(text, "whatsapp", from);
    const body = answer.trim() || "Listo.";
    const sent = await s.sendMessage(jid, { text: body });
    if (sent?.key?.id) sentIds.add(sent.key.id);
    s.sendMessage(jid, { react: { text: "✅", key: last.key } }).catch(() => {});
    log(`contesté en ${jid} (${batch.length} mensajes)`);
  } catch (e) {
    log(`turno falló en ${jid}: ${(e as Error).message}`);
    s.sendMessage(jid, { react: { text: "⚠️", key: last.key } }).catch(() => {});
    s.sendMessage(jid, { text: "Algo se atoró con ese mensaje. ¿Me lo repites?" }).catch(() => {});
  } finally {
    clearInterval(typing);
    s.sendPresenceUpdate("paused", jid).catch(() => {});
    buf.running = false;
    if (buf.items.length > 0) buf.timer = setTimeout(() => void vaciar(s, jid), COALESCE_MS);
  }
}
