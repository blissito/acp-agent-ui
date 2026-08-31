import { Puzzle } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Extensions() {
  return (
    <PlaceholderView
      title="Extensiones"
      description="Los servidores MCP que el agente tiene conectados."
      icon={Puzzle}
      pending="Salen por ACP, con goose.configExtensionsList_unstable (más Add, Remove, SetEnabled). Hoy el initialize manda mcpServers vacío."
    />
  );
}
