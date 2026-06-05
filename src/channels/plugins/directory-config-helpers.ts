/**
 * Directory config helper utilities.
 *
 * Builds user/group directory entries from plugin config with query and limit filtering.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.js";
import type { DirectoryConfigParams } from "./directory-types.js";
import type { ChannelDirectoryEntry } from "./types.public.js";

function resolveDirectoryQuery(query?: string | null): string {
  return normalizeLowercaseStringOrEmpty(query);
}

function resolveDirectoryLimit(limit?: number | null): number | undefined {
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

/**
 * Applies case-insensitive query filtering and a positive result limit to ids.
 */
export function applyDirectoryQueryAndLimit(
  ids: string[],
  params: { query?: string | null; limit?: number | null },
): string[] {
  const q = resolveDirectoryQuery(params.query);
  const limit = resolveDirectoryLimit(params.limit);
  const filtered: string[] = [];
  for (const id of ids) {
    if (q && !normalizeLowercaseStringOrEmpty(id).includes(q)) {
      continue;
    }
    filtered.push(id);
    if (typeof limit === "number" && filtered.length >= limit) {
      break;
    }
  }
  return filtered;
}

/**
 * Converts normalized ids into channel directory entries of one kind.
 */
export function toDirectoryEntries(kind: "user" | "group", ids: string[]): ChannelDirectoryEntry[] {
  const entries: ChannelDirectoryEntry[] = [];
  for (const id of ids) {
    entries.push({ kind, id });
  }
  return entries;
}

function collectDirectoryIdsFromEntries(params: {
  entries?: readonly unknown[];
  normalizeId?: (entry: string) => string | null | undefined;
}): string[] {
  return collectDirectoryIds(params.entries ?? [], params.normalizeId);
}

function collectDirectoryIdsFromMapKeys(params: {
  groups?: Record<string, unknown>;
  normalizeId?: (entry: string) => string | null | undefined;
}): string[] {
  return collectDirectoryIds(Object.keys(params.groups ?? {}), params.normalizeId);
}

function collectDirectoryIds(
  values: Iterable<unknown>,
  normalizeId?: (entry: string) => string | null | undefined,
): string[] {
  const ids: string[] = [];
  for (const value of values) {
    const entry = normalizeOptionalString(String(value)) ?? "";
    if (!entry || entry === "*") {
      continue;
    }
    const normalized = normalizeId ? normalizeId(entry) : entry;
    const id = normalizeOptionalString(normalized) ?? "";
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function dedupeDirectoryIds(ids: string[]): string[] {
  return uniqueStrings(ids);
}

/**
 * Collects unique normalized ids from multiple raw config sources.
 */
export function collectNormalizedDirectoryIds(params: {
  sources: Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}): string[] {
  const ids = new Set<string>();
  for (const source of params.sources) {
    for (const value of source) {
      const raw = normalizeOptionalString(value) ?? "";
      if (!raw || raw === "*") {
        continue;
      }
      const normalized = params.normalizeId(raw);
      const trimmed = normalizeOptionalString(normalized) ?? "";
      if (trimmed) {
        ids.add(trimmed);
      }
    }
  }
  return Array.from(ids);
}

/**
 * Lists directory entries from arbitrary config sources.
 *
 * Callers supply source iterables and an id normalizer so channel-specific
 * config shapes share the same wildcard filtering, dedupe, query, and limit
 * behavior.
 */
export function listDirectoryEntriesFromSources(params: {
  kind: "user" | "group";
  sources: Iterable<unknown>[];
  query?: string | null;
  limit?: number | null;
  normalizeId: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = collectNormalizedDirectoryIds({
    sources: params.sources,
    normalizeId: params.normalizeId,
  });
  return toDirectoryEntries(params.kind, applyDirectoryQueryAndLimit(ids, params));
}

/**
 * Lists directory entries for channels that inspect optional configured accounts.
 */
export function listInspectedDirectoryEntriesFromSources<InspectedAccount>(
  params: DirectoryConfigParams & {
    kind: "user" | "group";
    inspectAccount: (
      cfg: OpenClawConfig,
      accountId?: string | null,
    ) => InspectedAccount | null | undefined;
    resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.inspectAccount(params.cfg, params.accountId);
  // Missing optional accounts produce an empty directory instead of forcing
  // setup callers to special-case unconfigured channel state.
  if (!account) {
    return [];
  }
  return listDirectoryEntriesFromSources({
    kind: params.kind,
    sources: params.resolveSources(account),
    query: params.query,
    limit: params.limit,
    normalizeId: params.normalizeId,
  });
}

/**
 * Builds an async lister around an inspected-account directory source.
 */
export function createInspectedDirectoryEntriesLister<InspectedAccount>(params: {
  kind: "user" | "group";
  inspectAccount: (
    cfg: OpenClawConfig,
    accountId?: string | null,
  ) => InspectedAccount | null | undefined;
  resolveSources: (account: InspectedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}) {
  return async (configParams: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]> =>
    listInspectedDirectoryEntriesFromSources({
      ...configParams,
      ...params,
    });
}

/**
 * Lists directory entries for channels whose account resolver always returns a config object.
 */
export function listResolvedDirectoryEntriesFromSources<ResolvedAccount>(
  params: DirectoryConfigParams & {
    kind: "user" | "group";
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
    normalizeId: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.resolveAccount(params.cfg, params.accountId);
  return listDirectoryEntriesFromSources({
    kind: params.kind,
    sources: params.resolveSources(account),
    query: params.query,
    limit: params.limit,
    normalizeId: params.normalizeId,
  });
}

/**
 * Builds an async lister around a required resolved-account directory source.
 */
export function createResolvedDirectoryEntriesLister<ResolvedAccount>(params: {
  kind: "user" | "group";
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
  resolveSources: (account: ResolvedAccount) => Iterable<unknown>[];
  normalizeId: (entry: string) => string | null | undefined;
}) {
  return async (configParams: DirectoryConfigParams): Promise<ChannelDirectoryEntry[]> =>
    listResolvedDirectoryEntriesFromSources({
      ...configParams,
      ...params,
    });
}

/**
 * Lists user directory entries from an allowlist-style config array.
 */
export function listDirectoryUserEntriesFromAllowFrom(params: {
  allowFrom?: readonly unknown[];
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds(
    collectDirectoryIdsFromEntries({
      entries: params.allowFrom,
      normalizeId: params.normalizeId,
    }),
  );
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

/**
 * Lists user entries from both direct allowlists and map-key config.
 */
export function listDirectoryUserEntriesFromAllowFromAndMapKeys(params: {
  allowFrom?: readonly unknown[];
  map?: Record<string, unknown>;
  query?: string | null;
  limit?: number | null;
  normalizeAllowFromId?: (entry: string) => string | null | undefined;
  normalizeMapKeyId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds([
    ...collectDirectoryIdsFromEntries({
      entries: params.allowFrom,
      normalizeId: params.normalizeAllowFromId,
    }),
    ...collectDirectoryIdsFromMapKeys({
      groups: params.map,
      normalizeId: params.normalizeMapKeyId,
    }),
  ]);
  return toDirectoryEntries("user", applyDirectoryQueryAndLimit(ids, params));
}

/**
 * Lists group directory entries from map-key config.
 */
export function listDirectoryGroupEntriesFromMapKeys(params: {
  groups?: Record<string, unknown>;
  query?: string | null;
  limit?: number | null;
  normalizeId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds(
    collectDirectoryIdsFromMapKeys({
      groups: params.groups,
      normalizeId: params.normalizeId,
    }),
  );
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

/**
 * Lists group entries from both map-key config and allowlist values.
 */
export function listDirectoryGroupEntriesFromMapKeysAndAllowFrom(params: {
  groups?: Record<string, unknown>;
  allowFrom?: readonly unknown[];
  query?: string | null;
  limit?: number | null;
  normalizeMapKeyId?: (entry: string) => string | null | undefined;
  normalizeAllowFromId?: (entry: string) => string | null | undefined;
}): ChannelDirectoryEntry[] {
  const ids = dedupeDirectoryIds([
    ...collectDirectoryIdsFromMapKeys({
      groups: params.groups,
      normalizeId: params.normalizeMapKeyId,
    }),
    ...collectDirectoryIdsFromEntries({
      entries: params.allowFrom,
      normalizeId: params.normalizeAllowFromId,
    }),
  ]);
  return toDirectoryEntries("group", applyDirectoryQueryAndLimit(ids, params));
}

/**
 * Lists resolved-account user entries from an allowlist selector.
 */
export function listResolvedDirectoryUserEntriesFromAllowFrom<ResolvedAccount>(
  params: DirectoryConfigParams & {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveAllowFrom: (account: ResolvedAccount) => readonly unknown[] | undefined;
    normalizeId?: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.resolveAccount(params.cfg, params.accountId);
  return listDirectoryUserEntriesFromAllowFrom({
    allowFrom: params.resolveAllowFrom(account),
    query: params.query,
    limit: params.limit,
    normalizeId: params.normalizeId,
  });
}

/**
 * Lists resolved-account group entries from a group-map selector.
 */
export function listResolvedDirectoryGroupEntriesFromMapKeys<ResolvedAccount>(
  params: DirectoryConfigParams & {
    resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => ResolvedAccount;
    resolveGroups: (account: ResolvedAccount) => Record<string, unknown> | undefined;
    normalizeId?: (entry: string) => string | null | undefined;
  },
): ChannelDirectoryEntry[] {
  const account = params.resolveAccount(params.cfg, params.accountId);
  return listDirectoryGroupEntriesFromMapKeys({
    groups: params.resolveGroups(account),
    query: params.query,
    limit: params.limit,
    normalizeId: params.normalizeId,
  });
}
