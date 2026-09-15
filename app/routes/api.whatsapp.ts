/** /api/whatsapp — el estado del canal y sus grupos.
 *
 *  GET: estado + grupos. POST con `intent`: connect | pair | disconnect | group.
 *  La respuesta siempre trae el estado entero, como el resto de las rutas de recurso. */
import { data } from "react-router";
import type { Route } from "./+types/api.whatsapp";
import {
  connect,
  disconnect,
  gruposConRefresco,
  listGroups,
  pair,
  rehidratar,
  setGroupEnabled,
  waState,
} from "~/.server/whatsapp";

export async function loader() {
  rehidratar();
  return data({ state: waState(), groups: await gruposConRefresco() });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "method not allowed" }, { status: 405 });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return data({ error: "el cuerpo no es JSON" }, { status: 400 });
  }
  try {
    switch (body.intent) {
      case "connect":
        await connect();
        break;
      case "pair":
        await pair(String(body.phone ?? ""));
        break;
      case "disconnect":
        await disconnect();
        break;
      case "group":
        setGroupEnabled(String(body.jid), !!body.enabled);
        break;
      default:
        return data({ error: `no conozco el intent ${body.intent}` }, { status: 400 });
    }
    return data({ state: waState(), groups: listGroups() });
  } catch (e) {
    return data({ error: (e as Error).message }, { status: 400 });
  }
}
