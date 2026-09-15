/**
 * Deja el MCP de voz (Kokoro) corriendo en la caja como unidad de systemd.
 *
 *   node --env-file=.env scripts/install-voz-mcp.mjs
 *
 * Sube mcp/voz.py a /data/workspace, instala ffmpeg + python3-venv con apt si faltan,
 * crea el venv en /data/kokoro (el único disco que sobrevive), instala kokoro-onnx,
 * descarga los modelos, escribe `voz.service` (Restart=always) y comprueba con un
 * tools/call real que devuelva audio. Los pasos largos corren con nohup y se sondea el log,
 * porque un exec de la caja tope en ~600 s.
 *
 * Después: alta en /extensions como http `http://127.0.0.1:4124/mcp` y abrir HILO NUEVO.
 */
import { readFileSync } from "node:fs";

const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
const ID = process.env.AGENT_BOX_ID;
const PORT = Number(process.env.VOZ_PORT ?? 4124);
const MODELOS = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0";
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

/** Corre un paso largo con nohup y espera a que el log diga `marca` (o falle). */
const largo = async (nombre, command, marca, maxMin = 20) => {
  const log = `/data/logs/${nombre}.log`;
  await exec(`mkdir -p /data/logs; nohup sh -c '${command.replace(/'/g, `'\\''`)} && echo ${marca}' > ${log} 2>&1 &`, 30);
  for (let i = 0; i < maxMin * 6; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    const s = await exec(`grep -q ${marca} ${log} && echo OK; tail -c 300 ${log}`, 30);
    if (s.startsWith("OK")) return;
    if (/ERROR|E: |Failed|No such/.test(s)) throw new Error(`${nombre} falló:\n${s}`);
  }
  throw new Error(`${nombre} no terminó en ${maxMin} min`);
};

const voz = readFileSync(new URL("../mcp/voz.py", import.meta.url)).toString("base64");

const unit = `[Unit]
Description=MCP de voz Kokoro (Streamable HTTP)
After=network-online.target

[Service]
Type=simple
ExecStart=/data/kokoro/venv/bin/python3 /data/workspace/voz.py --http ${PORT}
Environment=KOKORO_MODEL=/data/kokoro/kokoro-v1.0.onnx
Environment=KOKORO_VOICES=/data/kokoro/voices-v1.0.bin
Environment=VOZ_DIR=/data/voz
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

// 1. Paquetes del sistema (ffmpeg convierte a OGG/Opus; python3-venv para el venv).
console.log("apt: ffmpeg + python3-venv");
const faltan = await exec(`command -v ffmpeg >/dev/null && python3 -c 'import ensurepip' 2>/dev/null && echo NO || echo SI`);
if (faltan === "SI") {
  await largo(
    "apt",
    "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq --no-install-recommends ffmpeg python3-venv python3-pip",
    "APT_DONE",
    15,
  );
}

// 2. Venv + kokoro-onnx en /data (persistente).
console.log("venv + pip kokoro-onnx");
await exec(`mkdir -p /data/kokoro /data/voz /data/workspace /data/work; [ -x /data/kokoro/venv/bin/python3 ] || python3 -m venv /data/kokoro/venv`, 120);
await largo("pip", "/data/kokoro/venv/bin/pip install --no-cache-dir kokoro-onnx soundfile", "PIP_DONE", 20);

// 3. Modelos (~340 MB).
console.log("modelos kokoro-v1.0.onnx + voices-v1.0.bin");
await largo(
  "modelos",
  `cd /data/kokoro && [ -s kokoro-v1.0.onnx ] || curl -sSL -o kokoro-v1.0.onnx ${MODELOS}/kokoro-v1.0.onnx; [ -s voices-v1.0.bin ] || curl -sSL -o voices-v1.0.bin ${MODELOS}/voices-v1.0.bin`,
  "DL_DONE",
  20,
);

// 4. Servidor + unidad systemd + nota en el CLAUDE.md de la caja.
console.log("voz.service");
const salida = await exec(`
set -e
echo '${voz}' | base64 -d > /data/workspace/voz.py
cat > /etc/systemd/system/voz.service <<'UNIT'
${unit}UNIT
grep -q generar_voz /data/work/CLAUDE.md 2>/dev/null || cat >> /data/work/CLAUDE.md <<'MD'
- Para generar voz, audio hablado o notas de voz usa SIEMPRE la tool \`generar_voz\` del MCP \`voz\`
  (ya está conectada, voz \`em_santa\`). No instales TTS ni escribas código: llama la tool con el
  texto en español y devuelve el audio.
MD
systemctl daemon-reload
systemctl enable --now voz.service
systemctl restart voz.service
sleep 3
systemctl is-active voz.service
`, 120);
console.log(salida);

// 5. Prueba real: un tools/call que devuelva audio.
console.log("prueba tools/call");
const prueba = await exec(`
for i in $(seq 1 30); do curl -sf -X POST http://127.0.0.1:${PORT}/mcp -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' >/dev/null && break; sleep 2; done
curl -s -X POST http://127.0.0.1:${PORT}/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generar_voz","arguments":{"texto":"Hola, soy la voz de la caja. Esta es una prueba."}}}' \\
  | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; c=r["content"]; print("isError" if r.get("isError") else "ok", c[0]["type"], c[0].get("mimeType"), len(c[0].get("data","")), "|", c[-1]["text"])'
du -sh /data/kokoro /data/voz
`, 300);
console.log(prueba);
console.log(`\nlisto: alta en /extensions como http → http://127.0.0.1:${PORT}/mcp, y abre hilo nuevo`);
