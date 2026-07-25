// Googlechat plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
} from "openclaw/plugin-sdk/runtime-doctor";

// Google Chat's nested streaming schema is delivery-only ({chunkMode, block});
// it has no preview mode (legacy streamMode is removed outright above), so
// only the delivery flat aliases migrate. The plugin doctor below then
// materializes Google Chat's root < accounts.default < named precedence.
const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "googlechat",
  streaming: { defaultMode: "partial", deliveryOnly: true },
  accountStreamingInheritsDefaultAccount: true,
  dm: { root: true, accounts: true },
});

function hasLegacyGoogleChatStreamMode(value: unknown): boolean {
  return asObjectRecord(value)?.streamMode !== undefined;
}

function hasRetiredReactions(value: unknown): boolean {
  return Object.hasOwn(asObjectRecord(asObjectRecord(value)?.actions) ?? {}, "reactions");
}

function hasLegacyGoogleChatGroupAllowAlias(value: unknown): boolean {
  const groups = asObjectRecord(asObjectRecord(value)?.groups);
  if (!groups) {
    return false;
  }
  return Object.values(groups).some((group) => Object.hasOwn(asObjectRecord(group) ?? {}, "allow"));
}

function normalizeGoogleChatGroups(params: {
  groups: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { groups: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextGroups = { ...params.groups };
  for (const [groupId, groupValue] of Object.entries(params.groups)) {
    const group = asObjectRecord(groupValue);
    if (!group || !Object.hasOwn(group, "allow")) {
      continue;
    }
    const nextGroup = { ...group };
    if (nextGroup.enabled === undefined) {
      nextGroup.enabled = group.allow;
      params.changes.push(
        `Moved ${params.pathPrefix}.${groupId}.allow → ${params.pathPrefix}.${groupId}.enabled.`,
      );
    } else {
      params.changes.push(
        `Removed ${params.pathPrefix}.${groupId}.allow (${params.pathPrefix}.${groupId}.enabled already set).`,
      );
    }
    delete nextGroup.allow;
    nextGroups[groupId] = nextGroup;
    changed = true;
  }
  return { groups: nextGroups, changed };
}

function normalizeGoogleChatEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let updated = params.entry;
  let changed = false;

  if (updated.streamMode !== undefined) {
    updated = { ...updated };
    delete updated.streamMode;
    params.changes.push(`Removed ${params.pathPrefix}.streamMode (legacy key no longer used).`);
    changed = true;
  }

  if (hasRetiredReactions(updated)) {
    const actions = { ...asObjectRecord(updated.actions) };
    delete actions.reactions;
    updated = { ...updated };
    if (Object.keys(actions).length > 0) {
      updated.actions = actions;
    } else {
      delete updated.actions;
    }
    params.changes.push(
      `Removed ${params.pathPrefix}.actions.reactions (Google Chat does not support reactions).`,
    );
    changed = true;
  }

  const groups = asObjectRecord(updated.groups);
  if (groups) {
    const normalized = normalizeGoogleChatGroups({
      groups,
      pathPrefix: `${params.pathPrefix}.groups`,
      changes: params.changes,
    });
    if (normalized.changed) {
      updated = { ...updated, groups: normalized.groups };
      changed = true;
    }
  }

  return { entry: updated, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "googlechat"],
    message:
      'channels.googlechat.actions.reactions is retired and ignored. Run "openclaw doctor --fix".',
    match: hasRetiredReactions,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      'channels.googlechat.accounts.<id>.actions.reactions is retired and ignored. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasRetiredReactions),
  },
  {
    path: ["channels", "googlechat"],
    message: "channels.googlechat.streamMode is legacy and no longer used; it is removed on load.",
    match: hasLegacyGoogleChatStreamMode,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      "channels.googlechat.accounts.<id>.streamMode is legacy and no longer used; it is removed on load.",
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyGoogleChatStreamMode),
  },
  {
    path: ["channels", "googlechat"],
    message:
      'channels.googlechat.groups.<id>.allow is legacy; use channels.googlechat.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: hasLegacyGoogleChatGroupAllowAlias,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      'channels.googlechat.accounts.<id>.groups.<id>.allow is legacy; use channels.googlechat.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasLegacyGoogleChatGroupAllowAlias),
  },
  ...streamingAliasMigration.legacyConfigRules,
];

function normalizeRetiredGoogleChatKeys(cfg: OpenClawConfig): ChannelDoctorConfigMutation {
  return normalizeChannelConfigEntries({
    cfg,
    channelId: "googlechat",
    normalizeEntry: normalizeGoogleChatEntry,
  });
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const retired = normalizeRetiredGoogleChatKeys(cfg);
  return streamingAliasMigration.normalizeChannelConfig({
    cfg: retired.config,
    changes: retired.changes,
  });
}
