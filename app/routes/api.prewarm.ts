/**
 * GET  /api/prewarm — estado de la sesión precalentada (la que adopta el
 *                     próximo chat): fase, modelos, error y cupo de la caja.
 * POST /api/prewarm — reintenta el precalentado tras un fallo.
 */
import { data } from "react-router";
import type { Route } from "./+types/api.prewarm";
import { prewarm, warmState } from "~/.server/acp";

export async function loader() {
  return data(warmState());
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }
  prewarm();
  return data(warmState());
}
