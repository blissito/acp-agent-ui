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
      <div
        className={`flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background-primary ${
          removeTopPadding ? "" : "pt-[32px]"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
