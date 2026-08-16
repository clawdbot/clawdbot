// Allowlist config edit helpers build safe config mutations for channel allowlists.
import type { ConfigWriteTarget } from "../channels/plugins/config-writes.js";
import type { ChannelAllowlistAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { isRecord } from "../utils.js";

type AllowlistConfigPaths = {
  readPaths: string[][];
  writePath: string[];
  cleanupPaths?: string[][];
};

/** Named allowlist entries attached to a route-specific override. */
export type AllowlistGroupOverride = { label: string; entries: string[] };

/** Per-entry display-name lookup results for channel allowlist UIs. */
export type AllowlistNameResolution = Array<{
  input: string;
  resolved: boolean;
  name?: string | null;
}>;
type AllowlistNormalizer = (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  values: Array<string | number>;
}) => string[];
type AllowlistAccountResolver<ResolvedAccount> = (params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}) => ResolvedAccount;

const DM_ALLOWLIST_CONFIG_PATHS: AllowlistConfigPaths = {
  readPaths: [["allowFrom"]],
  writePath: ["allowFrom"],
};

const GROUP_ALLOWLIST_CONFIG_PATHS: AllowlistConfigPaths = {
  readPaths: [["groupAllowFrom"]],
  writePath: ["groupAllowFrom"],
};

const LEGACY_DM_ALLOWLIST_CONFIG_PATHS: AllowlistConfigPaths = {
  readPaths: [["allowFrom"], ["dm", "allowFrom"]],
  writePath: ["allowFrom"],
  cleanupPaths: [["dm", "allowFrom"]],
};

/** Resolve modern DM/group allowlist paths for account-scoped channel config writes. */
export function resolveDmGroupAllowlistConfigPaths(scope: "dm" | "group") {
  return scope === "dm" ? DM_ALLOWLIST_CONFIG_PATHS : GROUP_ALLOWLIST_CONFIG_PATHS;
}

/** Resolve DM-only paths that still read and clean up the old nested dm.allowFrom location. */
export function resolveLegacyDmAllowlistConfigPaths(scope: "dm" | "group") {
  return scope === "dm" ? LEGACY_DM_ALLOWLIST_CONFIG_PATHS : null;
}

/** Coerce stored allowlist entries into presentable non-empty strings. */
export function readConfiguredAllowlistEntries(
  entries: Array<string | number> | null | undefined,
): string[] {
  return (entries ?? []).map(String).filter(Boolean);
}

/** Collect labeled allowlist overrides from a flat keyed record. */
export function collectAllowlistOverridesFromRecord<T>(params: {
  record: Record<string, T | undefined> | null | undefined;
  label: (key: string, value: T) => string;
  resolveEntries: (value: T) => Array<string | number> | null | undefined;
}): AllowlistGroupOverride[] {
  const overrides: AllowlistGroupOverride[] = [];
  for (const [key, value] of Object.entries(params.record ?? {})) {
    if (!value) {
      continue;
    }
    const entries = readConfiguredAllowlistEntries(params.resolveEntries(value));
    if (entries.length === 0) {
      continue;
    }
    overrides.push({ label: params.label(key, value), entries });
  }
  return overrides;
}

/** Collect labeled allowlist overrides from an outer record with nested child records. */
export function collectNestedAllowlistOverridesFromRecord<Outer, Inner>(params: {
  record: Record<string, Outer | undefined> | null | undefined;
  outerLabel: (key: string, value: Outer) => string;
  resolveOuterEntries: (value: Outer) => Array<string | number> | null | undefined;
  resolveChildren: (value: Outer) => Record<string, Inner | undefined> | null | undefined;
  innerLabel: (outerKey: string, innerKey: string, inner: Inner) => string;
  resolveInnerEntries: (value: Inner) => Array<string | number> | null | undefined;
}): AllowlistGroupOverride[] {
  const overrides: AllowlistGroupOverride[] = [];
  for (const [outerKey, outerValue] of Object.entries(params.record ?? {})) {
    if (!outerValue) {
      continue;
    }
    const outerEntries = readConfiguredAllowlistEntries(params.resolveOuterEntries(outerValue));
    if (outerEntries.length > 0) {
      overrides.push({ label: params.outerLabel(outerKey, outerValue), entries: outerEntries });
    }
    overrides.push(
      ...collectAllowlistOverridesFromRecord({
        record: params.resolveChildren(outerValue),
        label: (innerKey, innerValue) => params.innerLabel(outerKey, innerKey, innerValue),
        resolveEntries: params.resolveInnerEntries,
      }),
    );
  }
  return overrides;
}

/** Build an account-scoped flat override resolver from a keyed allowlist record. */
export function createFlatAllowlistOverrideResolver<ResolvedAccount, Entry>(params: {
  resolveRecord: (account: ResolvedAccount) => Record<string, Entry | undefined> | null | undefined;
  label: (key: string, value: Entry) => string;
  resolveEntries: (value: Entry) => Array<string | number> | null | undefined;
}): (account: ResolvedAccount) => AllowlistGroupOverride[] {
  return (account) =>
    collectAllowlistOverridesFromRecord({
      record: params.resolveRecord(account),
      label: params.label,
      resolveEntries: params.resolveEntries,
    });
}

/** Build an account-scoped nested override resolver from hierarchical allowlist records. */
export function createNestedAllowlistOverrideResolver<ResolvedAccount, Outer, Inner>(params: {
  resolveRecord: (account: ResolvedAccount) => Record<string, Outer | undefined> | null | undefined;
  outerLabel: (key: string, value: Outer) => string;
  resolveOuterEntries: (value: Outer) => Array<string | number> | null | undefined;
  resolveChildren: (value: Outer) => Record<string, Inner | undefined> | null | undefined;
  innerLabel: (outerKey: string, innerKey: string, inner: Inner) => string;
  resolveInnerEntries: (value: Inner) => Array<string | number> | null | undefined;
}): (account: ResolvedAccount) => AllowlistGroupOverride[] {
  return (account) =>
    collectNestedAllowlistOverridesFromRecord({
      record: params.resolveRecord(account),
      outerLabel: params.outerLabel,
      resolveOuterEntries: params.resolveOuterEntries,
      resolveChildren: params.resolveChildren,
      innerLabel: params.innerLabel,
      resolveInnerEntries: params.resolveInnerEntries,
    });
}

/** Build the common account-scoped token-gated allowlist name resolver. */
export function createAccountScopedAllowlistNameResolver<ResolvedAccount>(params: {
  resolveAccount: (params: { cfg: OpenClawConfig; accountId?: string | null }) => ResolvedAccount;
  resolveToken: (account: ResolvedAccount) => string | null | undefined;
  resolveNames: (params: { token: string; entries: string[] }) => Promise<AllowlistNameResolution>;
}): NonNullable<ChannelAllowlistAdapter["resolveNames"]> {
  return async ({ cfg, accountId, entries }) => {
    const account = params.resolveAccount({ cfg, accountId });
    const token = params.resolveToken(account)?.trim();
    if (!token) {
      return [];
    }
    return await params.resolveNames({ token, entries });
  };
}

function resolveAccountScopedWriteTarget(
  parsed: Record<string, unknown>,
  channelId: ChannelId,
  accountId?: string | null,
) {
  const channels = (parsed.channels ??= {}) as Record<string, unknown>;
  const channel = (channels[channelId] ??= {}) as Record<string, unknown>;
  const normalizedAccountId = normalizeAccountId(accountId);
  if (isBlockedObjectKey(normalizedAccountId)) {
    return {
      target: channel,
      pathPrefix: `channels.${channelId}`,
      writeTarget: { kind: "channel", scope: { channelId } } as const satisfies ConfigWriteTarget,
    };
  }
  const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;
  if (!useAccount) {
    return {
      target: channel,
      pathPrefix: `channels.${channelId}`,
      writeTarget: { kind: "channel", scope: { channelId } } as const satisfies ConfigWriteTarget,
    };
  }
  // Once an accounts map exists, even the default account writes through it so scoped
  // and unscoped config do not diverge inside the same channel stanza.
  const accounts = (channel.accounts ??= {}) as Record<string, unknown>;
  const existingAccount = Object.hasOwn(accounts, normalizedAccountId)
    ? accounts[normalizedAccountId]
    : undefined;
  if (!existingAccount || typeof existingAccount !== "object") {
    accounts[normalizedAccountId] = {};
  }
  const account = accounts[normalizedAccountId] as Record<string, unknown>;
  return {
    target: account,
    pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
    writeTarget: {
      kind: "account",
      scope: { channelId, accountId: normalizedAccountId },
    } as const satisfies ConfigWriteTarget,
  };
}

function getNestedValue(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureNestedObject(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let current = root;
  for (const key of path) {
    const existing = current[key];
    if (!existing || typeof existing !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function setNestedValue(root: Record<string, unknown>, path: string[], value: unknown) {
  const leaf = path.at(-1);
  if (leaf === undefined) {
    return;
  }
  if (path.length === 1) {
    root[leaf] = value;
    return;
  }
  const parent = ensureNestedObject(root, path.slice(0, -1));
  parent[leaf] = value;
}

function deleteNestedValue(root: Record<string, unknown>, path: string[]) {
  const leaf = path.at(-1);
  if (leaf === undefined) {
    return;
  }
  if (path.length === 1) {
    delete root[leaf];
    return;
  }
  const parent = getNestedValue(root, path.slice(0, -1));
  if (!isRecord(parent)) {
    return;
  }
  delete parent[leaf];
}

function applyAccountScopedAllowlistConfigEdit(params: {
  parsedConfig: Record<string, unknown>;
  channelId: ChannelId;
  accountId?: string | null;
  action: "add" | "remove";
  entry: string;
  normalize: (values: Array<string | number>) => string[];
  resolveEffectiveEntries?: () => Array<string | number> | null | undefined;
  paths: AllowlistConfigPaths;
}): NonNullable<Awaited<ReturnType<NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]>>>> {
  const resolvedTarget = resolveAccountScopedWriteTarget(
    params.parsedConfig,
    params.channelId,
    params.accountId,
  );
  const existing: string[] = [];
  let hasStoredList = false;
  for (const path of params.paths.readPaths) {
    const existingRaw = getNestedValue(resolvedTarget.target, path);
    if (!Array.isArray(existingRaw)) {
      continue;
    }
    hasStoredList = true;
    for (const entry of existingRaw) {
      const value = String(entry).trim();
      if (!value || existing.includes(value)) {
        continue;
      }
      existing.push(value);
    }
  }
  // A new account override starts from its effective inherited list; otherwise the
  // first scoped edit would silently discard every channel-level entry.
  if (!hasStoredList) {
    for (const entry of params.resolveEffectiveEntries?.() ?? []) {
      const value = String(entry).trim();
      if (!value || existing.includes(value)) {
        continue;
      }
      existing.push(value);
    }
  }

  const normalizedEntry = params.normalize([params.entry]);
  if (normalizedEntry.length === 0) {
    return { kind: "invalid-entry" };
  }

  const existingNormalized = params.normalize(existing);
  const shouldMatch = (value: string) => normalizedEntry.includes(value);

  let changed = false;
  let next = existing;
  const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
  if (params.action === "add") {
    if (!configHasEntry) {
      next = [...existing, params.entry.trim()];
      changed = true;
    }
  } else {
    const keep: string[] = [];
    for (const entry of existing) {
      const normalized = params.normalize([entry]);
      if (normalized.some((value) => shouldMatch(value))) {
        changed = true;
        continue;
      }
      keep.push(entry);
    }
    next = keep;
  }

  if (changed) {
    // Keep empty lists explicit: deleting the key can reactivate effective entries inherited
    // from another config surface, including after an earlier edit materialized that list.
    setNestedValue(resolvedTarget.target, params.paths.writePath, next);
    // Legacy readers can observe multiple paths, but writes must leave one canonical path.
    for (const path of params.paths.cleanupPaths ?? []) {
      deleteNestedValue(resolvedTarget.target, path);
    }
  }

  return {
    kind: "ok",
    changed,
    pathLabel: `${resolvedTarget.pathPrefix}.${params.paths.writePath.join(".")}`,
    writeTarget: resolvedTarget.writeTarget,
  };
}

/** Build the default account-scoped allowlist editor used by channel plugins with config-backed lists. */
export function buildAccountScopedAllowlistConfigEditor(params: {
  channelId: ChannelId;
  normalize: AllowlistNormalizer;
  resolveEffectiveEntries?: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    scope: "dm" | "group";
  }) => Array<string | number> | null | undefined;
  resolvePaths: (scope: "dm" | "group") => AllowlistConfigPaths | null;
}): NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]> {
  return ({ cfg, parsedConfig, accountId, scope, action, entry }) => {
    const paths = params.resolvePaths(scope);
    if (!paths) {
      return null;
    }
    return applyAccountScopedAllowlistConfigEdit({
      parsedConfig,
      channelId: params.channelId,
      accountId,
      action,
      entry,
      normalize: (values) => params.normalize({ cfg, accountId, values }),
      resolveEffectiveEntries: () => params.resolveEffectiveEntries?.({ cfg, accountId, scope }),
      paths,
    });
  };
}

function buildAccountAllowlistAdapter<ResolvedAccount>(params: {
  channelId: ChannelId;
  resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
  normalize: AllowlistNormalizer;
  supportsScope: NonNullable<ChannelAllowlistAdapter["supportsScope"]>;
  resolvePaths: (scope: "dm" | "group") => AllowlistConfigPaths | null;
  readConfig: (
    account: ResolvedAccount,
    context: { cfg: OpenClawConfig; accountId?: string | null },
  ) => Awaited<ReturnType<NonNullable<ChannelAllowlistAdapter["readConfig"]>>>;
  resolveEntries: (
    account: ResolvedAccount,
    scope: "dm" | "group",
    context: { cfg: OpenClawConfig; accountId?: string | null },
  ) => Array<string | number> | null | undefined;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit"> {
  return {
    supportsScope: params.supportsScope,
    readConfig: ({ cfg, accountId }) =>
      params.readConfig(params.resolveAccount({ cfg, accountId }), { cfg, accountId }),
    applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
      channelId: params.channelId,
      normalize: params.normalize,
      resolveEffectiveEntries: ({ cfg, accountId, scope }) =>
        params.resolveEntries(params.resolveAccount({ cfg, accountId }), scope, {
          cfg,
          accountId,
        }),
      resolvePaths: params.resolvePaths,
    }),
  };
}

/** Build the common DM/group allowlist adapter used by channels that store both lists in config. */
export function buildDmGroupAccountAllowlistAdapter<ResolvedAccount>(params: {
  channelId: ChannelId;
  resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
  normalize: AllowlistNormalizer;
  resolveDmAllowFrom: (
    account: ResolvedAccount,
    context: { cfg: OpenClawConfig; accountId?: string | null },
  ) => Array<string | number> | null | undefined;
  resolveGroupAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  resolveDmPolicy?: (account: ResolvedAccount) => string | null | undefined;
  resolveGroupPolicy?: (account: ResolvedAccount) => string | null | undefined;
  resolveGroupOverrides?: (account: ResolvedAccount) => AllowlistGroupOverride[] | undefined;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit"> {
  return buildAccountAllowlistAdapter({
    channelId: params.channelId,
    resolveAccount: params.resolveAccount,
    normalize: params.normalize,
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
    resolvePaths: resolveDmGroupAllowlistConfigPaths,
    resolveEntries: (account, scope, context) =>
      scope === "dm"
        ? params.resolveDmAllowFrom(account, context)
        : params.resolveGroupAllowFrom(account),
    readConfig: (account, context) => ({
      dmAllowFrom: readConfiguredAllowlistEntries(params.resolveDmAllowFrom(account, context)),
      groupAllowFrom: readConfiguredAllowlistEntries(params.resolveGroupAllowFrom(account)),
      dmPolicy: params.resolveDmPolicy?.(account) ?? undefined,
      groupPolicy: params.resolveGroupPolicy?.(account) ?? undefined,
      groupOverrides: params.resolveGroupOverrides?.(account),
    }),
  });
}

/** Build the common DM-only allowlist adapter for channels with legacy dm.allowFrom fallback paths. */
export function buildLegacyDmAccountAllowlistAdapter<ResolvedAccount>(params: {
  channelId: ChannelId;
  resolveAccount: AllowlistAccountResolver<ResolvedAccount>;
  normalize: AllowlistNormalizer;
  resolveDmAllowFrom: (
    account: ResolvedAccount,
    context: { cfg: OpenClawConfig; accountId?: string | null },
  ) => Array<string | number> | null | undefined;
  resolveGroupPolicy?: (account: ResolvedAccount) => string | null | undefined;
  resolveGroupOverrides?: (account: ResolvedAccount) => AllowlistGroupOverride[] | undefined;
}): Pick<ChannelAllowlistAdapter, "supportsScope" | "readConfig" | "applyConfigEdit"> {
  return buildAccountAllowlistAdapter({
    channelId: params.channelId,
    resolveAccount: params.resolveAccount,
    normalize: params.normalize,
    supportsScope: ({ scope }) => scope === "dm",
    resolvePaths: resolveLegacyDmAllowlistConfigPaths,
    resolveEntries: (account, _scope, context) => params.resolveDmAllowFrom(account, context),
    readConfig: (account, context) => ({
      dmAllowFrom: readConfiguredAllowlistEntries(params.resolveDmAllowFrom(account, context)),
      groupPolicy: params.resolveGroupPolicy?.(account) ?? undefined,
      groupOverrides: params.resolveGroupOverrides?.(account),
    }),
  });
}
