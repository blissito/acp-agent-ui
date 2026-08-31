# POC — Agente ACP en caja EasyBits consumido por SSH (+ web)

> **Estado: ✅ verificado de punta a punta.** Documentación del proof-of-concept del taller.
> Todo corre **solo con EasyBits** (cajas/LLM) y **goose** (oficial) como agente.
>
> Referencias de detalle: [`SPEC-1.md`](SPEC-1.md) (día 1) y [`SPEC-2.md`](SPEC-2.md) (día 2, 2 partes).

---

## 1. Qué es

Un agente de código (goose) corre **dentro de una microVM de EasyBits** y se consume por el
**Agent Client Protocol (ACP)** a través de **SSH** (túnel sobre 443). Encima, un **server único**
sirve una **interfaz web** que chatea con ese agente por SSE. El agente opera su **propio disco**
(el de la caja), no el del cliente.

```text
[ Navegador ] → https://sb-<id>-4000.sandboxes.easybits.cloud
        ▼
[ CAJA APP: webapp (dev-box) ]      node server.mjs (systemd) — sirve SPA + API + SSE
        ▼  ssh -i <llave> <goose>.ghosty "goose-acp"   (túnel 443)
[ CAJA AGENTE: goose-demo ]         goose acp · LLM = EasyBits (deepseek-v4-pro)
```

## 2. Stack

- **Agente**: goose **1.48** (oficial, `aaif-goose/goose`), servidor ACP vía `goose acp`.
- **LLM**: EasyBits — reseller de DeepSeek, endpoint `https://www.easybits.cloud/api/v2/llm/v1`
  (chat/completions). Modelo `deepseek-v4-pro`.
- **Transporte**: ACP sobre **SSH** a través del túnel `easybits ssh-proxy` (443).
- **Backend**: Node puro (`node:http` + SSE), sin dependencias.
- **Frontend**: **Vite + React 18 + React Router v7** + **Streamdown** (markdown en streaming).
- **Cajas**: sandboxes `dev-box` de EasyBits (con SSH, template que declara el 22).

## 3. Los días

**Día 1 (`SPEC-1`)** — el agente por SSH:
- Instalar goose oficial en la caja; LLM = EasyBits; `goose acp` como servidor ACP sobre stdio.
- Cliente ACP por SSH: `ssh <caja>.ghosty "goose-acp"` (el stdio viaja por el túnel).
- Probado: `initialize`, `session/new`, multi-turno (`session/prompt` sobre la misma sesión),
  el agente crea archivos **en la caja** (p. ej. `/root/hola-acp.txt`).

**Día 2 (`SPEC-2`, Parte 1)** — web + API en un solo server:
- `node server.mjs` sirve el SPA `client/dist` (+ fallback a `index.html` para rutas RRv7) **y** la
  API/SSE en `:4000`; por conversación abre un hijo `ssh <caja> "goose-acp"`.
- SPA: Vite + RRv7 (`/`→Home, `/c/:id`→Chat), Streamdown para markdown en vivo, auto-scroll,
  foco en el input, reporte de costo/tokens.
- Higiene: limpieza de sesiones muertas + idle timeout + tope (`MAX_CONVERSATIONS`).

**Día 2 (`SPEC-2`, Parte 2)** — publicado en EasyBits con link público:
- El app corre en otra caja (`webapp`) vía **systemd**; con CLI easybits + llave para SSHear a la
  caja del agente. `sandbox_expose_port(4000)` → URL pública. Verificado end-to-end.
- **Ciclo de vida (wake-on-demand, app-owned)**: el backend despierta la caja del agente al hablarle
  (`ensureAgentBox` → resume/self-heal con `@easybits.cloud/sdk`) y la suspende al quedar idle.
  Detalle en SPEC-2 §14.

## 4. Evidencia clave (verificada)

- `node server.mjs` → `GET /` 200, assets 200, fallback `/c/:id` 200.
- Turno SSE → chunks + `end_turn` + `usage`/cost. Ejemplos: `VITE_OK`, `ONE_SERVER_OK`,
  `OK_FINAL`, `FOCUS_OK`, `PUBLIC_OK`, `LIFECYCLE_OK`.
- **Ciclo de vida**: caja agente `suspended → (al hablarle) → running` y turno OK (wake-on-demand).
- **Bash en la web (2026-08-28)**: el server.mjs desplegado (`/app/web/server.mjs`, caja del app)
  debía declarar `clientCapabilities.terminal: true` a mano (la copia local ya lo tenía pero la
  desplegada no). Tras corregirla + `allow_shell = true` en la caja del agente, un prompt desde la
  app que pide ejecutar `echo APP_BASH_OK` devuelve `APP_BASH_OK` (verificado con `app_e2e.mjs`).
- Multi-turno en la misma sesión → `end_turn` en ambos.
- El agente escribe en la caja: `/root/hola-acp.txt`, `/root/hola-mundo.html`, `/tmp/hola-fs.txt`.
- Frontend: Home con "Nueva conversación", Streamdown, auto-scroll, foco en input, sin errores de
  consola (verificado con Playwright headless).
- Link público: `https://sb-85e7ea1b-487b-4cd6-9f5b-b94916010b0e-4000.sandboxes.easybits.cloud`.

## 5. Cómo correrlo

```bash
# A) local — solo server (sirve SPA + API + SSE)
cd acp-ghosty-poc/web/client && npm install && npm run build   # una vez
cd acp-ghosty-poc/web && PORT=4000 node server.mjs             # -> http://localhost:4000

# B) en una caja EasyBits (publicado) — receta en SPEC-2 §12
#    systemd + sandbox_expose_port(4000) -> link público
```

## 6. Archivos

| Ruta | Qué es |
|---|---|
| `SPEC-1.md` | Día 1: agente ACP en caja por SSH (receta reproducible). |
| `SPEC-2.md` | Día 2: Parte 1 (web+API server único) y Parte 2 (publicado + link). |
| `web/server.mjs` | Backend (API/SSE) que spawnea `ssh …"goose-acp"` y sirve el SPA. |
| `web/client/` | Frontend Vite + RRv7 + Streamdown (build en `client/dist`). |
| `ssh_repl.mjs` | REPL ACP multi-turno por SSH (cliente). |
| `ssh_client.mjs` | Cliente ACP one-shot. |
| `multi_turn.mjs` | Probe multi-turno. |
| `fs_probe.mjs` | Probe: ¿el agente usa la capability `fs` del cliente? |
| `~/.ghosty/sb_ed25519` | Llave SSH de los sandboxes. |

## 7. Aprendizajes / gotchas

- **goose no usa la `fs` del cliente** (aunque ofrezcas `fs:{read,write}`): opera su propio disco.
  La vía "editor" (escribir en local) **no** funciona con goose; la vía real es leer el archivo de la
  caja (artefacto) o cambiar a un agente tipo `claude-agent-acp`.
- **Ghosty 0.0.15 ↔ EasyBits** choca: ghosty usa **Responses API**; EasyBits solo expone
  **chat/completions** → **404**. Por eso el agente es **goose**. (0.0.16 ya usa `easybits` y funciona.)
- **Ghosty sin `Bash` por defecto**: el ACP server de ghosty omite la herramienta de shell salvo que
  el cliente declare `clientCapabilities.terminal: true` **y** la config de la caja tenga
  `allow_shell = true` (en `/root/.ghosty/config.toml`). Si no, el agente responde “no tengo
  herramienta de ejecución”. **Resuelto y verificado**: con ambos, un prompt que ejecuta un comando
  devuelve la salida real (`echo GHOSTY_BASH_OK` → `GHOSTY_BASH_OK`). Ver SPEC-1 §6.5.
- **SSH por túnel**: `~/.ssh/config` (`Host *.ghosty` → `easybits ssh-proxy %h`) + `ssh-enable` una
  vez. El **ticket** del túnel es de vida corta: ticket malo/caja ajena → **403/404** en el borde.
- **Desajuste de llaves**: "el túnel llega pero la llave no autoriza" fue por **par de llaves
  equivocado** (injectar la pública que corresponde a la privada que usas).
- **Launchd sin env**: lanzar el server con `launchctl submit` (sin `PATH`/`HOME`) servía el HTML
  pero su `ssh` no resolvía `*.ghosty` → el agente "no respondía". Usar un **plist** con `PATH`/`HOME`
  (o systemd en la caja).
- **Cajas efímeras**: se auto-destruyen al TTL → extender (`sandbox_extend`) o promover a
  **permanente** para que el link siga vivo.

## 8. Seguridad

- El server/app no conoce la key del LLM (vive en `/root/.config/goose/.env` de la **caja del agente**).
- Solo guarda la llave SSH + la config de `~/.ssh/config`.
- El túnel (443) no autentica; la sesión SSH se autentica de punta a punta con la llave.
- El agente escribe en su microVM; el cliente/backend no le comparte filesystem.
