import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { hasLineCredentials, parseLineAllowFromId } from "./account-helpers.js";
import {
  resolveLineAccount,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedLineAccount,
} from "./channel-api.js";
import { lineConfigAdapter } from "./config-adapter.js";
import { LineChannelConfigSchema } from "./config-schema.js";

export const lineChannelMeta = {
  id: "line",
  label: "LINE",
  selectionLabel: "LINE (Messaging API)",
  detailLabel: "LINE Bot",
  docsPath: "/channels/line",
  docsLabel: "line",
  blurb: "LINE Messaging API bot for Japan/Taiwan/Thailand markets.",
  systemImage: "message.fill",
} as const;

export const lineChannelPluginCommon = {
  meta: {
    ...lineChannelMeta,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.line"] },
  configSchema: LineChannelConfigSchema,
  config: {
    ...lineConfigAdapter,
    isConfigured: (account: ResolvedLineAccount) => hasLineCredentials(account),
    describeAccount: (account: ResolvedLineAccount) =>
      describeWebhookAccountSnapshot({
        account,
        configured: hasLineCredentials(account),
        extra: {
          tokenSource: account.tokenSource ?? undefined,
        },
      }),
  },
} satisfies Pick<
  ChannelPlugin<ResolvedLineAccount>,
  "meta" | "capabilities" | "reload" | "configSchema" | "config"
>;

export function isLineConfigured(cfg: OpenClawConfig, accountId: string): boolean {
  return hasLineCredentials(resolveLineAccount({ cfg, accountId }));
}

export { parseLineAllowFromId };
