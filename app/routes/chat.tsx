/**
 * La conversación. El loader entrega los mensajes ya ocurridos (por si
 * recargas), y de ahí en adelante el hilo lo alimenta el SSE.
 */
import { useEffect, useRef } from "react";
import { useLocation, useLoaderData } from "react-router";
import type { Route } from "./+types/chat";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ChatInputCard } from "~/components/ChatInputCard";
import { ChatInput } from "~/components/ChatInput";
import { Markdown } from "~/components/Markdown";
import { MessageUsageStats } from "~/components/MessageUsageStats";
import { useAcpStream, type ToolEntry, type Turn } from "~/hooks/useAcpStream";
import { config, getConversation, getMessages } from "~/.server/acp";

export async function loader({ params }: Route.LoaderArgs) {
  const conversation = getConversation(params.id);
  if (!conversation) {
    throw new Response("Esa conversación ya no existe", { status: 404 });
  }
  return {
    id: params.id,
    cwd: config.cwd,
    title: conversation.title,
    messages: getMessages(params.id).map((m) => ({ role: m.role, text: m.text })),
  };
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-background-inverse px-4 py-2.5 text-sm text-text-inverse">
          {turn.text}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[90%]">
      {turn.thought && (
        <details className="mb-3 text-xs text-text-secondary">
          <summary className="cursor-pointer select-none">Pensando…</summary>
          <p className="mt-2 whitespace-pre-wrap border-l-2 border-border-secondary pl-3">
            {turn.thought}
          </p>
        </details>
      )}
      {turn.tools && turn.tools.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1">
          {turn.tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </ul>
      )}
      {turn.text && <Markdown>{turn.text}</Markdown>}
      {turn.usage && <MessageUsageStats {...turn.usage} />}
    </div>
  );
}

// Una herramienta del agente, con su estado según ACP:
// pending → in_progress → completed | failed.
const STATUS_ICON: Record<string, string> = {
  pending: "⏳",
  in_progress: "●",
  completed: "✓",
  failed: "✗",
};

function ToolRow({ tool }: { tool: ToolEntry }) {
  const status = tool.status ?? "pending";
  const color =
    status === "failed"
      ? "text-text-danger"
      : status === "completed"
        ? "text-text-success"
        : "text-text-warning";
  return (
    <li className="flex min-w-0 items-baseline gap-2 text-xs">
      <span className={`shrink-0 ${color}`} aria-label={status}>
        {STATUS_ICON[status] ?? "•"}
      </span>
      {tool.kind && (
        <span className="shrink-0 rounded bg-background-secondary px-1 font-mono text-text-secondary">
          {tool.kind}
        </span>
      )}
      <span className="min-w-0 truncate text-text-primary">{tool.title ?? tool.id}</span>
      {tool.path && (
        <span className="hidden min-w-0 truncate font-mono text-text-tertiary sm:inline">
          {tool.path}
        </span>
      )}
    </li>
  );
}

export default function Chat() {
  const { id, cwd, messages } = useLoaderData<typeof loader>();
  const location = useLocation();
  const firstMessage = (location.state as { firstMessage?: string } | null)?.firstMessage;
  const { turns, busy, connected, error, send } = useAcpStream(
    id,
    messages as Turn[]
  );
  const sentFirst = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  // El primer mensaje viene del Hub; se manda una sola vez y en cuanto el
  // agente terminó de conectarse.
  useEffect(() => {
    if (!firstMessage || sentFirst.current || !connected) return;
    sentFirst.current = true;
    void send(firstMessage);
  }, [firstMessage, connected, send]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
            {turns.map((turn, i) => (
              <Bubble key={i} turn={turn} />
            ))}

            {busy && turns[turns.length - 1]?.role === "user" && (
              <div className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
            )}
            {error && <p className="text-sm text-text-danger">{error}</p>}
            <div ref={bottom} />
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6 sm:pb-6">
          <ChatInputCard>
            <ChatInput
              onSubmit={send}
              busy={busy}
              workingDir={cwd}
              placeholder={connected ? "Sigue la conversación…" : "Conectando con el agente…"}
            />
          </ChatInputCard>
        </div>
      </div>
    </MainPanelLayout>
  );
}
