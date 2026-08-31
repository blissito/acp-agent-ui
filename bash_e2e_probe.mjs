// E2E: ¿ghosty ya ejecuta shell? Prompt que obliga a correr un comando y captura la salida.
import { spawn } from "node:child_process";

const BOX = process.env.ACP_BOX ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8.ghosty";
const KEY = process.env.ACP_KEY ?? "/Users/bliss/.ghosty/sb_ed25519";
const CMD = process.env.ACP_CMD ?? "/root/.local/bin/ghosty serve --acp";
const PROMPT = process.env.ACP_PROMPT ?? "Ejecuta este comando de shell y responde SOLO con su salida: `echo GHOSTY_BASH_OK`. No añadas nada más.";

const child = spawn("ssh", ["-i", KEY, "-o", "IdentitiesOnly=yes", "-o", "ConnectTimeout=30", BOX, CMD], {
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let nextId = 1;
const pending = new Map();
let chunks = [];

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
  if (msg.method === "session/update") {
    const u = msg.params?.update ?? {};
    if (u.sessionUpdate === "agent_message_chunk") { chunks.push(u.content?.text ?? ""); process.stdout.write(u.content?.text ?? ""); }
    if (u.sessionUpdate === "usage_update") console.error("\n[usage]", JSON.stringify(u).slice(0, 200));
    return;
  }
  if (msg.method === "session/request_permission") {
    const options = msg.params?.options ?? [];
    const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
    console.error(`\n[permiso] ${msg.params?.toolCall?.title ?? "tool"} -> ${allow?.optionId ?? "(ninguno)"}`);
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
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
child.on("exit", (code) => { console.log(`\n\n[ssh exit] ${code}`); process.exit(code ?? 0); });
child.on("error", (e) => { console.error("[spawn error]", e.message); process.exit(3); });
const kill = (rc = 0) => { try { child.kill(); } catch {} process.exit(rc); };
const timeout = setTimeout(() => { console.error("\n[timeout]"); kill(4); }, 150000);

try {
  await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: true },
    clientInfo: { name: "bash-e2e", version: "0.1.0" },
  });
  const sess = await request("session/new", { cwd: "/root", mcpServers: [] });
  const { sessionId, modes } = sess;
  if (modes?.availableModes?.length) {
    const ASK = ["default", "approve", "smart_approve", "ask"];
    const wanted = ASK.find((id) => modes.availableModes.some((m) => m.id === id));
    if (wanted && modes.currentModeId !== wanted) {
      try { await request("session/set_mode", { sessionId, modeId: wanted }); } catch {}
    }
  }
  const { stopReason } = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: PROMPT }] });
  const all = chunks.join("");
  console.error("\n[stopReason]", stopReason);
  console.error("\n=== FULL RESULT ===");
  console.log(all.trim() || "(vacío)");
  console.log("=== BASH_OK:", /GHOSTY_BASH_OK/.test(all) ? "YES" : "NO");
  clearTimeout(timeout);
  kill(0);
} catch (e) {
  console.error("\n[error]", e.message);
  clearTimeout(timeout);
  kill(5);
}
