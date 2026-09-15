/**
 * Un MCP que genera imágenes, sin dependencias ni llave.
 *
 * `generar_imagen(prompt)` le pide la imagen a un generador por HTTP y la devuelve como
 * bloque `image` de MCP. El agente no sabe de WhatsApp ni de la web: devuelve la imagen
 * por el protocolo y cada canal decide cómo entregarla.
 *
 * Dos transportes:
 *   node mcp/imagen.ts              → stdio (JSON por renglón, como mcp/hello.ts)
 *   node mcp/imagen.ts --http 4123  → Streamable HTTP en /mcp, que es lo único que monta
 *                                     el adaptador claude-acp (un stdio se declara, se
 *                                     acepta y desaparece sin aviso).
 *
 * Prueba directa:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node mcp/imagen.ts
 *   curl -X POST localhost:4123/mcp -H 'content-type: application/json' \
 *        -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
 */
import { createServer } from "node:http";

type RpcRequest = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any };
type RpcResponse = { jsonrpc: "2.0"; id: RpcRequest["id"]; result?: unknown; error?: unknown };

const GENERADOR = process.env.IMAGEN_URL ?? "https://image.pollinations.ai/prompt/";
// La HD va por OpenAI, y sólo si hay llave: sin OPENAI_API_KEY la tool no se anuncia.
const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-2";

const TOOLS: any[] = [
  {
    name: "generar_imagen",
    description:
      "Genera una imagen a partir de una descripción en texto y la devuelve como imagen. Úsala cuando te pidan dibujar, ilustrar o generar una imagen.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Qué debe mostrar la imagen, en inglés si es posible" },
        width: { type: "number", description: "Ancho en píxeles (default 768)" },
        height: { type: "number", description: "Alto en píxeles (default 768)" },
      },
      required: ["prompt"],
    },
  },
];

if (OPENAI_KEY) {
  TOOLS.push({
    name: "generar_imagen_hd",
    description:
      "Genera una imagen en alta definición con el modelo de imágenes de OpenAI. Úsala SÓLO cuando te pidan explícitamente una imagen HD, en alta calidad o de alta resolución; para todo lo demás usa generar_imagen.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Qué debe mostrar la imagen, en inglés si es posible" },
        size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"], description: "Tamaño (default 1024x1024)" },
      },
      required: ["prompt"],
    },
  });
}

/** "HD" para el agente, pero se pide en calidad `low`: cuesta centavos y tarda segundos. */
async function generarHd(prompt: string, size = "1024x1024") {
  const r = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${OPENAI_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, prompt, size, quality: "low", n: 1 }),
    signal: AbortSignal.timeout(120_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${j?.error?.message ?? "sin detalle"}`);
  const data = j?.data?.[0]?.b64_json;
  if (!data) throw new Error("OpenAI no devolvió imagen");
  return { mimeType: "image/png", data };
}

async function generar(prompt: string, width = 768, height = 768) {
  const url = `${GENERADOR}${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true`;
  const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`el generador contestó ${r.status}`);
  const mimeType = r.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const data = Buffer.from(await r.arrayBuffer()).toString("base64");
  return { mimeType, data };
}

/** Atiende una petición; `null` si era notificación (sin id) y no se contesta. */
async function atender(req: RpcRequest): Promise<RpcResponse | null> {
  if (req.id === undefined) return null;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "initialize":
      return ok({
        protocolVersion: req.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "imagen", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const args = req.params?.arguments ?? {};
      if (req.params?.name === "generar_imagen_hd" && OPENAI_KEY) {
        try {
          const im = await generarHd(String(args.prompt ?? ""), args.size ? String(args.size) : undefined);
          return ok({
            content: [
              { type: "image", data: im.data, mimeType: im.mimeType },
              { type: "text", text: `Imagen HD generada para: ${args.prompt}` },
            ],
          });
        } catch (e) {
          return ok({ isError: true, content: [{ type: "text", text: `No pude generar la imagen HD: ${(e as Error).message}` }] });
        }
      }
      if (req.params?.name !== "generar_imagen") {
        return { jsonrpc: "2.0", id: req.id, error: { code: -32602, message: `no conozco la tool ${req.params?.name}` } };
      }
      try {
        const im = await generar(String(args.prompt ?? ""), Number(args.width) || 768, Number(args.height) || 768);
        return ok({
          content: [
            { type: "image", data: im.data, mimeType: im.mimeType },
            { type: "text", text: `Imagen generada para: ${args.prompt}` },
          ],
        });
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: `No pude generar la imagen: ${(e as Error).message}` }] });
      }
    }
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no conozco ${req.method}` } };
  }
}

// ---------------------------------------------------------------------------
// Transporte HTTP (Streamable HTTP): POST /mcp → JSON; notificación → 202;
// GET → stream SSE abierto con latido; DELETE → 200.
// ---------------------------------------------------------------------------
function servirHttp(port: number) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": abierto\n\n");
      const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => clearInterval(beat));
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let cuerpo = "";
    for await (const trozo of req) cuerpo += trozo;
    let msg: RpcRequest;
    try {
      msg = JSON.parse(cuerpo);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON ilegible" } }));
      return;
    }
    const respuesta = await atender(msg);
    if (!respuesta) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(respuesta));
  });
  server.listen(port, "0.0.0.0", () => console.error(`[imagen] http://127.0.0.1:${port}/mcp`));
}

// ---------------------------------------------------------------------------
// Transporte stdio: una petición por renglón, una respuesta por renglón.
// ---------------------------------------------------------------------------
function servirStdio() {
  let pendiente = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (trozo) => {
    pendiente += trozo;
    const lineas = pendiente.split("\n");
    pendiente = lineas.pop() ?? "";
    for (const linea of lineas) {
      if (!linea.trim()) continue;
      try {
        void atender(JSON.parse(linea)).then((r) => {
          if (r) process.stdout.write(JSON.stringify(r) + "\n");
        });
      } catch (e) {
        console.error("[imagen] línea ilegible:", (e as Error).message);
      }
    }
  });
}

const i = process.argv.indexOf("--http");
if (i !== -1) servirHttp(Number(process.argv[i + 1]) || 4123);
else servirStdio();
