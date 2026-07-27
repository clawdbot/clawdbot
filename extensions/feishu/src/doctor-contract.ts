// Feishu plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  normalizeChannelConfigEntries,
} from "openclaw/plugin-sdk/runtime-doctor";

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
const LEGACY_HEARTBEAT_FIELDS = ["visibility", "intervalMs"] as const;

function sanitizeLegacyHeartbeatFields(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const heartbeat = asObjectRecord(params.entry.heartbeat);
  if (
    !heartbeat ||
    (Object.keys(heartbeat).length > 0 &&
      !LEGACY_HEARTBEAT_FIELDS.some((field) => Object.hasOwn(heartbeat, field)))
  ) {
    return { entry: params.entry, changed: false };
  }
  const next = { ...params.entry };
  delete next.heartbeat;
  params.changes.push(
    `Removed ${params.pathPrefix}.heartbeat (legacy Feishu fields were never read by runtime).`,
  );
  return { entry: next, changed: true };
}

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
  return normalizeChannelConfigEntries({
    cfg,
    channelId: "feishu",
    changes,
    normalizeEntry: (params) => {
      const coalesce = sanitizeLegacyCoalesceFields(params);
      const heartbeat = sanitizeLegacyHeartbeatFields({ ...params, entry: coalesce.entry });
      return {
        entry: heartbeat.entry,
        changed: coalesce.changed || heartbeat.changed,
      };
    },
  }).config;
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
