/**
 * WhatsApp — sesión 5. Aquí se vincula el número (QR, o el código de 8 caracteres si el
 * QR no vincula), se ve el estado del canal y se eligen los grupos donde el agente
 * contesta. El estado llega por SSE; el QR sale solo al abrir y se renueva solo.
 */
import { useEffect, useState } from "react";
import { MessageCircle, Smartphone, Unplug } from "lucide-react";
import { useLoaderData } from "react-router";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { Switch } from "~/components/ui/switch";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { gruposConRefresco, rehidratar, waState, type WaGroup, type WaState } from "~/.server/whatsapp";

export async function loader() {
  rehidratar();
  return { state: waState(), groups: await gruposConRefresco() };
}

const FASE: Record<WaState["phase"], string> = {
  disconnected: "Sin vincular",
  connecting: "Conectando…",
  qr_pending: "Escanea el QR",
  pairing: "Vinculando por número",
  connected: "Conectado",
  failed: "Falló",
};

export default function WhatsApp() {
  const inicial = useLoaderData<typeof loader>();
  const [state, setState] = useState<WaState>(inicial.state);
  const [groups, setGroups] = useState<WaGroup[]>(inicial.groups);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pedidoQr, setPedidoQr] = useState(false);

  // El estado del canal vive en el servidor y se empuja por SSE.
  useEffect(() => {
    const es = new EventSource("/api/whatsapp/events");
    es.addEventListener("state", (e) => setState(JSON.parse((e as MessageEvent).data)));
    return () => es.close();
  }, []);

  // Al conectar, la lista de grupos del teléfono aparece sola.
  useEffect(() => {
    if (state.phase !== "connected") return;
    const t = setTimeout(() => void refrescar(), 1500);
    return () => clearTimeout(t);
  }, [state.phase]);

  async function refrescar() {
    const r = await fetch("/api/whatsapp");
    if (r.ok) setGroups((await r.json()).groups);
  }

  async function mutar(body: Record<string, unknown>) {
    setError(null);
    const r = await fetch("/api/whatsapp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) return setError(json.error ?? "algo salió mal");
    setState(json.state);
    setGroups(json.groups);
  }

  // El QR sale solo al abrir la pantalla si no hay nada vinculado.
  useEffect(() => {
    if (state.phase === "disconnected" && !pedidoQr) {
      setPedidoQr(true);
      void mutar({ intent: "connect" });
    }
  }, [state.phase, pedidoQr]);

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">WhatsApp</h1>
        <p className="mt-1 text-sm text-text-secondary">
          La app se vincula como un dispositivo más de tu WhatsApp. Un mensaje en un grupo
          prendido es un turno del hilo abierto: el mismo motor que usa el chat.
        </p>

        <section className="mt-8 rounded-xl border border-border-primary p-5">
          <div className="flex items-center gap-3">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                state.phase === "connected"
                  ? "bg-green-500"
                  : state.phase === "failed"
                    ? "bg-red-500"
                    : "bg-amber-400"
              }`}
            />
            <span className="text-sm text-text-primary">{FASE[state.phase]}</span>
            {state.me && (
              <span className="font-mono text-xs text-text-tertiary">
                {state.me.name ? `${state.me.name} · ` : ""}
                {state.me.id.split(":")[0].split("@")[0]}
              </span>
            )}
            <span className="flex-1" />
            {state.phase === "connected" || state.phase === "failed" ? (
              <Button variant="outline" size="sm" onClick={() => void mutar({ intent: "disconnect" })}>
                <Unplug /> Desvincular
              </Button>
            ) : null}
          </div>

          {(state.error || error) && (
            <p className="mt-3 text-sm text-red-500">{state.error ?? error}</p>
          )}

          {state.phase !== "connected" && (
            <div className="mt-5 flex flex-col gap-6 sm:flex-row">
              <div className="flex flex-col items-center gap-2">
                {state.qr ? (
                  <img src={state.qr} alt="QR de vinculación" className="h-64 w-64 rounded-lg bg-white p-2" />
                ) : (
                  <div className="flex h-64 w-64 items-center justify-center rounded-lg border border-dashed border-border-primary">
                    <MessageCircle className="h-8 w-8 animate-pulse text-text-tertiary" />
                  </div>
                )}
                <p className="text-xs text-text-tertiary">
                  WhatsApp → Dispositivos vinculados → Vincular un dispositivo
                </p>
              </div>

              <div className="flex flex-1 flex-col gap-2">
                <p className="text-xs uppercase tracking-wide text-text-tertiary">
                  O con tu número
                </p>
                <p className="text-xs text-text-tertiary">
                  Sale un código de 8 caracteres; en el teléfono elige "Vincular con el número
                  de teléfono". Pedirlo cancela el QR: es el mismo handshake.
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="5215512345678"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode="numeric"
                  />
                  <Button size="default" onClick={() => void mutar({ intent: "pair", phone })} disabled={!phone.trim()}>
                    <Smartphone /> Código
                  </Button>
                </div>
                {state.pairingCode && (
                  <p className="mt-2 font-mono text-3xl tracking-[0.3em] text-text-primary">
                    {state.pairingCode}
                  </p>
                )}
                {state.phase === "failed" && (
                  <Button variant="outline" size="sm" className="mt-2 self-start" onClick={() => void mutar({ intent: "connect" })}>
                    Reintentar con QR
                  </Button>
                )}
              </div>
            </div>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-xs uppercase tracking-wide text-text-tertiary">Grupos</h2>
          <p className="mb-3 mt-1 text-xs text-text-tertiary">
            El agente sólo contesta en los grupos prendidos. Un grupo aparece cuando alguien
            escribe en él o al conectar.
          </p>
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-12 text-center">
              <MessageCircle className="h-8 w-8 text-text-tertiary" />
              <p className="text-sm text-text-secondary">
                {state.phase === "connected"
                  ? "Todavía no veo grupos. Escribe algo en uno y aparece aquí."
                  : "Vincula el número para ver tus grupos."}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {groups.map((g) => (
                <li key={g.jid} className="flex items-center gap-3 rounded-xl border border-border-primary px-4 py-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm text-text-primary">{g.subject || "(sin nombre)"}</span>
                    <span className="truncate font-mono text-[11px] text-text-tertiary">{g.jid}</span>
                  </div>
                  <Switch
                    variant="mono"
                    checked={g.enabled}
                    onCheckedChange={(v) => void mutar({ intent: "group", jid: g.jid, enabled: v })}
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
