/** GET /api/agent-sessions — los hilos que el agente tiene guardados. */
import { data } from "react-router";
import { listAgentSessions } from "~/.server/acp";

export async function loader() {
  return data(await listAgentSessions().catch((e) => ({ error: String(e) })));
}
