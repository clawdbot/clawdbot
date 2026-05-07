import type { OpenClawConfig } from "../../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import type { DirectoryConfigParams } from "./directory-types.js";
import type { ChannelDirectoryEntry } from "./types.public.js";

function resolveDirectoryQuery(query?: string | null): string {
  return normalizeLowercaseStringOrEmpty(query);
}

function resolveDirectoryLimit(limit?: number | null): number | undefined {
  return typeof limit === "number" && limit > 0 ? limit : undefined;
}

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
  const ids: string[] = [];
  for (const value of params.entries ?? []) {
    const entry = normalizeOptionalString(String(value)) ?? "";
    if (!entry || entry === "*") {
      continue;
    }
    const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
    const id = normalizeOptionalString(normalized) ?? "";
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function collectDirectoryIdsFromMapKeys(params: {
  groups?: Record<string, unknown>;
  normalizeId?: (entry: string) => string | null | undefined;
}): string[] {
  const ids: string[] = [];
  for (const key of Object.keys(params.groups ?? {})) {
    const entry = normalizeOptionalString(key) ?? "";
    if (!entry || entry === "*") {
      continue;
    }
    const normalized = params.normalizeId ? params.normalizeId(entry) : entry;
    const id = normalizeOptionalString(normalized) ?? "";
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function dedupeDirectoryIds(ids: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    deduped.push(id);
  }
  return deduped;
}

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
