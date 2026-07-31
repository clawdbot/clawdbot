// Qqbot plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineKeyMoveMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
} from "openclaw/plugin-sdk/runtime-doctor";

const RESTRICTED_GROUP_TOOLS: GroupToolPolicyConfig = {
  deny: ["exec", "read", "write"],
};

const streamingTransportMigration = defineKeyMoveMigration({
  from: ["streaming", "c2cStreamApi"],
  to: ["streaming", "nativeTransport"],
  match: (value) => value !== undefined,
  sourceOwn: false,
});

// QQBot's legacy scalar `streaming` is not a plain mode alias: `true` enabled
// block streaming AND the official C2C stream API (shouldUseOfficialC2cStream
// treated `true` like `c2cStreamApi: true`), while `false` only disabled block
// streaming. It migrates to the nested `{mode, nativeTransport}` shape here
// instead of the shared alias DSL because qqbot has no flat delivery aliases
// and its strict streaming schema rejects the DSL's chunkMode/block slots.
// No account seeding: named accounts never inherit root config (bridge/config
// resolves them standalone), and the boolean carries its full semantics.
function hasLegacyStreamingValue(value: unknown): boolean {
  const entry = asObjectRecord(value);
  if (!entry) {
    return false;
  }
  return typeof entry.streaming === "boolean" || streamingTransportMigration.hasLegacy(entry);
}

function migrateStreamingValue(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  const streaming = params.entry.streaming;
  const path = `${params.pathPrefix}.streaming`;
  if (typeof streaming === "boolean") {
    const next: Record<string, unknown> = streaming
      ? { mode: "partial", nativeTransport: true }
      : { mode: "off" };
    params.changes.push(`Moved ${path} (boolean) → ${path}.mode (${next.mode as string}).`);
    if (streaming) {
      // `streaming: true` also enabled the official C2C stream API.
      params.changes.push(`Moved ${path} (boolean) → ${path}.nativeTransport.`);
    }
    return { entry: { ...params.entry, streaming: next }, changed: true };
  }
  return streamingTransportMigration.normalize(params);
}

function migrateToolPolicy(value: unknown): GroupToolPolicyConfig | undefined {
  if (value === "none") {
    return { deny: ["*"] };
  }
  if (value === "full") {
    return { allow: [] };
  }
  if (value === "restricted") {
    return { ...RESTRICTED_GROUP_TOOLS };
  }
  return undefined;
}

function describeToolPolicy(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

const groupToolPolicyMigration = defineKeyMoveMigration({
  scope: ["*"],
  from: ["toolPolicy"],
  to: ["tools"],
  match: (value) => value !== undefined,
  sourceOwn: false,
  map: (value) => {
    const policy = migrateToolPolicy(value);
    return policy ? { value: policy } : null;
  },
  movedMessage: ({ sourcePath, targetPath, sourceValue }) =>
    `Moved ${sourcePath}=${describeToolPolicy(sourceValue)} to ${targetPath}.`,
  existingMessage: ({ sourcePath, targetPath }) =>
    `Removed ${sourcePath} (${targetPath} already exists).`,
  invalidMessage: ({ sourcePath, sourceValue }) =>
    `Removed unsupported ${sourcePath}=${describeToolPolicy(sourceValue)}.`,
});

const voiceDirectUploadFormatsMigration = defineKeyMoveMigration({
  from: ["voiceDirectUploadFormats"],
  to: ["audioFormatPolicy", "uploadDirectFormats"],
  match: (value) => value !== undefined,
  sourceOwn: false,
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "qqbot"],
    message:
      'channels.qqbot streaming aliases and voiceDirectUploadFormats are legacy; use streaming.{mode,nativeTransport} and audioFormatPolicy.uploadDirectFormats. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyStreamingValue(value) || voiceDirectUploadFormatsMigration.hasLegacy(value),
  },
  {
    path: ["channels", "qqbot", "accounts"],
    message:
      'channels.qqbot account streaming aliases and voiceDirectUploadFormats are legacy; use streaming.{mode,nativeTransport} and audioFormatPolicy.uploadDirectFormats. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(
        value,
        (entry) =>
          hasLegacyStreamingValue(entry) || voiceDirectUploadFormatsMigration.hasLegacy(entry),
      ),
  },
  {
    path: ["channels", "qqbot", "groups"],
    message:
      'channels.qqbot.groups.<id>.toolPolicy is legacy and was ignored by QQBot group tool enforcement; use channels.qqbot.groups.<id>.tools instead. Run "openclaw doctor --fix".',
    match: groupToolPolicyMigration.hasLegacy,
  },
  {
    path: ["channels", "qqbot", "accounts"],
    message:
      'channels.qqbot.accounts.<id>.groups.<groupId>.toolPolicy is legacy and was ignored by QQBot group tool enforcement; use channels.qqbot.accounts.<id>.groups.<groupId>.tools instead. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, (account) =>
        groupToolPolicyMigration.hasLegacy(asObjectRecord(account)?.groups),
      ),
  },
];

function normalizeQqbotEntry(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { entry: Record<string, unknown>; changed: boolean } {
  let { entry, changed } = migrateStreamingValue(params);
  const audioFormats = voiceDirectUploadFormatsMigration.normalize({
    ...params,
    entry,
  });
  entry = audioFormats.entry;
  changed ||= audioFormats.changed;
  const groups = asObjectRecord(entry.groups);
  if (!groups) {
    return { entry, changed };
  }
  const migrated = groupToolPolicyMigration.normalize({
    entry: groups,
    pathPrefix: `${params.pathPrefix}.groups`,
    changes: params.changes,
  });
  return migrated.changed
    ? { entry: { ...entry, groups: migrated.entry }, changed: true }
    : { entry, changed };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return normalizeChannelConfigEntries({
    cfg,
    channelId: "qqbot",
    normalizeEntry: normalizeQqbotEntry,
  });
}
