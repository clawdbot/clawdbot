import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
} from "openclaw/plugin-sdk/runtime-doctor";
import { resolveSlackNativeStreaming, resolveSlackStreamingMode } from "./streaming-compat.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

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

  const dm = normalizeLegacyDmAliases({
    entry: updated,
    pathPrefix: "channels.slack",
    changes,
  });
  updated = dm.entry;
  changed = changed || dm.changed;

  const streaming = normalizeLegacyStreamingAliases({
    entry: updated,
    pathPrefix: "channels.slack",
    changes,
    resolvedMode: resolveSlackStreamingMode(updated),
    resolvedNativeTransport: resolveSlackNativeStreaming(updated),
  });
  updated = streaming.entry;
  changed = changed || streaming.changed;

  const rawAccounts = asObjectRecord(updated.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      let accountEntry = account;
      let accountChanged = false;
      const accountDm = normalizeLegacyDmAliases({
        entry: accountEntry,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
      });
      accountEntry = accountDm.entry;
      accountChanged = accountDm.changed;
      const accountStreaming = normalizeLegacyStreamingAliases({
        entry: accountEntry,
        pathPrefix: `channels.slack.accounts.${accountId}`,
        changes,
        resolvedMode: resolveSlackStreamingMode(accountEntry),
        resolvedNativeTransport: resolveSlackNativeStreaming(accountEntry),
      });
      accountEntry = accountStreaming.entry;
      accountChanged = accountChanged || accountStreaming.changed;
      if (accountChanged) {
        accounts[accountId] = accountEntry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts };
      changed = true;
    }
  }

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
