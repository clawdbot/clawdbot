import {
  type AnyAgentTool,
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
} from "openclaw/plugin-sdk/channel-entry-contract";

function createZalouserTool(context?: unknown): AnyAgentTool {
  const createTool = loadBundledEntryExportSync<(context?: unknown) => AnyAgentTool>(
    import.meta.url,
    {
      specifier: "./api.js",
      exportName: "createZalouserTool",
    },
  );
  return createTool(context);
}

export default defineBundledChannelEntry({
  id: "zalouser",
  name: "Zalo Personal",
  description: "Zalo personal account messaging via native zca-js integration",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./api.js",
    exportName: "zalouserPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setZalouserRuntime",
  },
  registerFull(api) {
    api.registerTool((ctx) => createZalouserTool(ctx), { name: "zalouser" });
  },
});
