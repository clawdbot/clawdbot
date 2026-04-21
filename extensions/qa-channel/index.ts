import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "qa-channel",
  name: "QA Channel",
  description: "Synthetic QA channel plugin",
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
