import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { createTelegramPluginConfig } from "./config-adapter.js";
import { TelegramChannelConfigSchema } from "./config-schema.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

const TELEGRAM_CHANNEL = "telegram" as const;

export function createTelegramSetupPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupWizard"]>;
  setupContract: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupContract"]>;
}): Pick<
  ChannelPlugin<ResolvedTelegramAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "reload"
  | "configSchema"
  | "config"
  | "setupContract"
  | "secrets"
> {
  return {
    id: TELEGRAM_CHANNEL,
    setupContract: params.setupContract,
    meta: {
      ...getChatChannelMeta(TELEGRAM_CHANNEL),
      quickstartAllowFrom: true,
    },
    setupWizard: params.setupWizard,
    capabilities: {
      chatTypes: ["direct", "group", "channel", "thread"],
      reactions: true,
      threads: true,
      media: true,
      tts: {
        voice: {
          synthesisTarget: "voice-note",
          captionedFinalText: true,
        },
      },
      polls: true,
      nativeCommands: true,
      blockStreaming: true,
    },
    reload: {
      configPrefixes: ["channels.telegram"],
      noopPrefixes: ["messages.inbound", "messages.ackReactionScope"],
    },
    configSchema: TelegramChannelConfigSchema,
    config: createTelegramPluginConfig(),
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
  };
}
