/**
 * La conversación. El loader entrega los mensajes ya ocurridos (por si
 * recargas), y de ahí en adelante el hilo lo alimenta el SSE.
 */
import { useEffect, useRef } from "react";
import { useLoaderData } from "react-router";
import type { Route } from "./+types/chat";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ChatInputCard } from "~/components/ChatInputCard";
import { ChatInput } from "~/components/ChatInput";
import { Markdown } from "~/components/Markdown";
import { MessageUsageStats } from "~/components/MessageUsageStats";
import {
  Braces,
  CircleCheck,
  CircleX,
  Clock,
  Code,
  FilePenLine,
  FileText,
  Folder,
  Globe,
  ListChecks,
  Loader2,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { ConnectingState } from "~/components/ConnectingState";
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
    messages: getMessages(params.id).map((m) => ({
      role: m.role,
      text: m.text,
      images: m.images,
    })),
  };
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-background-inverse px-4 py-2.5 text-sm text-text-inverse">
          {turn.images && turn.images.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              {turn.images.map((im, i) => (
                <img
                  key={i}
                  src={`data:${im.mimeType};base64,${im.data}`}
                  alt=""
                  className="h-20 w-20 rounded-lg object-cover"
                />
              ))}
            </div>
          )}
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
const STATUS: Record<string, { Icon: LucideIcon; className: string; label: string }> = {
  pending: { Icon: Clock, className: "text-text-tertiary", label: "Pendiente" },
  in_progress: { Icon: Loader2, className: "animate-spin text-text-info", label: "Ejecutando" },
  completed: { Icon: CircleCheck, className: "text-text-success", label: "Lista" },
  failed: { Icon: CircleX, className: "text-text-danger", label: "Falló" },
};

// Un icono por tipo de herramienta; lo desconocido cae en la llave inglesa.
const KIND_ICON: Record<string, LucideIcon> = {
  bash: Terminal,
  shell: Terminal,
  terminal: Terminal,
  read: FileText,
  read_file: FileText,
  write: FilePenLine,
  write_file: FilePenLine,
  edit: FilePenLine,
  edit_file: FilePenLine,
  grep: Search,
  glob: Search,
  search: Search,
  web_search: Globe,
  web_fetch: Globe,
  browser: Globe,
  todo: ListChecks,
  list: ListChecks,
  code: Code,
  script: Code,
  folder: Folder,
  mcp: Braces,
};

function ToolRow({ tool }: { tool: ToolEntry }) {
  const status = tool.status ?? "pending";
  const s = STATUS[status] ?? STATUS.pending;
  const StatusIcon = s.Icon;
  const KindIcon = tool.kind ? (KIND_ICON[tool.kind] ?? Wrench) : Wrench;
  return (
    <li className="flex items-start gap-2.5 rounded-lg border border-border-secondary bg-background-secondary/50 px-3 py-2 transition-colors hover:border-border-primary hover:bg-background-secondary">
      <span className="mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-background-primary text-text-secondary shadow-sm">
        <KindIcon className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {tool.kind && (
            <span className="shrink-0 font-mono text-[10px] font-medium tracking-wide text-text-tertiary uppercase">
              {tool.kind}
            </span>
          )}
          <span className="min-w-0 truncate text-xs font-medium text-text-primary">
            {tool.title ?? tool.id}
          </span>
        </span>
        {tool.path && (
          <span className="mt-0.5 block truncate font-mono text-[10px] text-text-tertiary">
            {tool.path}
          </span>
        )}
      </span>
      <span className="mt-0.5 shrink-0" title={s.label} aria-label={s.label}>
        <StatusIcon className={`h-3.5 w-3.5 ${s.className}`} />
      </span>
    </li>
  );
}

// Cada conversación necesita su propio estado: sin la key, React reusa la
// instancia al navegar entre /c/:id y el hilo anterior se queda pegado.
export default function Chat() {
  const { id } = useLoaderData<typeof loader>();
  return <ChatView key={id} />;
}

function ChatView() {
  const { id, cwd, messages } = useLoaderData<typeof loader>();
  const { turns, busy, connected, phase, error, notice, send, models, currentModel, setModel } = useAcpStream(
    id,
    messages as Turn[]
  );
  const bottom = useRef<HTMLDivElement>(null);

  // El primer mensaje ya no se reenvía desde aquí: el hub lo manda en el mismo
  // POST que crea la conversación, así que llega al loader como un mensaje más
  // y se pinta en el primer render. De paso, ya no hay forma de duplicarlo.

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
            {!connected && turns.length === 0 && (
              <ConnectingState phase={phase} error={error} />
            )}
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
            {notice && (
              <p className="text-sm text-text-tertiary">{notice}</p>
            )}
            {error && (connected || turns.length > 0) && (
              <p className="text-sm text-text-danger">{error}</p>
            )}
            <div ref={bottom} />
          </div>
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6 sm:pb-6">
          <ChatInputCard>
            <ChatInput
              onSubmit={send}
              busy={busy}
              workingDir={cwd}
              withImages
              models={models}
              currentModel={currentModel}
              onModelChange={setModel}
              placeholder={connected ? "Sigue la conversación…" : "Conectando con el agente…"}
            />
          </ChatInputCard>
        </div>
      </div>
    </MainPanelLayout>
  );
}
