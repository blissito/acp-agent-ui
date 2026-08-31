/**
 * Estado del panel de navegación: si está abierto y qué tan ancho. Se guarda en
 * localStorage para que sobreviva a la recarga, pero el primer render (el del
 * servidor) siempre usa los valores por defecto.
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

const MIN_WIDTH = 180;
const MAX_WIDTH = 420;
const DEFAULT_WIDTH = 260;

interface NavigationContextValue {
  isNavExpanded: boolean;
  setIsNavExpanded: (v: boolean) => void;
  navWidth: number;
  setNavWidth: (v: number) => void;
}

const NavigationContext = createContext<NavigationContextValue | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const [isNavExpanded, setExpanded] = useState(true);
  const [navWidth, setWidth] = useState(DEFAULT_WIDTH);

  // Hidratamos la preferencia después del primer render para no romper el SSR.
  useEffect(() => {
    const storedWidth = Number(localStorage.getItem("nav_width"));
    if (storedWidth >= MIN_WIDTH && storedWidth <= MAX_WIDTH) setWidth(storedWidth);
    if (localStorage.getItem("nav_expanded") === "false") setExpanded(false);
  }, []);

  const setIsNavExpanded = (v: boolean) => {
    setExpanded(v);
    localStorage.setItem("nav_expanded", String(v));
  };

  const setNavWidth = (v: number) => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, v));
    setWidth(clamped);
    localStorage.setItem("nav_width", String(clamped));
  };

  return (
    <NavigationContext.Provider
      value={{ isNavExpanded, setIsNavExpanded, navWidth, setNavWidth }}
    >
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigationContext() {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigationContext fuera de NavigationProvider");
  return ctx;
}
