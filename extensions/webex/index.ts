/**
 * Moltbot Webex channel plugin
 *
 * Provides integration with Cisco Webex for enterprise messaging.
 */

import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";
import { webexPlugin } from "./src/channel.js";
import { handleWebexWebhookRequest } from "./src/monitor.js";
import { setWebexRuntime } from "./src/runtime.js";

const plugin = {
  id: "webex",
  name: "Webex",
  description: "Moltbot Webex channel plugin for enterprise messaging",
  configSchema: emptyPluginConfigSchema(),

  register(api: MoltbotPluginApi) {
    // Set runtime for plugin modules
    setWebexRuntime(api.runtime);

    // Register channel plugin
    api.registerChannel({
      plugin: webexPlugin,
    });

    // Register HTTP handler for webhooks
    api.registerHttpHandler(handleWebexWebhookRequest);
  },
};

export default plugin;

// Re-export types for external use
export type {
  ResolvedWebexAccount,
  WebexAccountConfig,
  WebexConfig,
  WebexDmConfig,
  WebexMessage,
  WebexPerson,
  WebexRoom,
  WebexRoomConfig,
  WebexWebhookEvent,
} from "./src/types.js";

// Re-export functions for external use
export { getWebexMe, probeWebex, sendWebexMessage } from "./src/api.js";
export { resolveWebexAccount } from "./src/accounts.js";
export { handleWebexWebhookRequest } from "./src/monitor.js";
