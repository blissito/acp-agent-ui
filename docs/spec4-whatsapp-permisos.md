# Spec 4 — Contestando por WhatsApp y pidiéndote permiso desde ahí

> **Plan, no bitácora.**

## El problema

La interfaz web asume que estás sentado frente a ella. Un agente que trabaja solo necesita
alcanzarte donde estés, y necesita **preguntarte** antes de hacer algo caro o irreversible.

## Lo que ya existe

- **El permiso ya viaja.** `session/request_permission` llega hoy al backend, se emite por el SSE
  como `event: tool`… y se **auto-aprueba** en `app/.server/acp.ts`. El camino de ida está; falta
  el de vuelta.
- **La conexión no depende del navegador.** El agente vive en la caja y la app es un cliente ACP
  más: nada impide que el cliente sea un webhook de WhatsApp.

## Lo que hay que hacer

1. Quitar la auto-aprobación: que el turno **espere** la respuesta del humano.
2. Un canal de decisión que no sea la web (el mismo `optionId` que ya se emite).
3. El webhook de WhatsApp como segundo cliente del mismo motor.
4. Que la web y WhatsApp vean la misma conversación.

## Lo que falta decidir

- **Timeout de un permiso sin respuesta.** ¿El turno se cae, o espera indefinido?
- **Quién puede aprobar.** Hoy no hay usuarios: cualquiera con el link opera el agente.
- **Qué se pregunta y qué no.** Preguntar todo es inusable; no preguntar nada es peligroso.
