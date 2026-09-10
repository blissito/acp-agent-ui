/**
 * Extensiones — los servidores MCP que este Cliente le da al Agente.
 *
 * La pantalla enseña dos listas a propósito: arriba lo que declaramos
 * nosotros (nuestra base sqlite) y abajo lo que el Agente reporta como
 * conectado. Son dos verdades distintas y conviene verlas separadas.
 */
import { useState } from "react";
import { Puzzle, Trash2 } from "lucide-react";
import { useLoaderData } from "react-router";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { Switch } from "~/components/ui/switch";
import { listExtensions, type Extension, type Transport } from "~/.server/extensions";
import { listAgentExtensions } from "~/.server/acp";

export async function loader() {
  const reportadas = await listAgentExtensions();
  return { declaradas: listExtensions(), reportadas };
}

export default function Extensions() {
  const { declaradas, reportadas } = useLoaderData<typeof loader>();
  const [extensiones, setExtensiones] = useState<Extension[]>(declaradas);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);

  async function mutar(body: Record<string, unknown>) {
    setError(null);
    setAviso(null);
    const r = await fetch("/api/extensions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await r.json();
    if (!r.ok) return setError(json.error ?? "algo salió mal");
    setExtensiones(json.extensions);
    if (body.intent === "create" || body.intent === "toggle") {
      setAviso(
        json.enVivo
          ? "Conectada al hilo abierto: pregúntale al agente qué herramientas tiene."
          : "Entra en el próximo hilo que abras.",
      );
    }
  }

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">Extensiones</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Servidores MCP: procesos que le dan herramientas nuevas al agente. Los de{" "}
          <span className="font-mono text-xs">stdio</span> viven dentro de la caja y los lanza el
          agente; los de <span className="font-mono text-xs">http</span> viven en otro lado y sólo
          hace falta la URL.
        </p>

        <Formulario onCrear={(body) => mutar({ intent: "create", ...body })} />

        {error && (
          <p className="mt-4 rounded-xl border border-red-500/40 px-4 py-3 text-sm text-red-500">
            {error}
          </p>
        )}
        {aviso && (
          <p className="mt-4 rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
            {aviso}
          </p>
        )}

        <section className="mt-8">
          <h2 className="mb-3 text-xs uppercase tracking-wide text-text-tertiary">
            Declaradas aquí
          </h2>
          {extensiones.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-12 text-center">
              <Puzzle className="h-8 w-8 text-text-tertiary" />
              <p className="text-sm text-text-secondary">Todavía no has dado de alta ninguna.</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {extensiones.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center gap-3 rounded-xl border border-border-primary px-4 py-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm text-text-primary">{e.name}</span>
                    <span className="truncate font-mono text-[11px] text-text-tertiary">
                      {e.transport === "stdio"
                        ? [e.command, ...e.args].join(" ")
                        : e.url}
                    </span>
                  </div>
                  <Switch
                    checked={e.enabled}
                    onCheckedChange={(v) => void mutar({ intent: "toggle", id: e.id, enabled: v })}
                  />
                  <button
                    onClick={() => void mutar({ intent: "delete", id: e.id })}
                    className="text-text-tertiary transition-colors hover:text-red-500"
                    title="Quitar"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-text-tertiary">
            Quitar una de esta lista no la desconecta del hilo que ya la tiene: el agente la
            conserva hasta que ese hilo termine.
          </p>
        </section>

        <section className="mt-8">
          <h2 className="mb-3 text-xs uppercase tracking-wide text-text-tertiary">
            Lo que el agente reporta
          </h2>
          {reportadas.error ? (
            <p className="rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
              {reportadas.error}
            </p>
          ) : reportadas.extensions.length === 0 ? (
            <p className="rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
              Abre un hilo para que haya a quién preguntarle.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {reportadas.extensions.map((e) => (
                <li
                  key={e.name}
                  className="flex items-center justify-between gap-3 rounded-xl border border-border-primary px-4 py-3"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <span
                      className={
                        e.propia ? "text-sm text-text-primary" : "text-sm text-text-secondary"
                      }
                    >
                      {e.name}
                    </span>
                    <span className="truncate text-xs text-text-secondary">{e.description}</span>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
                    {e.propia ? "nuestra" : e.kind}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </MainPanelLayout>
  );
}

function Formulario({ onCrear }: { onCrear: (body: Record<string, unknown>) => void }) {
  const [transport, setTransport] = useState<Transport>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("/usr/local/bin/node");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");

  const campo =
    "w-full rounded-lg border border-border-primary bg-transparent px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-border-secondary";

  return (
    <div className="mt-6 flex flex-col gap-3 rounded-xl border border-border-primary p-4">
      <div className="flex gap-2">
        {(["stdio", "http"] as Transport[]).map((t) => (
          <button
            key={t}
            onClick={() => setTransport(t)}
            className={`rounded-lg px-3 py-1 font-mono text-xs transition-colors ${
              transport === t
                ? "bg-surface-secondary text-text-primary"
                : "text-text-tertiary hover:text-text-secondary"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <input
        className={campo}
        placeholder="nombre (así lo verá el agente)"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />

      {transport === "stdio" ? (
        <>
          <input
            className={`${campo} font-mono`}
            placeholder="/usr/local/bin/node"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <input
            className={`${campo} font-mono`}
            placeholder="/data/repo/mcp/hello.ts"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
          />
          <p className="text-xs text-text-tertiary">
            Ruta absoluta en los dos: quien lanza el proceso es el agente, dentro de su caja, y no
            hereda tu PATH.
          </p>
        </>
      ) : (
        <input
          className={`${campo} font-mono`}
          placeholder="https://…/api/mcp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      )}

      <button
        onClick={() => {
          onCrear({
            name,
            transport,
            command,
            args: args.split(" ").filter(Boolean),
            url,
          });
          setName("");
          setArgs("");
          setUrl("");
        }}
        disabled={!name}
        className="self-start rounded-lg bg-surface-secondary px-4 py-2 text-sm text-text-primary transition-opacity hover:opacity-80 disabled:opacity-40"
      >
        Dar de alta
      </button>
    </div>
  );
}
