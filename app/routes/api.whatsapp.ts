/** GET /api/whatsapp — estado y grupos. POST — connect · pair · disconnect · group. */
import { data } from "react-router";
import type { Route } from "./+types/api.whatsapp";
import { conectar, desvincular, listarGrupos, rehidratar, setGrupo, waState } from "~/.server/whatsapp";

export async function loader({ request }: Route.LoaderArgs) {
  rehidratar();
  const live = new URL(request.url).searchParams.get("live") === "1";
  return data({ state: waState(), groups: await listarGrupos({ live }) });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") return data({ error: "method not allowed" }, { status: 405 });
  const body = (await request.json().catch(() => ({}))) as {
    intent?: string;
    phone?: string;
    jid?: string;
    enabled?: boolean;
  };
  try {
    switch (body.intent) {
      case "connect":
        await conectar();
        break;
      case "pair":
        if (!body.phone) return data({ error: "falta el número" }, { status: 400 });
        await conectar({ phone: body.phone });
        break;
      case "disconnect":
        await desvincular();
        break;
      case "group":
        if (!body.jid) return data({ error: "falta el grupo" }, { status: 400 });
        setGrupo(body.jid, !!body.enabled);
        break;
      default:
        return data({ error: "intent desconocido" }, { status: 400 });
    }
    return data({ state: waState(), groups: await listarGrupos({ live: false }) });
  } catch (e) {
    return data({ error: (e as Error).message }, { status: 500 });
  }
}
