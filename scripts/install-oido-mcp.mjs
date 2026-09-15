/**
 * Deja el oído (faster-whisper) corriendo en la caja como unidad de systemd.
 *
 *   node --env-file=.env scripts/install-oido-mcp.mjs
 *
 * Sube mcp/oido.py a /data/workspace, crea el venv en /data/whisper (el único disco que
 * sobrevive), instala faster-whisper, precarga el modelo (HF_HOME=/data/whisper/hf para que
 * quede en /data), escribe `oido.service` (Restart=always) y comprueba con un POST real:
 * genera un audio en español con el MCP de voz (Kokoro, puerto 4124) y lo manda a
 * POST /transcribe. Los pasos largos corren con nohup y se sondea el log, porque un exec de
 * la caja tope en ~600 s.
 *
 * Variables: OIDO_PORT (4125), WHISPER_MODEL (base). Reejecutable: cada paso es idempotente.
 */
import { readFileSync } from "node:fs";

const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
const ID = process.env.AGENT_BOX_ID;
const PORT = Number(process.env.OIDO_PORT ?? 4125);
const VOZ_PORT = Number(process.env.VOZ_PORT ?? 4124);
const MODEL = process.env.WHISPER_MODEL ?? "base";
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
    if (/ERROR|E: |Failed|No such|Traceback/.test(s)) throw new Error(`${nombre} falló:\n${s}`);
  }
  throw new Error(`${nombre} no terminó en ${maxMin} min`);
};

const oido = readFileSync(new URL("../mcp/oido.py", import.meta.url)).toString("base64");

const unit = `[Unit]
Description=Oído de la caja: faster-whisper (HTTP)
After=network-online.target

[Service]
Type=simple
ExecStart=/data/whisper/venv/bin/python3 /data/workspace/oido.py --http ${PORT}
Environment=HF_HOME=/data/whisper/hf
Environment=WHISPER_MODEL=${MODEL}
Environment=WHISPER_THREADS=1
Environment=OIDO_DIR=/data/oido
Environment=OMP_NUM_THREADS=1
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
`;

// 1. ffmpeg + python3-venv (ya deberían estar por el MCP de voz).
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

// 2. Venv + faster-whisper en /data (persistente).
console.log("venv + pip faster-whisper");
await exec(`mkdir -p /data/whisper/hf /data/oido /data/workspace /data/work; [ -x /data/whisper/venv/bin/python3 ] || python3 -m venv /data/whisper/venv`, 120);
await largo("pip-whisper", "/data/whisper/venv/bin/pip install --no-cache-dir faster-whisper", "PIP_DONE", 20);

// 3. Precarga del modelo (descarga a /data/whisper/hf; se salta si ya está).
console.log(`modelo ${MODEL}`);
await largo(
  "modelo-whisper",
  `HF_HOME=/data/whisper/hf /data/whisper/venv/bin/python3 -c "from faster_whisper import WhisperModel; WhisperModel('${MODEL}', device='cpu', compute_type='int8')"`,
  "MODEL_DONE",
  20,
);

// 4. Servidor + unidad systemd.
console.log("oido.service");
const salida = await exec(`
set -e
echo '${oido}' | base64 -d > /data/workspace/oido.py
cat > /etc/systemd/system/oido.service <<'UNIT'
${unit}UNIT
systemctl daemon-reload
systemctl enable --now oido.service
systemctl restart oido.service
sleep 3
systemctl is-active oido.service
`, 120);
console.log(salida);

// 5. Prueba real: Kokoro genera un OGG en español y el oído lo transcribe.
console.log("prueba POST /transcribe");
const prueba = await exec(`
set -e
for i in $(seq 1 60); do curl -sf http://127.0.0.1:${PORT}/health | grep -q '"ok": true' && break; sleep 3; done
curl -s http://127.0.0.1:${PORT}/health; echo
curl -s -X POST http://127.0.0.1:${VOZ_PORT}/mcp -H 'content-type: application/json' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generar_voz","arguments":{"texto":"Hola, esto es una prueba de transcripción."}}}' \\
  | python3 -c 'import sys,json,base64; c=json.load(sys.stdin)["result"]["content"]; open("/data/oido/prueba.ogg","wb").write(base64.b64decode(c[0]["data"]))'
ls -la /data/oido/prueba.ogg
curl -s -X POST 'http://127.0.0.1:${PORT}/transcribe?lang=es' -H 'content-type: audio/ogg' --data-binary @/data/oido/prueba.ogg; echo
du -sh /data/whisper /data/whisper/hf
`, 300);
console.log(prueba);
console.log(`\nlisto: POST http://127.0.0.1:${PORT}/transcribe (cuerpo = bytes del audio) → {text, duration, language}`);
