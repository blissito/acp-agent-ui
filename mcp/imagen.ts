/**
 * MCP de imágenes: una sola herramienta, `generar_imagen`, que pide la imagen
 * a un generador por HTTP y la devuelve como bloque `image` de MCP.
 *
 * Es el ejemplo de la sesión 5: el agente no sabe de WhatsApp ni de la web.
 * Devuelve la imagen por el protocolo y cada canal decide cómo entregarla —
 * el grupo la recibe como foto, el navegador la pinta en la burbuja.
 *
 * Sin dependencias. Corre dentro de la caja, por stdio o por HTTP:
 *   node imagen.ts                 → stdio (JSON-RPC por renglón)
 *   node imagen.ts --http 4123     → Streamable HTTP en http://127.0.0.1:4123/mcp
 * El segundo existe porque el adaptador claude-acp sólo monta MCPs http
 * (`mcpCapabilities: { http: true }`): el proceso vive en la caja igual, pero
 * escucha en un puerto en vez de en stdin.
 * Prueba directa:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generar_imagen","arguments":{"prompt":"un gato"}}}' | node mcp/imagen.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

type RpcRequest = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any };

// Generador sin llave para el taller; se cambia por variable de entorno.
const IMAGE_API = process.env.IMAGE_API_URL ?? "https://image.pollinations.ai/prompt/";
const OUT_DIR = process.env.IMAGE_OUT_DIR ?? "/data/work/imagenes";

const TOOLS = [
  {
    name: "generar_imagen",
    description:
      "Genera una imagen a partir de una descripción en texto y la entrega directamente al humano por su canal. Úsala cuando te pidan dibujar, ilustrar o generar una imagen. Es la ÚNICA forma de generar imágenes: no busques otras herramientas ni la repitas con otro motor; un solo intento y confirma.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Qué debe mostrar la imagen, en detalle" },
        width: { type: "number", description: "Ancho en px (default 768)" },
        height: { type: "number", description: "Alto en px (default 768)" },
      },
      required: ["prompt"],
    },
  },
];

// `atender` devuelve la respuesta como línea JSON (o nada para una notificación);
// quien la transporta —stdout o la respuesta HTTP— la escribe.
const responder = (id: RpcRequest["id"], result: unknown) => JSON.stringify({ jsonrpc: "2.0", id, result });
const fallar = (id: RpcRequest["id"], message: string) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } });

async function generar(prompt: string, width = 768, height = 768) {
  const url = `${IMAGE_API}${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`el generador contestó ${r.status}`);
  const mimeType = r.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const bytes = Buffer.from(await r.arrayBuffer());
  // Se deja copia en el disco de la caja: el agente puede volver a usarla.
  let path = "";
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    path = `${OUT_DIR}/${Date.now()}.${mimeType.includes("png") ? "png" : "jpg"}`;
    writeFileSync(path, bytes);
  } catch {}
  return { data: bytes.toString("base64"), mimeType, path };
}

async function atender(req: RpcRequest): Promise<string | undefined> {
  switch (req.method) {
    case "initialize":
      return responder(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "imagen", version: "1.0.0" },
      });
    case "tools/list":
      return responder(req.id, { tools: TOOLS });
    case "tools/call": {
      const a = req.params?.arguments ?? {};
      if (req.params?.name !== "generar_imagen" || !a.prompt) return fallar(req.id, "falta el prompt");
      try {
        const img = await generar(String(a.prompt), Number(a.width) || 768, Number(a.height) || 768);
        return responder(req.id, {
          content: [
            { type: "image", data: img.data, mimeType: img.mimeType },
            { type: "text", text: `Imagen generada${img.path ? ` y guardada en ${img.path}` : ""}. Ya se la entregué al humano: no describas su contenido, solo confirma en una frase.` },
          ],
        });
      } catch (e) {
        return responder(req.id, { isError: true, content: [{ type: "text", text: `No pude generar la imagen: ${(e as Error).message}` }] });
      }
    }
    default:
      if (req.id === undefined) return;
      return JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no conozco ${req.method}` } });
  }
}

const httpIdx = process.argv.indexOf("--http");
if (httpIdx >= 0) {
  const port = Number(process.argv[httpIdx + 1] || 4123);
  createServer((req, res) => {
    // El cliente de Streamable HTTP abre un GET para recibir notificaciones del
    // servidor. No mandamos ninguna, pero el canal se deja abierto con latido:
    // un 405 aquí deja a algunos clientes reintentando en vez de llamar tools.
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": listo\n\n");
      const beat = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => clearInterval(beat));
      console.error("[imagen] GET stream abierto");
      return;
    }
    if (req.method === "DELETE") { res.writeHead(200).end(); return; }
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let msg: RpcRequest;
      try { msg = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
      // Una notificación (sin id) se acepta y no lleva cuerpo: así lo pide el transporte.
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      console.error(`[imagen] ${msg.method}${msg.params?.name ? " " + msg.params.name : ""}`);
      const linea = await atender(msg);
      console.error(`[imagen] ${msg.method} → ${linea ? linea.length + " bytes" : "sin cuerpo"}`);
      res.writeHead(200, { "content-type": "application/json" }).end(linea ?? "");
    });
  }).listen(port, "127.0.0.1", () => console.error(`[imagen] http://127.0.0.1:${port}/mcp`));
} else {
  let pendiente = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (trozo) => {
    pendiente += trozo;
    let i;
    while ((i = pendiente.indexOf("\n")) >= 0) {
      const linea = pendiente.slice(0, i).trim();
      pendiente = pendiente.slice(i + 1);
      if (!linea) continue;
      try {
        void atender(JSON.parse(linea)).then((r) => r && process.stdout.write(r + "\n"));
      } catch {}
    }
  });
}
