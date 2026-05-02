import {
  defineBundledChannelEntry,
  type OpenClawPluginCommandDefinition,
  type OpenClawPluginApi,
} from "openclaw/plugin-sdk/channel-entry-contract";

type RegisteredLineCardCommand = OpenClawPluginCommandDefinition;

let lineCardCommandPromise: Promise<RegisteredLineCardCommand> | null = null;

async function loadLineCardCommand(api: OpenClawPluginApi): Promise<RegisteredLineCardCommand> {
  lineCardCommandPromise ??= (async () => {
    let registered: RegisteredLineCardCommand | null = null;
    const { registerLineCardCommand } = await import("./src/card-command.js");
    registerLineCardCommand({
      ...api,
      registerCommand(command: RegisteredLineCardCommand) {
        registered = command;
      },
    });
    if (!registered) {
      throw new Error("LINE card command registration unavailable");
    }
    return registered;
  })();
  return await lineCardCommandPromise;
}

export default defineBundledChannelEntry({
  id: "line",
  name: "LINE",
  description: "LINE Messaging API channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "linePlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setLineRuntime",
  },
  registerFull(api) {
    api.registerCommand({
      name: "card",
      description: "Send a rich card message (LINE).",
      acceptsArgs: true,
      requireAuth: false,
      async handler(ctx) {
        const command = await loadLineCardCommand(api);
        return await command.handler(ctx);
      },
    });
  },
});
