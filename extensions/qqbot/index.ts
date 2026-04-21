import {
  defineBundledChannelEntry,
  loadBundledEntryExportSync,
  type OpenClawPluginApi,
  type PluginCommandContext,
} from "openclaw/plugin-sdk/channel-entry-contract";

type QQBotAccount = {
  accountId: string;
  appId: string;
  config: unknown;
};

type MediaTargetContext = {
  targetType: "c2c" | "group" | "channel" | "dm";
  targetId: string;
  account: QQBotAccount;
  logPrefix: string;
};
type SendDocumentOptions = {
  allowQQBotDataDownloads?: boolean;
};

type QQBotFrameworkCommandResult =
  | string
  | {
      text: string;
      filePath?: string;
    }
  | null
  | undefined;

type QQBotFrameworkCommand = {
  name: string;
  description: string;
  handler: (ctx: Record<string, unknown>) => Promise<QQBotFrameworkCommandResult>;
};

function resolveQQBotAccount(config: unknown, accountId?: string): QQBotAccount {
  const resolve = loadBundledEntryExportSync<(config: unknown, accountId?: string) => QQBotAccount>(
    import.meta.url,
    {
      specifier: "./api.js",
      exportName: "resolveQQBotAccount",
    },
  );
  return resolve(config, accountId);
}

function sendDocument(
  context: MediaTargetContext,
  filePath: string,
  options?: SendDocumentOptions,
) {
  const send = loadBundledEntryExportSync<
    (
      context: MediaTargetContext,
      filePath: string,
      options?: SendDocumentOptions,
    ) => Promise<unknown>
  >(import.meta.url, {
    specifier: "./api.js",
    exportName: "sendDocument",
  });
  return send(context, filePath, options);
}

function getFrameworkCommands(): QQBotFrameworkCommand[] {
  const getCommands = loadBundledEntryExportSync<() => QQBotFrameworkCommand[]>(import.meta.url, {
    specifier: "./api.js",
    exportName: "getFrameworkCommands",
  });
  return getCommands();
}

function registerChannelTool(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerChannelTool",
  });
  register(api);
}

function registerRemindTool(api: OpenClawPluginApi): void {
  const register = loadBundledEntryExportSync<(api: OpenClawPluginApi) => void>(import.meta.url, {
    specifier: "./api.js",
    exportName: "registerRemindTool",
  });
  register(api);
}

export default defineBundledChannelEntry({
  id: "qqbot",
  name: "QQ Bot",
  description: "QQ Bot channel plugin",
  importMetaUrl: import.meta.url,
  plugin: {
    specifier: "./channel-plugin-api.js",
    exportName: "qqbotPlugin",
  },
  runtime: {
    specifier: "./runtime-api.js",
    exportName: "setQQBotRuntime",
  },
  registerFull(api: OpenClawPluginApi) {
    registerChannelTool(api);
    registerRemindTool(api);

    // Register all requireAuth:true slash commands with the framework so that
    // resolveCommandAuthorization() applies commands.allowFrom.qqbot precedence
    // and qqbot: prefix normalization before any handler runs.
    for (const cmd of getFrameworkCommands()) {
      api.registerCommand({
        name: cmd.name,
        description: cmd.description,
        requireAuth: true,
        acceptsArgs: true,
        handler: async (ctx: PluginCommandContext) => {
          // Derive the QQBot message type from ctx.from so that handlers that
          // inspect SlashCommandContext.type get the correct value.
          // ctx.from format: "qqbot:<type>:<id>" e.g. "qqbot:c2c:<senderId>"
          const fromStripped = (ctx.from ?? "").replace(/^qqbot:/i, "");
          const rawMsgType = fromStripped.split(":")[0] ?? "c2c";
          const msgType: "c2c" | "guild" | "dm" | "group" =
            rawMsgType === "group"
              ? "group"
              : rawMsgType === "channel"
                ? "guild"
                : rawMsgType === "dm"
                  ? "dm"
                  : "c2c";

          // Parse target for file sends (same from string).
          const colonIdx = fromStripped.indexOf(":");
          const targetId = colonIdx !== -1 ? fromStripped.slice(colonIdx + 1) : fromStripped;
          const targetType: "c2c" | "group" | "channel" | "dm" =
            rawMsgType === "group"
              ? "group"
              : rawMsgType === "channel"
                ? "channel"
                : rawMsgType === "dm"
                  ? "dm"
                  : "c2c";
          const account = resolveQQBotAccount(ctx.config, ctx.accountId ?? undefined);

          // Build a minimal SlashCommandContext from the framework PluginCommandContext.
          // commandAuthorized is always true here because the framework has already
          // verified the sender via resolveCommandAuthorization().
          const slashCtx = {
            type: msgType,
            senderId: ctx.senderId ?? "",
            messageId: "",
            eventTimestamp: new Date().toISOString(),
            receivedAt: Date.now(),
            rawContent: `/${cmd.name}${ctx.args ? ` ${ctx.args}` : ""}`,
            args: ctx.args ?? "",
            accountId: account.accountId,
            // appId is not available from PluginCommandContext directly; handlers
            // that need it should call resolveQQBotAccount(ctx.config, ctx.accountId).
            appId: account.appId,
            accountConfig: account.config,
            commandAuthorized: true,
            queueSnapshot: {
              totalPending: 0,
              activeUsers: 0,
              maxConcurrentUsers: 10,
              senderPending: 0,
            },
          };

          const result = await cmd.handler(slashCtx);

          // Plain-text result.
          if (typeof result === "string") {
            return { text: result };
          }

          // File result: send the file attachment via QQ API, return text summary.
          if (result && typeof result === "object" && "filePath" in result) {
            try {
              const mediaCtx: MediaTargetContext = {
                targetType,
                targetId,
                account,
                logPrefix: `[qqbot:${account.accountId}]`,
              };
              await sendDocument(mediaCtx, String(result.filePath), {
                allowQQBotDataDownloads: true,
              });
            } catch {
              // File send failed; the text summary is still returned below.
            }
            return { text: result.text };
          }

          return {
            text:
              result &&
              typeof result === "object" &&
              "text" in result &&
              typeof result.text === "string"
                ? result.text
                : "⚠️ 命令返回了意外结果。",
          };
        },
      });
    }
  },
});
