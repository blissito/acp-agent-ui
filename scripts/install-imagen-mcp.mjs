/**
 * Deja el MCP de imágenes corriendo en la caja como unidad de systemd.
 *
 *   node scripts/install-imagen-mcp.mjs        # lee EASYBITS_API_KEY y AGENT_BOX_ID del .env
 *
 * Sube mcp/imagen.ts a /data/workspace, escribe imagen.service (Restart=always, arranca con la
 * caja) y CLAUDE.md en /data/work para que el agente use la tool sin irse a leer docs. Después
 * de correrlo hay que abrir un hilo nuevo: el hilo abierto se queda con la conexión MCP vieja.
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const KEY = process.env.EASYBITS_API_KEY ?? env.EASYBITS_API_KEY;
const BOX = process.env.AGENT_BOX_ID ?? env.AGENT_BOX_ID;
if (!KEY || !BOX) throw new Error("faltan EASYBITS_API_KEY o AGENT_BOX_ID");

const b64 = (s) => Buffer.from(s).toString("base64");
const unit = `[Unit]
Description=MCP de imagenes (Streamable HTTP en 127.0.0.1:4123)
After=network.target

[Service]
ExecStart=/usr/local/bin/node /data/workspace/imagen.ts --http 4123
Restart=always
RestartSec=2
WorkingDirectory=/data/workspace
StandardOutput=append:/data/workspace/imagen.log
StandardError=append:/data/workspace/imagen.log

[Install]
WantedBy=multi-user.target
`;
const hints = `# Reglas para este agente

- Para generar o dibujar imágenes usa SIEMPRE la herramienta \`generar_imagen\` (extensión
  \`imagen\`), un solo intento, y confirma en una frase. No busques otros generadores ni leas
  documentación de SDKs antes.
- Contesta en español, corto: en WhatsApp cada respuesta es una burbuja.
`;
async function exec(command) {
  const r = await fetch(`https://www.easybits.cloud/api/v2/sandboxes/${BOX}/exec`, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ command }),
  });
  const d = await r.json();
  if (d.exitCode !== 0) throw new Error(`exec falló (${d.exitCode}): ${command.slice(0, 60)}… ${d.stderr ?? ""}`);
  return (d.stdout ?? "").trim();
}

// Tres llamadas cortas en vez de una larga: /exec devuelve exitCode -1 sin explicar
// cuando el comando no le gusta, y así se sabe cuál fue.
await exec(`mkdir -p /data/workspace /data/work && echo ${b64(readFileSync(new URL("../mcp/imagen.ts", import.meta.url)))} | base64 -d > /data/workspace/imagen.ts`);
await exec(`echo ${b64(unit)} | base64 -d > /etc/systemd/system/imagen.service && echo ${b64(hints)} | base64 -d > /data/work/CLAUDE.md`);
// Si quedó un proceso suelto de antes, la unidad no puede tomar el puerto: se mata por /proc.
// Sólo procesos `node`: el shell de este mismo exec también lleva "imagen.ts" en su cmdline y
// un pkill -f se mataría a sí mismo (exitCode -1 sin explicación).
await exec(`for p in /proc/[0-9]*; do [ "$(cat $p/comm 2>/dev/null)" = node ] && grep -qs 'imagen.ts' $p/cmdline && kill $(basename $p); done; true`);
const estado = await exec(
  `systemctl daemon-reload && systemctl enable --now imagen.service >/dev/null 2>&1; systemctl restart imagen.service; sleep 2; systemctl is-active imagen.service; curl -s -o /dev/null -w '%{http_code}' -X POST localhost:4123/mcp -H content-type:application/json -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
);
console.log(estado);
if (!/active\s*200$/.test(estado)) process.exit(1);
console.log("imagen.service instalado; abre un hilo nuevo.");
