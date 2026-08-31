import { Link, useLoaderData } from "react-router";
import { History } from "lucide-react";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { listConversations } from "~/.server/acp";

export async function loader() {
  return { conversations: listConversations() };
}

const fecha = (ms: number) =>
  new Date(ms).toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });

export default function Sessions() {
  const { conversations } = useLoaderData<typeof loader>();

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">Historial</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Las conversaciones vivas de este servidor. No se persisten: un reinicio
          las borra.
        </p>

        {conversations.length === 0 ? (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-16 text-center">
            <History className="h-8 w-8 text-text-tertiary" />
            <p className="text-sm text-text-secondary">Todavía no hay ninguna.</p>
          </div>
        ) : (
          <ul className="mt-8 flex flex-col gap-2">
            {conversations.map((c) => (
              <li key={c.id}>
                <Link
                  to={`/c/${c.id}`}
                  className="flex flex-col gap-1 rounded-xl border border-border-primary px-4 py-3 transition-colors hover:bg-background-secondary"
                >
                  <span className="text-sm text-text-primary">{c.title}</span>
                  <span className="flex flex-wrap gap-3 text-xs text-text-tertiary">
                    <span>{fecha(c.updatedAt)}</span>
                    <span>{c.messageCount} mensajes</span>
                    <span>{c.tokens.toLocaleString("es-MX")} tokens</span>
                    {c.busy && <span className="text-text-success">respondiendo</span>}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </MainPanelLayout>
  );
}
