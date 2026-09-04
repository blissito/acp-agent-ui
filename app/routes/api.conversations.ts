/** POST /api/conversations — abre una conversación (y despierta la caja). */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations";
import { askConversation, createConversation, listConversations } from "~/.server/acp";
import type { ImagePayload } from "~/hooks/useAcpStream";

export async function loader() {
  return data({ conversations: listConversations() });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }
  // El primer turno puede venir en el mismo POST. Va aquí y no por el `state`
  // del navegador porque las imágenes son base64: cuatro adjuntos no caben en
  // `history.state` y el mensaje se perdería sin decir nada.
  const body = (await request.json().catch(() => ({}))) as {
    text?: string;
    images?: ImagePayload[];
  };
  const text = String(body.text ?? "").trim();
  const images = Array.isArray(body.images)
    ? body.images.filter(
        (im) =>
          im &&
          typeof im.mimeType === "string" &&
          im.mimeType.startsWith("image/") &&
          typeof im.data === "string" &&
          im.data.length > 0
      )
    : [];
  try {
    const id = await createConversation();
    if (text || images.length) askConversation(id, text, images);
    return data({ conversationId: id });
  } catch (e) {
    return data({ error: (e as Error).message }, { status: 429 });
  }
}
