import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./setup-plugin-api.js",
    exportName: "qaChannelSetupPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setQaChannelRuntime",
  },
});
