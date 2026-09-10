import type { ReactNode } from "react";

export function MainPanelLayout({
  children,
  removeTopPadding = false,
}: {
  children: ReactNode;
  removeTopPadding?: boolean;
}) {
  return (
    <div className="h-dvh">
      {/* El scroll vive aquí y no en cada vista: sin él, todo lo que pase del
          alto de la ventana se recorta en silencio. El chat no se entera,
          porque su lista tiene su propio scroller acotado. */}
      <div
        className={`flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background-primary ${
          removeTopPadding ? "" : "pt-[32px]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
