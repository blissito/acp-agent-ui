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

// Todo lo vivo del canal cuelga de globalThis: en dev, Vite recarga este módulo al tocar
// cualquier ruta que lo importe, y un módulo nuevo con `sock = null` abría un segundo
// socket con las mismas credenciales — WhatsApp los echa a los dos en bucle (440 conflict).
const g = globalThis as any;
const vivo: {
  estado: WaState;
  emisor: EventEmitter;
  sock: WASocket | null;
  reintentos: number;
  telefonoPendiente: string | null;
  nuestros: Set<string>;
  rehidratado: boolean;
  gruposAt: number;
  /** El grupo cuyo turno está en vuelo: las tools de grupo actúan ahí por defecto. */
  grupoEnTurno: string | null;
} = (g.__wa ??= {
  estado: { phase: "disconnected", qr: null, pairingCode: null, me: null, error: null },
  emisor: new EventEmitter(),
  sock: null,
  reintentos: 0,
  telefonoPendiente: null,
  nuestros: new Set(),
  rehidratado: false,
  gruposAt: 0,
  grupoEnTurno: null,
});
const estado = vivo.estado;
const emisor = vivo.emisor;
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
  level: "warn",
  trace() {},
  debug() {},
  info() {},
  warn(o: unknown, m?: string) { console.warn("[baileys]", m ?? "", typeof o === "object" ? JSON.stringify(o).slice(0, 200) : o); },
  error(o: unknown, m?: string) { console.error("[baileys]", m ?? "", typeof o === "object" ? JSON.stringify(o).slice(0, 200) : o); },
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

// Baileys 7 no pone `registered` al vincular por QR: la prueba de que hay sesión es `me`.
const vinculadas = (c: any) => Boolean(c?.me?.id || c?.registered);
const hayCredenciales = () => vinculadas(leer("creds"));

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
async function refrescarGrupos() {
  const sock = vivo.sock;
  if (!sock || estado.phase !== "connected" || Date.now() - vivo.gruposAt < 60_000) return;
  vivo.gruposAt = Date.now();
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
/** Ids de los mensajes que mandamos nosotros: no se contestan a sí mismos. */
const nuestros = vivo.nuestros;

const conCarrera = <T>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

async function abrirSocket() {
  if (vivo.sock) {
    try {
      vivo.sock.ev.removeAllListeners("connection.update");
      vivo.sock.end(undefined);
    } catch {}
    vivo.sock = null;
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
  vivo.sock = s;

  s.ev.on("creds.update", auth.saveCreds);

  s.ev.on("connection.update", async (u) => {
    // Un socket reemplazado ya no manda: sus cierres no reconectan.
    if (vivo.sock !== s) return;
    if (u.qr) {
      const qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
      setEstado({ phase: vivo.telefonoPendiente ? "pairing" : "qr_pending", qr, error: null });
    }
    if (u.connection === "open") {
      vivo.reintentos = 0;
      vivo.telefonoPendiente = null;
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
        vivo.sock = null;
        setEstado({ phase: "disconnected", qr: null, pairingCode: null, me: null, error: "El teléfono cerró la sesión." });
        return;
      }
      if (vivo.reintentos >= 5) {
        vivo.sock = null;
        setEstado({ phase: "failed", qr: null, pairingCode: null, error: `No pude reconectar (${code ?? "?"} ${msg}).` });
        return;
      }
      const espera = Math.min(30_000, 2 ** vivo.reintentos * 1000);
      vivo.reintentos++;
      setEstado({ phase: "connecting", qr: null, pairingCode: null, error: null });
      setTimeout(() => void abrirSocket().catch(fallo), espera);
    }
  });

  s.ev.on("messages.upsert", ({ type, messages }) => {
    console.log("[wa] upsert", type, messages.map((m) => `${m.key.remoteJid} ${Object.keys(m.message ?? {})[0] ?? m.messageStubType ?? "?"}`).join(" | "));
    if (type !== "notify") return;
    for (const m of messages) void recibir(m).catch((e) => console.warn("[wa] recibir:", e.message));
  });

  // Código por número: sólo si no hay registro previo, y 1.5 s después de crear el socket.
  if (vivo.telefonoPendiente && !vinculadas(auth.creds)) {
    const tel = vivo.telefonoPendiente;
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
  vivo.telefonoPendiente = null;
  vivo.reintentos = 0;
  await abrirSocket().catch(fallo);
}

/** Abre el handshake por código de 8 caracteres para ese número (sólo dígitos, con lada). */
export async function pair(phone: string) {
  const tel = phone.replace(/\D/g, "");
  if (tel.length < 8) throw new Error("El número va con lada y sólo dígitos, por ejemplo 5215512345678.");
  vivo.telefonoPendiente = tel;
  vivo.reintentos = 0;
  await abrirSocket().catch(fallo);
}

export async function disconnect() {
  vivo.telefonoPendiente = null;
  const s = vivo.sock;
  vivo.sock = null;
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
export function rehidratar() {
  if (vivo.rehidratado) return;
  vivo.rehidratado = true;
  if (hayCredenciales() && !vivo.sock) {
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
  // No se filtra `fromMe`: el dueño del número también le habla al agente desde su
  // teléfono. Lo que sí se ignora es lo que mandó esta app (ids en `nuestros`).
  if (m.key.id && nuestros.has(m.key.id)) return;
  const msg = m.message;
  if (!msg) return;

  verGrupo(jid);
  if (!grupoActivo(jid)) return;

  const from = m.pushName || (m.key.fromMe ? estado.me?.name : null) || m.key.participant?.split("@")[0] || "alguien";
  let text = msg.conversation ?? msg.extendedTextMessage?.text ?? "";
  const images: ImagePayload[] = [];

  if (msg.imageMessage) {
    // Una foto entrante se descifra y entra al turno como base64, igual que una del chat web.
    const buf = await downloadMediaMessage(m, "buffer", {});
    images.push({ mimeType: msg.imageMessage.mimetype ?? "image/jpeg", data: buf.toString("base64") });
    text = msg.imageMessage.caption ?? text;
  }

  if (msg.audioMessage) {
    // Una nota de voz se descifra y se transcribe en la caja (Whisper local); el texto
    // entra al turno marcado como voz para que el agente sepa que lo oyó, no lo leyó.
    const buf = await downloadMediaMessage(m, "buffer", {});
    try {
      const t = await transcribir(buf, msg.audioMessage.mimetype ?? "audio/ogg");
      text = `🎤 ${t}`;
    } catch (e) {
      console.warn("[wa] transcribir:", (e as Error).message);
      text = "🎤 (nota de voz que no pude transcribir)";
    }
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
  if (!r || !vivo.sock) return;
  const s = vivo.sock;
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

  vivo.grupoEnTurno = jid;
  try {
    const r = await askFromChannel(text, "whatsapp", from, images);
    clearInterval(typing);
    void s.sendPresenceUpdate("paused", jid).catch(() => {});
    await responder(s, jid, ultimo.key, r.text, r.images, r.audios);
    await reaccionar(s, jid, ultimo.key, "✅");
  } catch (e) {
    clearInterval(typing);
    console.warn("[wa] turno falló:", (e as Error).message);
    await enviar(s, jid, { text: `⚠️ No pude contestar: ${(e as Error).message}` });
  } finally {
    if (vivo.grupoEnTurno === jid) vivo.grupoEnTurno = null;
  }
}

// ---------------------------------------------------------------------------
// Superficie del grupo para el agente (la usa el MCP de /api/mcp/whatsapp)
// ---------------------------------------------------------------------------
function socketConectado(): WASocket {
  if (!vivo.sock || estado.phase !== "connected") throw new Error("WhatsApp no está conectado");
  return vivo.sock;
}

/** El grupo sobre el que actuar: el pedido, o el del turno en vuelo, o el único prendido. */
export function resolverGrupo(jid?: string | null): string {
  if (jid) {
    const j = jid.includes("@") ? jid : `${jid}@g.us`;
    if (!j.endsWith("@g.us")) throw new Error(`${jid} no es un grupo`);
    return j;
  }
  if (vivo.grupoEnTurno) return vivo.grupoEnTurno;
  const prendidos = listGroups().filter((g) => g.enabled);
  if (prendidos.length === 1) return prendidos[0].jid;
  throw new Error("Di en qué grupo (jid): hay varios prendidos y este turno no vino de ninguno.");
}

/** El link de invitación del grupo (`https://chat.whatsapp.com/<código>`). */
export async function linkDeGrupo(jid?: string | null): Promise<{ jid: string; subject: string; link: string }> {
  const s = socketConectado();
  const j = resolverGrupo(jid);
  const code = await s.groupInviteCode(j);
  if (!code) throw new Error("WhatsApp no devolvió código de invitación (¿la app es admin del grupo?)");
  const subject = listGroups().find((g) => g.jid === j)?.subject ?? "";
  return { jid: j, subject, link: `https://chat.whatsapp.com/${code}` };
}

/** Cambia la foto del grupo. Baileys la sube como attachment de perfil (WAMediaUpload). */
export async function cambiarFotoDeGrupo(jid: string | null | undefined, image: Buffer): Promise<{ jid: string; subject: string }> {
  const s = socketConectado();
  const j = resolverGrupo(jid);
  await s.updateProfilePicture(j, image);
  const subject = listGroups().find((g) => g.jid === j)?.subject ?? "";
  return { jid: j, subject };
}

const UN_EMOJI = /^\p{Extended_Pictographic}️?$/u;

// Whisper local: un servicio de la caja (oido.service), no un MCP; el canal lo usa directo.
const OIDO_URL = process.env.OIDO_URL ?? "http://127.0.0.1:4125/transcribe";

async function transcribir(audio: Buffer, mimeType: string): Promise<string> {
  const r = await fetch(`${OIDO_URL}?lang=es`, {
    method: "POST",
    headers: { "content-type": mimeType },
    body: new Uint8Array(audio),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new Error(`oído contestó ${r.status}`);
  const j = (await r.json()) as { text?: string };
  const t = (j.text ?? "").trim();
  if (!t) throw new Error("transcripción vacía");
  return t;
}

async function responder(
  s: WASocket,
  jid: string,
  key: WAMessage["key"],
  text: string,
  images: ImagePayload[],
  audios: ImagePayload[] = [],
) {
  const limpio = text.trim();
  // Un solo emoji va como reacción, no como mensaje.
  if (!images.length && !audios.length && UN_EMOJI.test(limpio)) {
    await reaccionar(s, jid, key, limpio);
    return;
  }
  // Un audio de una tool (Kokoro) sale como nota de voz: ogg/opus con `ptt`.
  for (const au of audios) {
    await enviar(s, jid, {
      audio: Buffer.from(au.data, "base64"),
      mimetype: au.mimeType.startsWith("audio/ogg") ? "audio/ogg; codecs=opus" : au.mimeType,
      ptt: true,
    });
  }
  if (audios.length && !images.length) {
    // El texto del agente suele repetir lo que dice la nota: sólo va si trae algo más.
    if (limpio && limpio.length > 40) await enviar(s, jid, { text: limpio });
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
