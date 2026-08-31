/**
 * Hub — la pantalla de inicio: reloj grande, saludo, y el input centrado.
 * Enviar crea la conversación en el servidor y navega a /c/:id.
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ChatInputCard } from "~/components/ChatInputCard";
import { ChatInput } from "~/components/ChatInput";
import { config } from "~/.server/acp";

export async function loader() {
  return { cwd: config.cwd, wsUrl: config.wsUrl };
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

export default function Hub({ loaderData }: { loaderData: { cwd: string } }) {
  const navigate = useNavigate();
  const clock = useClock();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const greeting = !clock
    ? ""
    : clock.hour < 12
      ? "Buenos días"
      : clock.hour < 18
        ? "Buenas tardes"
        : "Buenas noches";

  const handleSubmit = async (text: string) => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations", { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "no se pudo abrir la conversación");
      navigate(`/c/${body.conversationId}`, { state: { firstMessage: text } });
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
              placeholder="Pídele algo al agente que vive en la caja…"
            />
          </ChatInputCard>

          {error && <p className="mt-3 text-sm text-text-danger">{error}</p>}
          {creating && (
            <p className="mt-3 text-sm text-text-secondary">
              Despertando la caja del agente…
            </p>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}
