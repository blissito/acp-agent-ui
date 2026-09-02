/**
 * Consume el SSE de una conversación y arma el hilo de mensajes. Todo el ACP
 * ocurre del lado del servidor; aquí sólo llegan eventos ya traducidos.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Por dónde va la conexión con el agente antes del primer `started`. */
export type ConnectPhase = "waking" | "connecting" | "session";

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
  const [phase, setPhase] = useState<ConnectPhase>("waking");
  const [usage, setUsage] = useState<Usage | null>(null);
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
    async (text: string) => {
      setTurns((prev) => [...prev, { role: "user", text }]);
      setBusy(true);
      streaming.current = false;
      await fetch(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    },
    [conversationId]
  );

  return { turns, busy, connected, phase, error, usage, send };
}
