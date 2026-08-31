// fs_probe.mjs — ¿goose usa la capability fs del CLIENTE (vía ACP)?
// Ofrece fs:{readTextFile:true,writeTextFile:true} y registra si el agente
// llama a fs/write_text_file / fs/read_text_file (en vez de usar su shell).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";

const BOX = process.env.ACP_BOX ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8.ghosty";
const KEY = process.env.ACP_KEY ?? "/Users/bliss/.ghosty/sb_ed25519";
const CWD = process.env.ACP_CWD ?? "/tmp"; // cwd que ofrece el cliente
const CMD = process.env.ACP_CMD ?? "goose-acp"; // comando remoto (goose-acp | ds-acp)
const OUT = "/tmp/fs-calls.log";
mkdirSync("/tmp", { recursive: true }); appendFileSync(OUT, "\n===== run =====");
const log = (s) => { console.log(s); appendFileSync(OUT, "\n" + s); };

const child = spawn("ssh", ["-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=30", BOX, CMD], { stdio: ["pipe", "pipe", "inherit"] });
let buffer = "", nextId = 1; const pending = new Map();
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
function request(method, params) { const id = nextId++; send({ jsonrpc: "2.0", id, method, params }); return new Promise((res, rej) => pending.set(id, { res, rej })); }

function handle(msg) {
  if (msg.id !== undefined && !msg.method) { const w = pending.get(msg.id); pending.delete(msg.id); if (msg.error) w?.rej(new Error(JSON.stringify(msg.error))); else w?.res(msg.result); return; }
  if (msg.method === "session/update") { const u = msg.params?.update ?? {}; if (u.sessionUpdate === "agent_message_chunk") process.stdout.write(u.content?.text ?? ""); return; }
  if (msg.method === "session/request_permission") { const o = msg.params?.options ?? []; const a = o.find(x => x.kind === "allow_once") ?? o[0]; send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: a?.optionId } } }); return; }
  if (msg.method === "fs/write_text_file") {
    log(`\n[GOOSE→CLIENTE fs/write_text_file] path=${msg.params.path} content=${JSON.stringify(msg.params.content)}`);
    send({ jsonrpc: "2.0", id: msg.id, result: {} }); return;
  }
  if (msg.method === "fs/read_text_file") {
    log(`\n[GOOSE→CLIENTE fs/read_text_file] path=${msg.params.path}`);
    send({ jsonrpc: "2.0", id: msg.id, result: { content: "contenido leído del cliente" } }); return;
  }
  if (msg.method) { send({ jsonrpc: "2.0", id: msg.id, result: {} }); return; }
}
child.stdout.on("data", (c) => { buffer += c; let nl; while ((nl = buffer.indexOf("\n")) !== -1) { const l = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); if (!l) continue; try { handle(JSON.parse(l)); } catch {} } });
child.on("exit", (code) => { log(`\n[exit] ${code}`); process.exit(pending.size ? 2 : 0); });
const t = setTimeout(() => { log("\n[tmo]"); try{child.kill();}catch{}; process.exit(4); }, 150000);

(async () => {
  const init = await request("initialize", {
    protocolVersion: 1,
    // OFRECEMOS el filesystem del cliente (como un editor) ✅
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: "fs-probe", version: "1" },
  });
  log("agentCapabilities fs? " + JSON.stringify(init?.agentCapabilities ?? {}).slice(0, 200));
  const s = await request("session/new", { cwd: CWD, mcpServers: [] });
  log("session " + s.sessionId);
  // pedirle que cree un archivo; ver si usa fs/write o su shell
  const r = await request("session/prompt", { sessionId: s.sessionId, prompt: [{ type: "text", text: "Crea el archivo hola-fs.txt con el texto HOLA_FS. Dime qué hiciste." }] });
  log("\n[stop] " + r.stopReason);
  clearTimeout(t); try{child.kill();}catch{}; process.exit(0);
})().catch((e) => { log("\n[err] " + e.message); clearTimeout(t); try{child.kill();}catch{}; process.exit(5); });
