/**
 * POST /api/prewarm/model — elige el modelo desde el hub, antes de que exista
 * conversación. Queda como preferencia para las siguientes.
 */
import { data } from "react-router";
import type { Route } from "./+types/api.prewarm.model";
import { setWarmModel, warmState } from "~/.server/acp";

export async function action({ request }: Route.ActionArgs) {
  const body = (await request.json().catch(() => ({}))) as { value?: string };
  if (!body.value) return data({ error: "no value" }, { status: 400 });
  // Se guarda como preferencia aunque la tibia no esté lista, así que un false
  // no es un error del usuario: sólo dice que no se aplicó en caliente.
  const applied = await setWarmModel(String(body.value));
  return data({ ok: true, applied, warm: warmState() });
}
