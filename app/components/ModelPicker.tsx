import { Check, ChevronDown, Cpu } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import type { ModelOption } from "~/hooks/useAcpStream";

/**
 * El selector de modelo. ACP lo publica como una opción de configuración de la
 * sesión (categoría "model"); aquí lo pintamos como un dropdown discreto.
 */
export function ModelPicker({
  models,
  current,
  onChange,
}: {
  models: ModelOption[];
  current: string | null;
  onChange: (value: string) => void;
}) {
  if (models.length === 0) return null;
  const active = models.find((m) => m.value === current) ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex max-w-56 items-center gap-1.5 rounded-full border border-border-primary px-2.5 py-1 text-xs text-text-secondary transition-colors outline-none hover:bg-background-secondary hover:text-text-primary">
        <Cpu className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{active?.name ?? "Modelo"}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-52 overflow-y-auto">
        {models.map((m) => (
          <DropdownMenuItem
            key={m.value}
            onClick={() => onChange(m.value)}
            className="flex items-center justify-between gap-3"
          >
            <span className="truncate">{m.name}</span>
            {m.value === current && (
              <Check className="h-3.5 w-3.5 shrink-0 text-text-success" />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
