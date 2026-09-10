/** POST /api/conversations/:id/cancel — corta el turno en curso. */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.cancel";
import { cancelarTurno } from "~/.server/acp";

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }
  if (!cancelarTurno(params.id)) {
    return data({ error: "no hay turno que cortar" }, { status: 404 });
  }
  return data({ ok: true });
}
