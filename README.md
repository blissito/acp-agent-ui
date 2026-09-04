# Un agente en su propia máquina

Una interfaz web para un agente que **no corre en la tuya**: vive dentro de una microVM, opera su
propio disco, y se le habla por el [Agent Client Protocol](https://agentclientprotocol.com) sobre
WebSocket.

```text
[ Navegador ]
     │  SSE — eventos ya traducidos, el navegador nunca habla ACP
[ Esta app ]         React Router · SSR · Express
     │  wss://sb-<id>-3000.sandboxes.easybits.cloud/acp
[ La caja ]          goose serve · microVM de EasyBits · LLM propio
```

## Las ramas

| Rama | Qué tiene |
|---|---|
| `main` | La app al terminar la **sesión 1**: un turno completo contra el agente. Punto de partida. |
| `sesion-2` | `main` + lo de la **sesión 2**: hub con conversaciones, tarjetas de herramienta y pensamiento, selector de modelo. |

```sh
git clone https://github.com/blissito/acp-agent-ui
git switch sesion-2      # o quédate en main para arrancar desde cero
```

## El taller

Material de **[Sistemas Agénticos](https://www.fixtergeek.com/sistemas-agenticos)**, seis sesiones,
un documento por sesión en [`docs/`](docs/).

| | Sesión | Documento | Estado |
|---|---|---|---|
| 1 | Vive fuera de tu compu y despierta cuando lo llamas | [`spec1-agente-fuera.md`](docs/spec1-agente-fuera.md) | ✅ |
| 2 | UI propia, mostrando lo que hace mientras lo hace | [`spec2-ui-solida.md`](docs/spec2-ui-solida.md) | ✅ |
| 3 | Lo matas a media tarea y revive donde iba | [`spec3-revivir.md`](docs/spec3-revivir.md) | plan |
| 4 | Contesta por WhatsApp y te pide permiso desde ahí | [`spec4-permisos-extensiones.md`](docs/spec4-permisos-extensiones.md) | plan |
| 5 | Sólido, corriendo, y con forma de saber si se rompe | [`spec5-operacion.md`](docs/spec5-operacion.md) | plan |
| 6 | Haciendo lo tuyo: habilidades | [`spec6-habilidades.md`](docs/spec6-habilidades.md) | plan |

El estado operativo del día a día vive en [`ESTADO.md`](ESTADO.md). Un primer intento de la
interfaz, en SPA, quedó en [`legacy/`](legacy/).

## Correrlo

Del otro lado hace falta un agente que hable ACP. Dos caminos:

- **[Ghosty Lite](https://www.easybits.cloud/docs#ghosty-lite)** — el atajo. Un agente en Rust que
  ya habla ACP nativo, corre en su microVM con `/data` persistente y usa tu llave de EasyBits como
  cerebro (sin credenciales de OpenAI ni Anthropic aparte). Se crea con un `POST /api/v2/agents` y
  `template: "ghosty-lite"`; cuando queda `running`, su `agentUrl` y su `embedToken` son las dos
  variables de abajo. Duerme a las 2 h de ocio y despierta en ~1 s con el disco intacto.
- **goose en una caja tuya** — el camino largo, el de la sesión 1.
  [`scripts/install-goose-unit.mjs`](scripts/install-goose-unit.mjs) la deja lista y escribe el
  `.env`.

```sh
npm install
cp .env.example .env      # y llénalo
npm run dev               # http://localhost:5173
npm run build && npm start   # producción
```

Dos variables bastan:

```sh
ACP_WS_URL=wss://acp-<agentId>.sandboxes.easybits.cloud/acp   # el `agentUrl` del agente
ACP_TOKEN=<el token del agente>                               # el `embedToken` de Ghosty Lite, o el ACP_AGENT_TOKEN que le pusieras a goose
```

Opcionales: `ACP_CWD` (por defecto `/data/work`), y `AGENT_BOX_ID` + `EASYBITS_API_KEY` para que la
app despierte y suspenda la caja sola. Sin esas dos, el agente tiene que estar ya arriba.

Node ≥ 22.22. `react-router dev` no lee `.env` por su cuenta: los scripts pasan `--env-file`.

## Cómo está armado

| Ruta | Qué es |
|---|---|
| `app/.server/acp.ts` | El motor: una conexión ACP por conversación, ciclo de vida de la caja. |
| `app/routes/api.conversations.$id.events.ts` | El SSE, como ruta de recurso. |
| `app/routes/_shell.tsx` | Layout con el panel de navegación. |
| `app/routes/hub.tsx` · `chat.tsx` | Inicio y conversación. |
| `app/lib/theme.ts` | El tema, en cookie — con SSR no puede vivir en `localStorage`. |
| `server.js` | Express para producción. |
| `scripts/` | Auditoría de arranque y la unidad de systemd del agente. |

La capa visual es un port de [goose Desktop](https://github.com/block/goose) (Apache-2.0); la
atribución está en [`NOTICE`](NOTICE).

## Tres cosas que cuestan una tarde si no te las cuentan

- **`goose serve` escucha en `127.0.0.1:3284`.** El proxy del sandbox llega a la IP de la microVM,
  no a su loopback: sin `--host 0.0.0.0` no lo alcanza.
- **El token no es el `GOOSE_SERVER__SECRET_KEY` de la caja.** Ése es interno, se regenera en cada
  arranque y nunca sale de la microVM; mandarlo da un 401 que parece de credenciales.
- **El tema no puede vivir en `localStorage` con SSR.** El script que marca la clase antes de
  hidratar desajusta el HTML del servidor y React tira la página — y sólo le pasa a quien ya eligió
  tema, así que en la primera visita todo se ve bien.
