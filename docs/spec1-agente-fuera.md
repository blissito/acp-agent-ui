# Spec 1 — Día 1 · Agente ACP en caja EasyBits consumido por SSH

> Sesión 1 del taller: el agente viviendo fuera de tu compu. Sigue
> [la sesión 2](spec2-ui-solida.md), que le pone interfaz.

> Taller: **Día 1**. Estado: **probado** de punta a punta (incluido **multi-turno** y **REPL interactivo**).
> Este spec es la **base**; de él nace la [sesión 2](spec2-ui-solida.md), la interfaz que lo consume.
> Última actualización: 2026-08-28 · Objetivo: verificar el patrón de consumo de un agente (goose)
> **oficial**, en una **caja limpia de EasyBits**, vía **ACP sobre SSH (túnel 443)**.

---

## 1. Objetivo

**Ese día 1** se demuestra y especifica cómo se consume un agente por el **Agent Client Protocol (ACP)**
desde un cliente remoto, con el agente corriendo **dentro de una microVM de EasyBits** y el cliente
llegando a ella **por SSH (túnel sobre 443)**. El terreno de la demo = **todo EasyBits** (la caja, el
LLM vía catálogo de EasyBits y el runtime del agente). El objetivo de producto es **un backend +
interfaz web** que hable con ese agente por SSH/ACP.

**Por qué goose y no ghosty:** ghosty `0.0.15` le habla a los proveedores por **Responses API
(`/v1/responses`)**, que EasyBits no implementa (solo expone **`chat/completions`**) → 404 con
HTML. **Goose 1.48** usa `chat/completions`, que EasyBits sí implementa.

### Variables que el estudiante reemplaza (cuenta propia)

Cada estudiante abre su cuenta en [easybits.cloud](https://www.easybits.cloud) y crea su **API key**
en [Dashboard → Developer](https://www.easybits.cloud/dash/developer). La misma `EASYBITS_API_KEY`
sirve para el LLM y para el MCP. Sustituye estas variables en los comandos de la sección 4:

- **`EASYBITS_API_KEY`** — tu llave `eb_sk_live_...`. Usos: `easybits login` y `.env` de goose.
- **`SANDBOX_ID`** — id que devuelve `sandbox_create`. Uso: host del túnel `ssh <SANDBOX_ID>.ghosty`.
- **`SSH_KEY`** — ruta a tu **llave privada** (ej. `~/.ghosty/sb_ed25519`). Uso: `ssh -i $SSH_KEY`.
- **`SSH_PUBKEY`** — `"$(cat $SSH_KEY.pub)"`. Uso: `sandbox_ssh_enable`.
- **`GOOSE_MODEL`** — `deepseek-v4-flash` (o `deepseek-v4-pro`). Uso: `.env` de goose.
- **`OPENAI_BASE_URL`** — `https://www.easybits.cloud/api/v2/llm/v1`. Uso: `.env` de goose.

> La **key del LLM nunca sale de la caja**: queda en `/root/.config/goose/.env` dentro del sandbox. El
> cliente/backend sólo necesita la **llave SSH** (`SSH_KEY`).

---

## 2. Arquitectura (components)

```text
[ Navegador ]
     │  SSE / WebSocket
     ▼
[ Backend (Node/Express) ]        ← fase 2 (diseño)
     │  ACP (JSON-RPC newline) por SSH
     ▼        stdio del proceso `ssh`
[ tunel HTTP/SSE 443 → easybits ssh-proxy ]   ← ProxyCommand en ~/.ssh/config
     │
     ▼
[ microVM EasyBits: dev-box ]      ← caja limpia (sandbox)
     - goose 1.48.0 (oficial)  → `goose acp`  (servidor ACP stdio)
     - /usr/local/bin/goose-acp (launcher: env + exec goose acp)
     - LLM = EasyBits   (`GOOSE_PROVIDER=openai`, base_url = EasyBits)
     - archivo/sesión del agente en el disco de la caja
```

Flujo verificada:

1. Cliente abre `ssh <caja> "goose-acp"` (launcher).
2. goose arranca como **servidor ACP sobre stdio**; el stdio del cliente queda unido al stdio
   de goose **a través del túnel**.
3. Cliente ACP envía `initialize` → responde goose (`agentInfo goose 1.48.0`).
4. `session/new` → `sessionId`.
5. `session/prompt` → goose streamea `session/update` `agent_message_chunk` y responde
   `stopReason: end_turn` + `usage_update` (tokens/costo).
6. El agente ejecuta herramientas **en el disco de la caja** (no del cliente).

---

## 3. Resultados verificados del POC

| Ítem | Resultado |
|---|---|
| `goose acp` responde `initialize` | ✅ `agentInfo { name: goose, version: 1.48.0 }` |
| `session/new` | ✅ devuelve `sessionId` |
| `session/prompt` (turno) | ✅ `stopReason: end_turn`, streameó chunks |
| Multi-turno (misma sesión) | ✅ dos `session/prompt` sobre el mismo `sessionId` → `end_turn` en ambos |
| LLM vía EasyBits | ✅ `GOOSE_EASYBITS_OK` (test `goose run -t`) |
| Uso de ejemplo | 5 104 tokens · costo **$0.00068 USD** |
| Agente escribe en la caja | ✅ `/root/hola-acp.txt` = `hola desde ACP por SSH` (en el sandbox, no en la Mac) |
| Transporte SSH | ✅ túnel 443 (`easybits ssh-proxy`), sin depender de puerto alto |
| Template | ✅ `dev-box` (declara puerto 22, `translate: true`) — soporta `ssh_enable` |

---

## 4. Receta reproducible (lo que se hizo)

### 4.1 Caja limpia

- Template: `dev-box` (Debian 12, x86_64, Node 22, git, curl; nace sin credenciales).
- `sandbox_create` (template `dev-box`, `name=goose-demo`) → devuelve **`SANDBOX_ID`**; esperar `running`.
- `sandbox_ssh_enable` (con **`SSH_PUBKEY`** dedicada) → devuelve endpoint directo y **comando de túnel**
  (`ssh <SANDBOX_ID>.ghosty`).

### 4.2 SSH por túnel (recomendado; el puerto alto es fallback)

```bash
# CLI del proxy (una sola vez, con TU llave)
npm i -g @easybits.cloud/cli
easybits login "$EASYBITS_API_KEY"

# En ~/.ssh/config
Host *.ghosty
  ProxyCommand "$(command -v easybits)" ssh-proxy %h
  User root
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
  LogLevel ERROR
```

Acceso: `ssh -i $SSH_KEY <SANDBOX_ID>.ghosty`. El túnel **no autentica** (mueve bytes); la sesión SSH se
autentica de punta a punta contra el sshd de la caja (llave inyectada).

**Nota de llaves (bug que se encontró):** el síntoma "el túnel llega al sshd pero la llave no
autoriza" fue por **desajuste de llaves** (la pública inyectada no correspondía a la privada usada),
**no** por el template. Solución: usar un par fresco (privada+pub) y `ssh_enable` con esa pública.

### 4.3 Instalar goose oficial

```bash
export HOME=/root CONFIGURE=false GOOSE_BIN_DIR=/usr/local/bin
curl -fsSL https://github.com/aaif-goose/goose/releases/latest/download/download_cli.sh -o /tmp/gl.sh
bash /tmp/gl.sh
goose --version   # 1.48.0
```

### 4.4 Configurar LLM = EasyBits

goose **no** auto-carga `~/.config/goose/.env` para elegir proveedor/modelo → se leen de **env**.
La key se guarda en `/root/.config/goose/.env` (root-only) y un **launcher** la inyecta:

```bash
# /root/.config/goose/.env
GOOSE_PROVIDER=openai
GOOSE_MODEL=deepseek-v4-flash
OPENAI_API_KEY=<TU_EASYBITS_API_KEY>   # ← tu llave eb_sk_live_...
OPENAI_BASE_URL=https://www.easybits.cloud/api/v2/llm/v1
```

```bash
# /usr/local/bin/goose-acp  (chmod 700)
#!/bin/bash
export GOOSE_PROVIDER=openai
export GOOSE_MODEL=deepseek-v4-flash
export OPENAI_BASE_URL=https://www.easybits.cloud/api/v2/llm/v1
export OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' /root/.config/goose/.env)"
exec /usr/local/bin/goose acp "$@"
```

Probar LLM: `goose run -t "Responde exactamente: GOOSE_EASYBITS_OK"` → `GOOSE_EASYBITS_OK`.

### 4.5 Cliente ACP (cómo hablarle al agente)

Tres scripts en `acp-ghosty-poc/` que Spawnean `ssh -i $SSH_KEY <SANDBOX_ID>.ghosty "goose-acp"`:

| Script | Qué hace |
|---|---|
| `ssh_client.mjs` | **One-shot**: `initialize` + `session/new` + un `session/prompt`. Sin memoria entre llamadas. |
| `ssh_repl.mjs` | **REPL multi-turno**: mantiene la sesión viva y lee mensajes por stdin. |
| `multi_turn.mjs` | Probe: confirma 2 `session/prompt` sobre la misma sesión. |

Todos usan `clientCapabilities.fs = false` (el disco del agente es el de la caja) y responden a
`session/request_permission` con `allow_once` (auto-aprueba herramientas). Variables de entorno que
aceptan: `ACP_BOX` (host `*.ghosty`), `ACP_KEY` (llave privada), `ACP_CWD` (cwd de la sesión),
`ACP_AUTO_APPROVE=0` (para pedir permiso manualmente en el REPL).

**Interactuar** (desde tu terminal):

```bash
cd acp-ghosty-poc
node ssh_repl.mjs                 # chat interactivo multi-turno
node ssh_client.mjs "un mensaje"  # one-shot
```

---

## 5. Superficie ACP de goose

| Comando | Uso |
|---|---|
| `goose acp` | Servidor **ACP sobre stdio** (editor local/caja remota). El usado en el POC. |
| `goose serve` | Servidor **ACP por HTTP/WebSocket** (para exponer por URL). |
| `goose run -t <texto>` | One-shot por la terminal. Ultil para diagnosticar el LLM. |
| `goose configure` | Config interactiva (provider/model) — escribe `~/.config/goose/config.yaml`. |

### 5.1 Variante WSS (sin SSH, sin cloudflared)

> **EasyBits termina TLS en el edge.** `sandbox_expose_port` **no** da HTTP plano: expone
> `https://sb-<uuid>-<port>.sandboxes.easybits.cloud` con **cert wildcard** para `*.sandboxes.easybits.cloud`
> (Caddy en el edge). Dominios custom (CNAME) sacan su cert por **on-demand TLS**.
>
> El mismo hostname sirve **WSS sin nada extra**: el reverse proxy pasa `Upgrade: websocket` nativo y ya
> corre en producción. Ej.: el endpoint ACP de Ghosty es
> `wss://sb-<uuid>-3000.sandboxes.easybits.cloud/acp`. Sobre la misma ruta hay además un túnel
> **SSH-sobre-WebSocket**.
>
> **Conclusión:** fuera cloudflared y fuera puerto raw. Se expone el puerto y se habla `wss://` contra la
> URL pública.

**Flujo WSS (goose, para editor):**

1. En la caja, `goose serve` en un puerto (ej. `3000`), en background.
2. `sandbox_expose_port 3000` → `wss://sb-<uuid>-3000.sandboxes.easybits.cloud` (misma URL, `https`/`wss`).
3. Local, el puente `ghosty-acp` (npm) une stdio↔WebSocket:
   `ghosty-acp wss://sb-<uuid>-3000.sandboxes.easybits.cloud`
4. El editor (VSCode/Zed/Neovim, plugin ACP) habla con `ghosty-acp` por stdio.

> `ghosty-acp` (`npm i -g ghosty-acp`, v0.0.2, sin deps) es el puente oficial del taller: conecta tu
> editor a un agente ACP remoto, sin tocar SSH en el cliente. Requiere Node 22+; en VS Code hace falta
> además la extensión **ACP Client**.

**Verificado en el taller (2026-08-30), goose por WSS:**

```bash
# dentro de la caja (el endpoint /acp no exige secret si usas --dangerously-unauthenticated)
export GOOSE_PROVIDER=openai GOOSE_MODEL=deepseek-v4-flash \
  OPENAI_BASE_URL=https://www.easybits.cloud/api/v2/llm/v1 \
  OPENAI_API_KEY="$(sed -n 's/^OPENAI_API_KEY=//p' /root/.config/goose/.env)"
/usr/local/bin/goose serve --host 0.0.0.0 --port 3000 --dangerously-unauthenticated
```

| Hallazgo | Detalle |
|---|---|
| `goose serve` exige auth | Sin `--dangerously-unauthenticated`, exige `GOOSE_SERVER__SECRET_KEY` (fail-closed) |
| `--host 0.0.0.0` | Obligatorio: el default es `127.0.0.1` y el edge no llega |
| Endpoint `/acp` dual | Sirve **WebSocket** (GET + `Upgrade: websocket`) y **SSE** (`Accept: text/event-stream`, requiere header `Acp-Connection-Id`) |
| Handshake WS | Da `101 Switching Protocols`; hay que negociar HTTP/1.1 (curl con HTTP/2 tira los headers de upgrade) |
| Probe e2e | `initialize` → `agentInfo goose 1.48.0` · `session/new` · `session/prompt` → `ACP_WSS_OK` |
| Identidad persistente | `GOOSE_MOIM_MESSAGE_TEXT` inyecta instrucciones cada turno (ej. nombre del agente) |
| Latencia primer turno | Tras conectar, el primer prompt puede tardar unos segundos (caja fría) |

---

## 6. Opcional — ghosty como agente (en vez de goose)

Alternativa al agente goose: usar **ghosty** (ghostycode). Verificado en el taller: **ghosty 0.0.16**
funciona en la misma caja, por el mismo **ACP sobre SSH**, y con **EasyBits** como LLM.

### 6.1 Instalar

```bash
export HOME=/root GOOSE_BIN_DIR=/usr/local/bin
curl -fsSL https://formmy.app/ghosty/install.sh -o /tmp/g.sh && bash /tmp/g.sh
# queda en /root/.local/bin (o $GOOSE_BIN_DIR) → usa ruta absoluta o añade a PATH
```

### 6.2 Autenticar

```bash
ghosty auth set --provider easybits --api-key "TU_EASYBITS_API_KEY"   # EasyBits (reseller DeepSeek)
# o:  ghosty auth set --provider deepseek --api-key "TU_DEEPSEEK_API_KEY"
ghosty doctor
```

> **Hallazgo del taller:** ghosty 0.0.15 daba **404** con EasyBits (hablaba Responses API);
> **0.0.16 ya funciona** con el provider `easybits` (chat/completions).

### 6.3 Probar

```bash
ghosty exec "Responde: OK"                # one-shot
/root/.local/bin/ghosty serve --acp        # servidor ACP sobre stdio (para el túnel SSH)
```

### 6.4 Alternar goose ↔ ghosty en el app

El backend spawnea `ssh <caja>.ghosty "<ACP_CMD>"`. `ACP_CMD` decide el agente:

- `goose-acp` (default) → goose.
- `/root/.local/bin/ghosty serve --acp` → ghosty.

Verificado: con `ACP_CMD=/root/.local/bin/ghosty serve --acp`, la sesión es `ghosty-…` y responde
(`SOY_GHOSTY`, `end_turn`).

**Igual que goose.** Con bash habilitado (6.5), ghosty ya ejecuta real en su caja: levantó
`python3 -m http.server 8080` (persistente vía `nohup`), sirvió `hola-mundo.html` con HTTP 200 y
detectó `/root/cloudflared` para exponerlo por túnel — lo mismo que podía hacer goose.

> **Ojo con la advertencia del propio agente:** ghosty se cauto diciendo “el entorno bloquea procesos
> en segundo plano”, pero el server del 8080 **sí** corre en background (`nohup … &`, pid 1244); su
> aviso era conservador. El fondo funciona.

### 6.5 Herramientas de ghosty (por qué “no puede ejecutar”)

El servidor ACP de ghosty (`ghosty serve --acp`) **no expone `Bash` por defecto**. En
`build_acp_tool_registry` (`crates/tui/src/acp_server.rs`) la herramienta de shell solo se
registra si pasan **cuatro compuertas** a la vez:

```rust
let allow_shell = client_supports_terminal
    && config.allow_shell()
    && features.enabled(Feature::ShellTool)   // default true
    && sandbox_backend_ready;                 // sin sandbox externo → true
```

file/search/git sí se registran siempre; **bash es la única que se cierra en fail-closed**.

**Síntoma:** el agente responde *“mi entorno declara Linux /bin/bash pero no tengo herramienta
de ejecución de comandos; solo lectura/escritura y búsqueda”*.

**Causas** (cualquiera de las dos).

1. **El cliente ACP no declara `terminal`.** `clientCapabilities.terminal` debe ser `true`.
2. **La config no opta por shell.** `Config::allow_shell()` **default es `false`** en contextos
   headless/app-server (justo donde corre el ACP server).

**Fix (ambos, no es opcional):**

- Cliente (`server.mjs`, `initialize`):
  ```js
  clientCapabilities: {
    fs: { readTextFile: false, writeTextFile: false },
    terminal: true,   // ← sin esto ghosty omite Bash
  }
  ```
- Caja del agente (`/root/.ghosty/config.toml`):
  ```toml
  allow_shell = true
  ```
  o env `GHOSTY_ALLOW_SHELL=true`.

> **La ruta real es `/root/.ghosty/config.toml`** (no `~/.config/ghosty`); es donde `ghosty auth set`
> escribe. Y si el agente se consume desde el **app web desplegado**, la copia de `server.mjs` en esa
> caja **también** debe declarar `terminal: true` (la copia de trabajo ya lo trae, la desplegada se
> queda atrás; ver [`legacy/spec-web-spa.md`](../legacy/spec-web-spa.md) §12).

> Con esto el agente ya puede `Bash`/editar archivos y levantar un servidor web dentro de su caja
> (ej. `python3 -m http.server`, `npx vite`).
>
> **Verificado en el taller (2026-08-28):** con `server.mjs` declarando `terminal: true` y
> `allow_shell = true` en `/root/.ghosty/config.toml` de la caja `sb_d6a36806-…`, un
> `session/prompt` que pide ejecutar un comando hace que ghosty pida permiso `bash`
> (`session/request_permission`) y devuelve la salida real: `echo GHOSTY_BASH_OK` → `GHOSTY_BASH_OK`.
> Verificación reproducible: `node acp-ghosty-poc/bash_e2e_probe.mjs` (props `ACP_CMD`/`ACP_BOX`).

---

## 7. Siguiente paso → la sesión 2

El **backend + interfaz web** que consume esta caja por SSH/ACP (chat en el navegador, streaming por
SSE, una conversación = un hijo SSH) es la **sesión 2** y vive en
[`spec2-ui-solida.md`](spec2-ui-solida.md), que **nace de este spec**. Aquí sólo se deja lo
probado; el diseño de producto va allá.

---

## 8. Estado / limpieza

> **Sesión 1 cerrada (2026-08-28).** Goose (agente oficial) y ghosty (opcional) funcionan; ghosty con
> `bash` habilitado alcanza paridad (ejecuta + server + cloudflared).

| Recurso | Estado |
|---|---|
| Caja `sb_d6a36806-…` (`goose-demo`) | **activa** · agente goos/ghosty con `allow_shell` |
| Caja `sb_85e7ea1b-…` (`webapp`) | **activa** · link público; `server.mjs` con `terminal: true` |
| Caja `sb_420d62b2-…` (`ghosty-acp-poc`) | sobrante; expira sola 03:35 |
| `acp-ghosty-poc/ssh_client.mjs` | cliente ACP one-shot |
| `acp-ghosty-poc/ssh_repl.mjs` | REPL interactivo multi-turno |
| `acp-ghosty-poc/multi_turn.mjs` | probe multi-turno |
| `acp-ghosty-poc/bash_e2e_probe.mjs` | probe: ghosty ejecuta shell por SSH (ver §6.5) |
| `acp-ghosty-poc/app_e2e.mjs` | probe: bash a través del app desplegado (trayecto completo) |
| `acp-ghosty-poc/tools_probe.mjs` | probe del catálogo de tools (no aplica a ghosty; usa goose) |
| `docs/spec1-agente-fuera.md` | este spec (día 1) |
| `acp-ghosty-poc/la sesión 2.md` | spec día 2 (interfaz web, nace de este) |
| `~/.ghosty/sb_ed25519` (privada) | llave SSH cajas (no commitear) |
| `~/.ghosty/.ebkey`, `~/.ghosty/.dstmp` | secrets locales (no commitear) |


