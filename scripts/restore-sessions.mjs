/**
 * Devuelve a una caja la memoria episódica que se respaldó de otra.
 *
 *   EASYBITS_API_KEY=... node scripts/restore-sessions.mjs <fileId> [sandboxId] [--force]
 *
 * Es la otra mitad de `backup-sessions.mjs`. El `fileId` lo imprimió aquél: sin
 * ese dato el respaldo existe y no se encuentra, así que guardarlo es parte del
 * respaldo, no un detalle.
 *
 * Por defecto NO pisa una base que ya esté en la caja —bajar encima borraría
 * trabajo nuevo—; con `--force` sí.
 */
const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");

const args = process.argv.slice(2).filter((a) => a !== "--force");
const FORCE = process.argv.includes("--force");
const FILE_ID = args[0];
const ID = args[1] ?? process.env.AGENT_BOX_ID;
if (!FILE_ID) throw new Error("falta el fileId (lo imprimió backup-sessions.mjs)");
if (!ID) throw new Error("falta el sandboxId (argumento o AGENT_BOX_ID)");

const DIR = process.env.SESSIONS_DIR ?? "/data/state/goose/sessions";
const DB = `${DIR}/sessions.db`;

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

const exec = async (command) => {
  const r = await rest(`/sandboxes/${ID}/exec`, { method: "POST", body: { command } });
  return { ...r, stdout: r.stdout.trim() };
};

// 1. ¿Hay algo que perder en el destino?
const yaHay = await exec(`test -f ${DB} && echo si || echo no`);
if (yaHay.stdout === "si" && !FORCE) {
  console.log(`esa caja ya tiene ${DB}. Bajar encima borraría lo que haya ahí.`);
  console.log("Si de verdad quieres pisarla, repite con --force.");
  process.exit(1);
}

// 2. La URL de descarga la pide este script, que es quien tiene la llave.
const file = await rest(`/files/${FILE_ID}`);
const url = file.readUrl || file.url;
if (!url) throw new Error(`sin URL de descarga: ${JSON.stringify(file).slice(0, 200)}`);

// 3. La caja baja de una URL ya firmada. Y se para el agente antes de tocarle
//    la base debajo de los pies.
await exec("systemctl stop goose-acp 2>/dev/null || true");
const bajada = await exec(
  `mkdir -p ${DIR} && curl -sS -f -L ${JSON.stringify(url)} -o ${DB} && ls -l ${DB} | awk '{print $5}'`,
);
if (bajada.exitCode !== 0) throw new Error(`no se pudo bajar: ${bajada.stderr || bajada.stdout}`);

// 4. Verificar contando filas: un 200 no dice que el archivo sirva.
const hilos = await exec(`python3 - <<'PY'
import sqlite3
con = sqlite3.connect(${JSON.stringify(DB)})
print(con.execute("select count(*) from sessions").fetchone()[0])
PY`);
await exec("systemctl start goose-acp 2>/dev/null || true");

console.log(`restaurado ✅  ${bajada.stdout} bytes, ${hilos.stdout} hilos en ${DB}`);
console.log("Abre la app: el historial del agente está de vuelta.");
