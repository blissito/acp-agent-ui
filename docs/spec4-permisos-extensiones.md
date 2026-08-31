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
