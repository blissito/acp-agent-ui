import { Zap } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Skills() {
  return (
    <PlaceholderView
      title="Habilidades"
      description="Instrucciones que el agente carga bajo demanda."
      icon={Zap}
      pending="Las habilidades viven en el disco de la caja. Falta una ruta que las liste leyendo el sistema de archivos del agente."
    />
  );
}
