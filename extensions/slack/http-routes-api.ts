// Narrow entry point for registerSlackPluginHttpRoutes — avoids pulling in
// the full runtime-api barrel (~284KB, 13 chunks) during plugin register().
// Mirrors the runtime-setter-api.ts split.
export { registerSlackPluginHttpRoutes } from "./src/http/plugin-routes.js";
