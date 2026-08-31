// ACP client over SSH transport: spawns `ssh <box> "goose-acp"` and speaks
// JSON-RPC (newline-delimited) through the SSH tunnel.
import { spawn } from "node:child_process";

const BOX = process.env.ACP_BOX ?? "sb_d6a36806-455e-4113-b54a-093bfdb91ca8.ghosty";
const KEY = process.env.ACP_KEY ?? "/Users/bliss/.ghosty/sb_ed25519";
const CMD = process.env.ACP_CMD ?? "goose-acp";
const CWD = process.env.ACP_CWD ?? "/root";
const PROMPT = process.argv[2] ?? "Crea un archivo /root/hola-acp.txt con el texto: hola desde ACP por SSH. Despues dime en que ruta quedo.";

const child = spawn("ssh", [
  "-i", KEY,
  "-o", "IdentitiesOnly=yes",
  "-o", "ConnectTimeout=30",
  "-o", "ServerAliveInterval=30",
  BOX, CMD,
], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
let nextId = 1;
const pending = new Map();

function send(msg) {
  console.log("\n[→]", JSON.stringify(msg).slice(0, 220));
  child.stdin.write(JSON.stringify(msg) + "\n");
}
function request(method, params) {
  const id = nextId++;
  const p = new Promise((res, rej) => pending.set(id, { res, rej, method }));
  send({ jsonrpc: "2.0", id, method, params });
  return p;
}

function handle(msg) {
  console.log("\n[←]", JSON.stringify(msg).slice(0, 220));
  if (msg.id !== undefined && !msg.method) {
    const w = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) w?.rej(new Error(JSON.stringify(msg.error)));
    else w?.res(msg.result);
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params?.update ?? {};
    if (u.sessionUpdate === "agent_message_chunk") process.stdout.write("\n[chunk] " + (u.content?.text ?? ""));
    if (u.sessionUpdate === "usage_update") console.log("\n[usage]", JSON.stringify(u).slice(0, 300));
    return;
  }
  // Goose pide permiso para usar herramientas.
  if (msg.method === "session/request_permission") {
    const options = msg.params?.options ?? [];
    const title = msg.params?.toolCall?.title ?? msg.params?.toolCall?.rawInput?.command ?? "tool";
    const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
    console.log(`\n[permiso] ${title} -> ${allow?.optionId ?? "(ninguno)"}`);
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
child.on("exit", (code, sig) => {
  console.log(`\n\n[ssh exit] ${code} sig=${sig} pending=${[...pending.values()].map((p)=>p.method).join(",")}`);
  if (pending.size) process.exit(2);
  process.exit(0);
});
child.on("error", (e) => { console.error("[spawn error]", e.message); process.exit(3); });

const kill = (rc=0) => { try{child.kill();}catch{}; process.exit(rc); };
const timeout = setTimeout(() => { console.error("\n[timeout]"); kill(4); }, 150000);

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: "acp-ssh", version: "0.1.0" },
  });
  console.log("\n[initialize] agent:", JSON.stringify(init?.agentInfo ?? init).slice(0, 200));

  const sess = await request("session/new", { cwd: CWD, mcpServers: [] });
  console.log("\n[session/new]", JSON.stringify(sess).slice(0, 200));
  const { sessionId, modes } = sess;

  if (modes?.availableModes?.length) {
    const ASK = ["default", "approve", "smart_approve", "ask"];
    const wanted = ASK.find((id) => modes.availableModes.some((m) => m.id === id));
    if (wanted && modes.currentModeId !== wanted) {
      try { await request("session/set_mode", { sessionId, modeId: wanted }); console.log("\n[mode] ->", wanted); }
      catch (e) { console.log("\n[mode] skip:", e.message); }
    } else {
      console.log("\n[mode] actual:", modes.currentModeId, "de", modes.availableModes.map((m)=>m.id).join(","));
    }
  }

  const { stopReason } = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: PROMPT }] });
  console.log("\n[stopReason]", stopReason);
  clearTimeout(timeout);
  kill(0);
} catch (e) {
  console.error("\n[error]", e.message);
  clearTimeout(timeout);
  kill(5);
}
