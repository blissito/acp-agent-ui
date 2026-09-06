# Spec 3 — Lo matas a media tarea y revive justo donde iba

> **Plan, no bitácora.** Las sesiones 1 y 2 están hechas y verificadas; ésta todavía no.
> Aquí va lo que ya se sabe y lo que falta decidir. Todo lo que dice este documento está probado
> contra la caja, no sacado de la documentación: donde las dos se contradicen, gana la caja.

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

goose 1.48.0 anuncia en `initialize`:

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

El hilo son filas en SQLite, y el archivo no está donde uno cree.

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
- Esquema: `sessions`, `messages`, `usage_ledger`, `provider_inventory_*`. El hilo son filas en
  `messages`, no un blob.
- **`goose session list` no ve las sesiones de la app.** Son `session_type='acp'` y el CLI sólo
  lista las suyas. Para verificar por fuera se cuentan filas, no se usa el CLI.

## Respaldar: `.backup`, nunca `cp`

Con la base abierta y en modo WAL, copiar el archivo da una base
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

`POST /api/v2/sandboxes/:id/bootstrap` con `{"script": "..."}`.

- La referencia de EasyBits decía `PATCH`; la ruta sólo acepta `POST`. Es un bug de la doc.
- El script queda en `metadata.eb_boot`; corre en cada despertar con `EB_RESUME=1`.
- **Es asíncrono**: la caja despertó en 0.7 s y el primer `exec` le ganó al script. No asumir
  que terminó; hay dedupe de 5 s entre despertares.
- Si corrió y cómo salió se lee en el metadata, no se adivina: `eb_boot_last`, `eb_boot_exit`
  (0 bien, −1 ni arrancó), `eb_boot_err`.

## `session/load`: el agente repite el hilo

`session/load` con `{sessionId, cwd, mcpServers}` devuelve modos y opciones
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

**El hot-reload de Vite mata la conexión ACP.** Al tocar `app/.server/acp.ts` el módulo se recarga,
el `Map` se vacía y el log escupe `Got response to unknown request null`; hay que reiniciar el dev
server y volver a abrir una conversación. Es, en miniatura, el problema de esta sesión.

## Lo que hay que hacer

0. Poner `XDG_DATA_HOME=/data/state` en el bootstrap, para que el `sessions.db` de goose deje de
   colgar del home.
1. Que `/sessions` liste `session/list` del agente en vez del `Map` del proceso.
2. Que `/c/:id` haga `session/load` cuando no tiene la sesión en memoria.
3. Reconectar el SSE a una sesión que ya existía, sin crear una nueva. Si la caja se durmió en
   medio, el reconnect del WSS la despierta solo: no hace falta llamar a `ensureAgentBox` aquí.
4. Matar el server a media respuesta y comprobar qué sobrevive: ¿el turno se pierde, se reanuda, o
   queda a medias en el historial del agente?

## Cómo queda

El resumen es que **el Cliente deja de ser el registro**:

| | antes | ahora |
|---|---|---|
| `/sessions` | el `Map` del proceso | `session/list` del agente, cruzado con lo vivo |
| abrir un hilo viejo | 404 | `/c/acp:<sessionId>` → `session/load` → redirect al id local |
| los mensajes del hilo | se perdían | llegan en el replay y se guardan |

Tres cosas que hay que resolver y no son obvias:

1. **`session/list` necesita alguien a quien preguntar.** Recién reiniciado el server no hay
   ninguna conexión, así que el historial salía vacío aunque el agente lo tuviera todo. Se reusa la
   sesión tibia del precalentado, y si no hay, se abre una y se espera.
2. **La bandera de replay.** Durante `session/load` los chunks son historial, no un turno en vivo:
   se acumulan en `messages` en vez de emitirse al navegador. La bandera se baja **después** de que
   responde la petición, porque el agente repite el hilo antes de contestarla.
3. **Dos identidades por conversación.** El `id` local (UUID de la ruta) y el `sessionId` del
   agente. `ConversationSummary` ahora lleva los dos; sin eso no se puede saber si un hilo del
   agente ya está abierto aquí.

## Una sola sesión viva

Esta app es un alumno, una caja, un hilo a la vez. Nadie conversa en paralelo. Conviene construirla
así desde el principio, porque el diseño alternativo —varias conversaciones vivas, cada una con su
conexión— arrastra un problema en cadena: la caja atiende un número fijo de sesiones, leer el
historial empieza a competir con conversar, y para arreglarlo aparece un desalojo que le cierra la
conversación en la cara a quien la está leyendo.

```
una conexión ACP, reutilizada
abrir un hilo  =  session/close del anterior  +  session/load del nuevo
```

**La conexión es del agente, no del hilo.** Abrir el WebSocket y hacer `initialize` cuesta segundos;
hacerlo en cada cambio de hilo es pagar ese peaje por pasear por el historial. Se abre una vez y las
sesiones van y vienen por dentro — es lo que hace Zed, que cachea una conexión por agente y
multiplexa. Medido aquí: cambiar de hilo pasó de 3.2 s a 1.3 s, y 1.25 s de eso es el `session/load`
del propio agente. (El otro segundo se iba en preguntarle al host si la caja estaba despierta, con
una conexión viva encima.)

Leer y seguir dejan de ser cosas distintas: abres un hilo, es *el* hilo, y escribes.

**No es una limitación de esta app, es lo que hace la industria.** Cline llama `endActiveSession()`
antes de abrir otra tarea; Continue aborta el stream al cargar una sesión; los CLIs (Claude Code,
Codex, Gemini) son un proceso por conversación. Los dos que permiten varias las acotan con un tope
pequeño: Zed retiene **5** hilos inactivos y sólo desaloja los que sabe re-hidratar con
`session/load`; goose usa un LRU de agentes. Nadie mantiene una sesión viva por fila del historial.

Y aquí pesa el doble: **una sesión abierta impide que la microVM hiberne**. Por eso el relay de la
caja tiene un tope —`ACP_MAX_SESSIONS`, que por cierto es una variable de entorno, no una ley del
protocolo— y por eso `close()` tiene que mandar `session/close` de verdad: colgar el WebSocket no le
dice nada al agente, la sesión sigue contando, y la caja no se duerme.

### La URL es el hilo

Con una sesión viva sobra la doble identidad (un id local del Cliente + el `sessionId` del agente),
que es de donde salen los redirects y los mapas de correspondencia. La ruta es `/c/<sessionId>`
directamente. Un hilo sin estrenar vive en `/c/nuevo` hasta que el agente lo bautiza.

### La lista

Se le pregunta al agente con `session/list`, con un caché corto para no llamar en cada pantalla. Es
lo que hace el escritorio de goose, que es el caso idéntico: la base de sesiones ya es del agente,
así que llevar un índice propio sólo añade algo que desincronizar. Zed y Codex sí guardan índice
—`sidebar_threads`, `state.sqlite`— porque manejan varios agentes y proyectos.

**No va al navegador.** La memoria vive en la caja: ése es justo el asunto de esta sesión.

Pero la pantalla no puede depender de que haya una sesión abierta para pintarla: si lo hace, la
lista aparece, desaparece y baila según qué esté conectado en ese instante. Se guarda la última
lista conocida y se refresca por detrás.

### El selector de modelos

**ACP no tiene forma de listar modelos sin sesión**: los `configOptions` sólo viajan en las
respuestas de `session/new`, `load`, `resume` y `set_config_option`; ni `initialize` ni las
capacidades traen catálogo. Zed vive con eso creando la sesión por adelantado, que es lo mismo que
hacíamos con una conexión "tibia" — sólo que Zed no paga una microVM despierta.

La salida es guardar la última lista conocida y pintarla mientras no haya sesión; se refresca sola
al abrir cualquier hilo. Lo que de verdad importa que sobreviva es la **elección** del humano, no el
catálogo. (goose ofrece además `_goose/unstable/providers/list`, que no lleva `sessionId`, pero es
extensión propietaria: detrás de un adaptador si se usa.)

## El título lo pone el agente

Es el error natural: ver `New Chat` en toda la lista y concluir que el Cliente tiene que inventar
el nombre. En ACP el título viaja **del agente al Cliente**, en la notificación `session/update` con
`sessionUpdate: "session_info_update"` y su campo `title`. goose lo genera con un LLM leyendo los
primeros mensajes del hilo y lo empuja por ahí.

Si la lista dice `New Chat` para siempre, casi seguro el Cliente está tirando esa variante de
`session/update` sin darse cuenta. Fue exactamente el caso aquí.

- **No existe rename en la spec.** Los métodos de sesión son `new`, `load`, `prompt`, `cancel`,
  `close`, `list`, `delete`, `resume`, `set_mode`, `set_config_option`. Ninguno fija el título:
  `session/rename` responde *Method not found*.
- goose sí trae uno propietario, fuera del estándar: `_goose/unstable/session/rename`.
- También acepta un nombre desde el arranque: `_meta.client_title` en `session/new`.
- El Cliente igual guarda el título que recibe, porque `session/list` sólo lo trae si el agente ya
  lo generó, y porque un renombre del usuario tiene que sobrevivir. Zed hace justo esto: acepta el
  título del agente y guarda aparte un `title_override` local.

## Nada de esto es de goose

Todo lo que sostiene el historial es ACP estándar: `session/list`, `session/load`, `session/close` y
el `session_info_update` que trae el título. Cambiar de agente es cambiar la URL.

Comprobado apuntando el mismo Cliente, sin tocar una línea, a una caja `ghosty-lite`: listó su hilo,
lo leyó por la conexión lectora y lo reabrió al escribir. Los dos agentes anuncian exactamente las
mismas capacidades en `initialize` — de hecho son el mismo binario con distinta configuración.

Aun así, el Cliente no debe dar por hecho lo que no le dijeron. `initialize` responde qué sabe hacer
el agente, y de ahí salen tres degradaciones:

| Si falta | Qué se hace |
|---|---|
| `sessionCapabilities.list` | la lista enseña sólo las conversaciones vivas de este proceso |
| `loadSession` | no se ofrece reabrir hilos guardados |
| `sessionCapabilities.close` | no se pide cerrar; se recicla la conexión entera |

Y una trampa que no es del protocolo: una caja recién creada puede traer el agente vivo **sin
proveedor de modelo**. Acepta la sesión y revienta con `Internal error` al primer turno. Se ve en
`/etc/<agente>-runtime/.env` vacío, no en el Cliente.

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
