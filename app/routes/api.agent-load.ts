/** GET /api/agent-load?id=…&cwd=… — reanuda un hilo por `session/load`. */
import { data } from "react-router";
import { loadAgentSession } from "~/.server/acp";

export async function loader({ request }: { request: Request }) {
  const u = new URL(request.url);
  const id = u.searchParams.get("id") ?? "";
  const cwd = u.searchParams.get("cwd") ?? "/data/work";
  return data(await loadAgentSession(id, cwd).catch((e) => ({ error: String(e) })));
}
