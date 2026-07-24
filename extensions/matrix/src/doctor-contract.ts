// Matrix plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  defineChannelAliasMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor";
import {
  hasLegacyFlatAllowPrivateNetworkAlias,
  migrateLegacyFlatAllowPrivateNetworkAlias,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "./record-shared.js";
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

function hasLegacyMatrixRoomAllowAlias(value: unknown): boolean {
  const room = isRecord(value) ? value : null;
  return Boolean(room && typeof room.allow === "boolean");
}

function hasLegacyMatrixRoomMapAllowAliases(value: unknown): boolean {
  const rooms = isRecord(value) ? value : null;
  return Boolean(rooms && Object.values(rooms).some((room) => hasLegacyMatrixRoomAllowAlias(room)));
}

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

function normalizeMatrixRoomAllowAliases(params: {
  rooms: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { rooms: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextRooms: Record<string, unknown> = { ...params.rooms };
  for (const [roomId, roomValue] of Object.entries(params.rooms)) {
    const room = isRecord(roomValue) ? roomValue : null;
    if (!room || typeof room.allow !== "boolean") {
      continue;
    }
    const nextRoom = { ...room };
    if (typeof nextRoom.enabled !== "boolean") {
      nextRoom.enabled = room.allow;
    }
    delete nextRoom.allow;
    nextRooms[roomId] = nextRoom;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.${roomId}.allow → ${params.pathPrefix}.${roomId}.enabled (${String(nextRoom.enabled)}).`,
    );
  }
  return { rooms: nextRooms, changed };
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
    match: hasLegacyMatrixRoomMapAllowAliases,
  },
  {
    path: ["channels", "matrix", "rooms"],
    message:
      'channels.matrix.rooms.<room>.allow is legacy; use channels.matrix.rooms.<room>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyMatrixRoomMapAllowAliases,
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
          hasLegacyMatrixRoomMapAllowAliases(account.groups) ||
          hasLegacyMatrixRoomMapAllowAliases(account.rooms)
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
  for (const key of ["groups", "rooms"] as const) {
    const rooms = isRecord(entry[key]) ? entry[key] : null;
    if (!rooms) {
      continue;
    }
    const normalized = normalizeMatrixRoomAllowAliases({
      rooms,
      pathPrefix: `${params.pathPrefix}.${key}`,
      changes: params.changes,
    });
    if (normalized.changed) {
      entry = Object.assign({}, entry, { [key]: normalized.rooms });
      changed = true;
    }
  }
  return { entry, changed };
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
