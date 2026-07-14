// Qqbot plugin module implements doctor contract behavior.
import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor";

const RESTRICTED_GROUP_TOOLS: GroupToolPolicyConfig = {
  deny: ["exec", "read", "write"],
};

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
  return (
    typeof entry.streaming === "boolean" ||
    asObjectRecord(entry.streaming)?.c2cStreamApi !== undefined
  );
}

function hasLegacyAccountStreamingValues(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) => hasLegacyStreamingValue(account));
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
  const streamingRecord = asObjectRecord(streaming);
  if (!streamingRecord || streamingRecord.c2cStreamApi === undefined) {
    return { entry: params.entry, changed: false };
  }
  const { c2cStreamApi, ...rest } = streamingRecord;
  const next: Record<string, unknown> = { ...rest };
  if (next.nativeTransport === undefined) {
    next.nativeTransport = c2cStreamApi;
    params.changes.push(`Moved ${path}.c2cStreamApi → ${path}.nativeTransport.`);
  } else {
    params.changes.push(`Removed ${path}.c2cStreamApi (${path}.nativeTransport already set).`);
  }
  return { entry: { ...params.entry, streaming: next }, changed: true };
}

function hasLegacyGroupToolPolicy(value: unknown): boolean {
  const groups = asObjectRecord(value);
  if (!groups) {
    return false;
  }
  return Object.values(groups).some((group) => asObjectRecord(group)?.toolPolicy !== undefined);
}

function hasLegacyAccountGroupToolPolicy(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((account) =>
    hasLegacyGroupToolPolicy(asObjectRecord(account)?.groups),
  );
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

function migrateGroups(params: {
  groups: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): { groups: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const nextGroups = { ...params.groups };
  for (const [groupId, rawGroup] of Object.entries(params.groups)) {
    const group = asObjectRecord(rawGroup);
    if (!group || group.toolPolicy === undefined) {
      continue;
    }
    const { toolPolicy, ...rest } = group;
    const nextGroup = { ...rest };
    const policy = migrateToolPolicy(toolPolicy);
    const path = `${params.pathPrefix}.${groupId}`;
    if (nextGroup.tools !== undefined) {
      params.changes.push(`Removed ${path}.toolPolicy (${path}.tools already exists).`);
    } else if (policy) {
      nextGroup.tools = policy;
      params.changes.push(
        `Moved ${path}.toolPolicy=${describeToolPolicy(toolPolicy)} to ${path}.tools.`,
      );
    } else {
      params.changes.push(
        `Removed unsupported ${path}.toolPolicy=${describeToolPolicy(toolPolicy)}.`,
      );
    }
    nextGroups[groupId] = nextGroup;
    changed = true;
  }
  return { groups: nextGroups, changed };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "qqbot"],
    message:
      'channels.qqbot.streaming (boolean) and channels.qqbot.streaming.c2cStreamApi are legacy; use channels.qqbot.streaming.{mode,nativeTransport}. Run "openclaw doctor --fix".',
    match: hasLegacyStreamingValue,
  },
  {
    path: ["channels", "qqbot", "accounts"],
    message:
      'channels.qqbot.accounts.<id>.streaming (boolean) and streaming.c2cStreamApi are legacy; use channels.qqbot.accounts.<id>.streaming.{mode,nativeTransport}. Run "openclaw doctor --fix".',
    match: hasLegacyAccountStreamingValues,
  },
  {
    path: ["channels", "qqbot", "groups"],
    message:
      'channels.qqbot.groups.<id>.toolPolicy is legacy and was ignored by QQBot group tool enforcement; use channels.qqbot.groups.<id>.tools instead. Run "openclaw doctor --fix".',
    match: hasLegacyGroupToolPolicy,
  },
  {
    path: ["channels", "qqbot", "accounts"],
    message:
      'channels.qqbot.accounts.<id>.groups.<groupId>.toolPolicy is legacy and was ignored by QQBot group tool enforcement; use channels.qqbot.accounts.<id>.groups.<groupId>.tools instead. Run "openclaw doctor --fix".',
    match: hasLegacyAccountGroupToolPolicy,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawEntry = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.qqbot);
  if (!rawEntry) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let updated = rawEntry;
  let changed = false;

  const rootStreaming = migrateStreamingValue({
    entry: updated,
    pathPrefix: "channels.qqbot",
    changes,
  });
  updated = rootStreaming.entry;
  changed = changed || rootStreaming.changed;

  const groups = asObjectRecord(updated.groups);
  if (groups) {
    const migrated = migrateGroups({
      groups,
      pathPrefix: "channels.qqbot.groups",
      changes,
    });
    if (migrated.changed) {
      updated = { ...updated, groups: migrated.groups };
      changed = true;
    }
  }

  const accounts = asObjectRecord(updated.accounts);
  if (accounts) {
    let accountsChanged = false;
    const nextAccounts = { ...accounts };
    for (const [accountId, rawAccount] of Object.entries(accounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      const accountStreaming = migrateStreamingValue({
        entry: account,
        pathPrefix: `channels.qqbot.accounts.${accountId}`,
        changes,
      });
      let nextAccount = accountStreaming.entry;
      let accountChanged = accountStreaming.changed;

      const accountGroups = asObjectRecord(nextAccount.groups);
      if (accountGroups) {
        const migrated = migrateGroups({
          groups: accountGroups,
          pathPrefix: `channels.qqbot.accounts.${accountId}.groups`,
          changes,
        });
        if (migrated.changed) {
          nextAccount = { ...nextAccount, groups: migrated.groups };
          accountChanged = true;
        }
      }

      if (accountChanged) {
        nextAccounts[accountId] = nextAccount;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      updated = { ...updated, accounts: nextAccounts };
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
        qqbot: updated as unknown as NonNullable<OpenClawConfig["channels"]>["qqbot"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}
