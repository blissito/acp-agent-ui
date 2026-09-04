/** POST /api/conversations/:id/model — cambia el modelo de la sesión. */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.model";
import { setModel } from "~/.server/acp";

export async function action({ request, params }: Route.ActionArgs) {
  const body = (await request.json()) as { value?: string };
  if (!body.value) return data({ error: "no value" }, { status: 400 });
  const ok = await setModel(params.id, String(body.value));
  if (!ok) return data({ error: "conversation not found" }, { status: 404 });
  return data({ ok: true });
}
