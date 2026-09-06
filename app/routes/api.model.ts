/** POST /api/model — el modelo que el humano prefiere, haya sesión o no. */
import { data } from "react-router";
import { setModel } from "~/.server/acp";

export async function action({ request }: { request: Request }) {
  const body = (await request.json().catch(() => ({}))) as { value?: string };
  if (!body.value) return data({ error: "sin valor" }, { status: 400 });
  await setModel("", body.value); // sin sesión sólo se guarda la preferencia
  return data({ ok: true });
}
