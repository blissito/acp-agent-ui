/**
 * Deja el MCP de imágenes corriendo en la caja como unidad de systemd.
 *
 *   node --env-file=.env scripts/install-imagen-mcp.mjs
 *
 * Copia mcp/imagen.ts a /data/workspace (por si la caja no lo trajo sembrado), escribe
 * `imagen.service` (Restart=always, arranca con la caja) y deja un CLAUDE.md en /data/work
 * para que el agente use la tool a la primera y no se vaya a leer SDKs.
 *
 * Después: darlo de alta en /extensions como http `http://127.0.0.1:4123/mcp` y abrir
 * HILO NUEVO — el hilo abierto se queda con la conexión MCP vieja.
 */
import { readFileSync } from "node:fs";

const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
const ID = process.env.AGENT_BOX_ID;
const PORT = Number(process.env.IMAGEN_PORT ?? 4123);
// Opcional: con llave de OpenAI el MCP anuncia también generar_imagen_hd. Viaja como
// Environment de la unidad (archivo 600), nunca al repo.
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";
if (!KEY) throw new Error("falta EASYBITS_API_KEY");
if (!ID) throw new Error("falta AGENT_BOX_ID");

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

// Una caja dormida no ejecuta nada: se despierta primero.
const sb = await rest(`/sandboxes/${ID}`);
if (sb.status === "suspended") {
  await rest(`/sandboxes/${ID}/resume`, { method: "POST" }).catch(() => {});
}
for (let i = 0; i < 40; i++) {
  const s = await rest(`/sandboxes/${ID}`);
  if (s.status === "running") break;
  await new Promise((r) => setTimeout(r, 1500));
}

const exec = async (command, timeoutSeconds = 120) => {
  const r = await rest(`/sandboxes/${ID}/exec`, { method: "POST", body: { command, timeoutSeconds } });
  if (r.exitCode !== 0) throw new Error(`exec falló (${r.exitCode}): ${(r.stderr || r.stdout).slice(-400)}`);
  return (r.stdout ?? "").trim();
};

const imagen = readFileSync(new URL("../mcp/imagen.ts", import.meta.url)).toString("base64");

// Reglas para el agente. Se AGREGAN al CLAUDE.md de la caja si faltan: otros instaladores
// (voz, oído) dejan ahí las suyas y no hay que pisarlas.
const reglas = [
  "- Para generar o dibujar una imagen usa SIEMPRE la tool `generar_imagen` del MCP `imagen` (ya está conectada). No busques SDKs ni escribas código para generar imágenes: llama la tool con un prompt en inglés y devuelve el resultado.",
  "- Usa `generar_imagen_hd` SÓLO si piden explícitamente una imagen HD / alta calidad / alta resolución; si no, `generar_imagen`.",
  "- Contesta en español.",
];
// Va en base64: los backticks y comillas del texto no sobreviven a un `sh -c`.
const reglasB64 = Buffer.from(reglas.join("\n") + "\n").toString("base64");

const unit = `[Unit]
Description=MCP de imagenes (Streamable HTTP)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=-/etc/imagen-mcp.env
ExecStart=__NODE__ /data/workspace/imagen.ts --http ${PORT}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

const salida = await exec(`
set -e
mkdir -p /data/workspace /data/work
echo '${imagen}' | base64 -d > /data/workspace/imagen.ts
NODE=$(command -v node)
${OPENAI_KEY ? `printf 'OPENAI_API_KEY=%s\nOPENAI_IMAGE_MODEL=%s\n' '${OPENAI_KEY}' '${OPENAI_MODEL}' > /etc/imagen-mcp.env && chmod 600 /etc/imagen-mcp.env` : "true"}
cat > /etc/systemd/system/imagen.service <<'UNIT'
${unit}UNIT
sed -i "s|__NODE__|$NODE|" /etc/systemd/system/imagen.service
touch /data/work/CLAUDE.md
grep -q '^# Herramientas de esta caja' /data/work/CLAUDE.md || printf '# Herramientas de esta caja\\n\\n' >> /data/work/CLAUDE.md
grep -q 'generar_imagen_hd' /data/work/CLAUDE.md || echo '${reglasB64}' | base64 -d >> /data/work/CLAUDE.md
systemctl daemon-reload
systemctl enable --now imagen.service
systemctl restart imagen.service
sleep 2
systemctl is-active imagen.service
curl -s -X POST http://127.0.0.1:${PORT}/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 120
`);
console.log(salida);
console.log(`\nlisto: alta en /extensions como http → http://127.0.0.1:${PORT}/mcp, y abre hilo nuevo`);
