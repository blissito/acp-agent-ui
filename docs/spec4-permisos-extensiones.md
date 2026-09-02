# Spec 4 — Herramientas nuevas, y pidiéndote permiso por WhatsApp

> **Plan, no bitácora.**

## El problema

La interfaz web asume que estás sentado frente a ella. Un agente que trabaja solo necesita
alcanzarte donde estés, y necesita **preguntarte** antes de hacer algo caro o irreversible.

El permiso sólo importa cuando hay algo que permitir: por eso las **extensiones** viven en esta
sesión y no en la última. Darle herramientas nuevas al agente y decidir qué puede hacer sin
preguntar son la misma conversación.

## Lo que ya existe

- **Las extensiones se manejan por ACP**: `goose.configExtensionsList_unstable`, más `Add`,
  `Remove` y `SetEnabled`. Hoy el `initialize` manda `mcpServers: []`, o sea el agente arranca sin
  ninguna.
- **El permiso ya viaja.** `session/request_permission` llega hoy al backend, se emite por el SSE
  como `event: tool`… y se **auto-aprueba** en `app/.server/acp.ts`. El camino de ida está; falta
  el de vuelta.
- **La conexión no depende del navegador.** El agente vive en la caja y la app es un cliente ACP
  más: nada impide que el cliente sea un webhook de WhatsApp.

## Lo que hay que hacer

1. Conectarle una extensión MCP desde `/extensions`, para que tenga algo que pedir permiso de usar.
2. Quitar la auto-aprobación: que el turno **espere** la respuesta del humano.
3. Un canal de decisión que no sea la web (el mismo `optionId` que ya se emite).
4. El webhook de WhatsApp como segundo cliente del mismo motor.
5. Que la web y WhatsApp vean la misma conversación.

## Lo que falta decidir

- **Timeout de un permiso sin respuesta.** ¿El turno se cae, o espera indefinido?
- **Quién puede aprobar.** Hoy no hay usuarios: cualquiera con el link opera el agente.
- **Qué se pregunta y qué no.** Preguntar todo es inusable; no preguntar nada es peligroso. La
  respuesta depende de qué extensiones tenga conectadas.
- **Si un permiso se recuerda.** ACP ofrece `allow_once` y opciones permanentes: ¿quién decide que
  algo deja de preguntarse?

## La vista `/whatsapp`

Ya existe en cascarón (`app/routes/whatsapp.tsx`, entrada en el panel debajo de Extensiones). Es
la sección que la landing promete: "la integración va dada, ustedes la conectan". El canal son
**grupos**, no chats 1:1: el agente vive en un grupo con las personas que lo operan.

Requisito: la app hosteada (sesión 3). El canal necesita una URL pública estable.

### Qué se ve

1. **Sin vincular.** El QR ya pintado al abrir; se renueva solo (60 s el primero, 20 s los
   siguientes). Sin botón de "generar". Debajo, "Vincular con código": pides el número y sale el
   código de 8 caracteres (`XXXX-XXXX`) para WhatsApp → Dispositivos vinculados → Vincular con
   número. QR y código son excluyentes: pedir uno cancela el otro. En la práctica el código suele
   vincular mejor que el QR; se ofrecen los dos. El estado llega por SSE, igual que el chat.
2. **Conectado.** Número, nombre del teléfono, "conectado desde", botón Desvincular.
3. **Grupos.** Lista de los grupos donde está el número, con checkbox. Sin marcar, el agente
   calla en todos. Aquí vive el "un agente con permiso manda mil".
4. **Un mensaje en un grupo marcado es un turno** del mismo motor (`app/.server/acp.ts`). Se ve
   en `/c/:id`: dos clientes, una conversación.
5. **El permiso llega al grupo.** `session/request_permission` deja de auto-aprobarse: la
   pregunta sale al grupo con sus opciones (`optionId`), se contesta ahí y el turno sigue. La web
   sólo lo muestra como pendiente; no lo decide.

### Qué se copia y de dónde

La máquina de estados y la persistencia vienen de easybits
(`app/.server/integrations/whatsapp/baileys.server.ts`): Baileys, estados
`disconnected → connecting → qr_pending | pairing → connected | failed`, credenciales en base de datos con
flush de llaves con debounce de 600 ms (sin él el pairing se rompe), y `groupFetchAllParticipating`
con caché de 60 s para la lista de grupos. La sesión de WhatsApp va al almacén que decida la
sesión 3, para que sobreviva al deploy. El QR nunca se guarda.

### Fuera de alcance, a propósito

- Decidir el permiso desde la web: doble sincronía que no enseña más.
- Bandeja de chats: lo que entra ya se ve en `/c/:id`.
- Usuarios: quien tenga el link opera el canal. Se anota como límite.

### Por decidir

- Timeout de un permiso sin respuesta en el grupo.
- Si una decisión se recuerda (`allow_once` vs permanente) y quién la toma.
