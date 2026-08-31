import { AppWindow } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Apps() {
  return (
    <PlaceholderView
      title="Apps"
      description="Interfaces que las extensiones MCP dibujan dentro del chat."
      icon={AppWindow}
      pending="El agente ya monta /mcp-app-guest y /mcp-app-proxy, y expone goose.appsList_unstable. Falta el lado web: @mcp-ui/client para dibujar la app dentro del chat."
    />
  );
}
