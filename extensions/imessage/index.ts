import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelEntry({
  id: "imessage",
  name: "iMessage",
  description: "iMessage channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "imessagePlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setIMessageRuntime",
  },
});
