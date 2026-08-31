import type { LucideIcon } from "lucide-react";
import { MainPanelLayout } from "~/components/Layout/MainPanelLayout";

/**
 * Vista de sección todavía sin datos. El Desktop las llena con endpoints HTTP
 * de goosed que este POC no consume; queda el encabezado y el estado vacío
 * dice exactamente qué falta en vez de fingir contenido.
 */
export function PlaceholderView({
  title,
  description,
  icon: Icon,
  pending,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  pending: string;
}) {
  return (
    <MainPanelLayout>
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="text-2xl font-light text-text-primary">{title}</h1>
        <p className="mt-1 text-sm text-text-secondary">{description}</p>

        <div className="mt-8 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-primary px-6 py-16 text-center">
          <Icon className="h-8 w-8 text-text-tertiary" />
          <p className="max-w-md text-sm text-text-secondary">{pending}</p>
        </div>
      </div>
    </MainPanelLayout>
  );
}
