// Googlechat plugin module implements doctor contract behavior.
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
} from "openclaw/plugin-sdk/runtime-doctor-migrations";

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

const groupAllowMigration = defineKeyMoveMigration({
  scope: ["groups", "*"],
  from: ["allow"],
  to: ["enabled"],
});

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

  const groups = groupAllowMigration.normalize({ ...params, entry: updated });
  updated = groups.entry;
  changed = changed || groups.changed;

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
    match: groupAllowMigration.hasLegacy,
  },
  {
    path: ["channels", "googlechat", "accounts"],
    message:
      'channels.googlechat.accounts.<id>.groups.<id>.allow is legacy; use channels.googlechat.accounts.<id>.groups.<id>.enabled instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, groupAllowMigration.hasLegacy),
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
