import type { ReactNode } from "react";

/** La tarjeta que envuelve al input: borde suave y sombra, como en el Desktop. */
export function ChatInputCard({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border-primary bg-background-primary shadow-md transition-colors focus-within:border-border-secondary">
      {children}
    </div>
  );
}
