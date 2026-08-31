import { Clock } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Schedules() {
  return (
    <PlaceholderView
      title="Agenda"
      description="Conversaciones que arrancan solas en un horario."
      icon={Clock}
      pending="Salen por ACP, con goose.schedulesList_unstable y compañía. Requieren que el agente corra con --enable-scheduler, que hoy la unidad de systemd no pasa."
    />
  );
}
