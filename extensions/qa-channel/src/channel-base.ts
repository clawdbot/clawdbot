// Qa Channel plugin module implements channel base behavior.
import {
  listQaChannelAccountIds,
  resolveDefaultQaChannelAccountId,
  resolveQaChannelAccount,
  type ResolvedQaChannelAccount,
} from "./accounts.js";
import { qaChannelPluginConfigSchema } from "./config-schema.js";
import type { ChannelPlugin } from "./runtime-api.js";
import { applyQaSetup, type QaChannelSetupInput } from "./setup.js";
import type { CoreConfig } from "./types.js";

export const QA_CHANNEL_ID = "qa-channel" as const;

// qa-channel is synthetic and never in the bundled chat-meta catalog; it owns
// its metadata instead of spreading a lookup that could only ever be undefined.
export const qaChannelRuntimeMeta = {
  id: QA_CHANNEL_ID,
  label: "QA Channel",
  selectionLabel: "QA Channel",
  docsPath: "/channels/qa-channel",
  blurb: "Synthetic QA channel for OpenClaw QA runs.",
};
const qaChannelSetupMeta = qaChannelRuntimeMeta;

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
          input: input as QaChannelSetupInput,
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
