/**
 * Cascarón de la app.
 *
 * En pantalla ancha el panel de navegación empuja al contenido, como en el
 * Desktop. En móvil no cabe: ahí se vuelve un cajón que flota encima, arranca
 * cerrado y se cierra al navegar o al tocar el velo.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router";
import { AnimatePresence, motion } from "motion/react";
import { PanelLeft } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useIsMobile } from "~/hooks/useIsMobile";
import { NavigationProvider, useNavigationContext } from "./NavigationContext";
import { NavigationPanel } from "./NavigationPanel";
import type { ConversationSummary } from "~/.server/acp";

function AppLayoutContent({
  conversations,
  children,
}: {
  conversations: ConversationSummary[];
  children: ReactNode;
}) {
  const { isNavExpanded, setIsNavExpanded, navWidth, setNavWidth } =
    useNavigationContext();
  const isMobile = useIsMobile();
  const location = useLocation();
  const [isDragging, setIsDragging] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const isResizing = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // Navegar cierra el cajón; si no, tapa la pantalla a la que acabas de llegar.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      isResizing.current = true;
      startX.current = e.clientX;
      startWidth.current = navWidth;
      setIsDragging(true);
      e.preventDefault();
    },
    [navWidth]
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!isResizing.current) return;
      setNavWidth(startWidth.current + (e.clientX - startX.current));
    };
    const onUp = () => {
      if (isResizing.current) {
        isResizing.current = false;
        setIsDragging(false);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setNavWidth]);

  const open = isMobile ? drawerOpen : isNavExpanded;
  const toggle = () => (isMobile ? setDrawerOpen(!drawerOpen) : setIsNavExpanded(!isNavExpanded));
  const toggleTitle = open ? "Cerrar navegación" : "Abrir navegación";

  return (
    <div className="relative flex h-dvh w-full flex-1 flex-row bg-background-primary">
      <div className="absolute left-4 top-[11px] z-40 ml-1.5 flex items-center gap-1">
        <Button
          onClick={toggle}
          className="hover:!bg-background-tertiary"
          variant="ghost"
          size="xs"
          title={toggleTitle}
          aria-label={toggleTitle}
        >
          <PanelLeft className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex h-full min-h-0 w-full flex-1 flex-row">
        {isMobile ? (
          <AnimatePresence>
            {drawerOpen && (
              <>
                <motion.div
                  key="velo"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  onClick={() => setDrawerOpen(false)}
                  className="fixed inset-0 z-30 bg-black/40"
                />
                <motion.div
                  key="cajon"
                  initial={{ x: "-100%" }}
                  animate={{ x: 0 }}
                  exit={{ x: "-100%" }}
                  transition={{ type: "spring", stiffness: 400, damping: 40 }}
                  className="fixed inset-y-0 left-0 z-30 w-[min(280px,85vw)] p-2"
                >
                  <div className="h-full w-full overflow-hidden rounded-xl border border-border-primary bg-background-primary">
                    <NavigationPanel conversations={conversations} />
                  </div>
                </motion.div>
              </>
            )}
          </AnimatePresence>
        ) : (
          <motion.div
            initial={false}
            animate={{ width: isNavExpanded ? navWidth : 0 }}
            transition={
              isDragging ? { duration: 0 } : { type: "spring", stiffness: 400, damping: 40 }
            }
            style={{ height: "100%" }}
            className="relative h-full flex-shrink-0 overflow-hidden p-2"
          >
            <div className="h-full w-full overflow-hidden rounded-xl border border-border-primary">
              <NavigationPanel conversations={conversations} />
            </div>
            {isNavExpanded && (
              <div
                className="absolute right-0 top-0 h-full w-2 cursor-col-resize transition-colors hover:bg-border-primary/30"
                onMouseDown={handleResizeMouseDown}
              />
            )}
          </motion.div>
        )}

        <div className="min-h-0 w-full min-w-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

export function AppLayout({
  conversations,
  children,
}: {
  conversations: ConversationSummary[];
  children: ReactNode;
}) {
  return (
    <NavigationProvider>
      <AppLayoutContent conversations={conversations}>{children}</AppLayoutContent>
    </NavigationProvider>
  );
}
