import { MessageCircle } from "lucide-react";
import { PlaceholderView } from "~/components/PlaceholderView";

/**
 * Canal de WhatsApp — sesión 4. Aquí se vincula el número (QR), se ve el estado
 * del canal y, ya conectado, llegan los permisos que el agente pide desde ahí.
 * Ver docs/spec4-permisos-extensiones.md §"La vista /whatsapp".
 */
export default function WhatsApp() {
  return (
    <PlaceholderView
      title="WhatsApp"
      description="El agente contestando en un grupo de WhatsApp y pidiendo permiso desde ahí."
      icon={MessageCircle}
      pending="Aquí va el QR de vinculación (o el código de 8 caracteres si el QR no vincula), el estado del canal y los grupos donde el agente puede contestar. Se llena en la sesión 4: la app hosteada recibe los mensajes del grupo y los manda al mismo motor ACP que usa el chat."
    />
  );
}
