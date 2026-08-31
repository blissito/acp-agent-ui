import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAcpClient } from "use-acp";
import { Streamdown } from "streamdown";
import { Send, Loader2, Wrench, ShieldAlert, ShieldCheck, Circle } from "lucide-react";

// URL del agente (goose serve en la caja EasyBits). El navegador habla con el
// proxy de Vite (ws://localhost:5173/acp) porque el edge negocia h2 y goose no
// soporta upgrade WebSocket sobre h2. Vite reenvía por HTTP/1.1.
const WS_URL = "ws://localhost:5173/acp";

export default function App() {
  const {
    connectionState,
    agent,
    activeSessionId,
    notifications,
    pendingPermission,
    resolvePermission,
  } = useAcpClient({ wsUrl: WS_URL, autoConnect: true });

  const [input, setInput] = useState("");
  const [sessionReady, setSessionReady] = useState(false);
  const started = useRef(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);

  // Crear la sesión ACP una vez conectados (use-acp solo conecta, no crea sesión).
  useEffect(() => {
    if (started.current) return;
    if (connectionState.status === "connected" && agent) {
      started.current = true;
      agent
        .newSession({ cwd: "/root", mcpServers: [] })
        .then(() => setSessionReady(true))
        .catch((e) => console.error("newSession", e));
    }
  }, [connectionState.status, agent]);

  // Foco en el input al arrancar.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Auto-scroll.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [notifications, pendingPermission]);

  // ── Convertir notificaciones ACP en mensajes de chat ──────────────────────
  // goose manda agent_thought_chunk (razonamiento) y agent_message_chunk
  // (respuesta) como streams separados. El SDK de use-acp (0.4.9) DESCARTA el
  // messageId al validar (su schema no lo incluye → zod lo borra). Por eso NO
  // agrupamos por messageId: agrupamos chunks CONSECUTIVOS del mismo rol.
  const messages = useMemo(() => {
    const out = [];
    let cur = null; // { role, text }

    const flush = () => {
      if (cur && cur.text) out.push({ ...cur, key: `${cur.role}:${out.length}` });
      cur = null;
    };
    const begin = (role) => {
      if (cur && cur.role !== role) flush();
      if (!cur) cur = { role, text: "" };
    };

    for (const n of notifications) {
      if (n.type !== "session_notification") continue;
      const u = n.data?.update;
      if (!u) continue;

      switch (u.sessionUpdate) {
        case "agent_message_chunk": {
          begin("agent");
          cur.text += u.content?.text ?? "";
          break;
        }
        case "agent_thought_chunk": {
          begin("think");
          cur.text += u.content?.text ?? "";
          break;
        }
        case "user_message_chunk": {
          flush();
          out.push({ key: `user:${out.length}`, role: "user", text: u.content?.text ?? "" });
          break;
        }
        case "tool_call": {
          flush();
          out.push({ key: `tool:${out.length}`, role: "tool", text: u.title ?? "herramienta", status: u.status });
          break;
        }
        case "usage_update": {
          flush();
          out.push({ key: `usage:${out.length}`, role: "usage", used: u.used, size: u.size, cost: u.cost?.amount });
          break;
        }
        default:
          break;
      }
    }
    flush(); // empujar el último bloque en `cur` (sin esto, la respuesta se pierde)
    return out;
  }, [notifications]);

  const status = connectionState.status;
  const canSend = sessionReady && status === "connected" && !pendingPermission;

  async function send() {
    const text = input.trim();
    if (!text || !canSend || !activeSessionId) return;
    setInput("");
    try {
      await agent.prompt({ sessionId: activeSessionId, prompt: [{ type: "text", text }] });
    } catch (e) {
      console.error("prompt", e);
    }
    inputRef.current?.focus();
  }

  const allowOnce = () => resolvePermission({ outcome: { outcome: "selected", optionId: "allow_once" } });
  const allowAlways = () => resolvePermission({ outcome: { outcome: "selected", optionId: "allow_always" } });
  const rejectOnce = () => resolvePermission({ outcome: { outcome: "selected", optionId: "reject_once" } });

  return (
    <div className="flex h-dvh flex-col bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
        <span className="font-semibold">Gansito</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-zinc-400">
          <Circle className={`h-2 w-2 ${status === "connected" ? "fill-emerald-400 text-emerald-400" : status === "connecting" ? "fill-amber-400 text-amber-400" : "fill-red-400 text-red-400"}`} />
          {status}
        </span>
      </header>

      <main ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <p className="pt-10 text-center text-sm text-zinc-500">
            {status === "connecting" ? "Conectando con el agente…" : "Escribe tu primer mensaje."}
          </p>
        )}

        {messages.map((m) => {
          if (m.role === "user") {
            return (
              <div key={m.key} className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2 text-sm">{m.text}</div>
              </div>
            );
          }
          if (m.role === "think") {
            return (
              <details key={m.key} className="group text-xs text-zinc-500">
                <summary className="cursor-pointer select-none hover:text-zinc-400">🧠 razonamiento</summary>
                <div className="mt-1 whitespace-pre-wrap border-l-2 border-zinc-700 pl-2 text-zinc-500">{m.text}</div>
              </details>
            );
          }
          if (m.role === "tool") {
            return (
              <div key={m.key} className="flex items-center gap-2 text-xs text-amber-300/90">
                <Wrench className="h-3.5 w-3.5" />
                <span>{m.text}</span>
                {m.status && <span className="text-zinc-500">· {m.status}</span>}
              </div>
            );
          }
          if (m.role === "usage") {
            return (
              <div key={m.key} className="text-right text-[11px] text-zinc-500">
                {m.used?.toLocaleString()} / {m.size?.toLocaleString()} tokens
                {m.cost != null && <> · ${Number(m.cost).toFixed(6)}</>}
              </div>
            );
          }
          // agent (respuesta visible)
          return (
            <div key={m.key} className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-zinc-800 bg-zinc-900 px-4 py-2 text-sm">
                <div className="[&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-zinc-950 [&_pre]:p-3 [&_pre]:text-xs [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_table]:w-full [&_th]:border [&_th]:border-zinc-700 [&_th]:px-2 [&_td]:border [&_td]:border-zinc-700 [&_td]:px-2">
                  <Streamdown>{m.text}</Streamdown>
                </div>
              </div>
            </div>
          );
        })}

        {pendingPermission && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            <div className="mb-2 flex items-center gap-2 font-medium text-amber-300">
              <ShieldAlert className="h-4 w-4" /> Permiso requerido
            </div>
            <div className="mb-3 text-zinc-300">
              {pendingPermission.options?.map((o) => o.name).join(" · ") || "El agente pide permiso para usar una herramienta."}
            </div>
            <div className="flex gap-2">
              <button onClick={allowOnce} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium hover:bg-emerald-500">
                <ShieldCheck className="mr-1 inline h-3.5 w-3.5" /> Permitir una vez
              </button>
              <button onClick={allowAlways} className="rounded-lg bg-emerald-800 px-3 py-1.5 text-xs font-medium hover:bg-emerald-700">
                Permitir siempre
              </button>
              <button onClick={rejectOnce} className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-medium hover:bg-zinc-600">
                Rechazar
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="border-t border-zinc-800 p-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder={sessionReady ? "Escribe tu mensaje…" : "Conectando…"}
            disabled={!canSend}
            className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-blue-500 disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={!canSend}
            className="flex items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
          >
            {status === "connecting" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Enviar
          </button>
        </div>
      </footer>
    </div>
  );
}
