/**
 * El aviso de enlace externo, en la lengua y el tema de la casa.
 *
 * Streamdown trae el suyo, pero llega en inglés y en claro: sobre el chat
 * oscuro parecía de otra aplicación.
 */
import { Check, ExternalLink, X } from "lucide-react";
import { useState } from "react";
import type { LinkSafetyModalProps } from "streamdown";

export function LinkSafetyModal({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  const [copiado, setCopiado] = useState(false);
  if (!isOpen) return null;

  const copiar = async () => {
    await navigator.clipboard?.writeText(url).catch(() => {});
    setCopiado(true);
    setTimeout(() => setCopiado(false), 1500);
  };

  // Streamdown monta esto en un portal, fuera del árbol que lleva `.dark`: sin
  // la clase, el modal salía en claro sobre el chat oscuro.
  const abrir = () => {
    window.open(url, "_blank", "noopener,noreferrer");
    onConfirm();
  };

  return (
    <div
      className="dark fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border-primary bg-background-primary p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Salir a un sitio externo"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="flex items-center gap-2 text-base text-text-primary">
            <ExternalLink className="h-4 w-4 text-text-secondary" />
            Vas a salir de aquí
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="text-text-secondary transition hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* La URL entera y partible: el peligro de un enlace está en el dominio,
            y un dominio cortado no se puede juzgar. */}
        <p className="mt-4 break-all rounded-xl border border-border-primary bg-background-secondary px-3 py-2.5 font-mono text-xs text-text-primary">
          {url}
        </p>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={copiar}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-border-primary bg-background-secondary px-4 py-2 text-sm text-text-primary transition hover:border-text-tertiary"
          >
            {copiado ? (
              <>
                <Check className="h-4 w-4 text-text-success" />
                Copiado
              </>
            ) : (
              "Copiar"
            )}
          </button>
          <button
            type="button"
            onClick={abrir}
            className="flex-1 rounded-xl bg-text-primary px-4 py-2 text-sm text-text-inverse transition hover:opacity-90"
          >
            Abrir
          </button>
        </div>
      </div>
    </div>
  );
}
