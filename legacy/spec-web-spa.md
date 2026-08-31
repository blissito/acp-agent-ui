# Spec 2 — Día 2 · Interfaz web + backend que consume el agente por WSS/ACP con el SDK oficial

> Taller: **Día 2**. Nace de [`SPEC-1.md`](SPEC-1.md) (día 1: agente **goose** oficial en caja
> EasyBits, LLM = EasyBits). Este spec cubre el **backend + interfaz web** que habla con ese agente.
>
> **Decisión de arquitectura (2026-08-30):** el transporte se hace con el **SDK oficial de ACP**
> (`@agentclientprotocol/sdk` v1.4.0) por **WebSocket** (`goose serve` → `wss://`), **no** con
> `ssh` + ACP a mano. Verificado contra goose en vivo: el SDK 1.4.0 hace `initialize` →
> `buildSession().start()` → `session.prompt()` → `readText()` sin los problemas de schema que
> tenían las versiones viejas del SDK (ver §16.1).
>
> Última actualización: 2026-08-30.

---

# PARTE 1 — Backend + Web en un solo server

## 1. Objetivo (Parte 1)

Una página de **chat en el navegador** que habla con el agente de la caja a través de **un único
server**, manteniendo al agente **aislado en su microVM** (su disco y su shell, no los del server).
El server usa el **SDK oficial de ACP** para consumir el agente por **WebSocket** y streamea la
respuesta al navegador por **SSE**. Un solo proceso, un solo puerto.

## 2. Arquitectura

```text
[ Navegador ]  →  http://localhost:4000
        │
        ▼
[ UN server:  node server.mjs ]                     (:4000)
   - SPA estática: client/dist (index.html + assets) + fallback a index.html (RRv7)
   - API:  POST /conversations · GET /conversations/:id/events (SSE) · POST .../messages · DELETE
   - por conversación: 1 conexión ACP vía SDK (`client()` + `createWebSocketStream`)
   - stream de updates ACP → eventos SSE al navegador
        │
        ▼
[ edge EasyBits: wss://sb-<uuid>-3000.sandboxes.easybits.cloud/acp ]  (TLS + Upgrade nativo)
        │
        ▼
[ microVM EasyBits: goose-demo ]    (SPEC-1)
   - goose serve (servidor ACP sobre HTTP/WebSocket, --host 0.0.0.0 --port 3000)
   - LLM = EasyBits (chat/completions)
   - el agente opera el disco de la caja
```

> **Cambio vs. la versión anterior (SSH):** ya no hay `ssh`, ni `~/.ssh/config`, ni llave privada en
> el app, ni `ProxyCommand`. El backend habla `wss://` directo con el SDK oficial.

### Variables / config del server (env)

| Variable | Default | Uso |
|---|---|---|
| `ACP_WS_URL` | `wss://sb-<id>-3000.sandboxes.easybits.cloud/acp` | endpoint WebSocket del agente |
| `ACP_SECRET` | (vacío = sin auth) | `GOOSE_SERVER__SECRET_KEY` del agente; se manda como header `X-Secret-Key` |
| `ACP_CWD` | `/root` | cwd de la sesión del agente |
| `ACP_AUTO_APPROVE` | `1` | auto-aprueba herramientas (`0` = pedir) |
| `PORT` | `4000` | puerto del server |
| `MAX_CONVERSATIONS` | `10` | tope de conversaciones simultáneas (`429` si se pasa) |
| `ACP_IDLE_MS` | `15 min` | cerrar sesión inactiva (libera el slot) |

## 3. Backend (`legacy/web/server.mjs`, Node puro `node:http`)

### 3.1 `GooseSession` (1 por conversación) — con el SDK oficial

```js
import { client } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";   // Node: el SDK usa `ws` para el transporte

// 1 conexión ACP por conversación
const stream = createWebSocketStream(ACP_WS_URL, {
  WebSocket,
  headers: ACP_SECRET ? { "X-Secret-Key": ACP_SECRET } : undefined,
});
const conn = client({ name: "acp-web", version: "1.0.0" }).connect(stream);
const ctx = conn.agent;

// handshake + sesión
await ctx.request("initialize", {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
});
const session = await ctx.buildSession({ cwd: ACP_CWD, mcpServers: [] }).start();
// → session.sessionId, session.prompt(text), session.readText(), session.nextUpdate()
```

- **`client()` + `createWebSocketStream`**: el SDK oficial manda **frames de texto** (no binarios),
  así que no hay el bug de "goose no responde a binario" (ver §16.1).
- **`ctx.buildSession(...).start()`** reemplaza el `session/new` a mano; devuelve `ActiveSession`
  con `prompt()`, `readText()` (texto acumulado) y `nextUpdate()` (updates tipados).
- **Permisos**: el agente llama `session/request_permission` hacia el cliente. Se responde con un
  handler en el `ClientApp`:

  ```js
  app.onRequest("session/request_permission", ({ params }) =>
    ACP_AUTO_APPROVE
      ? { outcome: { outcome: "selected", optionId: "allow_once" } }
      : pedirAlUsuario(params)   // en la versión interactiva
  );
  ```

- **Streaming**: se lee `nextUpdate()` en un loop; cada `agent_message_chunk` / `tool_call` /
  `usage_update` se emite como evento SSE. `session.prompt()` resuelve con el `stopReason`.
- **Cleanup**: `session.dispose()` y `conn.close()` al cerrar la conversación o por idle timeout.

> **Qué NO se hace a mano ya**: `initialize`, `session/new`, `session/prompt`, el parseo de
> `session/update`, ni el framing JSON-RPC. Todo lo da el SDK.

### 3.2 Endpoints (sin cambios respecto al diseño anterior)

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/` (y cualquier GET no-API) | sirve el SPA build; **fallback a `index.html`** para rutas del router |
| `POST` | `/conversations` | crea `GooseSession` + handshake; devuelve `{ conversationId }` (o `429`) |
| `GET` | `/conversations/:id/events` | **SSE** (streaming) |
| `POST` | `/conversations/:id/messages` | `{ text }` → `session.prompt(text)`; devuelve `{ queued: true }` |
| `DELETE` | `/conversations/:id` | `session.dispose()` + `conn.close()` |
| `OPTIONS` | cualquier | preflight CORS |

### 3.3 Protocolo SSE

`event: <tipo>` + `data: {json}`:

| Tipo | Campos | Significado |
|---|---|---|
| `started` | `{ sessionId }` | sesión ACP lista |
| `chunk` | `{ text }` | trozo de la respuesta del agente |
| `tool` | `{ title, status }` | el agente usa una herramienta |
| `usage` | `{ used, size, cost }` | uso del turno (tokens/costo) |
| `done` | `{ stopReason, usage }` | turno terminado |
| `error` | `{ message }` | error (conexión, LLM, timeout) |
| `closed` | `{ code }` | sesión cerrada |

## 4. Frontend (`legacy/web/client/` — Vite + React Router v7 + Streamdown) — **sin cambios**

Igual que el diseño ya probado: Vite + React 18/19 + React Router v7 (`createBrowserRouter`), rutas
`/` (Home) y `/c/:id` (Chat), `EventSource` para SSE, Streamdown para markdown en vivo, auto-scroll
y foco en el input. Ver §17 para los lineamientos de UI.

## 5. Modelo de sesión / concurrencia / costo

- **1 conexión ACP = 1 conversación = 1 `ActiveSession`.** Vive mientras la conversación exista.
- **Tope** `MAX_CONVERSATIONS` (default `10`); al pasarse → `429`.
- **Idle timeout** `ACP_IDLE_MS` (default 15 min) cierra sesión y libera el slot.
- **Costo**: cada turno reporta `usage` (tokens + USD) → el backend acumula por conversación.

## 6. Seguridad

- El server **no conoce la key del LLM** (vive en `/root/.config/goose/.env` de la caja, root-only).
- **Auth de ACP obligatoria en producción**: `GOOSE_SERVER__SECRET_KEY` en goose, y el backend manda
  `X-Secret-Key` en el handshake. **No** usar `--dangerously-unauthenticated` fuera de demo local:
  `/acp` es control total del agente (lee archivos, ejecuta shell). El edge ya termina TLS
  (`wss://`), así que el secret es la única barrera y **debe** estar.
- El navegador **nunca** habla con goose directo: solo con `server.mjs` por SSE. La URL y el secret
  del agente no se exponen al cliente.

## 7. Receta de ejecución

```bash
# 1) build del SPA (una vez)
cd legacy/web/client && npm install && npm run build

# 2) un solo server (SPA + API + SSE) en :4000
cd legacy/web
PORT=4000 \
ACP_WS_URL="wss://sb-<id>-3000.sandboxes.easybits.cloud/acp" \
ACP_SECRET="$GOOSE_SERVER__SECRET_KEY" \
node server.mjs

# 3) abrir
open http://localhost:4000
```

**Persistente (launchd):** plist que define `PATH` y `HOME` (el gotcha de "ssh no lee
`~/.ssh/config` ya no aplica porque no hay ssh; sigue aplicando para encontrar `node`).

## 8. Evidencia verificada

| Ítem | Resultado |
|---|---|
| SDK oficial 1.4.0 contra goose por WSS | ✅ `initialize` → goose 1.48.0 · `buildSession` · `prompt` → `end_turn` |
| `session.readText()` | ✅ devuelve el texto acumulado (`STREAM_OK`) |
| Schema 1.4.0 (messageId, usage_update, session_info_update) | ✅ incluido; **no** hay `-32602` (ver §16.1) |
| SSH/ACP a mano (versión anterior) | ✅ probado 2026-08-28; queda reemplazado por el SDK |

> **Pendiente de construir/verificar (este refactor):** `server.mjs` con el SDK integrado de punta a
> punta (endpoints + SSE + idle + `429`). El probe del SDK se hizo aislado; falta integrarlo al server.

## 9. Criterios de aceptación (Parte 1)

1. `node server.mjs` = un solo server con la web y la API en `:4000` (SPA + fallback RRv7).
2. `POST /conversations` crea la conexión ACP vía SDK; el chat muestra la conversación.
3. Un mensaje llega al agente y los `chunk` se ven **en vivo** (SSE).
4. Multi-turno en la misma conversación.
5. El agente opera en el disco de la caja; el server no guarda estado del agente.
6. Se reporta **costo/tokens** (`usage`).
7. Tope de concurrencia + idle + cleanup (sin `429` persistente).
8. Frontend **Vite + React Router v7 + Streamdown**; input mantiene el foco; auto-scroll.
9. Corre con **Node puro** (backend) y sin `npm install` extra en runtime (SPA ya builded).

---

# PARTE 2 — Publicar el app en una caja de EasyBits (link público)

## 10. Objetivo (Parte 2)

Publicar el app (server único) en **otro sandbox de EasyBits** y exponerlo con un **link público**:
el app caja habla por `wss://` a la **caja del agente** (goose-demo), y el navegador consume la URL
pública del app.

## 11. Arquitectura

```text
[ Navegador ] → https://sb-<id>-4000.sandboxes.easybits.cloud
        │
        ▼
[ CAJA APP: webapp (dev-box) ]      ← corre `node server.mjs` (systemd)
   - SDK oficial de ACP (npm) + `ws`
   - habla wss://<goosebox>-3000.../acp  (X-Secret-Key si hay secret)
        │
        ▼
[ CAJA AGENTE: goose-demo ]         (SPEC-1)
   - goose serve (deepseek-v4-flash · EasyBits)
```

## 12. Receta de despliegue

1. `sandbox_create` (template `dev-box`, `name=webapp`) → `APP_SANDBOX_ID`.
2. En la caja app: `npm install` (deps: `@agentclientprotocol/sdk`, `ws`) + copiar `server.mjs` +
   `client/dist` (tar).
3. Unit systemd `/etc/systemd/system/acpweb.service` (env: `PORT`, `ACP_WS_URL`,
   `ACP_SECRET`) → `systemctl enable --now acpweb`.
4. `sandbox_expose_port(4000)` → URL pública.
5. Verificar: `GET /` = 200, `POST /conversations`, turno SSE (`end_turn`).

> **Nota:** ya no hay `easybits login` ni `~/.ssh/config` ni llave privada en la caja app. Solo la
> URL WSS del agente (y su secret, si lo hay).

## 13. Evidencia

```text
GET /           → 200 text/html
POST /conversations → c05639e7-…
SSE: started · chunk · usage · done end_turn
```

## 14. Ciclo de vida del agente (wake-on-demand) — lo hace el app

**Sin cambios respecto al diseño anterior** salvo el transporte: el app sigue gestionando
`suspend()`/`resume()`/`forkFromSnapshot` con `@easybits.cloud/sdk`. Lo único nuevo: tras
`resume()`/`forkFromSnapshot`, hay que asegurar que **`goose serve` esté corriendo** (systemd o
re-lanzarlo en `ensureAgentBox()`), no solo el sshd.

| Variable | Default | Uso |
|---|---|---|
| `AGENT_BOX_ID` | `sb_d6a36806-…` | id de la caja del agente |
| `AGENT_SNAPSHOT_ID` | `snap_9f31ad94-…` | snapshot para self-heal |
| `EASYBITS_API_KEY` | (o `/root/.ebkey`) | key del SDK de EasyBits |
| `ACP_IDLE_MS` | `900000` | tiempo de idle antes de suspender |

## 15. Notas

- **Dos cajas distintas.** El **app** vive en una caja (`webapp`, link público); su `server.mjs`
  habla `wss://` a la **caja del agente** (`goose-demo`). El agente opera su propio disco; el app no
  ve su filesystem.
- Cajas **efímeras**: usar `sandbox_extend` o promover a **permanente** para producción.
- El app caja **no** maneja la key del LLM (vive en la caja del agente); solo tiene la URL WSS y el
  secret de ACP.
- **Persistencia pendiente** (del diseño anterior, sigue aplicando): `allow_shell = true` y
  `terminal: true` son volátiles; hornearlos en el snapshot o reescribirlos en `ensureAgentBox()`.

## 16. Transporte WSS con el SDK oficial (el camino principal, no "variante")

> **Por qué SDK y no ACP a mano.** El SDK oficial es del propio protocolo (`agentclientprotocol`
> org), trae cliente **y** servidor, y su schema 1.4.0 está completo (messageId, usage_update,
> session_info_update). Verificado contra goose en vivo. Escribir JSON-RPC a mano ya no aporta nada.

**Servidor en la caja del agente (SPEC-1 §5.1):**

```bash
export GOOSE_PROVIDER=openai GOOSE_MODEL=deepseek-v4-flash \
  OPENAI_BASE_URL=https://www.easybits.cloud/api/v2/llm/v1 \
  OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' /root/.config/goose/.env)"
# --host 0.0.0.0 obligatorio (default 127.0.0.1); en producción, secret en vez de --dangerously-unauthenticated
exec /usr/local/bin/goose serve --host 0.0.0.0 --port 3000 --dangerously-unauthenticated
```

`sandbox_expose_port(3000)` → `wss://sb-<uuid>-3000.sandboxes.easybits.cloud/acp`.

**Lado cliente (backend), con el SDK:**

```js
import { client } from "@agentclientprotocol/sdk";
import { createWebSocketStream } from "@agentclientprotocol/sdk/experimental/ws-client";
import { WebSocket } from "ws";

const stream = createWebSocketStream(ACP_WS_URL, { WebSocket, headers: { "X-Secret-Key": ACP_SECRET } });
const conn = client({ name: "acp-web", version: "1.0.0" }).connect(stream);
await conn.agent.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
const session = await conn.agent.buildSession({ cwd: "/root", mcpServers: [] }).start();
const result = await session.prompt("hola");        // { stopReason, usage }
const text  = await session.readText();             // texto acumulado del turno
```

### 16.1 Gotchas del spike UI (2026-08-30) — resueltos por el SDK oficial

Tres bugs encontrados con `use-acp` (que usa el SDK **viejo** 0.4.9). El SDK 1.4.0 los resuelve:

1. **h2/upgrade**: el edge negocia HTTP/2 y goose no soporta upgrade WS sobre h2 → 406. El backend
   Node habla HTTP/1.1 (por defecto) → no aplica. (Solo afecta a un navegador que hable directo.)
2. **frames binarios**: `use-acp` mandaba `ws.send(Uint8Array)` y goose solo responde a texto.
   El SDK 1.4.0 `createWebSocketStream` manda **frames de texto** → resuelto.
3. **schema viejo**: el SDK 0.4.9 descartaba `messageId` y rechazaba `usage_update`/
   `session_info_update` (`-32602`). El 1.4.0 los incluye → resuelto.

**Lección de UI (razonamiento vs respuesta):** goose stremea `agent_thought_chunk` (razonamiento) y
`agent_message_chunk` (respuesta) por separado. La UI debe separarlos (bloque colapsable
"🧠 razonamiento" vs respuesta visible), no concatenarlos.

## 17. Lineamientos de UI (qué construir y con qué) — para que el agente decida, no improvise

> **Problema que resuelve.** §4 describe el frontend por piezas técnicas; §9 da criterios
> funcionales. Esta sección fija el **qué** y el **con qué**, y obliga a **preguntar las decisiones
> abiertas** antes de construir, usando **herramientas de la comunidad**.

### 17.1 Reglas de oro

1. **Pregunta antes de codear** las decisiones de §17.4.
2. **Design system, no CSS crudo**: Tailwind + `shadcn/ui` (o Radix).
3. **ACP se consume en el backend con el SDK oficial** (`@agentclientprotocol/sdk` v1.4.0), no en el
   navegador. El frontend habla **SSE** con `server.mjs`.
4. **Markdown en vivo** con `streamdown` (o `react-markdown` + `remark-gfm`).
5. **Cero "se ve feo"**.

### 17.2 Stack recomendado (comunidad, verificado en npm)

| Pieza | Paquete | Dónde |
|---|---|---|
| Protocolo | `@agentclientprotocol/sdk` v1.4.0 (oficial) | **backend** (Node) |
| Transporte WS | `ws` (constructor para el SDK) | **backend** |
| Markdown | `streamdown` o `react-markdown` + `remark-gfm` | frontend |
| UI kit | `shadcn/ui` (Radix) + Tailwind | frontend |
| Iconos | `lucide-react` | frontend |
| Toasts | `sonner` | frontend |
| Animación | `framer-motion` (opcional) | frontend |

> **`use-acp` (React hooks) quedó descartado para producción**: corre en el navegador y depende del
> SDK viejo (0.4.9) con los bugs de §16.1. Sirvió solo para descubrir esos gotchas. En el backend se
> usa el SDK oficial; el navegador habla SSE con `server.mjs`.

> **Gotcha Streamdown v2 (ya mordió en el taller, 2026-08-30).** `streamdown@2` renderiza utilidades
> Tailwind + tokens shadcn (`bg-muted`, `border-border`, `text-muted-foreground`, `bg-sidebar`,
> `text-primary`, `list-disc`, `font-semibold`, `text-3xl`…). **Sin Tailwind esos componentes salen
> sin fondos/bordes/espaciado y las tablas desbordan.** Por eso el markdown se veía "roto".
> El camino correcto (ya aplicado en `legacy/web/client`) es **oficial**:
>
> 1. Tailwind v4: `npm i -D tailwindcss @tailwindcss/vite` + plugin en `vite.config.js`.
> 2. En `styles.css`: `@import "tailwindcss";` y `@source "../node_modules/streamdown/dist/*.js";`
>    (ruta relativa desde el CSS al `node_modules` que contiene `streamdown`).
> 3. Definir los **design tokens** shadcn (`--background`, `--foreground`, `--card`, `--muted`,
>    `--muted-foreground`, `--border`, `--input`, `--primary`, `--sidebar`, `--ring`, `--radius`)
>    y mapearlos en `@theme inline` (`--color-*: var(--*)`) para que `bg-background`,
>    `border-border`, etc. resuelvan.
> 4. El CSS propio de la SPA debe vivir en **clases** (`.msg`, `.chat-foot`…), no en selectores de
>    elemento (`h1`, `ul`, `button`…) que Streamdown también usa: sin capa, el CSS sin layer le gana
>    a las utilidades de Tailwind y rompe el markdown otra vez.
>
> **Decisión: se adoptó Tailwind v4 + tokens oficiales (neutral shadcn). El markdown ya no lleva CSS
> a mano; Streamdown se estiliza solo.**

### 17.3 Componentes y estados obligatorios (checklist de UI)

| Componente | Requisito |
|---|---|
| Conversación | mensajes `user` / `bot` / `tool` con roles diferenciados |
| Razonamiento | `agent_thought_chunk` como bloque colapsable "🧠 razonamiento", separado de la respuesta |
| Streaming | los `chunk` se pintan en vivo |
| Permisos | `session/request_permission` → allow / deny / allow-once (chip o modal) |
| Herramientas | cada `tool` como chip/linea con título |
| Costo/tokens | pie con `usage` (tokens + USD) por turno y acumulado |
| Estados | `conectando` / `pensando…` / `listo` / `error` / `cerrado` |
| Vacío | bienvenida con hint del nombre del agente |
| Entrada | habilitada durante el turno, foco, Enter envía |
| Auto-scroll | scroll interno (`100dvh` + `flex:1; min-height:0`) |
| Errores | visibles como mensaje, no excepción de consola |
| Responsive | usable en móvil |

### 17.4 Decisiones abiertas (el agente DEBE preguntar antes de construir)

1. **Tema**: solo oscuro, solo claro, o `system` con toggle.
2. **Layout**: chat puro o sidebar de conversaciones; historial en memoria o persistente.
3. **Permisos**: inline o modal; default `allow_once`, `ask`, o modo `approve`.
4. **Identidad/agente**: nombre fijo (ej. "Gansito" vía `GOOSE_MOIM_MESSAGE_TEXT`), avatar.
5. **Marca**: colores/acento propios o neutral; logo.
6. **Multi-agente**: un agente por conversación o selector.
7. **Persistencia**: conversaciones en memoria (actual) o en disco/SQLite.

### 17.5 Do/Don't de UX

| ✅ Do | ❌ Don't |
|---|---|
| input con foco y habilitado todo el turno | deshabilitar el input mientras responde |
| scroll interno dentro del chat | scroll de la página entera |
| markdown en vivo | texto plano o markdown sin renderizar |
| estados visibles | pantalla muda sin feedback |
| chips de herramientas y permisos | log de JSON crudo |
| costo/tokens al pie | ocultar el consumo |
| accesible (focus, `aria`, contraste) | divs sin semántica ni foco |

### 17.6 Criterios de aceptación de UI

1. Design system elegido (Tailwind + shadcn/ui), no CSS a mano.
2. Streaming en vivo (chunk → pantalla).
3. Permisos con confirmación; herramientas como chips.
4. Estados y errores visibles; bienvenida en vacío.
5. Input habilitado + foco durante el turno; Enter envía; auto-scroll.
6. Responsive en móvil.
7. Cero "se ve feo".
