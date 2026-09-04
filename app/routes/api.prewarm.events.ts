/**
 * GET /api/prewarm/events — SSE de la sesión precalentada.
 *
 * Gemelo de `api.conversations.$id.events.ts` con dos diferencias deliberadas:
 * si no hay sesión tibia cierra el stream en vez de dar 404 (el hub distingue
 * "no hay" de "ruta rota"), y NO cuenta como SSE abierto: ese contador impide
 * dormir la caja mientras alguien lee un chat, y una pestaña del hub olvidada
 * la mantendría despierta para siempre.
 */
import type { Route } from "./+types/api.prewarm.events";
import { subscribeWarm, type AcpEvent } from "~/.server/acp";

export async function loader({ request }: Route.LoaderArgs) {
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // el cliente ya se fue
        }
      };

      write(": connected\n\n");

      unsubscribe = subscribeWarm((e: AcpEvent) => {
        const { type, ...rest } = e;
        write(`event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`);
        if (type === "closed") {
          try {
            controller.close();
          } catch {}
        }
      });

      if (!unsubscribe) {
        write(`event: closed\ndata: {}\n\n`);
        try {
          controller.close();
        } catch {}
        return;
      }

      const beat = setInterval(() => write(": ping\n\n"), 25_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(beat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
