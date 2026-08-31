import { FileText } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Recipes() {
  return (
    <PlaceholderView
      title="Recetas"
      description="Prompts guardados que arrancan una conversación con parámetros."
      icon={FileText}
      pending="El agente de la caja expone recetas por los endpoints HTTP de goosed, que este backend todavía no consume. Falta puentearlos en app/.server."
    />
  );
}
