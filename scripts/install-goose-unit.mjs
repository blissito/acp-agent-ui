// ⚠️ OBSOLETO (2026-09-03): esto instala `goose serve` a mano en una caja y genera un .env con
// ACP_SECRET=<GOOSE_SERVER__SECRET_KEY>. Ése ya NO es el modelo: un agente ACP de EasyBits se
// crea con POST /api/v2/agents y su credencial es el token del AGENTE (embedToken o el
// ACP_AGENT_TOKEN que le pongas), que viaja por ?token= / Authorization: Bearer.
// Se conserva por si alguien monta goose por su cuenta.
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");
const ID = process.env.AGENT_BOX_ID;
if (!ID) throw new Error("falta AGENT_BOX_ID");

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
const exec = async (command) =>
  (await rest(`/sandboxes/${ID}/exec`, { method: "POST", body: { command } }));

const SECRET = randomBytes(24).toString("hex");

// La unidad arranca sola al boot, así que sobrevive a suspender/reanudar.
const unit = `[Unit]
Description=goose ACP server
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/root/.config/goose/.env
EnvironmentFile=/etc/goose-acp.env
ExecStart=/usr/local/bin/goose serve --host 0.0.0.0 --port 3000
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

const script = `
set -e
which goose > /tmp/goosepath
printf 'GOOSE_SERVER__SECRET_KEY=%s\\n' '${SECRET}' > /etc/goose-acp.env
chmod 600 /etc/goose-acp.env
cat > /etc/systemd/system/goose-acp.service <<'UNIT'
${unit}UNIT
sed -i "s|/usr/local/bin/goose|$(cat /tmp/goosepath)|" /etc/systemd/system/goose-acp.service
systemctl daemon-reload
systemctl enable --now goose-acp.service
sleep 3
systemctl is-active goose-acp.service
ss -ltn | grep 3000 || echo 'NADA EN 3000'
`;

const r = await exec(script);
console.log((r.stdout || "").trim());
if (r.stderr) console.log("stderr:", r.stderr.trim().split("\n").slice(-3).join(" | "));

const exp = await rest(`/sandboxes/${ID}/expose`, { method: "POST", body: { port: 3000 } });
console.log("expuesto:", exp.url);

// El secret se guarda en el .env local; nunca se imprime. La llave de EasyBits
// se conserva: sin ella la app no gestiona el ciclo de vida de la caja.
const envPath = new URL("../.env", import.meta.url).pathname;
writeFileSync(
  envPath,
  `ACP_WS_URL=${exp.url.replace(/^https/, "wss")}/acp\nACP_SECRET=${SECRET}\nACP_CWD=/root\nAGENT_BOX_ID=${ID}\nEASYBITS_API_KEY=${KEY}\n`,
  { mode: 0o600 }
);
console.log("escrito:", envPath, "(secret dentro, no en pantalla)");
