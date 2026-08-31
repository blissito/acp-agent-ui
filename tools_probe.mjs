// Probe: ¿ghosty expone la herramienta Bash en session/new cuando el cliente
// declara clientCapabilities.terminal? Spawnea `ssh <box> "ghosty serve --acp"`.
import { spawn } from "node:child_process";

const BOX = process.env.ACP_BOX ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8.ghosty";
const KEY = process.env.ACP_KEY ?? "/Users/bliss/.ghosty/sb_ed25519";
const CMD = process.env.ACP_CMD ?? "/root/.local/bin/ghosty serve --acp";

const child = spawn("ssh", ["-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=30", BOX, CMD], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let nextId = 1;
const pending = new Map();

function send(msg) { child.stdin.write(JSON.stringify(msg) + "\n"); }
function request(method, params) {
  const id = nextId++;
  const p = new Promise((res, rej) => pending.set(id, { res, rej }));
  send({ jsonrpc: "2.0", id, method, params });
  return p;
}
function handle(msg) {
  if (msg.id !== undefined && !msg.method) {
    const w = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) w?.rej(new Error(JSON.stringify(msg.error)));
    else w?.res(msg.result);
    return;
  }
  if (msg.method && msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, result: {} });
}

child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
});
child.on("exit", (code) => { console.log(`\n[ssh exit] ${code}`); process.exit(code ?? 0); });
child.on("error", (e) => { console.error("[spawn error]", e.message); process.exit(3); });
const kill = (rc = 0) => { try { child.kill(); } catch {} process.exit(rc); };
const timeout = setTimeout(() => { console.error("\n[timeout]"); kill(4); }, 90000);

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    clientInfo: { name: "tools-probe", version: "0.1.0" },
  });
  const sess = await request("session/new", { cwd: "/root", mcpServers: [] });
  const tools = Array.isArray(sess?.tools) ? sess.tools : sess?.toolStubs ?? sess?.availableTools ?? [];
  const names = tools.map((t) => (typeof t === "string" ? t : t?.name)).filter(Boolean);
  const hasBash = names.some((n) => /^bash$/i.test(n) || n === "Bash" || /^terminal\//.test(n));
  console.log("\n=== sessionId:", sess?.sessionId ?? "(?)");
  console.log("=== tools count:", names.length);
  console.log("=== tools:", names.join(", "));
  console.log("=== HAS_BASH:", hasBash ? "YES" : "NO");
  clearTimeout(timeout);
  kill(0);
} catch (e) {
  console.error("\n[error]", e.message);
  clearTimeout(timeout);
  kill(5);
}
