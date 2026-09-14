/**
 * La conversación. El loader entrega los mensajes ya ocurridos (por si
 * recargas), y de ahí en adelante el hilo lo alimenta el SSE.
 */
import { useEffect, useRef, useState } from "react";
import { Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/chat";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { ChatInputCard } from "~/components/ChatInputCard";
import { ChatInput } from "~/components/ChatInput";
import { Markdown } from "~/components/Markdown";
import { MessageUsageStats } from "~/components/MessageUsageStats";
import {
  Braces,
  CircleCheck,
  CircleSlash,
  CircleX,
  Clock,
  Code,
  FilePenLine,
  ArrowDown,
  FileText,
  Folder,
  Globe,
  ListChecks,
  Loader2,
  MessageCircle,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { ConnectingState } from "~/components/ConnectingState";
import { useAcpStream, type ConnectPhase, type ToolEntry, type Turn } from "~/hooks/useAcpStream";
import { abrirHilo, config, getMessages } from "~/.server/acp";

const plano = (m: {
  role: "user" | "assistant";
  text: string;
  images?: any[];
  tools?: any[];
  via?: "web" | "whatsapp";
  from?: string;
}) => ({
  role: m.role,
  text: m.text,
  images: m.images,
  tools: m.tools,
  via: m.via,
  from: m.from,
});

export async function loader({ params }: Route.LoaderArgs) {
  // Abrir un hilo es cerrar el anterior y cargar éste: hay una sola sesión
  // viva, así que leerlo y seguirlo son la misma cosa.
  try {
    const s = await abrirHilo(params.id);
    const id = s.sessionId ?? params.id;
    // El agente le acaba de dar un id al hilo nuevo: la URL pasa a ser ésa.
    if (params.id !== id) throw redirect(`/c/${id}`);
    return {
      id,
      cwd: config.cwd,
      title: s.title,
      messages: getMessages(id).map(plano),
      // Si el agente sigue escribiendo, el navegador tiene que sumar lo que
      // llegue al último mensaje en vez de abrir otro: si no, la respuesta se
      // parte en dos y parece que llegó fuera de orden.
      enVuelo: s.busy,
      error: null as string | null,
    };
  } catch (e) {
    if (e instanceof Response) throw e;
    return {
      id: params.id,
      cwd: config.cwd,
      title: "No pude abrir el hilo",
      messages: [],
      enVuelo: false,
      error: (e as Error).message,
    };
  }
}

function Bubble({ turn }: { turn: Turn }) {
  if (turn.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1">
        {turn.via === "whatsapp" && (
          <span className="flex items-center gap-1 text-[11px] text-text-secondary">
            <MessageCircle className="h-3 w-3" /> WhatsApp{turn.from ? ` · ${turn.from}` : ""}
          </span>
        )}
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
      {turn.images && turn.images.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {turn.images.map((im, i) => (
            <img
              key={i}
              src={`data:${im.mimeType};base64,${im.data}`}
              alt=""
              className="max-h-80 max-w-full rounded-xl border border-border-primary object-contain"
            />
          ))}
        </div>
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
  // El turno acabó sin que el agente dijera cómo terminó esta herramienta.
  cancelled: { Icon: CircleSlash, className: "text-text-tertiary", label: "Sin cerrar" },
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

const ESPERA: Record<ConnectPhase, string> = {
  waking: "despertando la caja",
  connecting: "abriendo el canal ACP",
  session: "creando la sesión",
};

function WaitLabel({ phase }: { phase: ConnectPhase }) {
  const [segundos, setSegundos] = useState(0);
  // Lo que ya pasó, con su duración: distingue una caja dormida (waking largo)
  // de un modelo lento (session largo).
  const [hechos, setHechos] = useState<{ phase: ConnectPhase; secs: number }[]>([]);
  const anterior = useRef<{ phase: ConnectPhase; t0: number } | null>(null);

  useEffect(() => {
    const previo = anterior.current;
    if (previo && previo.phase !== phase) {
      const secs = Math.round((Date.now() - previo.t0) / 1000);
      setHechos((h) => [...h, { phase: previo.phase, secs }]);
    }
    anterior.current = { phase, t0: Date.now() };
    setSegundos(0);
    const t = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const que = phase === "session" ? "el agente está pensando" : ESPERA[phase];

  return (
    <div className="flex flex-col gap-0.5 text-xs text-text-tertiary">
      {hechos.map((h, i) => (
        <p key={i} className="opacity-60">
          ✓ {ESPERA[h.phase]} · {h.secs}s
        </p>
      ))}
      <p>
        {que} · {segundos}s
      </p>
    </div>
  );
}

export default function Chat() {
  const { id, error } = useLoaderData<typeof loader>();
  // Si el hilo no se pudo abrir no hay nada que transmitir: montar el chat sólo
  // sirve para que el stream falle aparte y se vea un segundo error encima.
  if (error) return <HiloNoDisponible mensaje={error} />;
  return <ChatView key={id} />;
}

function HiloNoDisponible({ mensaje }: { mensaje: string }) {
  return (
    <MainPanelLayout>
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="text-lg text-text-primary">Ese hilo no está en la caja</p>
        <p className="max-w-md text-sm text-text-secondary">{mensaje}</p>
        <Link
          to="/sessions"
          className="rounded-full border border-border-primary px-4 py-1.5 text-sm text-text-secondary transition-colors hover:bg-background-secondary hover:text-text-primary"
        >
          Ver el historial
        </Link>
      </div>
    </MainPanelLayout>
  );
}

function ChatView() {
  const { id, cwd, messages, enVuelo, error: loadError } = useLoaderData<typeof loader>();
  const { turns, busy, connected, phase, error, notice, send, stop, models, currentModel, setModel } = useAcpStream(
    id,
    messages as Turn[],
    { enVuelo }
  );
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [abajo, setAbajo] = useState(true);

  const irAbajo = () =>
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });

  // El primer mensaje ya no se reenvía desde aquí: el hub lo manda en el mismo
  // POST que crea la conversación, así que llega al loader como un mensaje más
  // y se pinta en el primer render. De paso, ya no hay forma de duplicarlo.

  useEffect(() => {
    if (abajo) irAbajo();
  }, [turns, abajo]);

  // "Abajo" con holgura: a menos de 80 px del final cuenta como estar al día.
  const alScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setAbajo(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 flex-col">
        <div ref={scroller} onScroll={alScroll} className="relative min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
            {!connected && turns.length === 0 && (
              <ConnectingState phase={phase} error={error} />
            )}
            {loadError && (
              <p className="rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
                {loadError}
              </p>
            )}
            {turns.map((turn, i) => (
              <Bubble key={i} turn={turn} />
            ))}

            {busy && turns[turns.length - 1]?.role === "user" && (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-1">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1.5 w-1.5 animate-pulse rounded-full bg-text-tertiary"
                      style={{ animationDelay: `${i * 150}ms` }}
                    />
                  ))}
                </div>
                <WaitLabel phase={phase} />
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

        <div className="relative mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6 sm:pb-6">
          {!abajo && (
            <button
              type="button"
              onClick={irAbajo}
              aria-label="Ir al último mensaje"
              className="absolute -top-12 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border-primary bg-background-secondary text-text-secondary shadow-lg transition hover:text-text-primary"
            >
              <ArrowDown className="h-4 w-4" />
            </button>
          )}
          <ChatInputCard>
            <ChatInput
              onSubmit={send}
              onStop={() => void stop()}
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
