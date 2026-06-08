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
      const accountGroups = asObjectRecord(account?.groups);
      if (!account || !accountGroups) {
        continue;
      }
      const migrated = migrateGroups({
        groups: accountGroups,
        pathPrefix: `channels.qqbot.accounts.${accountId}.groups`,
        changes,
      });
      if (migrated.changed) {
        nextAccounts[accountId] = { ...account, groups: migrated.groups };
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
