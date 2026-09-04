/**
 * Hub — la pantalla de inicio: reloj grande, saludo, y el input centrado.
 * Enviar crea la conversación en el servidor y navega a /c/:id.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ChatInputCard } from "~/components/ChatInputCard";
import { ChatInput } from "~/components/ChatInput";
import { cn } from "~/lib/utils";
import { config, warmState } from "~/.server/acp";
import { useWarmStream, type WarmSeed } from "~/hooks/useWarmStream";
import type { ImagePayload } from "~/hooks/useAcpStream";

export async function loader() {
  // El estado de la sesión precalentada viaja en el HTML: si el handshake ya
  // terminó (lo normal a la segunda visita), el selector aparece pintado desde
  // el primer frame en vez de aparecer medio segundo después.
  return { cwd: config.cwd, wsUrl: config.wsUrl, warm: warmState() };
}

/** El estado de la línea con el agente, en una frase y un punto de color. */
function EstadoConexion({
  ready,
  phase,
  error,
  gone,
  slots,
  onRetry,
}: {
  ready: boolean;
  phase: string;
  error: string | null;
  gone: boolean;
  slots: { live: number; max: number };
  onRetry: () => void;
}) {
  // Que no haya sesión precalentada NO es que el agente esté caído: lo normal es
  // que no quepa, porque la caja atiende un número fijo de conversaciones a la
  // vez. Pintarlo en rojo con un "Reintentar" que no puede funcionar era mentir.
  const sinHueco = !ready && !error && slots.live >= slots.max;
  const caido = Boolean(error) || (gone && !sinHueco);
  const texto = sinHueco
    ? `Sin hueco para precalentar (${slots.live} de ${slots.max} conversaciones); la próxima conectará al abrirse`
    : caido
    ? error ?? "Sin línea con el agente"
    : ready
      ? "Listo"
      : phase === "waking"
        ? "Despertando la caja…"
        : phase === "connecting"
          ? "Conectando…"
          : "Abriendo la sesión…";
  return (
    <div className="mb-2 flex items-center gap-2 text-xs text-text-tertiary">
      <span
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          caido
            ? "bg-text-danger"
            : ready
              ? "bg-text-success"
              : sinHueco
                ? "bg-text-tertiary"
                : "animate-pulse bg-text-tertiary"
        )}
      />
      <span className="truncate">{texto}</span>
      {caido && (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 underline underline-offset-2 transition-colors hover:text-text-primary"
        >
          Reintentar
        </button>
      )}
    </div>
  );
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  // Arranca en null: la hora del servidor no es la del usuario y provocaría
  // un desajuste de hidratación.
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!now) return null;
  const hour = now.getHours();
  const displayHour = ((hour + 11) % 12) + 1;
  return {
    time: `${displayHour}:${String(now.getMinutes()).padStart(2, "0")}`,
    meridiem: hour >= 12 ? "PM" : "AM",
    hour,
  };
}

export default function Hub({
  loaderData,
}: {
  loaderData: { cwd: string; warm: WarmSeed };
}) {
  const navigate = useNavigate();
  const clock = useClock();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const warm = useWarmStream(loaderData.warm);

  const greeting = !clock
    ? ""
    : clock.hour < 12
      ? "Buenos días"
      : clock.hour < 18
        ? "Buenas tardes"
        : "Buenas noches";

  const handleSubmit = async (text: string, images: ImagePayload[] = []) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      // El turno viaja EN la creación: así la conversación nace con su primer
      // mensaje puesto y el chat lo pinta al primer render, sin depender de que
      // el navegador cargue una ruta para reenviarlo.
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, images }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "no se pudo abrir la conversación");
      navigate(`/c/${body.conversationId}`);
    } catch (e) {
      setError((e as Error).message);
      setCreating(false);
    }
  };

  return (
    <MainPanelLayout>
      <div className="relative flex h-full min-h-0 flex-col items-center justify-center px-4 sm:px-6">
        <div className="w-full max-w-2xl">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="text-5xl font-light tabular-nums tracking-tight text-text-primary sm:text-6xl">
              {clock?.time ?? "—"}
            </span>
            <span className="text-2xl font-light text-text-secondary">
              {clock?.meridiem ?? ""}
            </span>
          </div>
          <p className="mb-6 text-xl text-text-secondary">{greeting}</p>

          <EstadoConexion
            ready={warm.ready}
            phase={warm.phase}
            error={warm.error}
            gone={warm.gone}
            slots={loaderData.warm.slots}
            onRetry={() => void warm.retry()}
          />

          <ChatInputCard>
            <ChatInput
              onSubmit={handleSubmit}
              busy={creating}
              workingDir={loaderData.cwd}
              withImages
              models={warm.models}
              currentModel={warm.currentModel}
              onModelChange={(v) => void warm.setModel(v)}
              placeholder="Pídele algo al agente que vive en la caja…"
            />
          </ChatInputCard>

          {error && <p className="mt-3 text-sm text-text-danger">{error}</p>}
          {creating && (
            <p className="mt-3 text-sm text-text-secondary">Abriendo la conversación…</p>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}
