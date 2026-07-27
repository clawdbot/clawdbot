// Whatsapp plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  hasLegacyAccountStreamingAliases,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor";
import { normalizeCompatibilityConfig as normalizeAckReactionConfig } from "./doctor.js";

// WhatsApp's nested streaming schema is delivery-only ({chunkMode, block});
// it has no preview mode, so only the delivery flat aliases are legal legacy
// input. WhatsApp resolution layers accounts.default shared config between the
// channel root and named accounts, so the shared migration materializes that
// inheritance when it creates a named-account streaming object.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "whatsapp",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingInheritsDefaultAccount: true,
});

const hasExposeErrorText = (value: unknown): boolean =>
  Object.hasOwn(asObjectRecord(value) ?? {}, "exposeErrorText");

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "whatsapp", "exposeErrorText"],
    message:
      'channels.whatsapp.exposeErrorText is retired and ignored. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "whatsapp", "accounts"],
    message:
      'channels.whatsapp.accounts.<id>.exposeErrorText is retired and ignored. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasExposeErrorText),
  },
];

function removeExposeErrorText(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  return stripRetiredChannelKeys({
    cfg,
    channelId: "whatsapp",
    keys: new Set(["exposeErrorText"]),
    scope: "root-and-accounts",
    onRemove: ({ key, pathPrefix }) => changes.push(`Removed retired ${pathPrefix}.${key}.`),
  }).config;
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const ackReaction = normalizeAckReactionConfig({ cfg });
  const retiredConfig = removeExposeErrorText(ackReaction.config, ackReaction.changes);
  return streamingAliasMigration.normalizeChannelConfig({
    cfg: retiredConfig,
    changes: ackReaction.changes,
  });
}
