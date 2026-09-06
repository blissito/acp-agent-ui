# Spec 3 — Lo matas a media tarea y revive justo donde iba

> **Plan, no bitácora.** Las sesiones 1 y 2 están hechas y verificadas; ésta todavía no.
> Aquí va lo que ya se sabe y lo que falta decidir. Lo marcado **[verificado 6 sep]** se probó
> contra la caja `goose-demo` en el ensayo, no salió de la doc.

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

**[verificado 6 sep]** goose 1.48.0 anuncia en `initialize`:

```json
{ "loadSession": true,
  "sessionCapabilities": { "list": {}, "delete": {}, "close": {} } }
```

Dos cosas que costaron encontrar:

- **La app tiraba esa respuesta.** `ctx.request("initialize", …)` se llamaba sin guardar el
  resultado, así que nunca supimos qué sabía hacer el agente. Ya se captura en
  `agentCapabilities`.
- **La doc de ACP dice que no existe listar.** Miente, o va atrás: `session/list` responde con
  `sessionId`, `cwd`, `title`, `updatedAt` y un `_meta` con `messageCount`, `providerId` y
  `modelId`. Suficiente para pintar `/sessions` sin tocar ninguna base de datos.

La consecuencia importante: **la fuente de verdad puede ser el agente, no una base de datos
nuestra.** El `Map` deja de ser el registro y pasa a ser un caché.

## Dónde vive la memoria del agente

**[verificado 6 sep]** El hilo son filas en SQLite, y el archivo no está donde uno cree.

| | goose (`dev-box`) | ghosty-lite |
|---|---|---|
| motor | goose 1.48.0 | **el mismo**: `agentInfo` dice `ghosty-lite` 1.48.0 |
| capacidades ACP | `loadSession`, `session/list`, `delete`, `close` | **idénticas**, verificadas por `initialize` |
| dónde manda la ruta | `$HOME` (XDG) | `GHOSTY_PATH_ROOT`, su propia variable |
| sesiones | `/root/.local/share/goose/sessions/sessions.db` | `/data/ghosty/data/sessions/sessions.db` |
| ¿sobrevive a la caja? | **no**, cuelga del `$HOME` | **sí**, el template lo trae horneado |
| `sqlite3` | sí | sí en el template actual; **no** en cajas viejas (`lite-vision`) |

Los dos agentes son el mismo binario. Lo único que cambia es quién decidió dónde escribir:
en `ghosty-lite-start` la línea `export GHOSTY_PATH_ROOT="${GHOSTY_PATH_ROOT:-/data/ghosty}"`
ya resolvió el problema que en goose hay que resolver a mano.

Otras diferencias del template ghosty-lite:

- El token del agente **se genera en cada boot** y nunca sale de la caja; el ACP escucha sólo en
  loopback `:3284` y el front en `:3000` lo reexpone.
- `/data/ghosty/state/logs/llm_request.N.jsonl`: traza cruda de cada llamada al modelo, con el
  system prompt completo (811 KB uno solo). Es traza, no memoria; se puede tirar.
- Los hints viven en `.goosehints` y **se pisan en cada boot** desde la copia horneada.

- El `cwd` que pide el Cliente **no manda aquí**: son dos raíces distintas. `sessions.db` cuelga de
  `$HOME`, no del directorio de trabajo. Una línea lo mueve: `XDG_DATA_HOME=/data/state`
  (la config es aparte: `XDG_CONFIG_HOME`).
- Esquema: `sessions`, `messages`, `usage_ledger`, `provider_inventory_*`. El día del ensayo,
  13 sesiones y 63 mensajes.
- **`goose session list` no ve las sesiones de la app.** Son `session_type='acp'` y el CLI sólo
  lista las suyas. Para verificar por fuera se cuentan filas, no se usa el CLI.

## Respaldar: `.backup`, nunca `cp`

**[verificado 6 sep]** Con la base abierta y en modo WAL, copiar el archivo da una base
**sin la tabla siquiera** — todo lo reciente vive en el `-wal`:

```
demo.bak.db   (.backup)  →  filas = 3
demo.cp.db    (cp)       →  ERROR: no such table: notas
```

Con el agente **cerrado** no hay `-wal` colgando y el `cp` parecería funcionar; con el agente
**vivo** —que es cuando uno respalda— no. Por eso la regla es siempre `.backup`, no "depende".
Si falta el binario `sqlite3` (cajas viejas), `python3` lo hace igual con `con.backup(dst)`.

Y el respaldo lo corre alguien **de afuera** — el agente no puede respaldarse a sí mismo: escribe
en esa base mientras corre, y si el proceso muere no queda quien ejecute nada.

## El bootstrap de la caja

**[verificado 6 sep]** `POST /api/v2/sandboxes/:id/bootstrap` con `{"script": "..."}`.

- La referencia de EasyBits decía `PATCH`; la ruta sólo acepta `POST`. Es un bug de la doc.
- El script queda en `metadata.eb_boot`; corre en cada despertar con `EB_RESUME=1`.
- **Es asíncrono**: la caja despertó en 0.7 s y el primer `exec` le ganó al script. No asumir
  que terminó; hay dedupe de 5 s entre despertares.
- Si corrió y cómo salió se lee en el metadata, no se adivina: `eb_boot_last`, `eb_boot_exit`
  (0 bien, −1 ni arrancó), `eb_boot_err`.

## `session/load`: el agente repite el hilo

**[verificado 6 sep]** `session/load` con `{sessionId, cwd, mcpServers}` devuelve modos y opciones
de configuración — **los mensajes no vienen en la respuesta**. Llegan antes, como notificaciones
`session/update`. Reanudando `20260904_6`:

```json
{ "user_message_chunk": 2, "agent_thought_chunk": 1, "agent_message_chunk": 1,
  "usage_update": 1, "available_commands_update": 1 }
```

Se repite todo: los mensajes, el pensamiento y el gasto de tokens.

**El hueco está en el Cliente, no en el agente.** El handler de `session/update` en `acp.ts` sólo
atiende `config_option_update` y descarta el resto en silencio. El chat ya sabe pintar
`agent_message_chunk` y `agent_thought_chunk`; basta con dejar de tirarlos.

Detalle del transporte: por HTTP, `/acp` exige la cabecera `Acp-Connection-Id` para hilar varias
llamadas; sin ella responde `Acp-Connection-Id header required`. Por WebSocket la conexión ya es
el hilo.

Y un tropiezo que va a pasar en vivo: **el hot-reload de Vite mata la conexión ACP**. Al tocar
`app/.server/acp.ts` el módulo se recarga, el `Map` se vacía y el log escupe
`Got response to unknown request null`. Hay que reiniciar el dev server y volver a abrir una
conversación. Es, literalmente, el problema de la sesión en miniatura.

## Lo que hay que hacer

0. Poner `XDG_DATA_HOME=/data/state` en el bootstrap, para que el `sessions.db` de goose deje de
   colgar del home.
1. Que `/sessions` liste `session/list` del agente en vez del `Map` del proceso.
2. Que `/c/:id` haga `session/load` cuando no tiene la sesión en memoria.
3. Reconectar el SSE a una sesión que ya existía, sin crear una nueva. Si la caja se durmió en
   medio, el reconnect del WSS la despierta solo: no hace falta llamar a `ensureAgentBox` aquí.
4. Matar el server a media respuesta y comprobar qué sobrevive: ¿el turno se pierde, se reanuda, o
   queda a medias en el historial del agente?

## Lo que falta decidir

- **A S3, ¿qué y cómo?** Para el taller: el archivo entero (`.backup` + `PutObject`, y al arrancar
  bajarlo sólo si no existe local). Un json por hilo es más barato y no choca entre cajas, pero
  obliga a reconstruir la base al recrear; se menciona, no se construye.
- **S3 no se lee para pintar la pantalla.** Va atrás de la realidad. Se lee una sola vez, al
  arrancar una caja nueva; la pantalla siempre pregunta al agente.

- **Qué pasa con un turno interrumpido.** Es la pregunta de la sesión y hay que responderla con la
  prueba, no con la doc.
- **`session/cancel`.** El botón de parar está dibujado y no interrumpe; toca aquí.
- **Si la caja se suspende a media tarea.** La despierta el propio `Upgrade` del WebSocket al
  reconectar (verificado el 1 sep 2026), pero el turno en vuelo ya murió con la suspensión.
