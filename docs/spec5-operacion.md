# Spec 5 — Todo sólido, corriendo, y con una forma de saber si se rompe

> **Plan, no bitácora.**

## El problema

Un agente que corre solo falla solo. Hoy, si se cae, te enteras porque el chat no responde.

## Lo que ya existe

- `goose serve` monta `/health` y `/status` en el mismo puerto expuesto.
- La caja del agente corre `goose-acp.service` con `Restart=always`, así que se levanta sola si
  el proceso muere.
- El ciclo de vida (`ensureAgentBox`) extiende el TTL de la caja, la suspende al ocio y detecta
  que ya no existe. **No la despierta**: eso lo hace el propio `Upgrade` del WebSocket, porque el
  proxy público hace `acquire` antes de enrutar (verificado el 1 sep 2026).
- Su self-heal con `forkFromSnapshot` **no funciona desde la API pública**: el fork sólo va sobre
  cajas vivas y la ruta por snapshot da 404 (verificado el 20 ago 2026). Justo el caso en que se
  ejecuta —caja perdida— es el que no puede resolver.

## Lo que hay que hacer

1. Que la app consulte `/health` del agente y lo muestre, en vez de fallar en silencio. Ojo: esa
   ruta puede contestarla el router del proxy sin llegar a la caja. Verificar con la caja suspendida
   qué responde antes de usarla como monitor.
2. Distinguir los tres "no responde": la caja dormida, el agente caído, el LLM caído. Aquí encaja
   `ensureAgentBox` en su papel real: decir "la caja ya no existe" con un mensaje claro en vez del
   404 crudo.
3. Logs del agente accesibles sin entrar por SSH (`/sandboxes/:id/logs` de la REST).
4. Desplegar la app en su propia caja, como la sesión 2 del POC original.
5. Que el error del SSE diga qué pasó — hoy un `401` llega crudo al navegador.

## Lo que falta decidir

- **Qué cuenta como "roto"**: ¿el agente sin responder, o el LLM devolviendo basura?
- **Cuánto se guarda**: costo y tokens ya se emiten por turno, pero no se acumulan en ningún lado.
- **Quién vigila**: un cron externo, o la app misma.
