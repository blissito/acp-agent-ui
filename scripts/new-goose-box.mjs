/**
 * Levanta una caja goose de cero y deja el .env apuntando a ella.
 *
 *   EASYBITS_API_KEY=... node scripts/new-goose-box.mjs [nombre]
 *
 * Pasos: crear (dev-box, siesta al ocio) → esperar running → instalar goose →
 * escribir /root/.config/goose/.env (LLM = EasyBits) → /data/work para
 * Ghosty Teams → install-goose-unit.mjs (unidad systemd, secreto, expose, .env).
 * Es el camino de respaldo si la caja del taller muere en vivo: ~1 min.
 */
import { spawnSync } from "node:child_process";

const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");
const NAME = process.argv[2] ?? "goose-demo";
const MODEL = process.env.GOOSE_MODEL ?? "deepseek-v4-flash";

const rest = async (p, o = {}) => {
  const r = await fetch(API + p, {
    method: o.method ?? "GET",
    headers: { authorization: `Bearer ${KEY}`, ...(o.body ? { "content-type": "application/json" } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} → ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : {};
};

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 1. Crear. timeoutSeconds es el TTL inicial (máx 4 h en Mega); con siesta al
//    ocio la caja se duerme en vez de morir, y el WebSocket la despierta.
const box = await rest("/sandboxes", {
  method: "POST",
  body: { name: NAME, template: "dev-box", timeoutSeconds: 14400, suspendOnIdle: true },
});
const ID = box.sandboxId;
console.log(`creada ${ID} (${since()})`);

// 2. Esperar running.
for (let i = 0; i < 60; i++) {
  const s = await rest(`/sandboxes/${ID}`);
  if (s.status === "running") break;
  if (["error", "stopped", "lost"].includes(s.status)) throw new Error(`caja en ${s.status}`);
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(`running (${since()})`);

const exec = async (command, timeoutSeconds = 300) => {
  const r = await rest(`/sandboxes/${ID}/exec`, { method: "POST", body: { command, timeoutSeconds } });
  if (r.exitCode !== 0) throw new Error(`exec falló (${r.exitCode}): ${(r.stderr || r.stdout).slice(-300)}`);
  return r.stdout.trim();
};

// 3. goose. El instalador oficial deja el binario en GOOSE_BIN_DIR.
console.log(
  "goose",
  await exec(`
set -e
export HOME=/root CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin
curl -fsSL https://github.com/aaif-goose/goose/releases/latest/download/download_cli.sh -o /tmp/gl.sh
bash /tmp/gl.sh > /tmp/gl.log 2>&1
/usr/local/bin/goose --version
`),
  `(${since()})`
);

// 4. LLM = EasyBits. La llave queda dentro de la caja, root-only.
//    printf con %s: un '\n' literal en el valor da 401 con el secreto correcto.
await exec(`
set -e
mkdir -p /root/.config/goose /data/work
printf 'GOOSE_PROVIDER=openai\\nGOOSE_MODEL=%s\\nOPENAI_BASE_URL=https://www.easybits.cloud/api/v2/llm/v1\\nOPENAI_API_KEY=%s\\n' '${MODEL}' '${KEY}' > /root/.config/goose/.env
chmod 600 /root/.config/goose/.env
`);
console.log(`LLM configurado (${since()})`);

// 5. Unidad systemd + secreto + expose + .env local.
const unit = spawnSync(process.execPath, [new URL("./install-goose-unit.mjs", import.meta.url).pathname], {
  stdio: "inherit",
  env: { ...process.env, AGENT_BOX_ID: ID },
});
if (unit.status !== 0) throw new Error("install-goose-unit.mjs falló");
console.log(`lista en ${since()} — AGENT_BOX_ID=${ID}`);
