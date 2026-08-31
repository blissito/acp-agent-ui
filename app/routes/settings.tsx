/**
 * Ajustes. El tema es real (escribe la clase en <html> y la recuerda); la
 * conexión con el agente se muestra en modo lectura porque vive en variables
 * de entorno del servidor.
 */
import { useLoaderData, useRevalidator } from "react-router";
import type { Route } from "./+types/settings";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { config } from "~/.server/acp";
import { cn } from "~/lib/utils";
import { applyTheme, themeFromCookies, type ThemePreference } from "~/lib/theme";

const OPCIONES: { id: ThemePreference; label: string }[] = [
  { id: "system", label: "sistema" },
  { id: "light", label: "claro" },
  { id: "dark", label: "oscuro" },
  { id: "aura", label: "aura" },
];

export async function loader({ request }: Route.LoaderArgs) {
  return {
    theme: themeFromCookies(request.headers.get("cookie")),
    wsUrl: config.wsUrl,
    cwd: config.cwd,
    agentBox: config.agentBox,
    idleMinutes: Math.round(config.idleMs / 60000),
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border-secondary py-3 last:border-b-0">
      <span className="text-xs uppercase tracking-wider text-text-tertiary">{label}</span>
      <span className="break-all font-mono text-sm text-text-primary">{value}</span>
    </div>
  );
}

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();

  // Aplica en vivo y revalida para que el servidor vuelva a leer la cookie.
  const apply = (next: ThemePreference) => {
    applyTheme(next);
    revalidator.revalidate();
  };

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">Ajustes</h1>

        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-text-primary">Tema</h2>
          <div className="flex flex-wrap gap-2">
            {OPCIONES.map((opcion) => (
              <button
                key={opcion.id}
                onClick={() => apply(opcion.id)}
                className={cn(
                  "rounded-lg border px-4 py-2 text-sm transition-colors",
                  data.theme === opcion.id
                    ? "border-border-inverse bg-background-inverse text-text-inverse"
                    : "border-border-primary text-text-secondary hover:bg-background-secondary"
                )}
              >
                {opcion.label}
              </button>
            ))}
          </div>
        </section>

        <section className="mt-10">
          <h2 className="mb-1 text-sm font-semibold text-text-primary">Agente</h2>
          <p className="mb-3 text-xs text-text-secondary">
            Se configura con variables de entorno del servidor: ACP_WS_URL, ACP_CWD,
            AGENT_BOX_ID, ACP_IDLE_MS.
          </p>
          <div className="rounded-xl border border-border-primary px-4">
            <Row label="Endpoint ACP" value={data.wsUrl} />
            <Row label="Directorio de trabajo" value={data.cwd} />
            <Row label="Caja del agente" value={data.agentBox} />
            <Row label="Suspender tras" value={`${data.idleMinutes} min de inactividad`} />
          </div>
        </section>
      </div>
    </MainPanelLayout>
  );
}
