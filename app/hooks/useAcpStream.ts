/**
 * Consume el SSE de una conversación y arma el hilo de mensajes. Todo el ACP
 * ocurre del lado del servidor; aquí sólo llegan eventos ya traducidos.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Por dónde va la conexión con el agente antes del primer `started`. */
export type ConnectPhase = "waking" | "connecting" | "session";

/** Un modelo que el agente ofrece para la sesión (selector ACP). */
export interface ModelOption {
  value: string;
  name: string;
}

/** Una imagen lista para el agente: base64 sin prefijo + su MIME. */
export interface ImagePayload {
  mimeType: string;
  data: string;
}

export interface ToolEntry {
  id: string;
  title?: string;
  kind?: string;
  status?: string;
  path?: string;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
  thought?: string;
  tools?: ToolEntry[];
  images?: ImagePayload[];
  usage?: { used: number; size: number; cost: number };
}

export interface Usage {
  used: number;
  size: number;
  cost: number;
}

export function useAcpStream(conversationId: string, initial: Turn[] = []) {
  const [turns, setTurns] = useState<Turn[]>(initial);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [phase, setPhase] = useState<ConnectPhase>("waking");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const streaming = useRef(false);

  useEffect(() => {
    const es = new EventSource(`/api/conversations/${conversationId}/events`);

    // Todo lo que llega durante un turno (texto, pensamiento, herramientas)
    // cae en el mismo mensaje del asistente; si aún no existe, se crea.
    const patchCurrent = (patch: (turn: Turn) => Turn) => {
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (streaming.current && last?.role === "assistant") {
          next[next.length - 1] = patch(last);
          return next;
        }
        streaming.current = true;
        return [...next, patch({ role: "assistant", text: "" })];
      });
    };
    const appendChunk = (text: string) =>
      patchCurrent((t) => ({ ...t, text: t.text + text }));
    const appendThought = (text: string) =>
      patchCurrent((t) => ({ ...t, thought: (t.thought ?? "") + text }));
    // Upsert por id: tool_call crea la fila, tool_call_update la completa.
    const upsertTool = (entry: ToolEntry) =>
      patchCurrent((t) => {
        const tools = [...(t.tools ?? [])];
        const i = tools.findIndex((x) => x.id === entry.id);
        if (i === -1) tools.push(entry);
        else tools[i] = { ...tools[i], ...entry };
        return { ...t, tools };
      });

    es.addEventListener("started", () => setConnected(true));
    es.addEventListener("models", (e) => {
      const m = JSON.parse((e as MessageEvent).data) as {
        options: ModelOption[];
        current: string | null;
      };
      setModels(m.options ?? []);
      setCurrentModel(m.current ?? null);
    });
    es.addEventListener("status", (e) => setPhase(JSON.parse((e as MessageEvent).data).phase));
    es.addEventListener("chunk", (e) => appendChunk(JSON.parse((e as MessageEvent).data).text));
    es.addEventListener("thought", (e) => appendThought(JSON.parse((e as MessageEvent).data).text));
    es.addEventListener("tool", (e) => upsertTool(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("usage", (e) => {
      const u = JSON.parse((e as MessageEvent).data) as Usage;
      setUsage(u);
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant") next[next.length - 1] = { ...last, usage: u };
        return next;
      });
    });
    es.addEventListener("done", () => {
      streaming.current = false;
      setBusy(false);
    });
    es.addEventListener("warning", (e) => {
      const data = (e as MessageEvent).data;
      if (data) setNotice(JSON.parse(data).message);
    });
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data;
      if (data) setError(JSON.parse(data).message);
    });
    es.addEventListener("closed", () => {
      setConnected(false);
      es.close();
    });

    return () => es.close();
  }, [conversationId]);

  const send = useCallback(
    async (text: string, images: ImagePayload[] = []) => {
      setTurns((prev) => [...prev, { role: "user", text, images }]);
      setBusy(true);
      streaming.current = false;
      await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, images }),
      });
    },
    [conversationId]
  );

  const setModel = useCallback(
    async (value: string) => {
      // Optimista: el SSE confirma el valor real cuando el agente responde.
      setCurrentModel(value);
      await fetch(`/api/conversations/${conversationId}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    },
    [conversationId]
  );

  return { turns, busy, connected, phase, error, notice, usage, models, currentModel, setModel, send };
}
