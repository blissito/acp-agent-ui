# Dónde estamos

> Actualizado el 31 de agosto de 2026. Este archivo es la foto operativa: qué corre, dónde, y qué
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
| Agente | caja `goose-demo` (`sb_d6a36806-…`), goose 1.48.0 | ✅ `goose-acp.service` |
| Repo | [blissito/acp-agent-ui](https://github.com/blissito/acp-agent-ui) | público |

## Para arrancar

```sh
npm install
npm run dev        # necesita .env
```

El `.env` (fuera del repo) lleva `ACP_WS_URL`, `ACP_SECRET`, `ACP_CWD` y `AGENT_BOX_ID`. Si se
pierde, [`scripts/install-goose-unit.mjs`](scripts/install-goose-unit.mjs) reinstala la unidad en la
caja, rota el secreto y reescribe el archivo. Necesita `EASYBITS_API_KEY` y `AGENT_BOX_ID` en el
entorno.

## Lo que hay que saber

- **La caja se suspende sola** al quedar inactiva. La app la despierta al hablarle
  (`ensureAgentBox`), y la unidad de systemd relanza `goose serve` al arrancar. Antes de eso, cada
  suspensión dejaba la app muerta con un 401 que parecía de credenciales.
- **Node 22.16 contra 22.22.** React Router pide ≥ 22.22 y avisa en cada arranque; funciona igual.
  Vale la pena subir la versión para dejar de leer el aviso.
- **Nada se persiste.** Las conversaciones viven en un `Map` del proceso: reiniciar el server las
  borra. Es justo el tema de la [sesión 3](docs/spec3-revivir.md).
- **El permiso se auto-aprueba.** `session/request_permission` se acepta solo, en
  `app/.server/acp.ts`. Tema de la [sesión 4](docs/spec4-permisos-extensiones.md).
- **El botón de parar no interrumpe.** Está dibujado; falta `session/cancel`.
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
