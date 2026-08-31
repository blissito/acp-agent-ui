import { AppWindow } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Apps() {
  return (
    <PlaceholderView
      title="Apps"
      description="Interfaces que las extensiones MCP dibujan dentro del chat."
      icon={AppWindow}
      pending="Requiere el cliente de MCP-UI y que el servidor declare la capability correspondiente en el initialize."
    />
  );
}
