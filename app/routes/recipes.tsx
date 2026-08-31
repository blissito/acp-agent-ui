import { FileText } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Recipes() {
  return (
    <PlaceholderView
      title="Recetas"
      description="Prompts guardados que arrancan una conversación con parámetros."
      icon={FileText}
      pending="Salen por ACP, con los métodos goose.recipesList_unstable y compañía (Save, Delete, Parse). Falta llamarlos desde app/.server/acp.ts sobre la conexión que ya existe."
    />
  );
}
