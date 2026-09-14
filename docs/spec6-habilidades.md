# Spec 6 — Tu agente haciendo lo tuyo: habilidades

> **Plan, no bitácora.** Es la sesión donde el alumno se lleva algo suyo.

## El problema

Hasta aquí el agente sabe lo que sabe goose de fábrica. Hacerlo tuyo es darle **tus
instrucciones**: cómo escribes, qué convenciones sigues, qué hace y qué nunca hace.

Una habilidad es eso, pero cargada **cuando hace falta** y no siempre. Es la diferencia entre un
prompt gigante que el agente arrastra en cada turno y un agente que sabe ir a buscar lo que
necesita.

## Lo que ya existe

`goose.sourcesList_unstable` las devuelve por la misma conexión ACP. Los archivos viven en el disco
de la caja: quien los lee es el agente, no la app.

La vista `/skills` está en el sidebar, vacía, con el método nombrado en su estado vacío.

## Lo que hay que hacer

1. Listar las habilidades del agente en `/skills`.
2. Escribir una nueva desde la interfaz — que es escribir en el disco de la caja.
3. Comprobar que el agente la usa: pedirle algo que sólo pueda resolver con ella.
4. Recetas como cierre: guardar una conversación afinada como punto de partida repetible
   (`goose.recipesList_unstable`, `Save`, `Delete`).

## Lo que falta decidir

- **Qué pasa con una sesión ACP viva** cuando cambias sus habilidades a media conversación.
- **Hasta dónde llega la interfaz**: ¿editar una habilidad en el navegador, o sólo verla y que el
  archivo se edite por otro lado?
- **Con qué se va el alumno**: una caja suya con sus habilidades, o una plantilla que pueda repetir.

## Fuera de esta sesión

Las **extensiones** (servidores MCP) se ven en la [sesión 4](spec4-permisos-extensiones.md): darle
herramientas nuevas y decidir qué puede hacer sin preguntar son el mismo problema.

Quedan sin sesión propia, con su vista en cascarón y el método anotado: **Agenda**
(`schedulesList_unstable`, exige `--enable-scheduler`) y **Apps** (MCP-UI: el agente ya monta
`/mcp-app-guest` y `/mcp-app-proxy`, falta `@mcp-ui/client` del lado web).
