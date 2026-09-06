/**
 * Habilidades — la memoria procedimental del agente, tal como él la ve.
 *
 * No hay método ACP para esto, así que se le pregunta a la caja con el CLI del
 * propio agente: lo que sale aquí es literalmente lo que él carga.
 */
import { Zap } from "lucide-react";
import { useLoaderData } from "react-router";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";
import { listSkills } from "~/.server/acp";

export async function loader() {
  return await listSkills();
}

export default function Skills() {
  const { skills, error } = useLoaderData<typeof loader>();
  const delRepo = skills.filter((s) => s.delProyecto);
  const deFabrica = skills.filter((s) => !s.delProyecto);

  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">Habilidades</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Instrucciones que el agente carga bajo demanda. Las del proyecto viven en el repo y llegan
          a la caja con el código: si la caja muere, vuelven solas.
        </p>

        {error && (
          <p className="mt-6 rounded-xl border border-border-primary px-4 py-3 text-sm text-text-secondary">
            {error}
          </p>
        )}

        {!error && skills.length === 0 && (
          <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-16 text-center">
            <Zap className="h-8 w-8 text-text-tertiary" />
            <p className="text-sm text-text-secondary">El agente no carga ninguna.</p>
          </div>
        )}

        {delRepo.length > 0 && <Grupo titulo="Del proyecto" skills={delRepo} />}
        {deFabrica.length > 0 && <Grupo titulo="De fábrica" skills={deFabrica} apagado />}
      </div>
    </MainPanelLayout>
  );
}

function Grupo({
  titulo,
  skills,
  apagado,
}: {
  titulo: string;
  skills: { name: string; description: string; location: string }[];
  apagado?: boolean;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 text-xs uppercase tracking-wide text-text-tertiary">{titulo}</h2>
      <ul className="flex flex-col gap-2">
        {skills.map((s) => (
          <li
            key={s.location}
            className="flex flex-col gap-1 rounded-xl border border-border-primary px-4 py-3"
          >
            <span className={apagado ? "text-sm text-text-secondary" : "text-sm text-text-primary"}>
              {s.name}
            </span>
            <span className="text-xs text-text-secondary">{s.description}</span>
            <span className="font-mono text-[11px] text-text-tertiary">{s.location}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
