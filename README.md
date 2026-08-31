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

El agente escribe en **su** disco, no en el tuyo. Esa es la diferencia con correr goose en la
laptop, y es la razón de todo lo demás.

## El taller

Este repo es el material de **[Sistemas Agénticos](https://www.fixtergeek.com/sistemas-agenticos)**,
un taller de seis sesiones. Un documento por sesión en [`docs/`](docs/): las dos primeras están
hechas y verificadas, las otras cuatro son planes con lo que ya se sabe y lo que falta decidir.

| | Sesión | Documento | Estado |
|---|---|---|---|
| 1 | Vive fuera de tu compu y despierta cuando lo llamas | [`spec1-agente-fuera.md`](docs/spec1-agente-fuera.md) | ✅ |
| 2 | UI propia, mostrando lo que hace mientras lo hace | [`spec2-ui-solida.md`](docs/spec2-ui-solida.md) | ✅ |
| 3 | Lo matas a media tarea y revive donde iba | [`spec3-revivir.md`](docs/spec3-revivir.md) | plan |
| 4 | Contesta por WhatsApp y te pide permiso desde ahí | [`spec4-permisos-extensiones.md`](docs/spec4-permisos-extensiones.md) | plan |
| 5 | Sólido, corriendo, y con forma de saber si se rompe | [`spec5-operacion.md`](docs/spec5-operacion.md) | plan |
| 6 | Haciendo lo tuyo: habilidades | [`spec6-habilidades.md`](docs/spec6-habilidades.md) | plan |

La app de la sesión 2 es la que vive en la raíz. Un primer intento de esa interfaz, en SPA, quedó
en [`legacy/`](legacy/) con su documento.

El estado operativo del día a día —qué corre, qué falta, qué duele— vive en
[`ESTADO.md`](ESTADO.md).

## Correrlo

Necesitas una caja con `goose serve` escuchando y su secreto. Si no la tienes,
[`scripts/install-goose-unit.mjs`](scripts/install-goose-unit.mjs) la deja lista (y escribe el
`.env` por ti).

```sh
npm install
cp .env.example .env      # y llénalo
npm run dev               # http://localhost:5173
```

Producción:

```sh
npm run build && npm start
```

Node ≥ 22.22. `react-router dev` no lee `.env` por su cuenta, por eso los scripts pasan
`--env-file`.

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
  no a su loopback: sin `--host 0.0.0.0` el resultado es un 502 mudo. Exponer el puerto correcto no
  alcanza.
- **El tema no puede vivir en `localStorage` con SSR.** Un script que marca la clase antes de
  hidratar desajusta el HTML del servidor y React tira la página — y sólo le pasa a quien ya eligió
  un tema, así que en la primera visita todo se ve bien.
- **`printf '%s' 'CLAVE=valor\n'` deja la barra-ene literal** pegada al valor. El agente compara
  contra un secreto con basura al final y responde 401 aunque el tuyo sea correcto.
