// Signal API module exposes the plugin doctor contract.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";
import { migrateLegacySignalTransportConfigSync } from "./src/config-compat.js";

const RETIRED_SIGNAL_ACCOUNT_TRANSPORT_FIELDS = [
  "configPath",
  "httpUrl",
  "httpHost",
  "httpPort",
  "cliPath",
  "autoStart",
  "startupTimeoutMs",
  "receiveMode",
  "ignoreStories",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasRetiredSignalAccountTransportFields(value: unknown): boolean {
  return (
    isRecord(value) &&
    RETIRED_SIGNAL_ACCOUNT_TRANSPORT_FIELDS.some((field) => Object.hasOwn(value, field))
  );
}

function hasRetiredSignalAccountMapTransportFields(value: unknown): boolean {
  return isRecord(value) && Object.values(value).some(hasRetiredSignalAccountTransportFields);
}

// Signal's nested streaming schema is delivery-only ({chunkMode, block}); it
// has no preview mode, so only the delivery flat aliases are legal legacy
// input. Account merge replaces the root streaming object wholesale
// (resolveMergedAccountConfig without a streaming deep-merge), so migration
// seeds materialized account objects with the inherited root settings.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "signal",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingReplacesRoot: true,
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "signal"],
    message:
      'Signal transport config is now account-owned; run "openclaw doctor --fix" to migrate retired channels.signal transport fields.',
    match: (value) =>
      isRecord(value) &&
      (Object.hasOwn(value, "apiMode") || hasRetiredSignalAccountTransportFields(value)),
  },
  {
    path: ["channels", "signal", "accounts"],
    message:
      'Signal transport config is now account-owned; run "openclaw doctor --fix" to migrate retired per-account transport fields.',
    match: hasRetiredSignalAccountMapTransportFields,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const streaming = streamingAliasMigration.normalizeChannelConfig({ cfg });
  const transport = migrateLegacySignalTransportConfigSync(streaming.config);
  return {
    config: transport.config,
    changes: [...streaming.changes, ...transport.changes],
    ...(transport.warnings?.length ? { warnings: transport.warnings } : {}),
  };
}
