import { Streamdown } from "streamdown";
import { LinkSafetyModal } from "./LinkSafetyModal";

/** Markdown en streaming — tolera el bloque de código a medio cerrar. */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none text-text-primary prose-headings:text-text-primary prose-strong:text-text-primary prose-a:text-text-info prose-pre:bg-background-secondary prose-code:text-[var(--color-inline-code)]">
      <Streamdown linkSafety={{ enabled: true, renderModal: (p) => <LinkSafetyModal {...p} /> }}>
        {children}
      </Streamdown>
    </div>
  );
}
