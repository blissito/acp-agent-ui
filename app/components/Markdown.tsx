import { Streamdown } from "streamdown";

/** Markdown en streaming — tolera el bloque de código a medio cerrar. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none text-text-primary prose-pre:bg-background-secondary prose-code:text-[var(--color-inline-code)]">
      <Streamdown>{children}</Streamdown>
    </div>
  );
}
