// Qqbot plugin entrypoint registers its OpenClaw integration.
import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";

function registerQQBotFull(api: OpenClawPluginApi): void {
  if (api.registrationMode === "tool-discovery") {
    const registerTools = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(
      import.meta.url,
      {
        specifier: "./tools-api.js",
        exportName: "registerQQBotTools",
      },
    );
    registerTools(api);
    return;
  }
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./channel-entry-api.js",
    exportName: "registerQQBotFull",
  });
  register(api);
}

export default defineBundledChannelEntry({
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "qqbotPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setQQBotRuntime",
  },
  registerFull: registerQQBotFull,
});
