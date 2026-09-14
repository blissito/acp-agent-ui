/**
 * MCP de imágenes: una sola herramienta, `generar_imagen`, que pide la imagen
 * a un generador por HTTP y la devuelve como bloque `image` de MCP.
 *
 * Es el ejemplo de la sesión 5: el agente no sabe de WhatsApp ni de la web.
 * Devuelve la imagen por el protocolo y cada canal decide cómo entregarla —
 * el grupo la recibe como foto, el navegador la pinta en la burbuja.
 *
 * Sin dependencias. Corre dentro de la caja: node /data/repo/mcp/imagen.ts
 * Prueba directa:
 *   echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generar_imagen","arguments":{"prompt":"un gato"}}}' | node mcp/imagen.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";

type RpcRequest = { jsonrpc: "2.0"; id?: number | string; method: string; params?: any };

// Generador sin llave para el taller; se cambia por variable de entorno.
const IMAGE_API = process.env.IMAGE_API_URL ?? "https://image.pollinations.ai/prompt/";
const OUT_DIR = process.env.IMAGE_OUT_DIR ?? "/data/work/imagenes";

const TOOLS = [
  {
    name: "generar_imagen",
    description:
      "Genera una imagen a partir de una descripción en texto y la devuelve como imagen. Úsala cuando te pidan dibujar, ilustrar o generar una imagen.",
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

function responder(id: RpcRequest["id"], result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function fallar(id: RpcRequest["id"], message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } }) + "\n");
}

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

async function atender(req: RpcRequest) {
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
      process.stdout.write(
        JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no conozco ${req.method}` } }) + "\n",
      );
  }
}

let pendiente = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (trozo) => {
  pendiente += trozo;
  let i;
  while ((i = pendiente.indexOf("\n")) >= 0) {
    const linea = pendiente.slice(0, i).trim();
    pendiente = pendiente.slice(i + 1);
    if (!linea) continue;
    try { void atender(JSON.parse(linea)); } catch {}
  }
});
