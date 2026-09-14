# Spec 5 — Un backend, n canales: WhatsApp por Baileys

> **Bitácora de la sesión del 14 de septiembre de 2026.** Lo que se construyó, lo que se
> descubrió y lo que queda.

## La idea

Hasta la sesión 4 el agente vivía detrás de una pantalla: el chat web. Si mañana una empresa te
contrata para "ponerle un agente a Slack", la pantalla pierde peso. Lo que vendes es el motor —
una sesión ACP viva con un agente en su caja, con sus MCPs y sus skills— y cada canal es una
puerta más a ese motor. El chat web pasa a ser un canal entre varios.

Un canal hace cuatro cosas, siempre las mismas: recibe un mensaje, lo convierte en un turno del
motor, espera la respuesta y la devuelve por donde entró. El agente no se entera de por dónde le
hablaron.

## Por qué Baileys

Tres formas de meter un programa a WhatsApp:

| | Cloud API (Meta) | whatsapp-web.js | Baileys |
|---|---|---|---|
| Qué es | la oficial | un Chrome oculto que da clics a WhatsApp Web | el protocolo de WhatsApp Web hablado directo por WebSocket |
| Pide | número de empresa, verificación, plantillas | un navegador corriendo | nada: tu número |
| Grupos | no | sí | sí |
| Precio | por conversación | RAM y fragilidad | no oficial: Meta puede bloquear el número; si cambia el protocolo, se rompe hasta que la comunidad la alcanza |

Baileys la escribió Adhiraj Singh por ingeniería inversa de WhatsApp Web; la reescritura
multi-dispositivo (Signal + Noise) quitó la necesidad de tener el teléfono prendido; en 2023 el
autor la dejó y la comunidad la sigue en WhiskeySockets (`@whiskeysockets/baileys`, MIT, ~10k ★).
La industria la usa a diario en bots, CRMs y automatizaciones. Para un agente en tu grupo, sin
permiso de Meta ni empresa de por medio, es la puerta — y el mismo motor sirve mañana para la
Cloud API si el cliente la pide.

## Lo que se construyó

### El canal — `app/.server/whatsapp.ts`

- **La app es un dispositivo vinculado más.** `makeWASocket` en este mismo proceso; el teléfono
  la ve como otra pestaña de WhatsApp Web.
- **Estados** `disconnected → connecting → qr_pending | pairing → connected | failed`, empujados
  al navegador por SSE (`/api/whatsapp/events`). El QR sale solo al abrir `/whatsapp` y se renueva
  solo; con tu número sale el código de 8 caracteres. Son el mismo handshake: pedir uno cancela
  al otro. El QR nunca se guarda.
- **Credenciales en sqlite** (misma base que las extensiones, tablas `whatsapp_auth` y
  `whatsapp_groups`). Las llaves de señal llegan a ráfagas en el pairing y se escriben con
  debounce de 600 ms; sin él el handshake se rompe. Con ellas, un reinicio reconecta sin escanear.
- **Baileys entrega todo; nosotros decidimos dónde contestar.** `messages.upsert` trae cada
  mensaje de cada chat. Sólo los grupos (`@g.us`) con el interruptor prendido pasan el filtro
  `grupoActivo(jid)`; un grupo nuevo aparece en la lista cuando alguien escribe en él.
- **Varios mensajes seguidos son UN turno.** Se juntan 1.5 s y va una sola petición
  (`askFromChannel`), con 👀 al leer y ✅ al contestar. Sin eso: tres turnos, tres respuestas, y un
  agente que parece spam.
- **Fotos y reacciones en las dos vías.** Una foto entrante se descifra
  (`downloadMediaMessage`) y entra al turno como base64, igual que una imagen del chat web. Las
  imágenes que devuelve una herramienta salen como foto con el texto de pie. Una reacción a un
  mensaje del agente vuelve como mensaje ("Osvaldo reaccionó con 👍…"); si el agente contesta con
  un solo emoji, va como reacción.

### El motor — `app/.server/acp.ts`

- `askFromChannel(text, via, from, images)` mete el turno en el hilo abierto (una sola sesión
  viva: dos clientes, una conversación) y resuelve con el texto entero y las imágenes.
- El navegador recibe un evento `user` con `via: "whatsapp"` y lo pinta etiquetado; las imágenes
  de las herramientas llegan como evento `image`.
- **Las imágenes viajan por ACP** en `tool_call_update.content[]` como
  `{ type: "content", content: { type: "image", data, mimeType } }`. Sólo cuentan las de
  extensiones (`mcp:`): un `Read` de un PNG también devuelve imagen, pero ésa la leyó el agente.

### La herramienta — `mcp/imagen.ts`

`generar_imagen(prompt)`: pide la imagen a un generador por HTTP y la devuelve como bloque
`image` de MCP. Sin dependencias ni llave. Corre por stdio o como Streamable HTTP
(`--http 4123`), porque el adaptador `claude-acp` sólo monta MCPs http. El agente no sabe de
WhatsApp ni de la web: devuelve la imagen por el protocolo y cada canal decide cómo entregarla.

### La caja — `scripts/new-ghosty-lite.mjs`

Un `POST /api/v2/agents` con `template: ghosty-lite`, el token OAuth de Claude
(`claude setup-token`) y el MCP sembrado en `/data/workspace`. Reescribe el `.env`.

## Lo que se descubrió (y no estaba en ningún doc)

1. **El token OAuth no cuenta como llave de proveedor** para EasyBits: sin `GHOSTY_PROVIDER=claude-acp`
   explícito el agente nace con DeepSeek medido, y con saldo en cero el síntoma es un
   "add more credits" que parece de Anthropic.
2. **La URL del agente del POST es provisional** (`sandbox://…`); la real la da `GET /agents/:id`
   ya en `running`, y unas veces trae `/acp` y otras no.
3. **claude-acp sólo monta MCPs http** (`mcpCapabilities: {http:true}`). Un stdio se declara,
   se acepta y desaparece sin aviso. Por eso `imagen.ts` también escucha por HTTP.
4. **Ghosty no entrega la respuesta del permiso.** Con `claude-acp`, ghosty reenvía
   `session/request_permission` al Cliente, pero cuando contestamos tira
   `No task waiting for confirmation` y la herramienta se queda colgada para siempre
   (`/data/ghosty/state/logs/cli/…`). El hilo se pone en `auto` con `session/set_mode` al
   abrirse (`ACP_MODE` lo cambia). **El permiso por WhatsApp del spec 4 queda bloqueado por esto.**
5. Menores: `seedFiles` aplana a `/data/workspace/<nombre>`; en `/exec` no hay `ps` ni `pgrep` y
   `pkill -f` mata al propio shell; `GET /sandboxes/:id/logs` da 500; el proxy LLM medido no tiene
   Claude. Y reiniciar el proceso del MCP deja al hilo abierto con la conexión muerta: hilo nuevo.

## Lo que queda

- **Toda la superficie del canal.** Hoy: texto, fotos y reacciones. Un canal completo es también
  adjuntos (audios, documentos), citar, notas de voz, ubicación, editados y borrados: cada uno un
  tipo de mensaje distinto en Baileys, de ida y de vuelta. Lo mismo aplica a Slack o Telegram: la
  superficie se implementa entera, lo que cambia es si la puerta es oficial.
- **El permiso desde el grupo** (spec 4), cuando ghosty-lite lo entregue.
- **Operación** ([`operacion.md`](operacion.md)): saber cuándo se rompe. Queda como plan, fuera del temario.
- **La sesión de WhatsApp al hostear**: `ACP_EXTENSIONS_DB` a `/data` para que sobreviva al
  despliegue.
- Usuarios: quien tenga el link opera el canal. Se anota como límite.

## Cómo rehacerlo desde la rama `sesion-4-mcp`

Para que un agente (o un alumno) lo construya en vivo, en este orden. Cada paso compila y se
prueba solo antes del siguiente.

1. **La caja.** `EASYBITS_API_KEY=… CLAUDE_CODE_OAUTH_TOKEN=… node scripts/new-ghosty-lite.mjs`
   (el token sale de `claude setup-token`). Reescribe `.env`. Comprobar: `npm run dev`, abrir
   `/`, pedir "di hola".
2. **Turnos desde fuera del navegador** (`app/.server/acp.ts`): a `ask()` se le da un
   `onAnswer(answer, error, images)` que se llama al cerrar el turno, y un `via`/`from` que se
   guardan en el mensaje y se emiten como evento `user`. Sobre eso, `askFromChannel(text, via,
   from, images)` → `Promise<{ text, images }>`, contra el hilo abierto o uno nuevo.
3. **Imágenes por ACP** (mismo archivo): en el bucle del turno, `tool_call_update.content[]`
   trae `{ type: "content", content: { type: "image", data, mimeType } }`; se cuelgan del
   mensaje del agente, se emiten como evento `image` y van en el `onAnswer`. Sólo si el título
   de la tool empieza con `mcp:`.
4. **Modo `auto`**: tras `session/new`, si `modes.currentModeId !== "auto"`,
   `session/set_mode { sessionId, modeId: "auto" }`. Sin esto toda tool se cuelga con claude-acp.
5. **El MCP de imagen** (`mcp/imagen.ts`, sin dependencias): `initialize`, `tools/list`,
   `tools/call` → `content: [{ type: "image", data, mimeType }, { type: "text", … }]`. Con
   `--http PORT`: POST `/mcp` → JSON; notificación (sin id) → 202; GET → stream SSE abierto con
   latido; DELETE → 200. Generador: `https://image.pollinations.ai/prompt/<prompt>?width=&height=`.
   Subirlo a la caja por `/exec` (base64), arrancarlo con `nohup node imagen.ts --http 4123` y
   darlo de alta en `/extensions` como http `http://127.0.0.1:4123/mcp`. **Hilo nuevo** después.
   Comprobar en la web: "usa generar_imagen para…" → la foto aparece en la burbuja.
6. **El canal** (`app/.server/whatsapp.ts`, `npm i @whiskeysockets/baileys@7.0.0-rc13 @hapi/boom qrcode`):
   - auth sobre sqlite: `creds` e `keys` serializados con `BufferJSON`; `keys.set` con debounce
     de 600 ms; `makeCacheableSignalKeyStore`.
   - `makeWASocket({ version, auth, logger: silencioso, browser: Browsers.macOS("Chrome") })`;
     `version` de `fetchLatestWaWebVersion` con carrera de 5 s.
   - `connection.update`: `qr` → data URL con `qrcode`; `open` → `connected` con `sock.user`;
     `close` con `DisconnectReason.restartRequired` (515) → reconectar en 500 ms sin contar;
     `loggedOut` → borrar auth; otro → backoff `min(30 s, 2^n s)` hasta 5.
   - código por número: `sock.requestPairingCode(phone)` 1.5 s después de crear el socket, sólo
     si `!creds.registered`.
   - `messages.upsert` tipo `notify`: sólo `@g.us`, ignorar `fromMe` y los ids que mandamos;
     texto en `conversation` / `extendedTextMessage.text`; foto con `downloadMediaMessage(m,
     "buffer")` + `imageMessage.caption`; reacción en `reactionMessage` (sólo si apunta a un id
     nuestro).
   - allowlist en tabla `whatsapp_groups (jid, subject, enabled, seen_at)`; lista con
     `groupFetchAllParticipating` cacheada 60 s (nunca en el poll).
   - ráfaga: buffer por grupo, 1.5 s, un `askFromChannel`; 👀 al empezar, `composing` cada 8 s,
     ✅ al terminar; respuesta con `sendMessage(jid, { image, caption })` por cada imagen o
     `{ text }`; un solo emoji → `{ react }`.
7. **Rutas y vista**: `api/whatsapp` (GET estado+grupos; POST `connect | pair | disconnect |
   group`), `api/whatsapp/events` (SSE del estado), `routes/whatsapp.tsx` (QR/código, conectado,
   grupos con switch). `rehidratar()` al primer request reconecta si hay credenciales.
8. **La web pinta los dos sentidos**: evento `user` con `via` → burbuja etiquetada; evento
   `image` → imágenes en el mensaje del agente.

Referencia de Baileys con todo lo anterior resuelto en producción:
`easybits/app/.server/integrations/whatsapp/baileys.server.ts` (privado; el spec de arriba
resume lo que hay que copiar).
