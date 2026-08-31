import { Zap } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Skills() {
  return (
    <PlaceholderView
      title="Habilidades"
      description="Instrucciones que el agente carga bajo demanda."
      icon={Zap}
      pending="Salen por ACP, con goose.sourcesList_unstable. Los archivos viven en el disco de la caja; el agente es quien los lee."
    />
  );
}
