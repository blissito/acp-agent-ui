# Spec 5 — Todo sólido, corriendo, y con una forma de saber si se rompe

> **Plan, no bitácora.**

## El problema

Un agente que corre solo falla solo. Hoy, si se cae, te enteras porque el chat no responde.

## Lo que ya existe

- `goose serve` monta `/health` y `/status` en el mismo puerto expuesto.
- La caja del agente corre `goose-acp.service` con `Restart=always`, así que se levanta sola si
  el proceso muere.
- El ciclo de vida (`ensureAgentBox`) despierta la caja al hablarle y la suspende al ocio.

## Lo que hay que hacer

1. Que la app consulte `/health` del agente y lo muestre, en vez de fallar en silencio.
2. Distinguir los tres "no responde": la caja dormida, el agente caído, el LLM caído.
3. Logs del agente accesibles sin entrar por SSH (`/sandboxes/:id/logs` de la REST).
4. Desplegar la app en su propia caja, como la sesión 2 del POC original.
5. Que el error del SSE diga qué pasó — hoy un `401` llega crudo al navegador.

## Lo que falta decidir

- **Qué cuenta como "roto"**: ¿el agente sin responder, o el LLM devolviendo basura?
- **Cuánto se guarda**: costo y tokens ya se emiten por turno, pero no se acumulan en ningún lado.
- **Quién vigila**: un cron externo, o la app misma.
