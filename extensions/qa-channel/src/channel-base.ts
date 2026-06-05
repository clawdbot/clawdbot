// Qa Channel plugin module implements channel base behavior.
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import {
  listQaChannelAccountIds,
  resolveDefaultQaChannelAccountId,
  resolveQaChannelAccount,
  type ResolvedQaChannelAccount,
} from "./accounts.js";
import { qaChannelPluginConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { applyQaSetup } from "./setup.js";
import type { CoreConfig } from "./types.js";

export const QA_CHANNEL_ID = "qa-channel" as const;

export const qaChannelSetupMeta = { ...getChatChannelMeta(QA_CHANNEL_ID) };
export const qaChannelRuntimeMeta = {
  ...qaChannelSetupMeta,
  id: QA_CHANNEL_ID,
  label: "QA Channel",
  selectionLabel: "QA Channel",
  docsPath: "/channels/qa-channel",
  blurb: "Synthetic QA channel for OpenClaw QA runs.",
};

type QaChannelPluginBase = Pick<
  ChannelPlugin<ResolvedQaChannelAccount>,
  "id" | "meta" | "capabilities" | "reload" | "configSchema" | "setup" | "config"
>;

export function createQaChannelPluginBase(
  meta: ChannelPlugin<ResolvedQaChannelAccount>["meta"] = qaChannelSetupMeta,
): QaChannelPluginBase {
  return {
    id: QA_CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    reload: { configPrefixes: ["channels.qa-channel"] },
    configSchema: qaChannelPluginConfigSchema,
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) =>
        applyQaSetup({
          cfg,
          accountId,
          input: input as Record<string, unknown>,
        }),
    },
    config: {
      listAccountIds: (cfg) => listQaChannelAccountIds(cfg as CoreConfig),
      resolveAccount: (cfg, accountId) =>
        resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }),
      defaultAccountId: (cfg) => resolveDefaultQaChannelAccountId(cfg as CoreConfig),
      isConfigured: (account) => account.configured,
      resolveAllowFrom: ({ cfg, accountId }) =>
        resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.allowFrom,
      resolveDefaultTo: ({ cfg, accountId }) =>
        resolveQaChannelAccount({ cfg: cfg as CoreConfig, accountId }).config.defaultTo,
    },
  };
}
