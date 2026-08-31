/** POST /api/conversations/:id/messages — encola un turno. */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations.$id.messages";
import { askConversation } from "~/.server/acp";

export async function action({ request, params }: Route.ActionArgs) {
  const body = (await request.json()) as { text?: string };
  if (!body.text) return data({ error: "no text" }, { status: 400 });
  const ok = askConversation(params.id, String(body.text));
  if (!ok) return data({ error: "conversation not found" }, { status: 404 });
  return data({ queued: true });
}
