# Dónde estamos

> Actualizado el 14 de septiembre de 2026. Este archivo es la foto operativa: qué corre, dónde, y qué
> hay que saber para retomar sin releer todo. Lo conceptual va en [`docs/`](docs/).

## Lo que funciona hoy

Un turno completo desde el navegador: llega al agente, el agente escribe en el disco de su caja,
responde en markdown y reporta tokens y costo. Verificado el 31 de agosto con
`/root/web3-ok.txt` → `WEB3_OK`.

| Pieza | Dónde | Estado |
|---|---|---|
| Interfaz | la raíz de este repo | ✅ SSR, 9 rutas |
| Motor ACP | `app/.server/acp.ts` | ✅ una conexión por conversación |
| SSE | `app/routes/api.conversations.$id.events.ts` | ✅ con latido cada 25 s |
| Extensiones MCP | `app/.server/extensions.ts` + `/extensions` | ✅ sqlite, alta en caliente |
| Agente | ghosty-lite `6aa7fc28…` en caja `sb_66f127ce-…` (la `goose-demo` murió el 14 sep) | ✅ `ghosty-lite-runtime` |
| Modelo | Sonnet 5 por `claude-acp` (suscripción, no API key) | ✅ el hilo se pone en modo `auto` |
| WhatsApp | `app/.server/whatsapp.ts`, Baileys, credenciales en sqlite | ✅ sesión 5 |
| MCP imagen | `mcp/imagen.ts` como `imagen.service` en la caja (`127.0.0.1:4123`) | ✅ `scripts/install-imagen-mcp.mjs` |
| Repo | [blissito/acp-agent-ui](https://github.com/blissito/acp-agent-ui) | público |

## Para arrancar

```sh
npm install
npm run dev        # necesita .env
```

El `.env` (fuera del repo) lleva `ACP_WS_URL`, `ACP_SECRET`, `ACP_CWD`, `AGENT_BOX_ID` y
`EASYBITS_API_KEY`. **Sin la llave la app funciona pero no gestiona la caja** (el log dice
"sin SDK"); `@easybits.cloud/sdk` ya es dependencia.

Si la caja muere, [`scripts/new-ghosty-lite.mjs`](scripts/new-ghosty-lite.mjs) levanta un ghosty-lite
con Claude en ~10 s (`EASYBITS_API_KEY` y `CLAUDE_CODE_OAUTH_TOKEN` en el entorno) y reescribe el
`.env`; luego `node scripts/install-imagen-mcp.mjs` deja el MCP de imágenes como unidad en la caja.
El camino viejo, [`scripts/new-goose-box.mjs`](scripts/new-goose-box.mjs), levanta una caja goose de cero
en ~25 s (crear, instalar goose, LLM = EasyBits, `/data/work`, unidad, expose) y reescribe el
`.env`. Sólo necesita `EASYBITS_API_KEY` en el entorno. Pasó el 2 sep: la primera `goose-demo`
desapareció del host sin aviso (404 "sandbox not found") mientras figuraba `running`.

## Lo que hay que saber

- **Las herramientas y el pensamiento se ven.** `tool_call` / `tool_call_update` llegan al
  navegador como evento `tool` (upsert por id) y `agent_thought_chunk` como `thought`; el chat
  pinta el pensamiento colapsado y una fila por herramienta con su estado. Hecho el 2 sep para la
  sesión 2.
- **`terminal: false` en `initialize`.** Con `true` goose pide `terminal/create` al cliente y,
  como no lo implementamos, cada `shell` termina en `failed`. El shell corre en la caja.
- **`POST /extend` da 500 en una caja con TTL vencido** (viva por la siesta): el host suma sobre
  el `expiresAt` viejo y rechaza con 400, y EasyBits lo convierte en 500. Arreglos en rama en
  `sandbox-host` y `easybits`, pendientes de desplegar.

- **Cinco cuelgues que ya no lo son** (10 sep). Todos eran del Cliente, no de la caja:
  `ensureAgentBox` sin plazo en ninguna llamada (de ahí los minutos en "despertando la caja",
  con el tope del handshake sin llegar a contar); el contador de streams SSE bajando el doble
  —`abort` y `cancel` disparan los dos— que dormía la caja con pestañas abiertas; un handshake
  vencido que dejaba el socket muerto en la caché y condenaba a los hilos siguientes; un mensaje
  a un hilo dormido que devolvía 404 en vez de reabrirlo; y el turno en vuelo que se perdía al
  cambiar de hilo. `ACP_DEBUG_SSE=1` enseña el contador de streams, que es la única forma de ver
  el segundo.
- **La caja se suspende sola** al quedar inactiva. La despierta el propio `Upgrade` del WebSocket
  (verificado el 1 sep 2026); `ensureAgentBox` sólo extiende el TTL, suspende al ocio y avisa si la
  caja ya no existe. La unidad de systemd relanza `goose serve` al arrancar. Antes de eso, cada
  suspensión dejaba la app muerta con un 401 que parecía de credenciales.
- **Node 22.16 contra 22.22.** React Router pide ≥ 22.22 y avisa en cada arranque; funciona igual.
  Vale la pena subir la versión para dejar de leer el aviso.
- **Nada se persiste.** Las conversaciones viven en un `Map` del proceso: reiniciar el server las
  borra. Es justo el tema de la [sesión 3](docs/spec3-revivir.md).
- **La primera base de datos del repo.** Las extensiones MCP viven en sqlite
  (`.data/extensions.db`, movible con `ACP_EXTENSIONS_DB`); los hilos, los títulos y los modelos
  siguen en JSON plano. El alta se aplica en caliente con
  `_goose/unstable/session/extensions/add`: no hace falta reabrir el hilo. Ojo: **los tokens de un
  MCP http quedan en claro** en esa base.
- **El permiso se auto-aprueba.** `session/request_permission` se acepta solo, en
  `app/.server/acp.ts`. Tema de la [sesión 4](docs/spec4-permisos-extensiones.md).
- **`GOOSE_MODE=approve` no es opcional** con `claude-acp`. Sin él goose pide el modo
  `bypassPermissions`, que el adaptador de Claude no ofrece, y todo turno muere con un
  `Internal error` mudo. El motivo real vive en `/root/.local/state/goose/logs/cli/<fecha>/*.log`,
  no en journald.
- **El MCP http de EasyBits sólo funciona con `claude-acp`.** Con DeepSeek conectaba, no entregaba
  ninguna tool al modelo y además tumbaba el proceso de la web. Mismo servidor y mismo token: la
  diferencia era el provider. La credencial va en el query (`?token=`), no en `headers[]`.
- **Los métodos son `_unstable`.** Todo lo que llene las vistas vacías lleva ese sufijo en goose:
  pueden cambiar sin aviso.

## Lo siguiente

Las sesiones 3 a 6 están planteadas en `docs/`, cada una con lo que ya se sabe del protocolo y lo
que falta decidir. El orden natural es el del temario: primero revivir (sesión 3), porque todo lo
demás se apoya en que el estado sobreviva.

Dos cosas sueltas antes de empezar:

- `.agents/skills/react-router/` viene del scaffold. **No borrar**: en la sesión 1 sirve de
  ejemplo en vivo de que las skills salen del `cwd` que viaja en `session/new` — goose la lee
  del proyecto y la anuncia al editor en `available_commands_update`.
- El `Dockerfile` es el del scaffold y hace `npm start`, que ahora exige `.env`: si se despliega en
  Fly, las variables van como secrets.
