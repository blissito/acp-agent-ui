/**
 * ssh_repl.mjs — REPL interactivo multi-turno con goose (ACP por SSH)
 *
 * Habla con el agente goose que corre DENTRO de una microVM de EasyBits, a través
 * del Agent Client Protocol (ACP) viajando por un túnel SSH (443).
 *
 *   node ssh_repl.mjs                # chat interactivo (en tu terminal)
 *   printf 'hola\nquien eres\n' | node ssh_repl.mjs   # también funciona con stdin pipeado
 *
 * Qué hace:
 *   1. Abre `ssh <caja>.ghosty "goose-acp"` (launcher que ejecuta `goose acp`).
 *   2. ACP: `initialize` → `session/new` → `session/set_mode`.
 *   3. Por cada línea de stdin → `session/prompt`; streamea los `agent_message_chunk`
 *      a stdout y el resumen de uso a stderr.
 *   4. Los mensajes se procesan de a uno (cola), sin solapar turnos.
 *
 * Variables de entorno:
 *   ACP_BOX           host `.ghosty` del sandbox (default: el de goose-demo)
 *   ACP_KEY           ruta a tu llave privada SSH (default: ~/.ghosty/sb_ed25519)
 *   ACP_CWD           cwd de la sesión del agente (default: /root)
 *   ACP_AUTO_APPROVE  0 → pedir permiso manualmente en vez de auto-aprobar
 */
import { spawn } from "node:child_process";
import readline from "node:readline";

// ---------------------------------------------------------------------------
// Configuración (variable para que cada quien la cambie sin tocar código)
// ---------------------------------------------------------------------------
const BOX = process.env.ACP_BOX ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8.ghosty";
const KEY = process.env.ACP_KEY ?? "/Users/bliss/.ghosty/sb_ed25519";
const CWD = process.env.ACP_CWD ?? "/root";
const AUTO_APPROVE = process.env.ACP_AUTO_APPROVE !== "0";

// ---------------------------------------------------------------------------
// Transporte: el agente es remoto → un proceso `ssh` es el cable.
// El stdio de goose (JSON-RPC, delimitado por saltos de línea) llega por ahí.
// ---------------------------------------------------------------------------
const child = spawn("ssh", [
  "-i", KEY,
  "-o", "IdentitiesOnly=yes",      // usar sólo la llave indicada (no probar todas)
  "-o", "ConnectTimeout=30",
  "-o", "ServerAliveInterval=30",  // mantener viva la conexión si hay pausas largas
  BOX,
  "goose-acp",                     // comando remoto: el launcher de goose
], { stdio: ["pipe", "pipe", "inherit"] });

// ---------------------------------------------------------------------------
// Estado de la sesión ACP
// ---------------------------------------------------------------------------
let buffer = "";      // acumula bytes del stdout hasta completar una línea JSON
let nextId = 1;       // ids de las peticiones que enviamos (client → agent)
let sessionId = null; // id de la sesión goose (lo da `session/new`)
const pending = new Map(); // id → { res, rej } para resolver cada petición

/** Envía un mensaje JSON-RPC (una línea) al agente. */
const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");

/** Envía una petición y devuelve una Promise que se resuelve con su respuesta. */
function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((res, rej) => pending.set(id, { res, rej }));
}

// ---------------------------------------------------------------------------
// Qué hacemos con lo que el agente manda
// ---------------------------------------------------------------------------
function handle(msg) {
  // 1) Respuesta a una petición nuestra.
  if (msg.id !== undefined && !msg.method) {
    const w = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) w?.rej(new Error(JSON.stringify(msg.error)));
    else w?.res(msg.result);
    return;
  }

  // 2) Notificaciones del agente (cómo va el turno).
  if (msg.method === "session/update") {
    const u = msg.params?.update ?? {};
    // El texto de la respuesta llega por partes (chunks).
    if (u.sessionUpdate === "agent_message_chunk") {
      process.stdout.write(u.content?.text ?? "");
    }
    // Gasto/tokens del turno → a stderr, para no mezclarlo con la respuesta.
    if (u.sessionUpdate === "usage_update") {
      const c = u.cost ? ` · cost $${u.cost.amount ?? "?"}` : "";
      process.stderr.write(`\n[usage ${u.used ?? "?"}/${u.size ?? "?"} tokens${c}]`);
    }
    return;
  }

  // 3) El agente NOS pide permiso para usar una herramienta.
  if (msg.method === "session/request_permission") {
    const options = msg.params?.options ?? [];
    const title = msg.params?.toolCall?.title ?? msg.params?.toolCall?.rawInput?.command ?? "tool";
    const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
    if (AUTO_APPROVE) {
      process.stderr.write(`\n[auto-approve] ${title} → ${allow?.optionId ?? "?"}\n`);
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
    return;
  }

  // 4) Cualquier otra petición del agente: responder vacío y seguir.
  if (msg.method && msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
}

// Lectura del stdout de ssh: partir en líneas y parsear cada JSON.
child.stdout.on("data", (c) => {
  buffer += c;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* línea a medias o ruido */ }
  }
});

// ---------------------------------------------------------------------------
// Entrada del usuario: cola de mensajes procesada de a uno, sin solapar turnos.
// `ready` evita mandar un prompt antes de que exista `sessionId` (útil con pipe).
// ---------------------------------------------------------------------------
const queue = [];
let busy = false;  // hay un turno en curso
let ready = false; // la sesión ACP ya está lista

function prompt(text) {
  return request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}

async function pump() {
  if (!ready || busy || queue.length === 0) return;
  busy = true;
  const text = queue.shift();
  process.stderr.write("goose> ");
  try {
    await prompt(text);
  } catch (e) {
    process.stderr.write(`\n[error turno] ${e.message}\n`);
  }
  busy = false;
  process.stderr.write("\nTú> ");
  pump(); // atender el siguiente mensaje pendiente, si lo hay
}

function shutdown(rc) {
  try { child.kill(); } catch {}
  rl.close();
  process.exit(rc);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", (line) => {
  const msg = line.trim();
  if (!msg) return;
  if (["exit", "quit", "salir"].includes(msg.toLowerCase())) return shutdown(0);
  queue.push(msg);
  pump();
});
rl.on("close", () => { if (!busy && queue.length === 0) shutdown(0); });

child.on("exit", (code, sig) => {
  process.stderr.write(`\n[ssh cerrado] code=${code} sig=${sig}\n`);
  rl.close();
  process.exit(code ?? 1);
});
child.on("error", (e) => { process.stderr.write(`[spawn error] ${e.message}\n`); shutdown(3); });

const timeout = setTimeout(() => { process.stderr.write("\n[timeout conexión]\n"); shutdown(4); }, 60000);

// ---------------------------------------------------------------------------
// Arranque: handshake ACP y luego bucle de lectura.
// ---------------------------------------------------------------------------
(async () => {
  try {
    // Hola al agente. `fs: false` → su disco es el de la caja, no el nuestro.
    await request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: "acp-repl", version: "0.1.0" },
    });
    // Nueva sesión de agente, con su cwd dentro de la caja.
    const s = await request("session/new", { cwd: CWD, mcpServers: [] });
    sessionId = s.sessionId;
    // Modo de permisos: usar el "menos agresivo" que el agente declare.
    const ASK = ["default", "approve", "smart_approve", "ask"];
    const wanted = ASK.find((id) => s.modes?.availableModes?.some((m) => m.id === id));
    if (wanted && s.modes?.currentModeId !== wanted) {
      try { await request("session/set_mode", { sessionId, modeId: wanted }); } catch {}
    }
    clearTimeout(timeout);
    ready = true;
    process.stderr.write(`[sesión ${sessionId}] goose listo. Escribe ('exit' para salir).\nTú> `);
    pump(); // vaciar cualquier mensaje que haya llegado mientras arrancaba
  } catch (e) {
    process.stderr.write(`\n[error setup] ${e.message}\n`);
    shutdown(5);
  }
})();
