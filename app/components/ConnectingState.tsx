/**
 * Lo que ocupa el hilo mientras el agente todavía no contesta. Tres pasos
 * reales (despertar la caja, abrir el WSS, crear la sesión) en vez de un
 * "Conectando…" mudo: el que espera sabe en qué va y cuánto suele tardar.
 */
import { motion, AnimatePresence } from "motion/react";
import { Check } from "lucide-react";
import type { ConnectPhase } from "~/hooks/useAcpStream";

const STEPS: { phase: ConnectPhase; label: string; hint: string }[] = [
  { phase: "waking", label: "Despertando la caja", hint: "si estaba dormida, unos 15 s" },
  { phase: "connecting", label: "Abriendo el canal ACP", hint: "WebSocket seguro a su microVM" },
  { phase: "session", label: "Creando la sesión", hint: "el agente carga su contexto" },
];

export function ConnectingState({
  phase,
  error,
}: {
  phase: ConnectPhase;
  error: string | null;
}) {
  const current = STEPS.findIndex((s) => s.phase === phase);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.3 }}
      className="flex min-h-[50vh] flex-col items-center justify-center gap-8 text-center"
    >
      <div className="relative flex h-20 w-20 items-center justify-center">
        {!error &&
          [0, 1].map((i) => (
            <motion.span
              key={i}
              className="absolute inset-0 rounded-full border border-border-primary"
              initial={{ scale: 0.6, opacity: 0.8 }}
              animate={{ scale: 1.6, opacity: 0 }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut", delay: i * 1.1 }}
            />
          ))}
        <motion.img
          src="/favicon.png"
          alt=""
          className="h-12 w-12 rounded-full"
          animate={error ? { scale: 1, filter: "grayscale(1)" } : { scale: [1, 1.06, 1] }}
          transition={error ? { duration: 0.3 } : { duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <ol className="flex flex-col gap-3 text-left">
        {STEPS.map((step, i) => {
          const done = !error && i < current;
          const active = !error && i === current;
          const failed = !!error && i === current;
          return (
            <li key={step.phase} className="flex items-center gap-3">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  {done ? (
                    <motion.span
                      key="done"
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="flex h-5 w-5 items-center justify-center rounded-full bg-background-success"
                    >
                      <Check className="h-3 w-3 text-text-success" strokeWidth={3} />
                    </motion.span>
                  ) : active ? (
                    <motion.span
                      key="active"
                      className="h-2.5 w-2.5 rounded-full bg-text-primary"
                      animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }}
                      transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
                    />
                  ) : failed ? (
                    <span key="failed" className="h-2.5 w-2.5 rounded-full bg-text-danger" />
                  ) : (
                    <span key="idle" className="h-2 w-2 rounded-full bg-border-primary" />
                  )}
                </AnimatePresence>
              </span>
              <div className="leading-tight">
                <p
                  className={`text-sm ${
                    active || failed ? "text-text-primary" : done ? "text-text-secondary" : "text-text-tertiary"
                  }`}
                >
                  {step.label}
                  {active && (
                    <motion.span
                      className="inline-block w-4 text-left"
                      animate={{ opacity: [0, 1, 1, 0] }}
                      transition={{ duration: 1.4, repeat: Infinity, times: [0, 0.2, 0.8, 1] }}
                    >
                      …
                    </motion.span>
                  )}
                </p>
                {active && <p className="text-xs text-text-tertiary">{step.hint}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex max-w-md flex-col items-center gap-3"
          >
            <p className="text-sm text-text-danger">{error}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-full border border-border-primary px-4 py-1.5 text-sm text-text-primary hover:bg-background-secondary"
            >
              Reintentar
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
