import { Clock } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

export default function Schedules() {
  return (
    <PlaceholderView
      title="Agenda"
      description="Conversaciones que arrancan solas en un horario."
      icon={Clock}
      pending="El planificador es del daemon de goose; por ACP no hay equivalente. Habría que correrlo en la caja y exponerlo."
    />
  );
}
