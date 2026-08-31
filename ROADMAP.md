# Lo que sigue

La sesión 3 dejó la interfaz. El chat funciona de punta a punta, pero el agente que hay detrás está
desnudo: sin herramientas más allá de su shell y su disco, sin instrucciones propias, y sin memoria
entre una conversación y otra. Las siguientes sesiones son eso.

Cada una tiene una vista esperándola en el panel de navegación, hoy en cascarón con un estado vacío
que dice qué falta.

## Extensiones (MCP)

**Vista:** `/extensions` · **Hoy:** el `initialize` manda `mcpServers: []`.

Un agente sin herramientas sólo puede leer y escribir su disco. Conectarle servidores MCP es lo que
lo saca de la caja: una base de datos, una API, un navegador.

Lo que hay que resolver:

- El `session/new` de ACP acepta `mcpServers` — es el lugar donde entran, y hoy va vacío desde
  `app/.server/acp.ts`.
- ¿Dónde vive la configuración? El Desktop la guarda en el perfil de `goosed`; aquí lo natural es
  el disco de la caja (`/root/.config/goose/`), que es lo que sobrevive a la suspensión.
- Alta y baja desde la interfaz implica escribir en la caja y reiniciar la sesión ACP, no sólo la
  conversación.
- **El permiso deja de ser trámite.** Hoy `session/request_permission` se auto-aprueba. Con
  herramientas de verdad, esa decisión es del usuario y la interfaz tiene que preguntársela: el
  evento ya viaja por el SSE (`event: tool`), falta el camino de vuelta.

## Skills

**Vista:** `/skills` · **Hoy:** nada las lee.

Instrucciones que el agente carga cuando hacen falta, en vez de cargar todo siempre. Es la
diferencia entre un prompt gigante y un agente que sabe buscar lo que necesita.

Lo que hay que resolver:

- Viven en el disco de la caja. Listarlas es leer un directorio del agente, no una tabla local.
- Editarlas desde la web significa escribir en la caja: `POST /sandboxes/:id/exec` o la API de
  archivos del sandbox.
- Qué pasa cuando una skill cambia a mitad de una sesión ACP viva.

## Memoria

**Vista:** ninguna todavía · **Hoy:** las conversaciones viven en un `Map` del proceso.

Es el hueco más grande: un reinicio del server borra todo, y el agente no recuerda nada de una
conversación a la siguiente.

Hay dos memorias distintas y conviene no confundirlas:

- **El historial** — qué se dijo. Persistirlo es del lado de la app. ACP tiene `session/list` y
  `session/load`, así que la fuente de verdad puede ser el agente en vez de una base local.
- **Lo que el agente recuerda** — hechos que sobreviven a la sesión. Eso es del lado del agente:
  un archivo en su disco, o una extensión de memoria.

Lo que hay que resolver:

- Que `/sessions` liste lo que el agente tiene guardado (`session/list`), no lo que este proceso
  recuerda.
- Retomar una conversación tras reiniciar el server (`session/load`).
- Dónde se guarda lo que el agente aprende, y cómo se ve —y se borra— desde la interfaz.

## Pendientes sueltos de la sesión 3

- **`session/cancel`.** El botón de parar está dibujado y no interrumpe.
- **Las vistas en cascarón** `/recipes`, `/apps` y `/schedules`. El planificador no tiene
  equivalente en ACP: habría que correrlo en la caja y exponerlo aparte.
- **Propuesta para EasyBits**, no para este repo: que `expose` mire qué está escuchando y, si sólo
  ve `127.0.0.1:<puerto>`, devuelva la URL con una advertencia en vez de dejar caer un 502 mudo.
  El problema no es la regla, es el diagnóstico.

  De la pareja de mensajes engañosos, uno ya está resuelto: la descripción de
  `sandbox_expose_port` aclara desde el 30 ago 2026 que sirve WebSocket sobre la misma URL, así que
  nadie más debería montar un túnel de más. El campo `warning` para el caso del loopback todavía no
  aparece: comprobado el 31 ago 2026 exponiendo un puerto sin nada escuchando, tanto por REST v2
  como por la herramienta MCP; las dos devuelven `{ host, port, url }` y nada más.
