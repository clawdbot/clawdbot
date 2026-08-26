// Matrix plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  defineChannelAliasMigration,
  defineKeyMoveMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
  hasLegacyFlatAllowPrivateNetworkAlias,
  migrateLegacyFlatAllowPrivateNetworkAlias,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixStreamingMode } from "./types.js";

function parseMatrixStreamingMode(value: unknown): MatrixStreamingMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "partial" ||
    normalized === "quiet" ||
    normalized === "progress" ||
    normalized === "off"
    ? normalized
    : null;
}

// Matrix has a preview stream mode with the channel-local "quiet" value, so it
// overrides the generic mode parser (which would collapse "quiet" to the
// default). Runtime defaults to "off" when streaming is absent or the object
// has no mode (resolveMatrixStreamingMode in matrix/monitor/index.ts), and the
// account merge replaces the root streaming object wholesale
// (resolveMergedAccountConfig without a streaming deep-merge), so migration
// seeds materialized account objects with the inherited root settings.
// `streamMode` was never a Matrix key (no schema field, no runtime read), so
// it is stripped as junk below instead of being treated as mode intent.
const streamingAliasMigration = defineChannelAliasMigration<MatrixStreamingMode>({
  channelId: "matrix",
  streaming: {
    defaultMode: "off",
    resolveMode: (entry) => {
      const streaming = isRecord(entry.streaming) ? entry.streaming : null;
      const parsed = parseMatrixStreamingMode(streaming ? streaming.mode : entry.streaming);
      if (parsed) {
        return parsed;
      }
      return entry.streaming === true ? "partial" : "off";
    },
  },
  accountStreamingReplacesRoot: true,
});

const roomAllowMigration = defineKeyMoveMigration({
  scope: ["*"],
  from: ["allow"],
  to: ["enabled"],
  sourceOwn: false,
  match: (value) => typeof value === "boolean",
  targetIsSet: (value) => typeof value === "boolean",
  movedMessage: ({ sourcePath, targetPath, mappedValue }) =>
    `Moved ${sourcePath} → ${targetPath} (${String(mappedValue)}).`,
  existingMessage: ({ sourcePath, targetPath, targetValue }) =>
    `Moved ${sourcePath} → ${targetPath} (${String(targetValue)}).`,
});

function hasLegacyTrustedDmPolicy(value: unknown): boolean {
  const root = isRecord(value) ? value : null;
  if (!root) {
    return false;
  }
  const dm = isRecord(root.dm) ? root.dm : null;
  return dm?.policy === "trusted";
}

function migrateLegacyTrustedDmPolicy(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const dm = isRecord(params.entry.dm) ? params.entry.dm : null;
  if (!dm || dm.policy !== "trusted") {
    return { entry: params.entry, changed: false };
  }
  const allowFromRaw = dm.allowFrom;
  // Trim before counting: downstream allowlist normalization drops whitespace-only
  // entries, so a config like ["   "] must still fall back to "pairing"
  // instead of becoming an effectively empty allowlist.
  const allowFromEntries = Array.isArray(allowFromRaw)
    ? allowFromRaw.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      ).length
    : 0;
  // Preserve the operator's existing trust boundary when an explicit allowFrom
  // list is present; only fall back to pairing when the effective allowlist is
  // empty.
  const nextPolicy: "allowlist" | "pairing" = allowFromEntries > 0 ? "allowlist" : "pairing";
  const nextDm = { ...dm, policy: nextPolicy };
  params.changes.push(
    `Migrated ${params.pathPrefix}.dm.policy "trusted" → "${nextPolicy}" (legacy alias removed; ` +
      `${allowFromEntries > 0 ? `preserved ${allowFromEntries} ${params.pathPrefix}.dm.allowFrom ${allowFromEntries === 1 ? "entry" : "entries"}` : "no allowFrom entries present, defaulting to pairing for safety"}).`,
  );
  return { entry: { ...params.entry, dm: nextDm }, changed: true };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "matrix"],
    message:
      'channels.matrix.allowPrivateNetwork is legacy; use channels.matrix.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyFlatAllowPrivateNetworkAlias(isRecord(value) ? value : {}),
  },
  {
    path: ["channels", "matrix", "accounts"],
    message:
      'channels.matrix.accounts.<id>.allowPrivateNetwork is legacy; use channels.matrix.accounts.<id>.network.dangerouslyAllowPrivateNetwork instead. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, (account) =>
        hasLegacyFlatAllowPrivateNetworkAlias(isRecord(account) ? account : {}),
      ),
  },
  {
    path: ["channels", "matrix", "groups"],
    message:
      'channels.matrix.groups.<room>.allow is legacy; use channels.matrix.groups.<room>.enabled instead. Run "openclaw doctor --fix".',
    match: roomAllowMigration.hasLegacy,
  },
  {
    path: ["channels", "matrix", "rooms"],
    message:
      'channels.matrix.rooms.<room>.allow is legacy; use channels.matrix.rooms.<room>.enabled instead. Run "openclaw doctor --fix".',
    match: roomAllowMigration.hasLegacy,
  },
  {
    path: ["channels", "matrix", "accounts"],
    message:
      'channels.matrix.accounts.<id>.{groups,rooms}.<room>.allow is legacy; use channels.matrix.accounts.<id>.{groups,rooms}.<room>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, (account) => {
        if (!isRecord(account)) {
          return false;
        }
        return (
          roomAllowMigration.hasLegacy(account.groups) ||
          roomAllowMigration.hasLegacy(account.rooms)
        );
      }),
  },
  {
    path: ["channels", "matrix"],
    message:
      'channels.matrix.dm.policy "trusted" is legacy; use "allowlist" (with allowFrom entries) or "pairing" instead. Run "openclaw doctor --fix".',
    match: hasLegacyTrustedDmPolicy,
  },
  {
    path: ["channels", "matrix", "accounts"],
    message:
      'channels.matrix.accounts.<id>.dm.policy "trusted" is legacy; use "allowlist" (with allowFrom entries) or "pairing" instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyTrustedDmPolicy),
  },
];

function normalizeMatrixEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const network = migrateLegacyFlatAllowPrivateNetworkAlias(params);
  const dmPolicy = migrateLegacyTrustedDmPolicy({ ...params, entry: network.entry });
  let entry = dmPolicy.entry;
  let changed = network.changed || dmPolicy.changed;
  for (const section of ["groups", "rooms"] as const) {
    const roomMap = isRecord(entry[section]) ? entry[section] : null;
    if (!roomMap) {
      continue;
    }
    const normalized = roomAllowMigration.normalize({
      entry: roomMap,
      pathPrefix: `${params.pathPrefix}.${section}`,
      changes: params.changes,
    });
    if (normalized.changed) {
      entry = Object.assign({}, entry, { [section]: normalized.entry });
      changed = true;
    }
  }
  return {
    entry,
    changed,
  };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  // `streamMode` was never honored by Matrix, so remove it before the generic
  // alias migration can mistake it for mode intent.
  const withoutJunkStreamMode = stripRetiredChannelKeys({
    cfg,
    channelId: "matrix",
    keys: new Set(["streamMode"]),
    scope: "root-and-accounts",
    onRemove: ({ key, pathPrefix }) =>
      changes.push(`Removed ${pathPrefix}.${key} (never read by the Matrix runtime).`),
  }).config;
  const aliases = streamingAliasMigration.normalizeChannelConfig({
    cfg: withoutJunkStreamMode,
    changes,
  });
  return normalizeChannelConfigEntries({
    cfg: aliases.config,
    channelId: "matrix",
    changes,
    normalizeEntry: normalizeMatrixEntry,
  });
}
