/**
 * Las extensiones MCP que este Cliente declara, en una base sqlite.
 *
 * Es la primera base de datos del repo: el resto de la memoria del Cliente
 * (los hilos, los títulos, los modelos) vive en JSON plano porque se lee y se
 * escribe entera. Una extensión no: se da de alta, se prende, se apaga y se
 * borra una a la vez, y ahí un archivo JSON empieza a doler.
 *
 * `node:sqlite` viene en Node desde la 22.5 y no pide instalar nada. Avisa que
 * es experimental al arrancar; es un aviso, no un error.
 */
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// En producción la app corre dentro de la caja con WORKDIR /app, y /app se
// borra en cada despliegue: por eso la ruta es variable de entorno y el .env
// de allá la manda a /data, que es lo único que sobrevive.
const DB_PATH = process.env.ACP_EXTENSIONS_DB ?? ".data/extensions.db";

export type Transport = "stdio" | "http";

export interface NameValue {
  name: string;
  value: string;
}

export interface Extension {
  id: string;
  name: string;
  transport: Transport;
  command: string | null;
  args: string[];
  url: string | null;
  headers: NameValue[];
  env: NameValue[];
  enabled: boolean;
  createdAt: number;
}

let db: DatabaseSync | null = null;

/** Se abre a la primera pregunta, no al importar: una base rota deja el chat
 *  funcionando sin extensiones en vez de tumbar el servidor entero.
 *  La misma base la usa el canal de WhatsApp (`whatsapp.ts`): una sola
 *  conexión, cada módulo crea sus tablas. */
export function abrir(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const nueva = new DatabaseSync(DB_PATH);
  nueva.exec(`
    CREATE TABLE IF NOT EXISTS extensions (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      transport  TEXT NOT NULL,
      command    TEXT,
      args       TEXT NOT NULL DEFAULT '[]',
      url        TEXT,
      headers    TEXT NOT NULL DEFAULT '[]',
      env        TEXT NOT NULL DEFAULT '[]',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )
  `);
  db = nueva;
  return nueva;
}

// `args`, `env` y `headers` se guardan como JSON dentro de una columna de
// texto. Tres tablas hijas serían más ortodoxas y triplicarían el código: se
// leen y se escriben siempre enteros, nunca se busca por dentro de ellos.
const aFila = (r: any): Extension => ({
  id: r.id,
  name: r.name,
  transport: r.transport,
  command: r.command,
  args: JSON.parse(r.args),
  url: r.url,
  headers: JSON.parse(r.headers),
  env: JSON.parse(r.env),
  enabled: !!r.enabled,
  createdAt: r.created_at,
});

export function listExtensions(): Extension[] {
  return abrir()
    .prepare("SELECT * FROM extensions ORDER BY created_at")
    .all()
    .map(aFila);
}

export interface NuevaExtension {
  name: string;
  transport: Transport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: NameValue[];
  env?: NameValue[];
}

/** Valida en el servidor, no en el formulario: el formulario ayuda, pero quien
 *  manda es esto. Lanza un Error con un mensaje que se pueda enseñar. */
export function createExtension(input: NuevaExtension): Extension {
  const name = (input.name ?? "").trim();
  // El Agente usa el nombre como prefijo de las herramientas que expone.
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) {
    throw new Error("El nombre lleva letras, números, guion y guion bajo (máximo 40).");
  }
  if (input.transport !== "stdio" && input.transport !== "http") {
    // sse queda fuera a propósito: el Agente lo rechaza y pide streamable http.
    throw new Error("El transporte es stdio o http.");
  }

  const command = (input.command ?? "").trim();
  const url = (input.url ?? "").trim();
  if (input.transport === "stdio") {
    // El error más común: escribir `node` en vez de la ruta completa. Quien
    // lanza el proceso es el Agente, y no hereda tu PATH.
    if (!command.startsWith("/")) {
      throw new Error("El comando va con ruta absoluta, por ejemplo /usr/local/bin/node.");
    }
  } else {
    try {
      const u = new URL(url);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocolo");
    } catch {
      throw new Error("La URL no es válida.");
    }
  }

  const fila: Extension = {
    id: randomUUID(),
    name,
    transport: input.transport,
    command: input.transport === "stdio" ? command : null,
    args: input.args ?? [],
    url: input.transport === "http" ? url : null,
    headers: input.headers ?? [],
    env: input.env ?? [],
    enabled: true,
    createdAt: Date.now(),
  };

  try {
    abrir()
      .prepare(
        `INSERT INTO extensions (id, name, transport, command, args, url, headers, env, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        fila.id,
        fila.name,
        fila.transport,
        fila.command,
        JSON.stringify(fila.args),
        fila.url,
        JSON.stringify(fila.headers),
        JSON.stringify(fila.env),
        fila.createdAt,
      );
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new Error(`Ya hay una extensión llamada ${name}.`);
    throw e;
  }
  return fila;
}

export function deleteExtension(id: string) {
  abrir().prepare("DELETE FROM extensions WHERE id = ?").run(id);
}

export function setExtensionEnabled(id: string, enabled: boolean) {
  abrir().prepare("UPDATE extensions SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

export function getExtension(id: string): Extension | null {
  const r = abrir().prepare("SELECT * FROM extensions WHERE id = ?").get(id);
  return r ? aFila(r as any) : null;
}

/** Una fila, en la forma que espera ACP.
 *
 *  Ojo con stdio: en el esquema de ACP es la única variante SIN el campo
 *  `type`. Agregárselo "para que quede parejo" rompe `session/new` con un
 *  error de deserialización que no dice nada. */
export function aMcpServer(e: Extension) {
  return e.transport === "stdio"
    ? { name: e.name, command: e.command!, args: e.args, env: e.env }
    : { type: "http" as const, name: e.name, url: e.url!, headers: e.headers };
}

/** Lo declarado y encendido, listo para el handshake. Si la base falla, el
 *  chat abre sin extensiones en vez de no abrir. */
export function mcpServersParaAcp() {
  try {
    return listExtensions()
      .filter((e) => e.enabled)
      .map(aMcpServer);
  } catch (e) {
    console.warn("[extensions] no pude leer la base:", (e as Error).message);
    return [];
  }
}
