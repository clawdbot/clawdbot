import {
  defineLegacyConfigMigration,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function hasLegacyThreadBindingTtl(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(threadBindings && hasOwnKey(threadBindings, "ttlHours"));
}

function hasLegacyThreadBindingSpawnSplit(value: unknown): boolean {
  const threadBindings = getRecord(value);
  return Boolean(
    threadBindings &&
    (hasOwnKey(threadBindings, "spawnSubagentSessions") ||
      hasOwnKey(threadBindings, "spawnAcpSessions")),
  );
}

function hasLegacyThreadBindingTtlInAccounts(value: unknown): boolean {
  const accounts = getRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((entry) =>
    hasLegacyThreadBindingTtl(getRecord(entry)?.threadBindings),
  );
}

function hasLegacyThreadBindingSpawnSplitInAccounts(value: unknown): boolean {
  const accounts = getRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((entry) =>
    hasLegacyThreadBindingSpawnSplit(getRecord(entry)?.threadBindings),
  );
}

function migrateThreadBindingsTtlHoursForPath(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasOwnKey(threadBindings, "ttlHours")) {
    return false;
  }

  const hadIdleHours = threadBindings.idleHours !== undefined;
  if (!hadIdleHours) {
    threadBindings.idleHours = threadBindings.ttlHours;
  }
  delete threadBindings.ttlHours;
  params.owner.threadBindings = threadBindings;

  if (hadIdleHours) {
    params.changes.push(
      `Removed ${params.pathPrefix}.threadBindings.ttlHours (${params.pathPrefix}.threadBindings.idleHours already set).`,
    );
  } else {
    params.changes.push(
      `Moved ${params.pathPrefix}.threadBindings.ttlHours → ${params.pathPrefix}.threadBindings.idleHours.`,
    );
  }
  return true;
}

function resolveMigratedSpawnSessions(
  threadBindings: Record<string, unknown>,
): boolean | undefined {
  const subagent = threadBindings.spawnSubagentSessions;
  const acp = threadBindings.spawnAcpSessions;
  const subagentBool = typeof subagent === "boolean" ? subagent : undefined;
  const acpBool = typeof acp === "boolean" ? acp : undefined;
  if (subagentBool === undefined) {
    return acpBool;
  }
  if (acpBool === undefined) {
    return subagentBool;
  }
  return subagentBool && acpBool;
}

function migrateThreadBindingsSpawnSessionsForPath(params: {
  owner: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
}): boolean {
  const threadBindings = getRecord(params.owner.threadBindings);
  if (!threadBindings || !hasLegacyThreadBindingSpawnSplit(threadBindings)) {
    return false;
  }

  const hadSpawnSessions = threadBindings.spawnSessions !== undefined;
  const resolved = resolveMigratedSpawnSessions(threadBindings);
  const oldSubagent = threadBindings.spawnSubagentSessions;
  const oldAcp = threadBindings.spawnAcpSessions;
  delete threadBindings.spawnSubagentSessions;
  delete threadBindings.spawnAcpSessions;
  if (!hadSpawnSessions && resolved !== undefined) {
    threadBindings.spawnSessions = resolved;
  }
  params.owner.threadBindings = threadBindings;

  if (hadSpawnSessions) {
    params.changes.push(
      `Removed deprecated ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions (${params.pathPrefix}.threadBindings.spawnSessions already set).`,
    );
  } else if (
    typeof oldSubagent === "boolean" &&
    typeof oldAcp === "boolean" &&
    oldSubagent !== oldAcp
  ) {
    params.changes.push(
      `Collapsed conflicting ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`,
    );
  } else {
    params.changes.push(
      `Moved ${params.pathPrefix}.threadBindings.spawnSubagentSessions/spawnAcpSessions → ${params.pathPrefix}.threadBindings.spawnSessions (${String(resolved)}).`,
    );
  }
  return true;
}

function hasLegacyThreadBindingTtlInAnyChannel(value: unknown): boolean {
  const channels = getRecord(value);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((entry) => {
    const channel = getRecord(entry);
    if (!channel) {
      return false;
    }
    return (
      hasLegacyThreadBindingTtl(channel.threadBindings) ||
      hasLegacyThreadBindingTtlInAccounts(channel.accounts)
    );
  });
}

function hasLegacyThreadBindingSpawnSplitInAnyChannel(value: unknown): boolean {
  const channels = getRecord(value);
  if (!channels) {
    return false;
  }
  return Object.values(channels).some((entry) => {
    const channel = getRecord(entry);
    if (!channel) {
      return false;
    }
    return (
      hasLegacyThreadBindingSpawnSplit(channel.threadBindings) ||
      hasLegacyThreadBindingSpawnSplitInAccounts(channel.accounts)
    );
  });
}

const THREAD_BINDING_RULES: LegacyConfigRule[] = [
  {
    path: ["session", "threadBindings"],
    message:
      'session.threadBindings.ttlHours was renamed to session.threadBindings.idleHours. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingTtl(value),
  },
  {
    path: ["channels"],
    message:
      'channels.<id>.threadBindings.ttlHours was renamed to channels.<id>.threadBindings.idleHours. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingTtlInAnyChannel(value),
  },
  {
    path: ["session", "threadBindings"],
    message:
      'session.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by session.threadBindings.spawnSessions. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingSpawnSplit(value),
  },
  {
    path: ["channels"],
    message:
      'channels.<id>.threadBindings.spawnSubagentSessions/spawnAcpSessions were replaced by channels.<id>.threadBindings.spawnSessions. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyThreadBindingSpawnSplitInAnyChannel(value),
  },
];

export const LEGACY_CONFIG_MIGRATIONS_CHANNELS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "thread-bindings.ttlHours->idleHours",
    describe:
      "Move legacy threadBindings.ttlHours keys to threadBindings.idleHours (session + channel configs)",
    legacyRules: THREAD_BINDING_RULES,
    apply: (raw, changes) => {
      const session = getRecord(raw.session);
      if (session) {
        migrateThreadBindingsTtlHoursForPath({
          owner: session,
          pathPrefix: "session",
          changes,
        });
        migrateThreadBindingsSpawnSessionsForPath({
          owner: session,
          pathPrefix: "session",
          changes,
        });
        raw.session = session;
      }

      const channels = getRecord(raw.channels);
      if (!channels) {
        return;
      }

      for (const [channelId, channelRaw] of Object.entries(channels)) {
        const channel = getRecord(channelRaw);
        if (!channel) {
          continue;
        }
        migrateThreadBindingsTtlHoursForPath({
          owner: channel,
          pathPrefix: `channels.${channelId}`,
          changes,
        });
        migrateThreadBindingsSpawnSessionsForPath({
          owner: channel,
          pathPrefix: `channels.${channelId}`,
          changes,
        });

        const accounts = getRecord(channel.accounts);
        if (accounts) {
          for (const [accountId, accountRaw] of Object.entries(accounts)) {
            const account = getRecord(accountRaw);
            if (!account) {
              continue;
            }
            migrateThreadBindingsTtlHoursForPath({
              owner: account,
              pathPrefix: `channels.${channelId}.accounts.${accountId}`,
              changes,
            });
            migrateThreadBindingsSpawnSessionsForPath({
              owner: account,
              pathPrefix: `channels.${channelId}.accounts.${accountId}`,
              changes,
            });
            accounts[accountId] = account;
          }
          channel.accounts = accounts;
        }
        channels[channelId] = channel;
      }
      raw.channels = channels;
    },
  }),
];
