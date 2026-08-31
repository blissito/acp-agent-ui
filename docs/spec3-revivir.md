# Spec 3 — Lo matas a media tarea y revive justo donde iba

> **Plan, no bitácora.** Las sesiones 1 y 2 están hechas y verificadas; ésta todavía no.
> Aquí va lo que ya se sabe y lo que falta decidir.

## El problema

Hoy las conversaciones viven en un `Map` dentro del proceso (`app/.server/acp.ts`). Reinicias el
server y desaparecen. Peor: si el turno iba a la mitad, el trabajo del agente se pierde con él.

## Lo que ya existe en el protocolo

No hay que inventar persistencia: el agente ya la tiene.

| Para | Método |
|---|---|
| Listar lo que el agente recuerda | `session/list` (ACP estándar) |
| Retomar una sesión por id | `session/load` (ACP estándar) |
| Sacar o meter una conversación entera | `goose.sessionExport_unstable` · `sessionImport_unstable` |
| Datos de una sesión | `goose.sessionInfo_unstable` |
| Renombrar | `goose.sessionRename_unstable` |
| Cortar el historial | `goose.sessionConversationTruncate_unstable` |

La consecuencia importante: **la fuente de verdad puede ser el agente, no una base de datos
nuestra.** El `Map` deja de ser el registro y pasa a ser un caché.

## Lo que hay que hacer

1. Que `/sessions` liste `session/list` del agente en vez del `Map` del proceso.
2. Que `/c/:id` haga `session/load` cuando no tiene la sesión en memoria.
3. Reconectar el SSE a una sesión que ya existía, sin crear una nueva.
4. Matar el server a media respuesta y comprobar qué sobrevive: ¿el turno se pierde, se reanuda, o
   queda a medias en el historial del agente?

## Lo que falta decidir

- **Qué pasa con un turno interrumpido.** Es la pregunta de la sesión y hay que responderla con la
  prueba, no con la doc.
- **`session/cancel`.** El botón de parar está dibujado y no interrumpe; toca aquí.
- **Si la caja se suspende a media tarea.** El `ensureAgentBox` la despierta al hablarle, pero el
  turno en vuelo ya murió.
