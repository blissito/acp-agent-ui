/**
 * Respalda la memoria episódica del agente: su `sessions.db`, fuera de la caja.
 *
 *   EASYBITS_API_KEY=... node scripts/backup-sessions.mjs [sandboxId]
 *
 * Sin argumento usa AGENT_BOX_ID del .env. Imprime un `fileId`: apúntalo, es lo
 * único que hace falta para restaurar.
 *
 * Dos cosas que este script enseña:
 *
 *  1. **`.backup`, nunca `cp`.** La base está abierta y en modo WAL: lo reciente
 *     vive en el `-wal`, así que copiar el archivo da una base sin la tabla
 *     siquiera. Se hace con `python3`, porque la caja no trae el binario
 *     `sqlite3`.
 *  2. **Las llaves no entran a la caja.** Quien tiene la llave es este script,
 *     que corre fuera; la caja sólo recibe una URL ya firmada y hace `curl -T`.
 */
const API = "https://www.easybits.cloud/api/v2";
const KEY = process.env.EASYBITS_API_KEY;
if (!KEY) throw new Error("falta EASYBITS_API_KEY");

const ID = process.argv[2] ?? process.env.AGENT_BOX_ID;
if (!ID) throw new Error("falta el sandboxId (argumento o AGENT_BOX_ID)");

// Dónde vive la memoria de goose. Con XDG_DATA_HOME=/data/state cae en el disco
// que sobrevive; sin él, en el home, que muere con la caja.
const DB = process.env.SESSIONS_DB ?? "/data/state/goose/sessions/sessions.db";

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
  if (r.exitCode !== 0) throw new Error(`en la caja: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

// 1. La copia en caliente. `con.backup()` es la vía correcta con la base viva:
//    lee bajo transacción y deja un archivo consistente, WAL incluido.
const TMP = "/tmp/sessions.bak.db";
const salida = await exec(`python3 - <<'PY'
import sqlite3, os, sys
origen = ${JSON.stringify(DB)}
if not os.path.exists(origen):
    sys.exit("no hay ninguna base en " + origen)
con = sqlite3.connect(f"file:{origen}?mode=ro", uri=True)
dst = sqlite3.connect(${JSON.stringify(TMP)})
con.backup(dst)              # NO shutil.copy: la copia cruda sale sin la tabla
dst.close()
hilos = con.execute("select count(*) from sessions").fetchone()[0]
print(os.path.getsize(${JSON.stringify(TMP)}), hilos)
PY`);
const [size, hilos] = salida.split(/\s+/).map(Number);
console.log(`copia en caliente: ${size} bytes, ${hilos} hilos`);

// 2. El sitio donde va, pedido desde AQUÍ: la respuesta trae una URL firmada.
const nombre = `sessions-${ID.slice(0, 12)}-${new Date().toISOString().slice(0, 10)}.db`;
const creado = await rest("/files", {
  method: "POST",
  body: { fileName: nombre, contentType: "application/x-sqlite3", size, access: "private" },
});
const putUrl = creado.putUrl;
const fileId = creado.file?.id;
if (!putUrl || !fileId) throw new Error(`respuesta rara: ${JSON.stringify(creado).slice(0, 200)}`);

// 3. La caja sube contra esa URL. No sabe la llave y no tiene por qué.
await exec(`curl -sS -f -X PUT --upload-file ${TMP} ${JSON.stringify(putUrl)} -o /dev/null -w "%{http_code}"`);

console.log(`\nrespaldado ✅  fileId: ${fileId}`);
console.log(`restaurar:  node scripts/restore-sessions.mjs ${fileId} <sandboxId>`);
