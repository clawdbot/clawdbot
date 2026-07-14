// Feishu plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord, defineChannelAliasMigration } from "openclaw/plugin-sdk/runtime-doctor";

// Feishu's legacy boolean `streaming` gated streaming-card replies with an
// enabled default, so it migrates through the mode path (true → "partial",
// false → "off"); absent stays absent because runtime defaults to "partial"
// (resolveChannelPreviewStreamMode in reply-dispatcher.ts). Account merge
// replaces the root streaming object wholesale (resolveMergedAccountConfig
// without a streaming deep-merge in accounts.ts), so migration seeds
// materialized account objects with the inherited root settings.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "feishu",
  streaming: { defaultMode: "partial" },
  accountStreamingReplacesRoot: true,
});

// The retired Feishu-local coalesce schema advertised enabled/minDelayMs/
// maxDelayMs, but no runtime path ever read those fields (delivery reads
// minChars/maxChars/idleMs via resolveChannelStreamingBlockCoalesce). The
// generic alias migration moves the object verbatim, so strip the dead fields
// afterwards or `doctor --fix` would emit a schema-invalid coalesce object.
const LEGACY_COALESCE_FIELDS = ["enabled", "minDelayMs", "maxDelayMs"] as const;

function sanitizeLegacyCoalesceFields(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const streaming = asObjectRecord(params.entry.streaming);
  const block = asObjectRecord(streaming?.block);
  const coalesce = asObjectRecord(block?.coalesce);
  if (!streaming || !block || !coalesce) {
    return { entry: params.entry, changed: false };
  }
  const removed = LEGACY_COALESCE_FIELDS.filter((field) => coalesce[field] !== undefined);
  if (removed.length === 0) {
    return { entry: params.entry, changed: false };
  }
  const nextCoalesce = { ...coalesce };
  for (const field of removed) {
    delete nextCoalesce[field];
  }
  params.changes.push(
    `Removed ${params.pathPrefix}.streaming.block.coalesce.{${removed.join(",")}} (legacy Feishu-only fields; block delivery reads minChars/maxChars/idleMs).`,
  );
  return {
    entry: {
      ...params.entry,
      streaming: { ...streaming, block: { ...block, coalesce: nextCoalesce } },
    },
    changed: true,
  };
}

function sanitizeFeishuCoalesce(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.feishu);
  if (!entry) {
    return cfg;
  }
  const root = sanitizeLegacyCoalesceFields({
    entry,
    pathPrefix: "channels.feishu",
    changes,
  });
  let updated = root.entry;
  let changed = root.changed;

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      const sanitized = sanitizeLegacyCoalesceFields({
        entry: account,
        pathPrefix: `channels.feishu.accounts.${accountId}`,
        changes,
      });
      if (sanitized.changed) {
        nextAccounts[accountId] = sanitized.entry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts: nextAccounts };
      changed = true;
    }
  }

  if (!changed) {
    return cfg;
  }
  return {
    ...cfg,
    channels: { ...channels, feishu: updated },
  } as OpenClawConfig;
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] =
  streamingAliasMigration.legacyConfigRules;

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg });
  return {
    config: sanitizeFeishuCoalesce(aliases.config, aliases.changes),
    changes: aliases.changes,
  };
}
