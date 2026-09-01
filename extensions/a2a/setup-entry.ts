import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "a2aChannelSetupPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setA2aChannelRuntime",
  },
});
