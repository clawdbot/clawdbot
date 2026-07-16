import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-plugin-common";
import { listSlackAccountIds, mergeSlackAccountConfig } from "../accounts.js";
import { normalizeSlackWebhookPath } from "./paths.js";

let slackHttpHandlerRuntimePromise: Promise<typeof import("./handler.runtime.js")> | null = null;

async function loadSlackHttpHandlerRuntime() {
  slackHttpHandlerRuntimePromise ??= import("./handler.runtime.js");
  return await slackHttpHandlerRuntimePromise;
}

export function registerSlackPluginHttpRoutes(api: OpenClawPluginApi): void {
  const accountIds = new Set<string>([DEFAULT_ACCOUNT_ID, ...listSlackAccountIds(api.config)]);
  const registeredPaths = new Set<string>();
  for (const accountId of accountIds) {
    // Route registration must remain config-only and should not resolve tokens.
    const accountConfig = mergeSlackAccountConfig(api.config, accountId);
    registeredPaths.add(normalizeSlackWebhookPath(accountConfig.webhookPath));
  }
  if (registeredPaths.size === 0) {
    registeredPaths.add(normalizeSlackWebhookPath());
  }
  for (const path of registeredPaths) {
    api.registerHttpRoute({
      path,
      auth: "plugin",
      handler: async (req, res) =>
        await (await loadSlackHttpHandlerRuntime()).handleSlackHttpRequest(req, res),
    });
  }
}
