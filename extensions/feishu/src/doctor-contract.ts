// Feishu plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  defineKeyMoveMigration,
  hasLegacyAccountStreamingAliases,
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
const toolsBaseMigration = defineKeyMoveMigration({
  from: ["tools", "base"],
  to: ["tools", "bitable"],
  match: (value) => typeof value === "boolean",
  sourceOwn: false,
});

function normalizeLegacyCustomDomain(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    (!url.username && !url.password && !url.href.includes("?") && !url.href.includes("#"))
  ) {
    return undefined;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function sanitizeLegacyCustomDomain(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const domain = normalizeLegacyCustomDomain(params.entry.domain);
  if (!domain) {
    return { entry: params.entry, changed: false };
  }
  params.changes.push(
    `Normalized ${params.pathPrefix}.domain by removing unsupported URL credentials, query, or fragment components.`,
  );
  return { entry: { ...params.entry, domain }, changed: true };
}

function hasLegacyFeishuCustomDomain(entry: Record<string, unknown> | undefined): boolean {
  if (!entry) {
    return false;
  }
  if (normalizeLegacyCustomDomain(entry.domain)) {
    return true;
  }
  return Object.values(asObjectRecord(entry.accounts) ?? {}).some((account) => {
    return normalizeLegacyCustomDomain(asObjectRecord(account)?.domain) !== undefined;
  });
}

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

function sanitizeFeishuLegacyConfig(cfg: OpenClawConfig, changes: string[]): OpenClawConfig {
  return normalizeChannelConfigEntries({
    cfg,
    channelId: "feishu",
    changes,
    normalizeEntry: (params) => {
      const tools = toolsBaseMigration.normalize(params);
      const domain = sanitizeLegacyCustomDomain({ ...params, entry: tools.entry });
      const coalesce = sanitizeLegacyCoalesceFields({ ...params, entry: domain.entry });
      const heartbeat = sanitizeLegacyHeartbeatFields({ ...params, entry: coalesce.entry });
      return {
        entry: heartbeat.entry,
        changed: tools.changed || domain.changed || coalesce.changed || heartbeat.changed,
      };
    },
  }).config;
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "feishu"],
    message:
      'channels.feishu[.accounts.<id>].tools.base is legacy; use tools.bitable. Run "openclaw doctor --fix".',
    match: (value) => {
      const entry = asObjectRecord(value);
      return (
        toolsBaseMigration.hasLegacy(entry) ||
        hasLegacyAccountStreamingAliases(entry?.accounts, toolsBaseMigration.hasLegacy)
      );
    },
  },
  {
    path: ["channels", "feishu"],
    message:
      'channels.feishu[.accounts.<id>].domain must be an HTTPS API base URL. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyFeishuCustomDomain(asObjectRecord(value) ?? undefined),
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const aliases = streamingAliasMigration.normalizeChannelConfig({ cfg });
  return {
    config: sanitizeFeishuLegacyConfig(aliases.config, aliases.changes),
    changes: aliases.changes,
  };
}
