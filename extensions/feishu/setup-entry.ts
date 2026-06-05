// Feishu plugin module implements setup entry behavior.
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {
    legacyStateMigrations: true,
  },
  plugin: {
    specifier: "./setup-api.js",
    exportName: "feishuPlugin",
  },
  legacyStateMigrations: {
    specifier: "./legacy-state-migrations-api.js",
    exportName: "detectFeishuLegacyStateMigrations",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-setter-api.js",
    exportName: "setFeishuRuntime",
  },
});
