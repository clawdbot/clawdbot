import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyChannelAliases,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveSlackNativeStreaming, resolveSlackStreamingMode } from "./streaming-compat.js";

function hasLegacySlackStreamingAliases(value: unknown): boolean {
  return hasLegacyStreamingAliases(value, { includeNativeTransport: true });
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "slack"],
    message:
      "channels.slack.streamMode, channels.slack.streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}.",
    match: hasLegacySlackStreamingAliases,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      "channels.slack.accounts.<id>.streamMode, streaming (scalar), chunkMode, blockStreaming, blockStreamingCoalesce, and nativeStreaming are legacy; use channels.slack.accounts.<id>.streaming.{mode,chunkMode,block.enabled,block.coalesce,nativeTransport}.",
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacySlackStreamingAliases),
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.slack);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  const aliases = normalizeLegacyChannelAliases({
    entry: rawEntry,
    pathPrefix: "channels.slack",
    changes,
    normalizeDm: true,
    normalizeAccountDm: true,
    resolveStreamingOptions: (entry) => ({
      resolvedMode: resolveSlackStreamingMode(entry),
      resolvedNativeTransport: resolveSlackNativeStreaming(entry),
    }),
  });
  updated = aliases.entry;
  changed = aliases.changed;

  if (!changed) {
    return { config: cfg, changes: [] };
  }
  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        slack: updated as unknown as NonNullable<OpenClawConfig["channels"]>["slack"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}
