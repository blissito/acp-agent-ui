/**
 * Consume el SSE de una conversación y arma el hilo de mensajes. Todo el ACP
 * ocurre del lado del servidor; aquí sólo llegan eventos ya traducidos.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface Turn {
  role: "user" | "assistant";
  text: string;
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
  const [tools, setTools] = useState<string[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const streaming = useRef(false);

  useEffect(() => {
    const es = new EventSource(`/api/conversations/${conversationId}/events`);

    const appendChunk = (text: string) => {
      setTurns((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (streaming.current && last?.role === "assistant") {
          next[next.length - 1] = { ...last, text: last.text + text };
          return next;
        }
        streaming.current = true;
        return [...next, { role: "assistant", text }];
      });
    };

    es.addEventListener("started", () => setConnected(true));
    es.addEventListener("chunk", (e) => appendChunk(JSON.parse((e as MessageEvent).data).text));
    es.addEventListener("tool", (e) => {
      const { title } = JSON.parse((e as MessageEvent).data);
      setTools((prev) => [...prev, title]);
    });
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
      setTools([]);
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

  return { turns, busy, connected, error, tools, usage, send };
}
