// Slack plugin entrypoint registers its OpenClaw integration.
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerSlackPluginHttpRoutes } from "./http-routes-api.js";
import { SLACK_THREAD_PARTICIPATION_STORE_OPTIONS } from "./thread-participation-state-api.js";

export default defineBundledChannelEntry({
  id: "slack",
  name: "Slack",
  description: "Slack channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "slackPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setSlackRuntime",
  },
  accountInspect: {
    specifier: "./account-inspect-api.js",
    exportName: "inspectSlackReadOnlyAccount",
  },
  registerFull: (api) => {
    if (api.registrationMode !== "full") {
      return;
    }
    try {
      api.runtime.state?.openKeyedStore(SLACK_THREAD_PARTICIPATION_STORE_OPTIONS);
    } catch (error) {
      api.logger.warn(`Slack persistent thread participation state failed: ${String(error)}`);
    }
    registerSlackPluginHttpRoutes(api);
  },
});
