/** POST /api/conversations — abre una conversación (y despierta la caja). */
import { data } from "react-router";
import type { Route } from "./+types/api.conversations";
import { createConversation, listConversations } from "~/.server/acp";

export async function loader() {
  return data({ conversations: listConversations() });
}

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return data({ error: "method not allowed" }, { status: 405 });
  }
  try {
    const id = await createConversation();
    return data({ conversationId: id });
  } catch (e) {
    return data({ error: (e as Error).message }, { status: 429 });
  }
}
