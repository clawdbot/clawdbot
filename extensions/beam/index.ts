import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createBeamRequestHandler } from "./src/http.js";
import { createBeamSessionCatalog } from "./src/session-catalog.js";
import { createBeamStore } from "./src/store.js";

export default definePluginEntry({
  id: "beam",
  name: "Beam",
  description: "Receive redacted local coding sessions as a read-only catalog",
  register(api) {
    const store = createBeamStore(api.runtime);
    api.registerSessionCatalog(createBeamSessionCatalog(store));
    api.registerHttpRoute({
      path: "/api/v1/beam/sessions",
      auth: "gateway",
      match: "exact",
      handler: createBeamRequestHandler({
        store,
        resolveControlUiBasePath: () => api.runtime.config.current().gateway?.controlUi?.basePath,
      }),
    });
  },
});
