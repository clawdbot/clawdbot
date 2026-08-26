import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createDiscordActivityHttpHandler } from "./http.js";
import { createDiscordWidgetPresenter } from "./presenter.js";
import { DiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { DISCORD_ACTIVITY_ROUTE_PREFIX } from "./shell.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";

export function registerDiscordActivities(api: OpenClawPluginApi): void {
  setDiscordActivitiesRuntime(undefined);
  // Registration precedes publication of secret-resolved channel config. Keep the
  // transport static; runtime matching and HTTP dispatch gate on the current snapshot.
  const store = new DiscordActivityStore(
    openDiscordActivityStores(<T>(options: OpenKeyedStoreOptions) =>
      api.runtime.state.openKeyedStore<T>(options),
    ),
  );
  const runtime = new DiscordActivitiesRuntime(
    store,
    api.config,
    api.runtime.config?.current
      ? () => api.runtime.config.current() as typeof api.config
      : undefined,
  );
  setDiscordActivitiesRuntime(runtime);
  const http = createDiscordActivityHttpHandler({
    runtime,
    vendorAssetPath: api.resolvePath("assets/embedded-app-sdk.mjs"),
  });
  api.registerHttpRoute({
    path: DISCORD_ACTIVITY_ROUTE_PREFIX,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => await http.handleHttpRequest(req, res),
  });
  api.registerWidgetPresenter(createDiscordWidgetPresenter(runtime));
}
