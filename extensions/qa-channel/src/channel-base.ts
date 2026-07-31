import { defineChannelSetupContract } from "openclaw/plugin-sdk/channel-setup";
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
  "id" | "meta" | "capabilities" | "reload" | "configSchema" | "setup" | "setupContract" | "config"
>;

export function createQaChannelPluginBase(
  meta: ChannelPlugin<ResolvedQaChannelAccount>["meta"] = qaChannelSetupMeta,
): QaChannelPluginBase {
  const setup = {
    applyAccountConfig: ({ cfg, accountId, input }) =>
      applyQaSetup({
        cfg,
        accountId,
        input: input as QaChannelSetupInput,
      }),
  } satisfies NonNullable<ChannelPlugin["setup"]>;
  return {
    id: QA_CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    reload: { configPrefixes: ["channels.qa-channel"] },
    configSchema: qaChannelPluginConfigSchema,
    setup,
    setupContract: defineChannelSetupContract({
      fields: {
        baseUrl: {
          kind: "string",
          cli: { flags: "--base-url <url>", description: "QA channel base URL" },
        },
        botUserId: {
          kind: "string",
          cli: { flags: "--bot-user-id <id>", description: "QA channel bot user id" },
        },
        botDisplayName: {
          kind: "string",
          cli: { flags: "--bot-display-name <name>", description: "QA channel bot display name" },
        },
      },
      legacyAdapter: setup,
    }),
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
