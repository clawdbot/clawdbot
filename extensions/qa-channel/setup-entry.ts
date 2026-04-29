import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "qaChannelPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setQaChannelRuntime",
  },
});
