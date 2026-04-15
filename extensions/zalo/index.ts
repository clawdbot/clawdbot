import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "zalo",
  name: "Zalo",
  description: "Zalo channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "zaloPlugin",
  },
  secrets: {
    specifier: "./secret-contract-api.js",
    exportName: "channelSecrets",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setZaloRuntime",
  },
});
