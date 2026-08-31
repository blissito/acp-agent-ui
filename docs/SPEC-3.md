# SPEC-3 — Interfaz propia con SSR (React Router v8)

> Sesión 3 del taller. **La app de este documento es la que vive en la raíz del repo.** La SPA de
> la sesión 2 se conserva en [`legacy/web/`](../legacy/web/) como referencia verificada.
>
> **Estado: ✅ verificado de punta a punta.** Un turno desde el navegador llega al agente, que
> escribe en el disco de su caja y responde con markdown, tokens y costo.

---

## 1. Qué cambia respecto al SPEC-2

| | Sesión 2 (`legacy/web/`) | Sesión 3 (la raíz) |
|---|---|---|
| Render | SPA de Vite servida por `node:http` | SSR con React Router en Express |
| Rutas | `/` y `/c/:id` | 9 rutas, layout compartido |
| Datos | todo por `fetch` desde el cliente | `loader` en el servidor; el HTML ya llega poblado |
| Interfaz | propia, mínima | portada de goose Desktop |
| ACP | `server.mjs` | `app/.server/acp.ts` (mismo motor) |

El agente y el transporte **no cambian**: goose dentro de la caja, hablado por ACP sobre WSS con el
SDK oficial. Lo único que se movió es de qué lado del cable se dibuja la interfaz.

## 2. De dónde sale la interfaz

De `block/goose`, `ui/desktop` (Apache-2.0 — la atribución está en [`NOTICE`](../NOTICE)).
El Desktop es Electron, pero su capa visual es React + Tailwind + Radix + Motion, así que se porta
casi sin tocarla. Se copió tal cual:

- `theme/theme-tokens.ts` — los tres temas (claro, oscuro, aura) como tokens.
- `styles/main.css` → `app/app.css` — la hoja base y el registro de tokens en Tailwind.
- `components/ui/` — las primitivas (button, card, dialog, tabs, input, …).

Se rehízo lo que dependía de Electron o de `goosed`: layout, panel de navegación, Hub, input y el
hilo del chat.

### 2.1 El tema tiene que viajar en cookie

Primer intento: los tokens como CSS estático y un script previo a la pintura que leía
`localStorage` y marcaba la clase en `<html>`. **Rompe la app.** El servidor manda `<html>` sin
clase, el script le pone `class="aura"` antes de hidratar, React ve el desajuste y tira la página
en blanco — con el agravante de que sólo le pasa a quien ya eligió un tema, así que en la primera
visita todo se ve bien.

La versión que funciona (`app/lib/theme.ts`): la preferencia vive en una **cookie**, el `loader` de
`root` la lee y el servidor escribe la clase en el HTML. Sin script, sin parpadeo, sin desajuste.

Y un detalle que cuesta ver: **`light` necesita su propia clase**. Sin clase manda
`prefers-color-scheme`, así que "claro" no hacía nada en una máquina con el sistema en oscuro. Sólo
`system` va sin clase.

### 2.2 Las otras dos trampas del port

- **El reloj del Hub desajusta la hidratación.** La hora del servidor no es la del usuario. El
  reloj arranca en `null` y se llena en el primer efecto.
- **`react-intl` no hacía falta.** Un shim de 30 líneas en `app/i18n.tsx` con la misma firma
  (`defineMessages` / `useIntl`) deja que los componentes copiados funcionen sin editarlos.

## 3. El SSE en una ruta de recurso

`app/routes/api.conversations.$id.events.ts` no renderiza: devuelve un `ReadableStream` que se
mantiene abierto. La baja se cuelga de `request.signal`, y va un `: ping` cada 25 s porque los
proxies impacientes cortan una conexión callada.

El navegador nunca habla ACP. El `EventSource` recibe eventos ya traducidos
(`chunk`, `thought`, `tool`, `usage`, `done`, `error`, `closed`).

## 4. Las rutas

| Ruta | Estado |
|---|---|
| `/` | Hub — reloj, saludo e input. Crea la conversación y navega. |
| `/c/:id` | Chat — markdown en streaming, herramientas, tokens y costo. |
| `/sessions` | Historial de las conversaciones vivas del proceso. |
| `/settings` | Tema (funciona) + la conexión al agente en modo lectura. |
| `/recipes` `/skills` `/apps` `/schedules` `/extensions` | Encabezado y estado vacío. |

Las cinco últimas están en cascarón a propósito: en el Desktop se llenan con endpoints HTTP de
`goosed` que este backend no consume, y el planificador ni siquiera tiene equivalente en ACP. Cada
estado vacío dice qué falta, en vez de fingir contenido.

## 5. Móvil

El panel del Desktop empuja al contenido; en 375 px eso deja el chat en una columna de dos
palabras. Debajo de 768 px el panel pasa a ser un cajón sobre un velo, arranca cerrado y se cierra
al navegar. Verificado en 375×812.

## 6. El agente: que sobreviva a la suspensión

La caja del agente se suspende al quedar inactiva, y al despertar **nadie relanzaba `goose serve`**.
El síntoma era un 401 intermitente que parecía de credenciales y era de que no había servidor.
La caja ahora trae una unidad que arranca sola:

```ini
# /etc/systemd/system/goose-acp.service
[Unit]
Description=goose ACP server
After=network-online.target

[Service]
Type=simple
EnvironmentFile=/root/.config/goose/.env    # provider y modelo del LLM
EnvironmentFile=/etc/goose-acp.env          # GOOSE_SERVER__SECRET_KEY
ExecStart=/usr/local/bin/goose serve --host 0.0.0.0 --port 3000
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
```

### 6.1 `goose serve` escucha en loopback por defecto

`--host` vale `127.0.0.1` y `--port` vale **3284**. El proxy del sandbox llega a la IP de la
microVM, no a su loopback, así que sin `--host 0.0.0.0` el resultado es un **502 mudo**. Medido con
tres cajas:

| Escenario | Escuchando dentro | Resultado |
|---|---|---|
| todo por defecto, expongo 3284 | `127.0.0.1:3284` | ❌ 502 |
| `--host 0.0.0.0`, puerto por defecto | `0.0.0.0:3284` | ✅ ACP responde |
| `--host 0.0.0.0 --port 3000` | `0.0.0.0:3000` | ✅ ACP responde |

Exponer el puerto correcto no basta: la bandera que hace el trabajo es `--host`. Vale como regla
general de las cajas, no como nota al pie — cualquier servicio que quieras alcanzar desde fuera
bindea `0.0.0.0`.

`sandbox_expose_port` **sí sirve `wss://`**: es capa 7 con TLS y Caddy pasa el `Upgrade` nativo. La
misma URL acepta HTTPS y WebSocket; lo único rechazado es L4 crudo (22/23/25/445/3389 → 400).

### 6.2 Un `\n` literal en el secreto

Escribir el archivo del secreto con `printf '%s' 'CLAVE=valor\n'` deja la barra-ene **literal**
pegada al valor: `printf %s` no interpreta escapes en el argumento. goose compara contra un secreto
con basura al final y responde 401 aunque el de la app sea el correcto. `cat -A` lo delata (`\n` en
vez de `$` al cierre). Va `printf 'CLAVE=%s\n' "$valor"`.

### 6.3 Cuánto tarda una caja goose en hablar ACP

Medido por REST (`https://www.easybits.cloud/api/v2`), tres corridas, caja destruida al final:

| Fase | Tiempo |
|---|---|
| `POST /sandboxes` responde | 0.5–1.3 s |
| `status=running` | +1.8 s |
| `goose --version` (viene en la imagen) | +0.6 s |
| `POST /bg` — `goose serve` lanzado | +0.4 s |
| `POST /expose 3000` → URL pública | +0.4 s |
| `initialize` ACP OK | +0.7 s |
| **Total de cero a ACP** | **4.8 / 5.3 / 5.6 s** |

Siempre al primer intento de handshake: cuando `expose` devuelve la URL, goose ya escucha. Ojo con
la versión: la plantilla `goose` de EasyBits trae **1.30.0**, mientras que la caja `goose-demo` de
este POC corre **1.48.0**.

## 7. Correrlo

```sh
npm install
cp .env.example .env    # y llénalo
npm run dev             # Vite + SSR
npm run build && npm start    # producción, Express
```

El `.env` (fuera del repo, ver `.env.example`) lleva `ACP_WS_URL`, `ACP_SECRET`, `ACP_CWD` y `AGENT_BOX_ID`.
`react-router dev` no carga `.env` por su cuenta: las variables las lee `process.env` del servidor,
de ahí el `--env-file` dentro de los scripts de `package.json`.

Requiere Node ≥ 22.22 (React Router lo avisa; con 22.16 funciona pero se queja).

## 8. Verificado

- `npm run typecheck` limpio.
- SSR: `GET /` 200 con los tokens del tema ya en el HTML.
- Sin errores de consola en 1440×900 ni en 375×812 (Playwright headless).
- Los cuatro temas responden con el sistema en claro **y** en oscuro, y sobreviven la recarga.
- Una cookie de tema preexistente ya no rompe la hidratación.
- El cajón de navegación abre, tapa con velo y cierra al navegar.
- WSS: `initialize` OK con `X-Secret-Key`, **401 sin él** (la auth no quedó abierta).
- **Turno real**: el prompt llegó al agente, creó `/root/web3-ok.txt` con `WEB3_OK` en el disco de
  su caja, respondió "listo", y llegaron `usage` (5,017 tokens, $0.0004) y `end_turn`.

## 9. Lo que falta

- **Nada se persiste.** Las conversaciones viven en un `Map` del proceso: un reinicio las borra.
  El historial del Desktop sí persiste, contra el disco de la caja.
- **El botón de parar no interrumpe.** Está dibujado, pero falta `session/cancel`.
- Las cinco vistas en cascarón (§4).
- **Propuesta para EasyBits** (no es de este POC): que `expose` mire qué está escuchando y, si sólo
  ve `127.0.0.1:<puerto>`, devuelva la URL con una advertencia clara en vez de dejar caer un 502
  mudo. El problema no es la regla, es el diagnóstico.
