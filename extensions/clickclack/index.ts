import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "clickclack",
  name: "ClickClack",
  description: "ClickClack channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "clickClackPlugin",
  },
  runtime: {
    specifier: "./api.js",
    exportName: "setClickClackRuntime",
  },
});
