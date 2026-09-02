import { isDeepStrictEqual } from "node:util";
import { mergeDeep } from "../infra/deep-merge.js";
import {
  asObjectRecord,
  type CompatMutationResult,
  type NormalizeChannelConfigEntryParams,
  type NormalizeLegacyChannelAccountParams,
  type RetiredChannelKeyRemoval,
} from "./channel-compat-normalization.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Applies one channel-specific doctor migration to every object-shaped account. */
export function normalizeChannelAccounts(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  normalizeAccount: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
}): CompatMutationResult {
  const rawAccounts = asObjectRecord(params.entry.accounts);
  if (!rawAccounts) {
    return { entry: params.entry, changed: false };
  }
  let changed = false;
  const accounts = { ...rawAccounts };
  for (const [accountId, value] of Object.entries(rawAccounts)) {
    const account = asObjectRecord(value);
    if (!account) {
      continue;
    }
    const normalized = params.normalizeAccount({
      account,
      accountId,
      pathPrefix: `${params.pathPrefix}.accounts.${accountId}`,
      changes: params.changes,
    });
    if (normalized.changed) {
      accounts[accountId] = normalized.entry;
      changed = true;
    }
  }
  return changed
    ? { entry: { ...params.entry, accounts }, changed: true }
    : { entry: params.entry, changed: false };
}

/** Applies the same channel-specific doctor migration at root and account scope. */
export function normalizeChannelConfigEntries(params: {
  cfg: OpenClawConfig;
  channelId: string;
  changes?: string[];
  normalizeEntry: (params: NormalizeChannelConfigEntryParams) => CompatMutationResult;
}): { config: OpenClawConfig; changes: string[] } {
  const changes = params.changes ?? [];
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.[params.channelId]);
  if (!entry) {
    return { config: params.cfg, changes };
  }
  const channelPath = `channels.${params.channelId}`;
  const root = params.normalizeEntry({ entry, pathPrefix: channelPath, changes });
  const accounts = normalizeChannelAccounts({
    entry: root.entry,
    pathPrefix: channelPath,
    changes,
    normalizeAccount: (accountParams) =>
      params.normalizeEntry({
        entry: accountParams.account,
        accountId: accountParams.accountId,
        pathPrefix: accountParams.pathPrefix,
        changes: accountParams.changes,
      }),
  });
  if (!root.changed && !accounts.changed) {
    return { config: params.cfg, changes };
  }
  return {
    config: {
      ...params.cfg,
      channels: { ...channels, [params.channelId]: accounts.entry },
    } as OpenClawConfig,
    changes,
  };
}

function stripRetiredKeys(params: {
  value: unknown;
  keys: ReadonlySet<string>;
  pathPrefix: string;
  recursive: boolean;
  onRemove?: (removed: RetiredChannelKeyRemoval) => void;
}): { value: unknown; changed: boolean } {
  if (params.recursive && Array.isArray(params.value)) {
    let changed = false;
    const value = params.value.map((item, index) => {
      const stripped = stripRetiredKeys({
        ...params,
        value: item,
        pathPrefix: `${params.pathPrefix}[${index}]`,
      });
      changed = changed || stripped.changed;
      return stripped.value;
    });
    return { value: changed ? value : params.value, changed };
  }
  const record = asObjectRecord(params.value);
  if (!record) {
    return { value: params.value, changed: false };
  }
  let changed = false;
  const value: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (params.keys.has(key)) {
      params.onRemove?.({ key, pathPrefix: params.pathPrefix });
      changed = true;
      continue;
    }
    if (!params.recursive) {
      value[key] = child;
      continue;
    }
    const stripped = stripRetiredKeys({
      ...params,
      value: child,
      pathPrefix: `${params.pathPrefix}.${key}`,
    });
    changed = changed || stripped.changed;
    value[key] = stripped.value;
  }
  return { value: changed ? value : params.value, changed };
}

/** Removes retired keys recursively or from a channel root and its accounts. */
export function stripRetiredChannelKeys(params: {
  cfg: OpenClawConfig;
  channelId: string;
  keys: ReadonlySet<string>;
  scope: "recursive" | "root-and-accounts";
  onRemove?: (removed: RetiredChannelKeyRemoval) => void;
}): { config: OpenClawConfig; changed: boolean } {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.[params.channelId]);
  if (!entry) {
    return { config: params.cfg, changed: false };
  }
  const channelPath = `channels.${params.channelId}`;
  if (params.scope === "recursive") {
    const stripped = stripRetiredKeys({
      value: entry,
      keys: params.keys,
      pathPrefix: channelPath,
      recursive: true,
      onRemove: params.onRemove,
    });
    return stripped.changed
      ? {
          config: {
            ...params.cfg,
            channels: { ...channels, [params.channelId]: stripped.value },
          } as OpenClawConfig,
          changed: true,
        }
      : { config: params.cfg, changed: false };
  }
  const normalized = normalizeChannelConfigEntries({
    cfg: params.cfg,
    channelId: params.channelId,
    normalizeEntry: (entryParams) => {
      const stripped = stripRetiredKeys({
        value: entryParams.entry,
        keys: params.keys,
        pathPrefix: entryParams.pathPrefix,
        recursive: false,
        onRemove: params.onRemove,
      });
      return { entry: stripped.value as Record<string, unknown>, changed: stripped.changed };
    },
  });
  return { config: normalized.config, changed: normalized.config !== params.cfg };
}

/** Materializes root/default-account inheritance after aliases create streaming. */
export function materializeInheritedAccountStreaming(params: {
  cfg: OpenClawConfig;
  channelId: string;
  accountsBefore: Record<string, unknown> | null;
  changes: string[];
}): OpenClawConfig {
  const channels = params.cfg.channels as Record<string, unknown> | undefined;
  const entry = asObjectRecord(channels?.[params.channelId]);
  const accounts = asObjectRecord(entry?.accounts);
  if (!entry || !accounts) {
    return params.cfg;
  }
  const rootStreaming = asObjectRecord(entry.streaming);
  const defaultKey = Object.hasOwn(accounts, "default")
    ? "default"
    : Object.keys(accounts).find((key) => key.trim().toLowerCase() === "default");
  let changed = false;
  const nextAccounts = { ...accounts };
  const accountIds = Object.keys(accounts).toSorted((left, right) =>
    left === defaultKey ? -1 : right === defaultKey ? 1 : left.localeCompare(right),
  );
  for (const accountId of accountIds) {
    if (asObjectRecord(params.accountsBefore?.[accountId])?.streaming !== undefined) {
      continue;
    }
    const account = asObjectRecord(nextAccounts[accountId]);
    const created = asObjectRecord(account?.streaming);
    if (!account || !created) {
      continue;
    }
    const defaultStreaming = defaultKey
      ? asObjectRecord(asObjectRecord(nextAccounts[defaultKey])?.streaming)
      : null;
    const inherited =
      accountId === defaultKey ? rootStreaming : (defaultStreaming ?? rootStreaming);
    if (!inherited) {
      continue;
    }
    const materialized = asObjectRecord(mergeDeep(inherited, created));
    if (!materialized || isDeepStrictEqual(materialized, created)) {
      continue;
    }
    nextAccounts[accountId] = { ...account, streaming: materialized };
    changed = true;
    const sourcePath =
      accountId !== defaultKey && defaultKey && defaultStreaming
        ? `channels.${params.channelId}.accounts.${defaultKey}.streaming`
        : `channels.${params.channelId}.streaming`;
    params.changes.push(
      `Copied ${sourcePath} into channels.${params.channelId}.accounts.${accountId}.streaming to keep inherited settings while migrating flat streaming keys.`,
    );
  }
  return changed
    ? ({
        ...params.cfg,
        channels: {
          ...channels,
          [params.channelId]: { ...entry, accounts: nextAccounts },
        },
      } as OpenClawConfig)
    : params.cfg;
}
