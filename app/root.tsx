import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { themes } from "./theme/theme-tokens";
import { themeClass, themeFromCookies } from "./lib/theme";

export function loader({ request }: Route.LoaderArgs) {
  return { theme: themeFromCookies(request.headers.get("cookie")) };
}

/**
 * El Desktop aplica los tokens del tema con JS después de montar. Con SSR eso
 * parpadea, y peor: escribir la clase en <html> antes de hidratar desajusta el
 * HTML del servidor y React tira la página. Los tokens salen como CSS estático
 * y la clase la pone el servidor leyendo la cookie.
 */
function tokensToCss(): string {
  const block = (selector: string, tokens: Record<string, string>) =>
    `${selector}{${Object.entries(tokens)
      .map(([k, v]) => `${k}:${v};`)
      .join("")}}`;
  return [
    block(":root", themes.light.tokens),
    block(".dark", themes.dark.tokens),
    block(".aura", themes.aura.tokens),
    // Sin clase explícita manda la preferencia del sistema.
    `@media (prefers-color-scheme: dark){${block(
      ":root:not(.light):not(.dark):not(.aura)",
      themes.dark.tokens
    )}}`,
  ].join("\n");
}

export function links() {
  return [{ rel: "icon", type: "image/png", href: "/favicon.png" }];
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Layout también renderiza las páginas de error, donde el loader pudo no
  // haber corrido; ahí se cae al tema del sistema.
  const data = useRouteLoaderData<typeof loader>("root");
  return (
    <html lang="es" className={themeClass(data?.theme ?? "system")}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <style dangerouslySetInnerHTML={{ __html: tokensToCss() }} />
      </head>
      <body className="bg-background-primary text-text-primary antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Algo se rompió";
  let details = "Ocurrió un error inesperado.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "Esta página no existe."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-3 p-8">
      <h1 className="text-4xl font-light">{message}</h1>
      <p className="text-text-secondary">{details}</p>
      {stack && (
        <pre className="w-full max-w-2xl overflow-x-auto rounded-lg border border-border-primary p-4 text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
