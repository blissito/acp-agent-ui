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
import { config, hubState } from "~/.server/acp";
import type { ImagePayload } from "~/hooks/useAcpStream";

export async function loader() {
  // Sin sesión abierta no se puede preguntar al agente por sus modelos (ACP no
  // tiene forma de listarlos sin sesión), así que el selector se pinta con el
  // último catálogo conocido. Se refresca solo al abrir cualquier hilo.
  return { cwd: config.cwd, wsUrl: config.wsUrl, hub: hubState() };
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
  loaderData: { cwd: string; hub: { models: { value: string; name: string }[]; currentModel: string | null } };
}) {
  const navigate = useNavigate();
  const clock = useClock();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { models, currentModel: modeloGuardado } = loaderData.hub;
  const [modelo, setModelo] = useState(modeloGuardado);

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


          <ChatInputCard>
            <ChatInput
              onSubmit={handleSubmit}
              busy={creating}
              workingDir={loaderData.cwd}
              withImages
              models={models}
              currentModel={modelo}
              onModelChange={(v) => {
                setModelo(v);
                void fetch("/api/model", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ value: v }),
                });
              }}
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
