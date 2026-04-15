import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import type { ResolvedTelegramAccount } from "./src/accounts.js";
import { resolveTelegramAccount } from "./src/accounts.js";
import { telegramApprovalCapability } from "./src/approval-native.js";
import { telegramConfigAdapter } from "./src/shared.js";

export const telegramCommandTestPlugin = {
  id: "telegram",
  meta: getChatChannelMeta("telegram"),
  capabilities: {
    chatTypes: ["direct", "group", "channel", "thread"],
    reactions: true,
    threads: true,
    media: true,
    polls: true,
    nativeCommands: true,
    blockStreaming: true,
  },
  config: telegramConfigAdapter,
  approvalCapability: telegramApprovalCapability,
  pairing: {
    idLabel: "telegramUserId",
  },
  allowlist: buildDmGroupAccountAllowlistAdapter<ResolvedTelegramAccount>({
    channelId: "telegram",
    resolveAccount: resolveTelegramAccount,
    normalize: ({ cfg, accountId, values }) =>
      telegramConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
    resolveDmAllowFrom: (account) => account.config.allowFrom,
    resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
    resolveDmPolicy: (account) => account.config.dmPolicy,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
  }),
} satisfies Pick<
  ChannelPlugin<ResolvedTelegramAccount>,
  "id" | "meta" | "capabilities" | "config" | "approvalCapability" | "pairing" | "allowlist"
>;
