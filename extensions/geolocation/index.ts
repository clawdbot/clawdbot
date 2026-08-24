/**
 * Geolocation plugin entry. It exposes one authenticated lookup route and keeps
 * the database download lazy, so an install that nobody queries costs nothing.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { resolveGeolocationSettings } from "./src/config.js";
import { createGeolocationDatabaseStore } from "./src/database-store.js";
import { createGeolocationLookupHandler } from "./src/lookup-route.js";

export default definePluginEntry({
  id: "geolocation",
  name: "Geolocation Plugin",
  description: "Bundled geolocation plugin",
  register(api) {
    const settings = resolveGeolocationSettings(api.pluginConfig);
    const store = createGeolocationDatabaseStore({
      stateDir: resolveStateDir(),
      settings,
      now: () => new Date(),
      fetchImpl: fetch,
      logger: api.logger,
    });
    api.registerHttpRoute({
      path: "/plugins/geolocation",
      auth: "gateway",
      match: "prefix",
      handler: createGeolocationLookupHandler({
        loadDatabase: () => store.load(),
        settings,
        logger: api.logger,
      }),
    });
  },
});
