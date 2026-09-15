/**
 * Hostea esta app DENTRO de la caja del agente, como unidad de systemd.
 *
 *   node --env-file=.env scripts/deploy-app-in-box.mjs [rama]
 *
 * Por qué en la misma caja: el WebSocket ACP queda en loopback (ws://127.0.0.1:3000/acp), el
 * MCP de WhatsApp que sirve la app (/api/mcp/whatsapp) es alcanzable por el agente sin túnel,
 * y todo lo que la app guarda (extensiones, sesión de WhatsApp, títulos) vive en /data, que
 * sobrevive a la siesta y al despliegue.
 *
 * Pasos: clonar/actualizar el repo en /data/app → npm ci → build → .env en /data/app →
 * `acp-web.service` en el puerto 8080 → exponer el puerto → dar de alta las extensiones
 * (imagen y whatsapp) en la base de la app hosteada. Idempotente: se puede correr de nuevo
 * para desplegar cambios.
 */
const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
const ID = process.env.AGENT_BOX_ID;
const TOKEN = process.env.ACP_TOKEN ?? process.env.ACP_SECRET;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");
if (!ID) throw new Error("falta AGENT_BOX_ID");
if (!TOKEN) throw new Error("falta ACP_SECRET");
const RAMA = process.argv[2] ?? "sesion-5-ensayo";
const REPO = process.env.APP_REPO ?? "https://github.com/blissito/acp-agent-ui.git";
const PORT = Number(process.env.APP_PORT ?? 8080);

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
const since = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const sb = await rest(`/sandboxes/${ID}`);
if (sb.status === "suspended") await rest(`/sandboxes/${ID}/resume`, { method: "POST" }).catch(() => {});
for (let i = 0; i < 40; i++) {
  if ((await rest(`/sandboxes/${ID}`)).status === "running") break;
  await new Promise((r) => setTimeout(r, 1500));
}

const exec = async (command, timeoutSeconds = 300) => {
  const r = await rest(`/sandboxes/${ID}/exec`, { method: "POST", body: { command, timeoutSeconds } });
  if (r.exitCode !== 0) throw new Error(`exec falló (${r.exitCode}):\n${(r.stderr || r.stdout).slice(-800)}`);
  return (r.stdout ?? "").trim();
};

// 1. Código.
console.log(
  await exec(`
set -e
if [ -d /data/app/.git ]; then
  cd /data/app && git fetch -q origin ${RAMA} && git checkout -q ${RAMA} && git reset -q --hard origin/${RAMA}
else
  git clone -q -b ${RAMA} ${REPO} /data/app
fi
cd /data/app && git log --oneline -1
`),
  `(${since()})`,
);

// 2. Dependencias y build. En exec separados: cada uno puede tardar minutos.
console.log(await exec(`cd /data/app && npm ci --no-audit --no-fund 2>&1 | tail -2`, 600), `(${since()})`);
console.log(await exec(`cd /data/app && NODE_OPTIONS=--max-old-space-size=1536 npm run build 2>&1 | tail -3`, 600), `(${since()})`);

// 3. .env de la app hosteada. Sin AGENT_BOX_ID a propósito: la app no gestiona el ciclo de
//    vida de la caja en la que ella misma corre (se suspendería a sí misma).
const env = [
  `PORT=${PORT}`,
  `ACP_WS_URL=ws://127.0.0.1:3000/acp`,
  `ACP_SECRET=${TOKEN}`,
  `ACP_CWD=/data/work`,
  `ACP_EXTENSIONS_DB=/data/app-data/extensions.db`,
  `ACP_MODELS_PATH=/data/app-data/models.json`,
  `ACP_LIST_PATH=/data/app-data/hilos.json`,
  `ACP_TITLES_PATH=/data/app-data/titles.json`,
  `WHATSAPP_MCP_TOKEN=${TOKEN}`,
].join("\n");

const unit = `[Unit]
Description=acp-agent-ui (web + canal WhatsApp)
After=network-online.target ghosty-lite-runtime.service

[Service]
Type=simple
WorkingDirectory=/data/app
ExecStart=__NODE__ --env-file=/data/app/.env /data/app/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

console.log(
  await exec(`
set -e
mkdir -p /data/app-data
cat > /data/app/.env <<'ENV'
${env}
ENV
chmod 600 /data/app/.env
NODE=$(command -v node)
cat > /etc/systemd/system/acp-web.service <<'UNIT'
${unit}UNIT
sed -i "s|__NODE__|$NODE|" /etc/systemd/system/acp-web.service
systemctl daemon-reload
systemctl enable -q acp-web.service
systemctl restart acp-web.service
sleep 4
systemctl is-active acp-web.service
curl -s -o /dev/null -w 'web local → %{http_code}\\n' http://127.0.0.1:${PORT}/
`),
  `(${since()})`,
);

// 4. Exponer el puerto. Si ya estaba expuesto, el host devuelve la misma URL.
const exp = await rest(`/sandboxes/${ID}/expose`, { method: "POST", body: { port: PORT } });
const url = exp.url.replace(/\/$/, "");
console.log("expuesta:", url);

// 5. Extensiones de la app hosteada: el MCP de imagen (en la caja) y el de WhatsApp (la app misma).
const alta = async (body) => {
  const r = await fetch(`${url}/api/extensions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: "create", ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !/Ya hay una extensión/.test(j.error ?? "")) throw new Error(`alta ${body.name}: ${j.error}`);
  return j.error ? "ya estaba" : "alta";
};
console.log("imagen:", await alta({ name: "imagen", transport: "http", url: "http://127.0.0.1:4123/mcp" }));
console.log(
  "whatsapp:",
  await alta({
    name: "whatsapp",
    transport: "http",
    url: `http://127.0.0.1:${PORT}/api/mcp/whatsapp`,
    headers: [{ name: "authorization", value: `Bearer ${TOKEN}` }],
  }),
);
console.log(`\nlisto en ${since()}: ${url}/whatsapp — escanea el QR ahí (la sesión de WhatsApp vive en la caja).`);
