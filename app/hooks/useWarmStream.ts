/**
 * Estado en vivo de la sesión precalentada, para el hub.
 *
 * Hermano pequeño de `useAcpStream`: aquí no hay turnos ni mensajes, sólo por
 * dónde va la conexión y qué modelos ofrece el agente. La semilla llega del
 * loader (así el primer paint ya trae lo que se sepa) y el SSE la corrige.
 *
 * Va por SSE y no por sondeo porque el evento que más importa —la lista de
 * modelos— llega cuando el agente termina de refrescar su inventario en
 * segundo plano, en un momento que nadie puede predecir.
 */
import { useCallback, useEffect, useState } from "react";
import type { ConnectPhase, ModelOption } from "~/hooks/useAcpStream";

export interface WarmSeed {
  configured: boolean;
  present: boolean;
  ready: boolean;
  phase: ConnectPhase;
  error: string | null;
  models: ModelOption[];
  currentModel: string | null;
  slots: { live: number; max: number };
}

export function useWarmStream(seed: WarmSeed) {
  const [ready, setReady] = useState(seed.ready);
  const [phase, setPhase] = useState<ConnectPhase>(seed.phase);
  const [error, setError] = useState<string | null>(seed.error);
  const [models, setModels] = useState<ModelOption[]>(seed.models);
  const [currentModel, setCurrentModel] = useState<string | null>(seed.currentModel);
  const [gone, setGone] = useState(!seed.present && seed.configured);
  // Cambiar de valor reabre el EventSource: es lo que hace "Reintentar".
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!seed.configured) return;
    const es = new EventSource("/api/prewarm/events");
    es.addEventListener("started", () => {
      setReady(true);
      setGone(false);
      setError(null);
    });
    es.addEventListener("status", (e) =>
      setPhase(JSON.parse((e as MessageEvent).data).phase)
    );
    es.addEventListener("models", (e) => {
      const m = JSON.parse((e as MessageEvent).data) as {
        options: ModelOption[];
        current: string | null;
      };
      setModels(m.options ?? []);
      setCurrentModel(m.current ?? null);
    });
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      if (data) setError(JSON.parse(data).message);
    });
    es.addEventListener("closed", () => {
      setReady(false);
      setGone(true);
      es.close();
    });
    return () => es.close();
  }, [seed.configured, attempt]);

  const setModel = useCallback(async (value: string) => {
    // Optimista: el SSE confirma el valor real cuando el agente responde.
    setCurrentModel(value);
    await fetch("/api/prewarm/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
  }, []);

  const retry = useCallback(async () => {
    setError(null);
    setGone(false);
    await fetch("/api/prewarm", { method: "POST" });
    setAttempt((n) => n + 1);
  }, []);

  return { ready, phase, error, models, currentModel, setModel, retry, gone };
}
