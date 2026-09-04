/**
 * Input del chat: textarea que crece, Enter envía y Shift+Enter hace salto de
 * línea. Con `withImages` acepta adjuntos (drag & drop o botón), muestra un
 * preview con object URL y NO convierte a base64 hasta darle a enviar.
 * Mientras el agente responde, el botón de enviar se vuelve el de parar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { cn } from "~/lib/utils";
import { ModelPicker } from "~/components/ModelPicker";
import type { ImagePayload, ModelOption } from "~/hooks/useAcpStream";

const MAX_HEIGHT = 240;
const MAX_IMAGES = 4;
const MAX_FILE_MB = 10;

interface Adjunto {
  id: number;
  file: File;
  url: string; // object URL, sólo para el preview
}

function leerComoImagen(file: File): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const result = String(fr.result); // data:image/png;base64,XXXX
      const comma = result.indexOf(",");
      resolve({
        mimeType: file.type || "image/png",
        data: comma === -1 ? result : result.slice(comma + 1),
      });
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

export function ChatInput({
  onSubmit,
  onStop,
  busy = false,
  autoFocus = true,
  placeholder = "Pídele algo al agente…",
  workingDir,
  withImages = false,
  models = [],
  currentModel = null,
  onModelChange,
}: {
  onSubmit: (text: string, images?: ImagePayload[]) => void;
  onStop?: () => void;
  busy?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  workingDir?: string;
  withImages?: boolean;
  models?: ModelOption[];
  currentModel?: string | null;
  onModelChange?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [adjuntos, setAdjuntos] = useState<Adjunto[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(0);
  const urlsRef = useRef(new Set<string>());

  const liberarUrl = (url: string) => {
    urlsRef.current.delete(url);
    URL.revokeObjectURL(url);
  };

  // rAF es más confiable que autoFocus cuando el render cruza una frontera async.
  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  // Las object URLs del preview se liberan al desmontar (por si quedan adjuntas).
  useEffect(() => {
    return () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
      urlsRef.current.clear();
    };
  }, []);

  // Crece con el contenido. Vacío se queda en su altura de una línea: dejarlo
  // en `auto` dentro del flex lo estira a lo alto de la tarjeta.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!value) {
      el.style.height = "";
      return;
    }
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const agregarArchivos = useCallback((files: FileList | File[]) => {
    if (busy) return;
    setAdjuntos((prev) => {
      const nuevos = [...prev];
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) continue;
        if (file.size > MAX_FILE_MB * 1024 * 1024) continue;
        if (nuevos.length >= MAX_IMAGES) break;
        const url = URL.createObjectURL(file);
        urlsRef.current.add(url);
        nuevos.push({ id: ++nextId.current, file, url });
      }
      return nuevos;
    });
  }, [busy]);

  const quitarAdjunto = (id: number) => {
    setAdjuntos((prev) => {
      const salir = prev.find((a) => a.id === id);
      if (salir) liberarUrl(salir.url);
      return prev.filter((a) => a.id !== id);
    });
  };

  const submit = async () => {
    const text = value.trim();
    if ((!text && adjuntos.length === 0) || busy) return;
    // Sólo aquí se lee a base64: los previews vivían de object URLs.
    const images = adjuntos.length
      ? await Promise.all(adjuntos.map((a) => leerComoImagen(a.file)))
      : undefined;
    onSubmit(text, images);
    setValue("");
    for (const a of adjuntos) liberarUrl(a.url);
    setAdjuntos([]);
  };

  const puedeEnviar = Boolean(value.trim() || adjuntos.length > 0);

  return (
    <div
      onDragOver={
        withImages
          ? (e) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }
          : undefined
      }
      onDragLeave={
        withImages
          ? (e) => {
              // Ignora salir hacia un hijo: evita el parpadeo al pasar por encima.
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
            }
          : undefined
      }
      onDrop={
        withImages
          ? (e) => {
              e.preventDefault();
              setDragging(false);
              agregarArchivos(e.dataTransfer.files);
            }
          : undefined
      }
      className={cn(
        "flex flex-col gap-2 p-3 transition-shadow",
        withImages && dragging &&
          "rounded-2xl ring-2 ring-inset ring-ring-info bg-background-secondary/40"
      )}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) agregarArchivos(e.target.files);
          e.target.value = "";
        }}
      />

      {withImages && adjuntos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {adjuntos.map((a) => (
            <div
              key={a.id}
              className="relative h-16 w-16 overflow-hidden rounded-lg border border-border-primary bg-background-secondary"
            >
              <img src={a.url} alt="adjunto" className="h-full w-full object-cover" />
              <button
                type="button"
                onClick={() => quitarAdjunto(a.id)}
                aria-label="Quitar imagen"
                className="absolute top-0.5 right-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-background-inverse/80 text-text-inverse shadow-sm transition-colors hover:bg-background-inverse"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={ref}
        rows={1}
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        className="max-h-60 min-h-[24px] w-full flex-none resize-none overflow-y-auto bg-transparent px-1 text-sm leading-6 text-text-primary outline-none placeholder:text-text-tertiary"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {withImages && (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy || adjuntos.length >= MAX_IMAGES}
              aria-label="Adjuntar imagen"
              title="Adjuntar imagen"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-background-secondary hover:text-text-primary disabled:opacity-40"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          )}
          {models.length > 0 && onModelChange ? (
            <ModelPicker models={models} current={currentModel} onChange={onModelChange} />
          ) : (
            <span className="truncate font-mono text-[11px] text-text-tertiary">
              {/*workingDir*/}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={busy ? onStop : () => void submit()}
          disabled={!busy && !puedeEnviar}
          aria-label={busy ? "Detener" : "Enviar"}
          className={cn(
            "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
            busy || puedeEnviar
              ? "bg-background-inverse text-text-inverse"
              : "bg-background-disabled text-text-disabled"
          )}
        >
          {busy ? <Square className="h-3 w-3 fill-current" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}
