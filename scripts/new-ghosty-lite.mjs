/**
 * Levanta un agente ghosty-lite con Claude (por suscripción) y deja el .env apuntando a él.
 *
 *   EASYBITS_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… node scripts/new-ghosty-lite.mjs [nombre]
 *
 * Es el camino de la sesión 5: un solo POST /api/v2/agents. El token OAuth (el de
 * `claude setup-token`) hace que los turnos salgan por la suscripción, no por API key;
 * el template lo convierte en GHOSTY_PROVIDER=claude-acp. Siembra mcp/imagen.ts en
 * /data/workspace para que el MCP de imágenes exista sin clonar el repo.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
const OAUTH = process.env.CLAUDE_CODE_OAUTH_TOKEN;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");
if (!OAUTH) throw new Error("falta CLAUDE_CODE_OAUTH_TOKEN");
const NAME = process.argv[2] ?? "taller-s5";

const rest = async (p, o = {}) => {
  const r = await fetch(API + p, {
    method: o.method ?? "GET",
    headers: { authorization: `Bearer ${KEY}`, ...(o.body ? { "content-type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} → ${r.status}: ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
};

const t0 = Date.now();
const imagen = readFileSync(new URL("../mcp/imagen.ts", import.meta.url));
const agent = await rest("/agents", {
  method: "POST",
  body: {
    template: "ghosty-lite",
    name: NAME,
    timeoutSeconds: 14400,
    // Explícito: sin esto EasyBits mete provider `easybits` (DeepSeek medido) porque el
    // token OAuth no figura entre las llaves de proveedor que reconoce.
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH, GHOSTY_PROVIDER: "claude-acp", GHOSTY_MODEL: "current", GHOSTY_MODE: "approve" },
    seedFiles: [{ name: "imagen.ts", contentBase64: imagen.toString("base64") }],
  },
});
console.log(`agente ${agent.agentId} en caja ${agent.sandboxId} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
// La URL del POST es provisional (sandbox://…): la de verdad la da GET /agents/:id
// cuando la caja ya corre. Se espera hasta que llegue como wss://.
let url = agent.agentUrl;
for (let i = 0; i < 30 && !/^wss?:/.test(url); i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const a = await rest(`/agents/${agent.agentId}`);
  url = (a.agent ?? a).agentUrl ?? url;
}
if (!/^wss?:/.test(url)) throw new Error(`la caja no dio URL: ${url}`);
console.log(`url ${url} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// Reescribir el .env conservando el resto de variables.
const envPath = new URL("../.env", import.meta.url);
const prev = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const vars = Object.fromEntries(
  prev.split("\n").filter((l) => l.includes("=") && !l.trim().startsWith("#")).map((l) => {
    const i = l.indexOf("=");
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  }),
);
vars.ACP_WS_URL = /\/acp$/.test(url) ? url : url.replace(/\/?$/, "/acp");
vars.ACP_SECRET = agent.embedToken;
vars.AGENT_BOX_ID = agent.sandboxId;
vars.AGENT_ID = agent.agentId;
vars.ACP_CWD ??= "/data/work";
vars.EASYBITS_API_KEY ??= KEY;
writeFileSync(envPath, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
console.log(".env actualizado");
