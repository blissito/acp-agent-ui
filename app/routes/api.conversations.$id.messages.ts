/** POST /api/conversations/:id/messages — encola un turno (texto y/o imágenes). */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.messages";
import { askConversation } from "~/.server/acp";
import type { ImagePayload } from "~/hooks/useAcpStream";

export async function action({ request, params }: Route.ActionArgs) {
  const body = (await request.json()) as {
    text?: string;
    images?: ImagePayload[];
  };
  const text = String(body.text ?? "").trim();
  // Saneo: sólo imágenes de verdad, con mime image/* y base64 presente.
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
  if (!text && images.length === 0) return data({ error: "no content" }, { status: 400 });
  const ok = askConversation(params.id, text, images);
  if (!ok) return data({ error: "conversation not found" }, { status: 404 });
  return data({ queued: true });
}
