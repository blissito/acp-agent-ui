/**
 * GET /api/conversations/:id/events — SSE.
 *
 * Es una ruta de recurso: no renderiza nada, devuelve un ReadableStream que se
 * mantiene abierto mientras el navegador escuche.
 */
import type { Route } from "./+types/api.conversations.$id.events";
import { closeSse, openSse, sesionActual, subscribe, type AcpEvent } from "~/.server/acp";

export async function loader({ params, request }: Route.LoaderArgs) {
  if (!sesionActual()) {
    return new Response("conversation not found", { status: 404 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  // El navegador que se va dispara `abort` y `cancel`, los dos. Sin esta
  // guarda el contador de streams baja el doble y la caja se echa a dormir
  // con pestañas abiertas: la siguiente pregunta paga el despertar entero.
  let cerrado = false;
  const soltar = () => {
    if (cerrado) return;
    cerrado = true;
    unsubscribe?.();
    closeSse();
  };

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
      openSse();

      unsubscribe = subscribe(params.id, (e: AcpEvent) => {
        const { type, ...rest } = e;
        write(`event: ${type}\ndata: ${JSON.stringify(rest)}\n\n`);
        if (type === "closed") {
          try {
            controller.close();
          } catch {}
        }
      });

      // Latido: mantiene viva la conexión frente a proxies impacientes.
      const beat = setInterval(() => write(": ping\n\n"), 25_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(beat);
        soltar();
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      soltar();
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
