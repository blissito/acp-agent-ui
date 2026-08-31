import { Coins, Gauge } from "lucide-react";

/** Tokens del turno, qué tanto del contexto se llevó y cuánto costó. */
export function MessageUsageStats({
  used,
  size,
  cost,
}: {
  used: number;
  size: number;
  cost: number;
}) {
  if (!used && !cost) return null;
  const pct = size > 0 ? Math.min(100, Math.round((used / size) * 100)) : 0;
  return (
    <div className="mt-2 flex items-center gap-4 text-[11px] text-text-tertiary">
      <span className="flex items-center gap-1">
        <Gauge className="h-3 w-3" />
        {used.toLocaleString("es-MX")}
        {size > 0 && ` / ${size.toLocaleString("es-MX")} (${pct}%)`}
      </span>
      {cost > 0 && (
        <span className="flex items-center gap-1">
          <Coins className="h-3 w-3" />
          {cost.toLocaleString("es-MX", {
            style: "currency",
            currency: "USD",
            maximumFractionDigits: 4,
          })}
        </span>
      )}
    </div>
  );
}
