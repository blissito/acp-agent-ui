/**
 * Layout de toda la app. El loader corre en el servidor, así que la lista de
 * conversaciones llega ya renderizada en el HTML.
 */
import { Outlet, useLoaderData } from "react-router";
import { AppLayout } from "~/components/Layout/AppLayout";
import { listConversations, prewarm } from "~/.server/acp";

export async function loader() {
  // El handshake con el agente empieza aquí, al abrir la app: despertar la caja
  // y crear la sesión tarda segundos, y así se gastan mientras el usuario lee la
  // pantalla en vez de después de su primer mensaje. No se espera (`void`): si
  // el agente está caído, la interfaz carga igual y el error se ve en el chat.
  prewarm();
  return { conversations: listConversations() };
}

export default function Shell() {
  const { conversations } = useLoaderData<typeof loader>();
  return (
    <AppLayout conversations={conversations}>
      <Outlet />
    </AppLayout>
  );
}
