/** /api/extensions — el alta, la baja y el interruptor de los servidores MCP.
 *
 *  Un solo verbo con `intent`, como el resto de las rutas de recurso de este
 *  repo. La respuesta siempre trae la lista completa: así la pantalla se pinta
 *  sin una segunda vuelta. */
import { data } from "react-router";
import type { Route } from "./+types/api.extensions";
import {
  createExtension,
  deleteExtension,
  getExtension,
  listExtensions,
  setExtensionEnabled,
} from "~/.server/extensions";
import { conectarExtensionEnVivo } from "~/.server/acp";

export async function loader() {
  return data({ extensions: listExtensions() });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return data({ error: "el cuerpo no es JSON" }, { status: 400 });
  }

  try {
    switch (body.intent) {
      case "create": {
        const nueva = createExtension(body);
        // Se intenta conectar al hilo abierto. Si no hay ninguno, no es un
        // error: entra sola en el próximo.
        const vivo = await conectarExtensionEnVivo(nueva);
        return data({ extensions: listExtensions(), enVivo: vivo.ok, avisoEnVivo: vivo.error });
      }
      case "toggle": {
        setExtensionEnabled(body.id, !!body.enabled);
        // Prender una ya declarada también se intenta en caliente.
        const e = body.enabled ? getExtension(body.id) : null;
        const vivo = e ? await conectarExtensionEnVivo(e) : { ok: false };
        return data({ extensions: listExtensions(), enVivo: vivo.ok });
      }
      case "delete":
        deleteExtension(body.id);
        // Quitarla de la sesión viva no se intenta: el Agente la conserva
        // hasta que el hilo termine. Se dice en la pantalla.
        return data({ extensions: listExtensions() });
      default:
        return data({ error: `no conozco el intent ${body.intent}` }, { status: 400 });
    }
  } catch (e) {
    return data({ error: (e as Error).message }, { status: 400 });
  }
}
