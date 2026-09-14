# Spec 4 — Herramientas nuevas, y pidiéndote permiso por WhatsApp

> **Plan, no bitácora.**

## El problema

La interfaz web asume que estás sentado frente a ella. Un agente que trabaja solo necesita
alcanzarte donde estés, y necesita **preguntarte** antes de hacer algo caro o irreversible.

El permiso sólo importa cuando hay algo que permitir: por eso las **extensiones** viven en esta
sesión y no en la última. Darle herramientas nuevas al agente y decidir qué puede hacer sin
preguntar son la misma conversación.

## Lo que ya existe

- **Las extensiones ya se dan de alta desde la web** (hecho el 10 de septiembre; ver "Lo que se
  construyó"). El handshake manda las declaradas y el alta se aplica en caliente.
- **Los métodos del agente no son los que decía este archivo.** `goose.configExtensionsList_unstable`
  no existe: los reales son `_goose/unstable/session/extensions/list`, `/add` y `/remove` para la
  sesión viva, y `_goose/unstable/config/extensions/list|add|remove|set` para la configuración
  global. Salieron de leer los literales del binario en la caja, no de la documentación.
- **El permiso ya viaja.** `session/request_permission` llega hoy al backend, se emite por el SSE
  como `event: tool`… y se **auto-aprueba** en `app/.server/acp.ts`. El camino de ida está; falta
  el de vuelta.
- **La conexión no depende del navegador.** El agente vive en la caja y la app es un cliente ACP
  más: nada impide que el cliente sea un webhook de WhatsApp.

## Lo que hay que hacer

1. ~~Conectarle una extensión MCP desde `/extensions`~~ — hecho.
2. Quitar la auto-aprobación: que el turno **espere** la respuesta del humano.
3. Un canal de decisión que no sea la web (el mismo `optionId` que ya se emite).
4. El webhook de WhatsApp como segundo cliente del mismo motor.
5. Que la web y WhatsApp vean la misma conversación.

## Lo que se construyó (10 sep)

Una extensión pasa por dos lugares distintos, y ésa es la lección de la sesión: la tabla guarda lo
que el Cliente **declara**; el Agente reporta lo que tiene **conectado**. La vista enseña las dos
listas porque no siempre coinciden.

- **`app/.server/extensions.ts`** — la primera base de datos del repo, sqlite con `node:sqlite`,
  una tabla y sin ORM. Los hilos, los títulos y los modelos siguen en JSON plano: una extensión
  entra ahí porque se prende, se apaga y se borra de una en una. La ruta la manda
  `ACP_EXTENSIONS_DB`, y al hostear la app hay que apuntarla a `/data`.
- **El envoltorio de goose.** `session/extensions/add` no pide el `McpServer` de ACP pelado, sino
  un `GooseExtension::Mcp` que lo lleva dentro del campo `server`.
- **stdio no lleva discriminador.** En el esquema de ACP, `http`, `sse` y `acp` exigen `type`;
  stdio es la única variante sin él. Agregárselo "para que quede parejo" rompe `session/new` con
  un error de deserialización que no dice nada.
- **En `session/load` los servidores se suman** a los que el agente ya guardó para ese hilo: un
  hilo revivido puede traer una extensión que en la tabla ya se borró.
- **Una extensión rota no se lleva el chat.** Si la sesión no arranca con ellas, se reabre sin
  ninguna y se avisa por el SSE.
- **`mcp/hello.ts`** — un MCP en 60 líneas, sin dependencias: JSON-RPC por stdin y stdout. Corre en
  la caja sin banderas porque ahí hay Node 22.22, que borra los tipos solo.

### El MCP http de EasyBits, y por qué no funcionaba

Costó media sesión y la culpa no era de donde parecía. Con goose sobre DeepSeek, el servidor de
EasyBits conectaba y el agente lo listaba, pero al modelo no le llegaba **ninguna** tool —sólo los
recursos `ui://easybits/*`— y de paso el proceso de la web se moría en silencio al abrir un hilo.
Por curl, el mismo endpoint devolvía 86 tools. Daba igual pedir 11 que 75, así que no era el
tamaño.

Al cambiar el provider a `claude-acp` con Sonnet, el mismo servidor, la misma URL y el mismo token
entregaron las 11 tools del toolset `web` y `web_search` corrió a la primera. El fallo estaba en
el provider, no en el servidor MCP.

Dos cosas que sí valen como regla:
- **La credencial en `headers[]` no siempre viaja.** Con goose, en vez de usarla arrancó un flujo
  OAuth contra EasyBits. Con el token en el query (`?token=`) funciona en los dos providers.
- **Un MCP http ajeno** (`https://mcp.deepwiki.com/mcp`, sin credencial) sirve para descartar el
  cableado propio en treinta segundos.

### El modelo del agente: Sonnet por `claude-acp`

La caja corre `claude-agent-acp` sobre la suscripción de Claude Code
(`CLAUDE_CODE_OAUTH_TOKEN`), no una API key. Lo que costó encontrar: hace falta
**`GOOSE_MODE=approve`**. Por omisión goose pide el modo `bypassPermissions`, que el adaptador de
Claude no ofrece (`default, acceptEdits, plan, auto`), y el turno muere con un `Internal error`
que no dice nada — el motivo real sólo aparece en
`/root/.local/state/goose/logs/cli/<fecha>/*.log`.

Efecto secundario que enlaza con la otra mitad de esta sesión: en modo `approve` el agente **pide
permiso** antes de lo arriesgado, y la web todavía lo auto-aprueba.

Con DeepSeek también hacía falta pegarle al primer turno la instrucción de idioma
(`ACP_IDIOMA` en `acp.ts`): sin ella contestaba en chino.

### Lo que se arregló de camino

Nada de esto estaba planeado; salió de usar la app en serio durante la preparación de la sesión.
Vale como material: son los fallos que aparecen cuando un cliente ACP se enfrenta a una caja que
duerme.

| Se veía como | Era |
|---|---|
| "Despertando la caja" cinco minutos | `ensureAgentBox` sin plazo en ninguna llamada |
| La caja dormida con la pestaña abierta | el contador de streams SSE bajaba dos veces por conexión |
| Un mensaje que se manda y desaparece al recargar | el servidor devolvía 404 en vez de reabrir el hilo |
| Salir del chat y volver sin la respuesta | `session/close` con el turno todavía en vuelo |
| Un hilo sin rastro de lo que hizo el agente | las herramientas no se guardaban, sólo se emitían |
| Spinners girando para siempre | un turno cortado no cierra sus `tool_call` |
| Todos los hilos titulados igual | el agente titulaba con la instrucción de idioma que le pegamos |

## Lo que falta decidir

- **Timeout de un permiso sin respuesta.** ¿El turno se cae, o espera indefinido?
- **Quién puede aprobar.** Hoy no hay usuarios: cualquiera con el link opera el agente.
- **Qué se pregunta y qué no.** Preguntar todo es inusable; no preguntar nada es peligroso. La
  respuesta depende de qué extensiones tenga conectadas.
- **Si un permiso se recuerda.** ACP ofrece `allow_once` y opciones permanentes: ¿quién decide que
  algo deja de preguntarse?

## La vista `/whatsapp`

> **Construida en la sesión 5** — ver [`spec5-canales.md`](spec5-canales.md). Lo de abajo es el
> plan original; el permiso desde el grupo sigue pendiente (hueco 4 del spec 5).

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
