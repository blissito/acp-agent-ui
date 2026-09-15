/**
 * /api/mcp/whatsapp — un MCP servido por la app, con la superficie del grupo.
 *
 * El socket de WhatsApp vive aquí, no en la caja; así que las tools que tocan el grupo
 * (foto, link) se sirven desde aquí como Streamable HTTP y el agente las monta como
 * cualquier otra extensión http. La caja tiene que poder llegar a esta URL: en producción
 * es la de la app; en dev, un túnel (ngrok) apuntando al 3000.
 *
 * Alta en /extensions: http → <PUBLIC_URL>/api/mcp/whatsapp, header
 * `authorization: Bearer <ACP_SECRET>` (o `?token=`).
 */
import { data } from "react-router";
import type { Route } from "./+types/api.mcp.whatsapp";
import { cambiarFotoDeGrupo, linkDeGrupo } from "~/.server/whatsapp";

const TOKEN = process.env.WHATSAPP_MCP_TOKEN ?? process.env.ACP_TOKEN ?? process.env.ACP_SECRET ?? "";
const GENERADOR = process.env.IMAGEN_URL ?? "https://image.pollinations.ai/prompt/";

const TOOLS = [
  {
    name: "link_grupo",
    description:
      "Devuelve el link de invitación del grupo de WhatsApp desde el que te hablan (o del jid que se indique). Úsala cuando pidan compartir el link o invitar a alguien.",
    inputSchema: {
      type: "object",
      properties: { jid: { type: "string", description: "Grupo (…@g.us). Opcional: por defecto el grupo del turno actual." } },
    },
  },
  {
    name: "cambiar_imagen_grupo",
    description:
      "Cambia la foto del grupo de WhatsApp desde el que te hablan (o del jid indicado). Da un `prompt` para generar la imagen, o `image_url` con una imagen existente.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Descripción de la imagen a generar (en inglés si se puede)" },
        image_url: { type: "string", description: "URL http(s) de una imagen ya hecha" },
        jid: { type: "string", description: "Grupo (…@g.us). Opcional: por defecto el grupo del turno actual." },
      },
    },
  },
];

async function traerImagen(args: any): Promise<{ buf: Buffer; mimeType: string }> {
  const url = args.image_url
    ? String(args.image_url)
    : args.prompt
      ? `${GENERADOR}${encodeURIComponent(String(args.prompt))}?width=640&height=640&nologo=true`
      : null;
  if (!url) throw new Error("Falta prompt o image_url");
  const r = await fetch(url, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`no pude traer la imagen (${r.status})`);
  return { buf: Buffer.from(await r.arrayBuffer()), mimeType: r.headers.get("content-type")?.split(";")[0] || "image/jpeg" };
}

async function llamar(name: string, args: any) {
  const texto = (t: string) => ({ content: [{ type: "text", text: t }] });
  switch (name) {
    case "link_grupo": {
      const r = await linkDeGrupo(args.jid);
      return texto(`Link del grupo ${r.subject || r.jid}: ${r.link}`);
    }
    case "cambiar_imagen_grupo": {
      const im = await traerImagen(args);
      const r = await cambiarFotoDeGrupo(args.jid, im.buf);
      return {
        content: [
          { type: "image", data: im.buf.toString("base64"), mimeType: im.mimeType },
          { type: "text", text: `Foto del grupo ${r.subject || r.jid} cambiada.` },
        ],
      };
    }
    default:
      throw new Error(`no conozco la tool ${name}`);
  }
}

async function atender(req: any) {
  if (req.id === undefined) return null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result });
  switch (req.method) {
    case "initialize":
      return ok({
        protocolVersion: req.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "whatsapp", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call":
      try {
        return ok(await llamar(req.params?.name, req.params?.arguments ?? {}));
      } catch (e) {
        return ok({ isError: true, content: [{ type: "text", text: (e as Error).message }] });
      }
    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no conozco ${req.method}` } };
  }
}

function autorizado(request: Request) {
  if (!TOKEN) return true;
  const h = request.headers.get("authorization") ?? "";
  const q = new URL(request.url).searchParams.get("token");
  return h === `Bearer ${TOKEN}` || q === TOKEN;
}

/** GET → stream SSE abierto con latido (lo pide Streamable HTTP). */
export async function loader({ request }: Route.LoaderArgs) {
  if (!autorizado(request)) return new Response("unauthorized", { status: 401 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const write = (c: string) => {
        try {
          controller.enqueue(encoder.encode(c));
        } catch {}
      };
      write(": abierto\n\n");
      const beat = setInterval(() => write(": ping\n\n"), 15_000);
      request.signal.addEventListener("abort", () => {
        clearInterval(beat);
        try {
          controller.close();
        } catch {}
      });
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

export async function action({ request }: Route.ActionArgs) {
  if (!autorizado(request)) return new Response("unauthorized", { status: 401 });
  if (request.method === "DELETE") return new Response(null, { status: 200 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let msg: any;
  try {
    msg = await request.json();
  } catch {
    return data({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON ilegible" } }, { status: 400 });
  }
  const r = await atender(msg);
  if (!r) return new Response(null, { status: 202 });
  return data(r);
}
