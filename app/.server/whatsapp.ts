/**
 * El canal de WhatsApp — sesión 5.
 *
 * Un canal hace cuatro cosas, siempre las mismas: recibe un mensaje, lo convierte en un
 * turno del motor, espera la respuesta y la devuelve por donde entró. El agente no se
 * entera de por dónde le hablaron.
 *
 * La app es un dispositivo vinculado más: `makeWASocket` en este mismo proceso, y el
 * teléfono la ve como otra pestaña de WhatsApp Web (Baileys habla el protocolo directo por
 * WebSocket; no hay Chrome oculto ni número de empresa).
 */
import { EventEmitter } from "node:events";
import makeWASocket, {
  Browsers,
  BufferJSON,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import QRCode from "qrcode";
import { abrirDb } from "./extensions";
import { askFromChannel } from "./acp";
import type { ImagePayload } from "~/hooks/useAcpStream";

// ---------------------------------------------------------------------------
// Estado que ve el navegador
// ---------------------------------------------------------------------------
export type WaPhase = "disconnected" | "connecting" | "qr_pending" | "pairing" | "connected" | "failed";

export interface WaGroup {
  jid: string;
  subject: string;
  enabled: boolean;
  seenAt: number;
}

export interface WaState {
  phase: WaPhase;
  /** Data URL del QR. Nunca se guarda: vive lo que vive el handshake. */
  qr: string | null;
  /** El código de 8 caracteres si se pidió vincular por número. */
  pairingCode: string | null;
  /** Con quién quedó vinculada la app. */
  me: { id: string; name?: string } | null;
  error: string | null;
}

const estado: WaState = { phase: "disconnected", qr: null, pairingCode: null, me: null, error: null };
const emisor = new EventEmitter();
emisor.setMaxListeners(50);

function setEstado(patch: Partial<WaState>) {
  Object.assign(estado, patch);
  emisor.emit("state", { ...estado });
}

export const waState = (): WaState => ({ ...estado });

/** Suscribe al estado; llama de inmediato con el actual. */
export function subscribeWa(fn: (s: WaState) => void) {
  emisor.on("state", fn);
  fn({ ...estado });
  return () => emisor.off("state", fn);
}

// Un logger callado: Baileys es ruidoso y aquí sólo importa lo que decidimos loguear.
const silencio: any = {
  level: "silent",
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silencio;
  },
};

// ---------------------------------------------------------------------------
// Credenciales en sqlite (tablas whatsapp_auth y whatsapp_groups)
// ---------------------------------------------------------------------------
function db() {
  const d = abrirDb();
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
    );
  `);
  return d;
}

const leer = (name: string): any | null => {
  const r = db().prepare("SELECT value FROM whatsapp_auth WHERE name = ?").get(name) as any;
  return r ? JSON.parse(r.value, BufferJSON.reviver) : null;
};
const escribir = (name: string, value: unknown) =>
  db()
    .prepare("INSERT OR REPLACE INTO whatsapp_auth (name, value) VALUES (?, ?)")
    .run(name, JSON.stringify(value, BufferJSON.replacer));
const borrar = (name: string) => db().prepare("DELETE FROM whatsapp_auth WHERE name = ?").run(name);

const hayCredenciales = () => Boolean(leer("creds")?.registered);

/** El estado de auth que Baileys pide, sobre sqlite. Las llaves de señal llegan a ráfagas
 *  en el pairing y se escriben con debounce de 600 ms; sin él el handshake se rompe. */
function authDesdeSqlite() {
  const creds: AuthenticationCreds = leer("creds") ?? initAuthCreds();
  const pendientes = new Map<string, unknown | null>();
  let timer: NodeJS.Timeout | null = null;
  const volcar = () => {
    timer = null;
    const d = db();
    const ins = d.prepare("INSERT OR REPLACE INTO whatsapp_auth (name, value) VALUES (?, ?)");
    const del = d.prepare("DELETE FROM whatsapp_auth WHERE name = ?");
    for (const [name, value] of pendientes) {
      if (value == null) del.run(name);
      else ins.run(name, JSON.stringify(value, BufferJSON.replacer));
    }
    pendientes.clear();
  };
  const keys = {
    get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const out: Record<string, SignalDataTypeMap[T]> = {};
      for (const id of ids) {
        const k = `key:${type}:${id}`;
        const v = pendientes.has(k) ? pendientes.get(k) : leer(k);
        if (v != null) out[id] = v as SignalDataTypeMap[T];
      }
      return out;
    },
    set(data: any) {
      for (const type of Object.keys(data)) {
        for (const id of Object.keys(data[type])) {
          pendientes.set(`key:${type}:${id}`, data[type][id]);
        }
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(volcar, 600);
    },
  };
  const saveCreds = () => escribir("creds", creds);
  return { creds, keys, saveCreds, volcar: () => timer && volcar() };
}

function borrarAuth() {
  db().prepare("DELETE FROM whatsapp_auth").run();
}

// ---------------------------------------------------------------------------
// Grupos: allowlist. Baileys entrega todo; nosotros decidimos dónde contestar.
// ---------------------------------------------------------------------------
const aGrupo = (r: any): WaGroup => ({ jid: r.jid, subject: r.subject, enabled: !!r.enabled, seenAt: r.seen_at });

export function listGroups(): WaGroup[] {
  return db().prepare("SELECT * FROM whatsapp_groups ORDER BY subject").all().map(aGrupo);
}

export function setGroupEnabled(jid: string, enabled: boolean) {
  db().prepare("UPDATE whatsapp_groups SET enabled = ? WHERE jid = ?").run(enabled ? 1 : 0, jid);
}

/** Un grupo nuevo aparece en la lista cuando alguien escribe en él (o al listar). */
function verGrupo(jid: string, subject?: string) {
  db()
    .prepare(
      `INSERT INTO whatsapp_groups (jid, subject, enabled, seen_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(jid) DO UPDATE SET subject = CASE WHEN excluded.subject <> '' THEN excluded.subject ELSE subject END, seen_at = excluded.seen_at`,
    )
    .run(jid, subject ?? "", Date.now());
}

function grupoActivo(jid: string): boolean {
  const r = db().prepare("SELECT enabled FROM whatsapp_groups WHERE jid = ?").get(jid) as any;
  return !!r?.enabled;
}

// La lista de grupos del teléfono se pide una vez por minuto, nunca en el poll.
let gruposAt = 0;
async function refrescarGrupos() {
  if (!sock || estado.phase !== "connected" || Date.now() - gruposAt < 60_000) return;
  gruposAt = Date.now();
  try {
    const todos = await sock.groupFetchAllParticipating();
    for (const g of Object.values(todos)) verGrupo(g.id, g.subject);
  } catch (e) {
    console.warn("[wa] groupFetchAllParticipating:", (e as Error).message);
  }
}

export async function gruposConRefresco(): Promise<WaGroup[]> {
  await refrescarGrupos();
  return listGroups();
}

// ---------------------------------------------------------------------------
// El socket
// ---------------------------------------------------------------------------
let sock: WASocket | null = null;
let reintentos = 0;
let telefonoPendiente: string | null = null;
/** Ids de los mensajes que mandamos nosotros: no se contestan a sí mismos. */
const nuestros = new Set<string>();

const conCarrera = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

async function abrirSocket() {
  if (sock) {
    try {
      sock.ev.removeAllListeners("connection.update");
      sock.end(undefined);
    } catch {}
    sock = null;
  }
  setEstado({ phase: "connecting", qr: null, pairingCode: null, error: null });

  const auth = authDesdeSqlite();
  // La versión de WhatsApp Web, con carrera de 5 s: si el fetch no vuelve se usa la del paquete.
  const { version } = await conCarrera<{ version?: any }>(fetchLatestWaWebVersion({}), 5_000, {});

  const s = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(auth.keys, silencio) },
    logger: silencio,
    browser: Browsers.macOS("Chrome"),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  sock = s;

  s.ev.on("creds.update", auth.saveCreds);

  s.ev.on("connection.update", async (u) => {
    if (u.qr) {
      const qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      setEstado({ phase: telefonoPendiente ? "pairing" : "qr_pending", qr, error: null });
    }
    if (u.connection === "open") {
      reintentos = 0;
      telefonoPendiente = null;
      const me = s.user ? { id: s.user.id, name: s.user.name } : null;
      setEstado({ phase: "connected", qr: null, pairingCode: null, me, error: null });
      console.log("[wa] conectado como", me?.id);
      void refrescarGrupos();
    }
    if (u.connection === "close") {
      auth.volcar();
      const code = (u.lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const msg = (u.lastDisconnect?.error as Error | undefined)?.message ?? "";
      console.log("[wa] cerrado", code, msg);
      if (code === DisconnectReason.restartRequired) {
        // Tras el pairing WhatsApp pide reiniciar el socket: no cuenta como fallo.
        setTimeout(() => void abrirSocket().catch(fallo), 500);
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        borrarAuth();
        sock = null;
        setEstado({ phase: "disconnected", qr: null, pairingCode: null, me: null, error: "El teléfono cerró la sesión." });
        return;
      }
      if (reintentos >= 5) {
        sock = null;
        setEstado({ phase: "failed", qr: null, pairingCode: null, error: `No pude reconectar (${code ?? "?"} ${msg}).` });
        return;
      }
      const espera = Math.min(30_000, 2 ** reintentos * 1000);
      reintentos++;
      setEstado({ phase: "connecting", qr: null, pairingCode: null, error: null });
      setTimeout(() => void abrirSocket().catch(fallo), espera);
    }
  });

  s.ev.on("messages.upsert", ({ type, messages }) => {
    if (type !== "notify") return;
    for (const m of messages) void recibir(m).catch((e) => console.warn("[wa] recibir:", e.message));
  });

  // Código por número: sólo si no hay registro previo, y 1.5 s después de crear el socket.
  if (telefonoPendiente && !auth.creds.registered) {
    const tel = telefonoPendiente;
    setTimeout(async () => {
      try {
        const code = await s.requestPairingCode(tel);
        setEstado({ phase: "pairing", qr: null, pairingCode: code, error: null });
      } catch (e) {
        setEstado({ phase: "failed", error: `No pude pedir el código: ${(e as Error).message}` });
      }
    }, 1_500);
  }
}

function fallo(e: Error) {
  console.warn("[wa] socket:", e.message);
  setEstado({ phase: "failed", qr: null, pairingCode: null, error: e.message });
}

/** Abre el handshake por QR. Pedir uno cancela al otro: son el mismo handshake. */
export async function connect() {
  telefonoPendiente = null;
  reintentos = 0;
  await abrirSocket().catch(fallo);
}

/** Abre el handshake por código de 8 caracteres para ese número (sólo dígitos, con lada). */
export async function pair(phone: string) {
  const tel = phone.replace(/\D/g, "");
  if (tel.length < 8) throw new Error("El número va con lada y sólo dígitos, por ejemplo 5215512345678.");
  telefonoPendiente = tel;
  reintentos = 0;
  await abrirSocket().catch(fallo);
}

export async function disconnect() {
  telefonoPendiente = null;
  const s = sock;
  sock = null;
  try {
    await s?.logout();
  } catch {}
  try {
    s?.end(undefined);
  } catch {}
  borrarAuth();
  setEstado({ phase: "disconnected", qr: null, pairingCode: null, me: null, error: null });
}

/** Al primer request reconecta si hay credenciales: un reinicio no pide escanear. */
let rehidratado = false;
export function rehidratar() {
  if (rehidratado) return;
  rehidratado = true;
  if (hayCredenciales() && !sock) {
    console.log("[wa] credenciales guardadas: reconecto");
    void abrirSocket().catch(fallo);
  }
}

// ---------------------------------------------------------------------------
// Mensajes: del grupo al motor y de vuelta
// ---------------------------------------------------------------------------
interface Entrante {
  text: string;
  from: string;
  images: ImagePayload[];
  key: WAMessage["key"];
}

/** Varios mensajes seguidos son UN turno: se juntan 1.5 s por grupo. */
const rafagas = new Map<string, { items: Entrante[]; timer: NodeJS.Timeout }>();
const RAFAGA_MS = 1_500;

async function recibir(m: WAMessage) {
  const jid = m.key.remoteJid ?? "";
  if (!jid.endsWith("@g.us")) return;
  if (m.key.fromMe || (m.key.id && nuestros.has(m.key.id))) return;
  const msg = m.message;
  if (!msg) return;

  verGrupo(jid);
  if (!grupoActivo(jid)) return;

  const from = m.pushName || m.key.participant?.split("@")[0] || "alguien";
  let text = msg.conversation ?? msg.extendedTextMessage?.text ?? "";
  const images: ImagePayload[] = [];

  if (msg.imageMessage) {
    // Una foto entrante se descifra y entra al turno como base64, igual que una del chat web.
    const buf = await downloadMediaMessage(m, "buffer", {});
    images.push({ mimeType: msg.imageMessage.mimetype ?? "image/jpeg", data: buf.toString("base64") });
    text = msg.imageMessage.caption ?? text;
  }

  if (msg.reactionMessage) {
    // Una reacción sólo cuenta si apunta a un mensaje nuestro.
    const objetivo = msg.reactionMessage.key?.id;
    if (!objetivo || !nuestros.has(objetivo) || !msg.reactionMessage.text) return;
    text = `${from} reaccionó con ${msg.reactionMessage.text} a tu mensaje anterior.`;
  }

  if (!text && !images.length) return;
  encolar(jid, { text, from, images, key: m.key });
}

function encolar(jid: string, item: Entrante) {
  const r = rafagas.get(jid);
  if (r) {
    r.items.push(item);
    clearTimeout(r.timer);
    r.timer = setTimeout(() => void despachar(jid), RAFAGA_MS);
    return;
  }
  rafagas.set(jid, { items: [item], timer: setTimeout(() => void despachar(jid), RAFAGA_MS) });
}

async function despachar(jid: string) {
  const r = rafagas.get(jid);
  rafagas.delete(jid);
  if (!r || !sock) return;
  const s = sock;
  const items = r.items;
  const ultimo = items[items.length - 1];
  const from = items.length === 1 ? items[0].from : [...new Set(items.map((i) => i.from))].join(", ");
  const text = items
    .map((i) => (items.length > 1 ? `${i.from}: ${i.text}` : i.text))
    .filter(Boolean)
    .join("\n");
  const images = items.flatMap((i) => i.images);

  // 👀 al leer, "escribiendo…" mientras piensa, ✅ al contestar.
  await reaccionar(s, jid, ultimo.key, "👀");
  const typing = setInterval(() => void s.sendPresenceUpdate("composing", jid).catch(() => {}), 8_000);
  void s.sendPresenceUpdate("composing", jid).catch(() => {});

  try {
    const r = await askFromChannel(text, "whatsapp", from, images);
    clearInterval(typing);
    void s.sendPresenceUpdate("paused", jid).catch(() => {});
    await responder(s, jid, ultimo.key, r.text, r.images);
    await reaccionar(s, jid, ultimo.key, "✅");
  } catch (e) {
    clearInterval(typing);
    console.warn("[wa] turno falló:", (e as Error).message);
    await enviar(s, jid, { text: `⚠️ No pude contestar: ${(e as Error).message}` });
  }
}

const UN_EMOJI = /^\p{Extended_Pictographic}️?$/u;

async function responder(s: WASocket, jid: string, key: WAMessage["key"], text: string, images: ImagePayload[]) {
  const limpio = text.trim();
  // Un solo emoji va como reacción, no como mensaje.
  if (!images.length && UN_EMOJI.test(limpio)) {
    await reaccionar(s, jid, key, limpio);
    return;
  }
  if (images.length) {
    // Cada imagen sale como foto; el texto va de pie en la primera.
    for (let i = 0; i < images.length; i++) {
      await enviar(s, jid, {
        image: Buffer.from(images[i].data, "base64"),
        mimetype: images[i].mimeType,
        caption: i === 0 ? limpio.slice(0, 1024) : undefined,
      });
    }
    return;
  }
  await enviar(s, jid, { text: limpio || "(sin respuesta)" });
}

async function enviar(s: WASocket, jid: string, contenido: any) {
  const enviado = await s.sendMessage(jid, contenido);
  if (enviado?.key?.id) nuestros.add(enviado.key.id);
}

async function reaccionar(s: WASocket, jid: string, key: WAMessage["key"], emoji: string) {
  try {
    await s.sendMessage(jid, { react: { text: emoji, key } });
  } catch (e) {
    console.warn("[wa] react:", (e as Error).message);
  }
}
