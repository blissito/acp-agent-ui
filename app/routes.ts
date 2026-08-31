import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  // Rutas de recurso: la API que consume el navegador (SSE incluido).
  route("api/conversations", "routes/api.conversations.ts"),
  route("api/conversations/:id/events", "routes/api.conversations.$id.events.ts"),
  route("api/conversations/:id/messages", "routes/api.conversations.$id.messages.ts"),

  layout("routes/_shell.tsx", [
    index("routes/hub.tsx"),
    route("c/:id", "routes/chat.tsx"),
    route("sessions", "routes/sessions.tsx"),
    route("recipes", "routes/recipes.tsx"),
    route("skills", "routes/skills.tsx"),
    route("apps", "routes/apps.tsx"),
    route("schedules", "routes/schedules.tsx"),
    route("extensions", "routes/extensions.tsx"),
    route("settings", "routes/settings.tsx"),
  ]),
] satisfies RouteConfig;
