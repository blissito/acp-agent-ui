// Probe: speak ACP to `ghosty serve --acp` over stdio.
// Minimal handshake + one turn, printing what the agent says.
import { spawn } from "node:child_process";

const CMD = process.env.ACP_CMD ?? "ghosty serve --acp";
const [cmd, ...args] = CMD.split(" ");
const PROMPT = process.argv[2] ?? "Di exactamente: HOLA DESDE ACP";
const CWD = process.env.ACP_CWD ?? process.cwd();

const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"], cwd: process.cwd() });

let buffer = "";
let nextId = 1;
const pending = new Map();
let sawInit = false;

function send(msg) {
  console.log("\n[→]", JSON.stringify(msg).slice(0, 300));
  child.stdin.write(JSON.stringify(msg) + "\n");
}
function request(method, params) {
  const id = nextId++;
  const p = new Promise((res, rej) => pending.set(id, { res, rej, method }));
  send({ jsonrpc: "2.0", id, method, params });
  return p;
}

function handle(msg) {
  console.log("\n[←]", JSON.stringify(msg).slice(0, 300));
  if (msg.id !== undefined && !msg.method) {
    const w = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) w?.rej(new Error(msg.error.message));
    else w?.res(msg.result);
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params?.update ?? {};
    if (u.sessionUpdate === "agent_message_chunk") process.stdout.write("\n[chunk] " + (u.content?.text ?? ""));
    if (u.sessionUpdate === "usage_update") console.log("\n[usage]", JSON.stringify(u));
    return;
  }
  if (msg.method === "session/request_permission") {
    const options = msg.params?.options ?? [];
    const allow = options.find((o) => o.kind === "allow_once") ?? options[0];
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow?.optionId } } });
    return;
  }
  if (msg.method && msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
  }
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
  console.log(`\n\n[exit] code=${code} sig=${sig}`, `pending=${[...pending.values()].map((p) => p.method).join(",")}`);
  if (pending.size) process.exit(2);
  process.exit(0);
});
child.on("error", (e) => { console.error("[spawn error]", e.message); process.exit(3); });

const timeout = setTimeout(() => { console.error("\n[timo] colgando"); child.kill(); process.exit(4); }, 120000);

try {
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: "acp-probe", version: "0.0.1" },
  });
  sawInit = true;
  console.log("\n[initialize] agentInfo:", JSON.stringify(init?.agentInfo ?? init));

  const sess = await request("session/new", { cwd: CWD, mcpServers: [] });
  console.log("\n[session/new]", JSON.stringify(sess));
  const { sessionId, modes } = sess;

  if (modes?.availableModes?.length && modes?.currentModeId) {
    const ASK = ["default", "approve", "smart_approve", "ask"];
    const wanted = ASK.find((id) => modes.availableModes.some((m) => m.id === id));
    if (wanted && modes.currentModeId !== wanted) {
      await request("session/set_mode", { sessionId, modeId: wanted });
      console.log(`\n[mode] ${modes.currentModeId} -> ${wanted}`);
    }
  }

  const { stopReason } = await request("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: PROMPT }],
  });
  console.log("\n[stopReason]", stopReason);
  clearTimeout(timeout);
  child.kill();
  process.exit(0);
} catch (e) {
  console.error("\n[error]", e.message);
  clearTimeout(timeout);
  child.kill();
  process.exit(5);
}
