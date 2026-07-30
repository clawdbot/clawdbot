/**
 * Runtime SDK subpath for plugin doctor migrations, compat checks, and uninstall helpers.
 */
import { asObjectRecord } from "../config/channel-compat-normalization.js";
import type { CompatMutationResult } from "../config/channel-compat-normalization.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export { collectProviderDangerousNameMatchingScopes } from "../config/dangerous-name-matching.js";
export { defineChannelAliasMigration } from "../config/channel-alias-migration.js";
export type {
  ChannelAliasMigrationSpec,
  StreamingAliasMode,
} from "../config/channel-alias-migration.js";
export {
  asObjectRecord,
  hasLegacyAccountStreamingAliases,
  hasLegacyStreamingAliases,
  normalizeLegacyChannelAliases,
  normalizeLegacyDmAliases,
  normalizeLegacyStreamingAliases,
  resolveLegacyAliasStreamingMode,
} from "../config/channel-compat-normalization.js";
export {
  materializeInheritedAccountStreaming,
  normalizeChannelAccounts,
  normalizeChannelConfigEntries,
  stripRetiredChannelKeys,
} from "../config/channel-doctor-helpers.js";
export type {
  CompatMutationResult,
  LegacyStreamingAliasOptions,
  NormalizeChannelConfigEntryParams,
  NormalizeLegacyChannelAccountParams,
  RetiredChannelKeyRemoval,
} from "../config/channel-compat-normalization.js";
export {
  detectPluginInstallPathIssue,
  formatPluginInstallPathIssue,
} from "../infra/plugin-install-path-warnings.js";
export type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "../plugin-state/plugin-state-store.js";
export { createPluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.js";
export {
  detectOpenClawStateDatabaseSchemaMigrations,
  repairOpenClawStateDatabaseSchema,
} from "../state/openclaw-state-db.js";
export type { OpenClawStateDatabaseSchemaMigration } from "../state/openclaw-state-db.js";
export { removePluginFromConfig } from "../plugins/uninstall.js";
export type {
  PluginDoctorStateMigration,
  PluginDoctorStateMigrationContext,
} from "../plugins/doctor-contract-registry.js";
export {
  archiveLegacyStateSource,
  legacyStateFileExists,
} from "../plugins/doctor-state-migration-fs.js";
export type { DoctorSessionRouteStateOwner } from "../plugins/doctor-session-route-state-owner-types.js";

type KeyMoveValue = { value: unknown };
type KeyMoveChangeContext = {
  sourcePath: string;
  targetPath: string;
  sourceValue: unknown;
  targetValue: unknown;
  mappedValue: unknown;
};

/** Collects a channel's root config and object-shaped account overrides in config order. */
export function collectChannelAccountScopes(params: {
  cfg: OpenClawConfig;
  channelId: string;
}): Array<{
  prefix: string;
  pathSegments: string[];
  account: Record<string, unknown>;
}> {
  const scopes: Array<{
    prefix: string;
    pathSegments: string[];
    account: Record<string, unknown>;
  }> = [];
  const pathSegments = ["channels", params.channelId];
  const channels = asObjectRecord(params.cfg.channels);
  const channel = asObjectRecord(channels?.[params.channelId]);
  if (!channel) {
    return scopes;
  }
  scopes.push({ prefix: pathSegments.join("."), pathSegments, account: channel });
  const accounts = asObjectRecord(channel.accounts);
  if (!accounts) {
    return scopes;
  }
  for (const [accountId, value] of Object.entries(accounts)) {
    const account = asObjectRecord(value);
    if (account) {
      const accountPathSegments = [...pathSegments, "accounts", accountId];
      scopes.push({
        prefix: accountPathSegments.join("."),
        pathSegments: accountPathSegments,
        account,
      });
    }
  }
  return scopes;
}

function readKeyMovePath(entry: Record<string, unknown>, path: readonly string[], own = true) {
  let current = entry;
  for (const segment of path.slice(0, -1)) {
    const next = asObjectRecord(current[segment]);
    if (!next) {
      return null;
    }
    current = next;
  }
  const key = path.at(-1);
  return key && (own ? Object.hasOwn(current, key) : key in current)
    ? { value: current[key] }
    : null;
}

function setKeyMovePath(
  entry: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [key, ...rest] = path;
  if (!key) {
    return entry;
  }
  if (rest.length === 0) {
    return { ...entry, [key]: value };
  }
  return {
    ...entry,
    [key]: setKeyMovePath(asObjectRecord(entry[key]) ?? {}, rest, value),
  };
}

function deleteKeyMovePath(
  entry: Record<string, unknown>,
  path: readonly string[],
  pruneEmpty: boolean,
): Record<string, unknown> {
  const [key, ...rest] = path;
  if (!key) {
    return entry;
  }
  const next = { ...entry };
  if (rest.length === 0) {
    delete next[key];
    return next;
  }
  const child = asObjectRecord(entry[key]);
  if (!child) {
    return entry;
  }
  const updatedChild = deleteKeyMovePath(child, rest, pruneEmpty);
  if (pruneEmpty && Object.keys(updatedChild).length === 0) {
    delete next[key];
  } else {
    next[key] = updatedChild;
  }
  return next;
}

/** Defines an immutable legacy-key move across fixed or `*`-mapped object paths. */
export function defineKeyMoveMigration(params: {
  scope?: readonly string[];
  from: readonly string[];
  to: readonly string[];
  match?: (value: unknown) => boolean;
  sourceOwn?: boolean;
  map?: (value: unknown) => KeyMoveValue | null;
  targetIsSet?: (value: unknown) => boolean;
  pruneEmptySource?: boolean;
  movedMessage?: (context: KeyMoveChangeContext) => string;
  existingMessage?: (context: KeyMoveChangeContext) => string;
  invalidMessage?: (context: KeyMoveChangeContext) => string;
}): {
  hasLegacy: (value: unknown) => boolean;
  normalize: (params: {
    entry: Record<string, unknown>;
    pathPrefix: string;
    changes: string[];
  }) => CompatMutationResult;
} {
  const visitScopes = (
    entry: Record<string, unknown>,
    scope: readonly string[],
    visit: (scopeEntry: Record<string, unknown>, scopePath: readonly string[]) => boolean,
    scopePath: readonly string[] = [],
  ): boolean => {
    const [segment, ...rest] = scope;
    if (!segment) {
      return visit(entry, scopePath);
    }
    if (segment === "*") {
      return Object.entries(entry).some(([key, value]) => {
        const child = asObjectRecord(value);
        return child ? visitScopes(child, rest, visit, [...scopePath, key]) : false;
      });
    }
    const child = asObjectRecord(entry[segment]);
    return child ? visitScopes(child, rest, visit, [...scopePath, segment]) : false;
  };

  const hasLegacy = (value: unknown): boolean => {
    const entry = asObjectRecord(value);
    return entry
      ? visitScopes(entry, params.scope ?? [], (scopeEntry) => {
          const source = readKeyMovePath(scopeEntry, params.from, params.sourceOwn);
          return Boolean(source && (params.match?.(source.value) ?? true));
        })
      : false;
  };

  const normalizeScope = (
    scopeEntry: Record<string, unknown>,
    scopePath: readonly string[],
    pathPrefix: string,
    changes: string[],
  ): CompatMutationResult => {
    const source = readKeyMovePath(scopeEntry, params.from, params.sourceOwn);
    if (!source || !(params.match?.(source.value) ?? true)) {
      return { entry: scopeEntry, changed: false };
    }
    const target = readKeyMovePath(scopeEntry, params.to);
    const mapped = params.map ? params.map(source.value) : { value: source.value };
    const context: KeyMoveChangeContext = {
      sourcePath: [pathPrefix, ...scopePath, ...params.from].join("."),
      targetPath: [pathPrefix, ...scopePath, ...params.to].join("."),
      sourceValue: source.value,
      targetValue: target?.value,
      mappedValue: mapped?.value,
    };
    const targetSet = params.targetIsSet?.(target?.value) ?? target?.value !== undefined;
    let updated = scopeEntry;
    if (targetSet) {
      changes.push(
        params.existingMessage?.(context) ??
          `Removed ${context.sourcePath} (${context.targetPath} already set).`,
      );
    } else if (mapped) {
      updated = setKeyMovePath(updated, params.to, mapped.value);
      changes.push(
        params.movedMessage?.(context) ?? `Moved ${context.sourcePath} → ${context.targetPath}.`,
      );
    } else {
      changes.push(
        params.invalidMessage?.(context) ?? `Removed invalid ${context.sourcePath} value.`,
      );
    }
    return {
      entry: deleteKeyMovePath(updated, params.from, params.pruneEmptySource ?? false),
      changed: true,
    };
  };

  const normalizeScopes = (
    entry: Record<string, unknown>,
    scope: readonly string[],
    pathPrefix: string,
    changes: string[],
    scopePath: readonly string[] = [],
  ): CompatMutationResult => {
    const [segment, ...rest] = scope;
    if (!segment) {
      return normalizeScope(entry, scopePath, pathPrefix, changes);
    }
    let changed = false;
    const updated = { ...entry };
    const keys = segment === "*" ? Object.keys(entry) : [segment];
    for (const key of keys) {
      const child = asObjectRecord(entry[key]);
      if (!child) {
        continue;
      }
      const normalized = normalizeScopes(child, rest, pathPrefix, changes, [...scopePath, key]);
      if (normalized.changed) {
        updated[key] = normalized.entry;
        changed = true;
      }
    }
    return changed ? { entry: updated, changed: true } : { entry, changed: false };
  };

  return {
    hasLegacy,
    normalize: ({ entry, pathPrefix, changes }) =>
      normalizeScopes(entry, params.scope ?? [], pathPrefix, changes),
  };
}
