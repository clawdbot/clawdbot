import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../accounts.js";
import { resolveDiscordActivitiesConfig } from "./config.js";
import { createDiscordActivityHttpHandler } from "./http.js";
import { DiscordActivitiesRuntime, setDiscordActivitiesRuntime } from "./runtime.js";
import { DISCORD_ACTIVITY_ROUTE_PREFIX } from "./shell.js";
import { DiscordActivityStore, openDiscordActivityStores } from "./store.js";
import { createDiscordWidgetTool } from "./tool.js";

export function registerDiscordActivities(api: OpenClawPluginApi): void {
  setDiscordActivitiesRuntime(undefined);
  const enabledAccountIds: string[] = [];
  for (const accountId of listDiscordAccountIds(api.config)) {
    const account = resolveDiscordAccount({ cfg: api.config, accountId });
    if (!isDiscordAccountEnabledForRuntime(account, api.config)) {
      continue;
    }
    const resolution = resolveDiscordActivitiesConfig(account.config);
    if (resolution.enabled) {
      enabledAccountIds.push(account.accountId);
      continue;
    }
    if (resolution.reason === "missing-client-secret") {
      api.logger.warn(
        `[discord] activities configured for account ${account.accountId}, but no client secret resolved; feature disabled`,
      );
    }
  }
  if (enabledAccountIds.length === 0) {
    return;
  }

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
  const http = createDiscordActivityHttpHandler({ runtime });
  api.registerHttpRoute({
    path: DISCORD_ACTIVITY_ROUTE_PREFIX,
    auth: "plugin",
    match: "prefix",
    handler: async (req, res) => await http.handleHttpRequest(req, res),
  });
  api.registerTool((context) => createDiscordWidgetTool(context, { runtime }), {
    name: "discord_widget",
  });
}
