import { useEffect, useState } from "react";

/**
 * Debajo de este ancho el panel de navegación deja de empujar el contenido y
 * pasa a ser un cajón encima. Arranca en false para que el HTML del servidor
 * coincida con el primer render del cliente.
 */
export const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return isMobile;
}
