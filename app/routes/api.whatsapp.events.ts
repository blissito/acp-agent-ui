/**
 * GET /api/whatsapp/events — SSE con el estado del canal.
 *
 * El QR se renueva cada ~20 s y la vinculación cambia de estado varias veces
 * en segundos: por eso llega empujado, igual que el chat, y no por poll.
 */
import type { Route } from "./+types/api.whatsapp.events";
import { rehidratar, subscribeWa, type WaState } from "~/.server/whatsapp";

export async function loader({ request }: Route.LoaderArgs) {
  rehidratar();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try { controller.enqueue(encoder.encode(chunk)); } catch {}
      };
      write(": connected\n\n");
      unsubscribe = subscribeWa((s: WaState) => write(`event: state\ndata: ${JSON.stringify(s)}\n\n`));
      const beat = setInterval(() => write(": ping\n\n"), 25_000);
      request.signal.addEventListener("abort", () => {
        clearInterval(beat);
        unsubscribe?.();
        try { controller.close(); } catch {}
      });
    },
    cancel() { unsubscribe?.(); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
