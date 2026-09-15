/** GET /api/whatsapp/events — SSE con el estado del canal (QR incluido). */
import { rehidratar, subscribeWa, type WaState } from "~/.server/whatsapp";

export async function loader({ request }: { request: Request }) {
  rehidratar();
  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {}
      };
      write(": connected\n\n");
      unsubscribe = subscribeWa((s: WaState) => write(`event: state\ndata: ${JSON.stringify(s)}\n\n`));
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
      "x-accel-buffering": "no",
    },
  });
}
