// ClickClack plugin module shares channel metadata and account config behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  DEFAULT_ACCOUNT_ID,
  listClickClackAccountIds,
  resolveClickClackAccount,
  resolveDefaultClickClackAccountId,
} from "./accounts.js";
import type { CoreConfig, ResolvedClickClackAccount } from "./types.js";

export const CLICKCLACK_CHANNEL_ID = "clickclack" as const;
export const clickClackMeta = { ...getChatChannelMeta(CLICKCLACK_CHANNEL_ID) };

export const clickClackConfigAdapter = {
  listAccountIds: (cfg) => listClickClackAccountIds(cfg as CoreConfig),
  resolveAccount: (cfg, accountId) =>
    resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }),
  defaultAccountId: (cfg) => resolveDefaultClickClackAccountId(cfg as CoreConfig),
  isConfigured: (account) => account.configured,
  resolveAllowFrom: ({ cfg, accountId }) =>
    resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).allowFrom,
  resolveDefaultTo: ({ cfg, accountId }) =>
    resolveClickClackAccount({ cfg: cfg as CoreConfig, accountId }).defaultTo,
} satisfies ChannelPlugin<ResolvedClickClackAccount>["config"];

export { DEFAULT_ACCOUNT_ID };
