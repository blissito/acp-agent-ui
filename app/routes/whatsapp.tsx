/**
 * WhatsApp — el número vinculado a esta app y los grupos donde contesta.
 *
 * Tres estados en pantalla: sin vincular (QR ya pintado, o código si das tu
 * número), conectado (quién eres, desde cuándo, desvincular) y la lista de
 * grupos con su interruptor. Sin grupo marcado, el agente calla en todos.
 */
import { useEffect, useState } from "react";
import { MessageCircle, Smartphone, Unlink, Users } from "lucide-react";
import { useLoaderData } from "react-router";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { listarGrupos, rehidratar, waState, type WaGroup, type WaState } from "~/.server/whatsapp";

export async function loader() {
  rehidratar();
  return { state: waState(), groups: await listarGrupos({ live: true }) };
}

const ETIQUETA: Record<WaState["status"], string> = {
  disconnected: "Sin vincular",
  connecting: "Conectando…",
  qr_pending: "Escanea el QR",
  pairing: "Teclea el código",
  connected: "Conectado",
  failed: "Falló",
};

export default function WhatsApp() {
  const inicial = useLoaderData<typeof loader>();
  const [state, setState] = useState<WaState>(inicial.state);
  const [groups, setGroups] = useState<WaGroup[]>(inicial.groups);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // El estado llega empujado; al conectar se vuelve a pedir la lista de grupos.
  useEffect(() => {
    const es = new EventSource("/api/whatsapp/events");
    es.addEventListener("state", (e) => {
      const s = JSON.parse((e as MessageEvent).data) as WaState;
      setState((prev) => {
        if (prev.status !== "connected" && s.status === "connected") {
          void fetch("/api/whatsapp?live=1").then((r) => r.json()).then((j) => setGroups(j.groups));
        }
        return s;
      });
    });
    return () => es.close();
  }, []);

  // Sin vincular y sin intento en curso: el QR sale solo, sin botón.
  useEffect(() => {
    if (state.status === "disconnected" && !state.reason) void mutar({ intent: "connect" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function mutar(body: Record<string, unknown>) {
    setError(null);
    setOcupado(true);
    try {
      const r = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) return setError(json.error ?? "algo salió mal");
      setState(json.state);
      setGroups(json.groups);
    } finally {
      setOcupado(false);
    }
  }

  const conectado = state.status === "connected";
  const activos = groups.filter((g) => g.enabled).length;

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">WhatsApp</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Esta app se vincula como un dispositivo más de tu WhatsApp. Un mensaje en un grupo marcado
          es un turno del mismo agente que usas aquí, y la respuesta vuelve al grupo.
        </p>

        {error && (
          <p className="mt-4 rounded-xl border border-red-500/40 px-4 py-3 text-sm text-red-500">{error}</p>
        )}

        {/* ── Estado del canal ── */}
        <section className="mt-8 rounded-xl border border-border-primary p-5">
          <div className="flex items-center gap-3">
            <span
              className={
                "h-2.5 w-2.5 rounded-full " +
                (conectado ? "bg-green-500" : state.status === "failed" ? "bg-red-500" : "bg-amber-400 animate-pulse")
              }
            />
            <span className="text-sm text-text-primary">{ETIQUETA[state.status]}</span>
            {state.attempt > 0 && state.status === "connecting" && (
              <span className="text-xs text-text-tertiary">reintento {state.attempt}</span>
            )}
          </div>
          {state.reason && <p className="mt-2 text-xs text-text-secondary">{state.reason}</p>}

          {conectado && state.me && (
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <Smartphone className="h-8 w-8 text-text-tertiary" />
              <div className="flex-1">
                <p className="text-sm text-text-primary">{state.me.name || "Sin nombre"}</p>
                <p className="font-mono text-xs text-text-tertiary">+{state.me.id}</p>
                {state.connectedAt && (
                  <p className="text-xs text-text-tertiary">
                    conectado desde {new Date(state.connectedAt).toLocaleTimeString("es-MX")}
                  </p>
                )}
              </div>
              <Button variant="outline" disabled={ocupado} onClick={() => void mutar({ intent: "disconnect" })}>
                <Unlink /> Desvincular
              </Button>
            </div>
          )}

          {!conectado && (
            <div className="mt-4 grid gap-6 sm:grid-cols-[auto_1fr]">
              <div className="flex h-[240px] w-[240px] items-center justify-center rounded-lg border border-border-primary bg-white">
                {state.qr ? (
                  <img src={state.qr} alt="QR de vinculación" className="h-[232px] w-[232px]" />
                ) : state.pairingCode ? (
                  <span className="font-mono text-3xl tracking-widest text-black">{state.pairingCode}</span>
                ) : (
                  <span className="px-4 text-center text-xs text-gray-500">
                    {state.status === "failed" ? "Sin intento en curso" : "Preparando…"}
                  </span>
                )}
              </div>
              <div className="flex flex-col gap-3 text-sm text-text-secondary">
                {state.pairingCode ? (
                  <p>
                    En el teléfono: <b>Dispositivos vinculados → Vincular con número de teléfono</b> y
                    teclea el código. Tienes un par de minutos.
                  </p>
                ) : (
                  <p>
                    En el teléfono: <b>Dispositivos vinculados → Vincular un dispositivo</b> y escanea.
                    El QR se renueva solo.
                  </p>
                )}
                <div className="mt-2 border-t border-border-primary pt-3">
                  <p className="mb-2 text-xs text-text-tertiary">
                    ¿No vincula? Prueba con tu número: suele fallar menos que la cámara.
                  </p>
                  <form
                    className="flex gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void mutar({ intent: "pair", phone });
                    }}
                  >
                    <input
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="521XXXXXXXXXX"
                      inputMode="numeric"
                      className="h-9 flex-1 rounded-md border border-border-primary bg-transparent px-3 font-mono text-sm text-text-primary outline-none focus:border-text-secondary"
                    />
                    <Button type="submit" variant="outline" disabled={ocupado || phone.replace(/\D/g, "").length < 10}>
                      Pedir código
                    </Button>
                  </form>
                </div>
                {state.status === "failed" && (
                  <Button variant="outline" className="self-start" disabled={ocupado} onClick={() => void mutar({ intent: "connect" })}>
                    Volver a intentar con QR
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>

        {/* ── Grupos ── */}
        <section className="mt-8">
          <h2 className="flex items-center gap-2 text-xs uppercase tracking-wide text-text-tertiary">
            <Users className="h-3.5 w-3.5" /> Grupos
            {activos > 0 && <span className="text-text-secondary">· contesta en {activos}</span>}
          </h2>
          <p className="mb-3 mt-1 text-xs text-text-tertiary">
            Sólo contesta donde lo prendas. Un grupo nuevo aparece aquí cuando alguien escribe en él
            o al recargar esta página.
          </p>
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-12 text-center">
              <MessageCircle className="h-8 w-8 text-text-tertiary" />
              <p className="text-sm text-text-secondary">
                {conectado ? "Este número no está en ningún grupo todavía." : "Vincula el número para ver sus grupos."}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {groups.map((g) => (
                <li key={g.id} className="flex items-center gap-3 rounded-xl border border-border-primary px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-sm text-text-primary">{g.subject}</span>
                    <span className="truncate font-mono text-[11px] text-text-tertiary">{g.id}</span>
                  </div>
                  <Switch
                    checked={g.enabled}
                    disabled={ocupado}
                    onCheckedChange={(v) => void mutar({ intent: "group", jid: g.id, enabled: v })}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </MainPanelLayout>
  );
}
