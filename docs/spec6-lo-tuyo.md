# Spec 6 — Tu agente haciendo lo tuyo, no el ejercicio del taller

> **Plan, no bitácora.** Es la sesión donde el alumno se lleva algo suyo.

## El problema

Hasta aquí el agente sabe lo que sabe goose de fábrica. Hacerlo tuyo es darle **herramientas**
(extensiones), **instrucciones** (habilidades) y una **manera de arrancar** (recetas).

## Lo que ya existe

Todo sale por ACP, sobre la conexión que ya funciona. Las vistas están en el sidebar, vacías, y
cada estado vacío nombra su método.

| Vista | Métodos (`goose.*_unstable`) |
|---|---|
| Extensiones | `configExtensionsList` · `Add` · `Remove` · `SetEnabled` |
| Habilidades | `sourcesList` |
| Recetas | `recipesList` · `Save` · `Delete` · `Parse` · `Encode` |
| Agenda | `schedulesList` · `Create` · `Delete` · `Pause` · `RunNow` |
| Apps | `appsList` · `Import` · `Export`, más `toolsList` · `toolsCall` |

Dos avisos: el sufijo `_unstable` es de goose y puede cambiar sin previo aviso; la agenda exige
arrancar el agente con `--enable-scheduler`, que la unidad de systemd hoy no pasa.

## Lo que hay que hacer

1. Extensiones: listar, encender y apagar servidores MCP desde la interfaz.
2. Habilidades: leerlas del disco de la caja y editarlas desde la web.
3. Recetas: guardar una conversación como punto de partida.
4. Apps (MCP-UI): el agente ya monta `/mcp-app-guest` y `/mcp-app-proxy`; falta `@mcp-ui/client`
   del lado web para dibujarlas dentro del chat.

## Lo que falta decidir

- **Qué pasa con una sesión ACP viva** cuando cambias sus extensiones a media conversación.
- **Hasta dónde llega la interfaz**: ¿editar una habilidad en el navegador, o sólo verla?
- **Con qué se va el alumno**: una caja suya, o una plantilla que pueda repetir.
