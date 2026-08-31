import { Puzzle } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Extensions() {
  return (
    <PlaceholderView
      title="Extensiones"
      description="Los servidores MCP que el agente tiene conectados."
      icon={Puzzle}
      pending="El initialize de este cliente manda mcpServers vacío. Falta leer la config de la caja y permitir alta y baja."
    />
  );
}
