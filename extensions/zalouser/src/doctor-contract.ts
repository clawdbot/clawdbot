// Zalouser plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
} from "openclaw/plugin-sdk/runtime-doctor";

function hasLegacyZalouserGroupAllowAlias(value: unknown): boolean {
  const group = asObjectRecord(value);
  return Boolean(group && typeof group.allow === "boolean");
}

function hasLegacyZalouserGroupAllowAliases(value: unknown): boolean {
  const groups = asObjectRecord(value);
  return Boolean(
    groups && Object.values(groups).some((group) => hasLegacyZalouserGroupAllowAlias(group)),
  );
}

function normalizeZalouserGroupAllowAliases(params: {
  groups: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { groups: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextGroups: Record<string, unknown> = { ...params.groups };
  for (const [groupId, groupValue] of Object.entries(params.groups)) {
    const group = asObjectRecord(groupValue);
    if (!group || typeof group.allow !== "boolean") {
      continue;
    }
    const nextGroup = { ...group };
    if (typeof nextGroup.enabled !== "boolean") {
      nextGroup.enabled = group.allow;
    }
    delete nextGroup.allow;
    nextGroups[groupId] = nextGroup;
    changed = true;
    params.changes.push(
      `Moved ${params.pathPrefix}.${groupId}.allow → ${params.pathPrefix}.${groupId}.enabled (${String(nextGroup.enabled)}).`,
    );
  }
  return { groups: nextGroups, changed };
}

function normalizeZalouserEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const groups = asObjectRecord(params.entry.groups);
  if (!groups) {
    return { entry: params.entry, changed: false };
  }
  const normalized = normalizeZalouserGroupAllowAliases({
    groups,
    pathPrefix: `${params.pathPrefix}.groups`,
    changes: params.changes,
  });
  return normalized.changed
    ? { entry: { ...params.entry, groups: normalized.groups }, changed: true }
    : { entry: params.entry, changed: false };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "zalouser", "groups"],
    message:
      'channels.zalouser.groups.<id>.allow is legacy; use channels.zalouser.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyZalouserGroupAllowAliases,
  },
  {
    path: ["channels", "zalouser", "accounts"],
    message:
      'channels.zalouser.accounts.<id>.groups.<id>.allow is legacy; use channels.zalouser.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, (account) =>
        hasLegacyZalouserGroupAllowAliases(asObjectRecord(account)?.groups),
      ),
  },
];

export function normalizeCompatibilityConfig(params: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return normalizeChannelConfigEntries({
    cfg: params.cfg,
    channelId: "zalouser",
    normalizeEntry: normalizeZalouserEntry,
  });
}
