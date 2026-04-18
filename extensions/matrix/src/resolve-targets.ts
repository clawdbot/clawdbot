import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import { isMatrixQualifiedUserId, normalizeMatrixMessagingTarget } from "./matrix/target-ids.js";
import type {
  ChannelDirectoryEntry,
  ChannelResolveKind,
  ChannelResolveResult,
  RuntimeEnv,
} from "./runtime-api.js";

function normalizeLookupQuery(query: string): string {
  return normalizeOptionalLowercaseString(query) ?? "";
}

function findExactDirectoryMatches(
  matches: ChannelDirectoryEntry[],
  query: string,
): ChannelDirectoryEntry[] {
  const normalized = normalizeLookupQuery(query);
  if (!normalized) {
    return [];
  }
  return matches.filter((match) => {
    const id = normalizeOptionalLowercaseString(match.id);
    const name = normalizeOptionalLowercaseString(match.name);
    const handle = normalizeOptionalLowercaseString(match.handle);
    return normalized === id || normalized === name || normalized === handle;
  });
}

function pickBestGroupMatch(
  matches: ChannelDirectoryEntry[],
  query: string,
): { best?: ChannelDirectoryEntry; note?: string } {
  if (matches.length === 0) {
    return {};
  }
  const exact = findExactDirectoryMatches(matches, query);
  if (exact.length > 1) {
    return { best: exact[0], note: "multiple exact matches; chose first" };
  }
  if (exact.length === 1) {
    return { best: exact[0] };
  }
  return {
    best: matches[0],
    note: matches.length > 1 ? "multiple matches; chose first" : undefined,
  };
}

function pickBestUserMatch(
  matches: ChannelDirectoryEntry[],
  query: string,
): ChannelDirectoryEntry | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  const exact = findExactDirectoryMatches(matches, query);
  if (exact.length === 1) {
    return exact[0];
  }
  return undefined;
}

function describeUserMatchFailure(matches: ChannelDirectoryEntry[], query: string): string {
  if (matches.length === 0) {
    return "no matches";
  }
  const normalized = normalizeLookupQuery(query);
  if (!normalized) {
    return "empty input";
  }
  const exact = findExactDirectoryMatches(matches, normalized);
  if (exact.length === 0) {
    return "no exact match; use full Matrix ID";
  }
  if (exact.length > 1) {
    return "multiple exact matches; use full Matrix ID";
  }
  return "no exact match; use full Matrix ID";
}

async function readCachedMatches(
  cache: Map<string, ChannelDirectoryEntry[]>,
  query: string,
  lookup: (query: string) => Promise<ChannelDirectoryEntry[]>,
): Promise<ChannelDirectoryEntry[]> {
  const key = normalizeLookupQuery(query);
  if (!key) {
    return [];
  }
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const matches = await lookup(query.trim());
  cache.set(key, matches);
  return matches;
}

export async function resolveMatrixTargets(params: {
  cfg: unknown;
  accountId?: string | null;
  inputs: string[];
  kind: ChannelResolveKind;
  runtime?: RuntimeEnv;
}): Promise<ChannelResolveResult[]> {
  const results: ChannelResolveResult[] = [];
  const userLookupCache = new Map<string, ChannelDirectoryEntry[]>();
  const groupLookupCache = new Map<string, ChannelDirectoryEntry[]>();

  for (const input of params.inputs) {
    const trimmed = input.trim();
    if (!trimmed) {
      results.push({ input, resolved: false, note: "empty input" });
      continue;
    }
    if (params.kind === "user") {
      const normalizedTarget = normalizeMatrixMessagingTarget(trimmed);
      if (normalizedTarget && isMatrixQualifiedUserId(normalizedTarget)) {
        results.push({ input, resolved: true, id: normalizedTarget });
        continue;
      }
      try {
        const matches = await readCachedMatches(userLookupCache, trimmed, (query) =>
          listMatrixDirectoryPeersLive({
            cfg: params.cfg,
            accountId: params.accountId,
            query,
            limit: 5,
          }),
        );
        const best = pickBestUserMatch(matches, trimmed);
        results.push({
          input,
          resolved: Boolean(best?.id),
          id: best?.id,
          name: best?.name,
          note: best ? undefined : describeUserMatchFailure(matches, trimmed),
        });
      } catch (err) {
        params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
        results.push({ input, resolved: false, note: "lookup failed" });
      }
      continue;
    }
    const normalizedTarget = normalizeMatrixMessagingTarget(trimmed);
    if (normalizedTarget?.startsWith("!")) {
      results.push({ input, resolved: true, id: normalizedTarget });
      continue;
    }
    try {
      const matches = await readCachedMatches(groupLookupCache, trimmed, (query) =>
        listMatrixDirectoryGroupsLive({
          cfg: params.cfg,
          accountId: params.accountId,
          query,
          limit: 5,
        }),
      );
      const { best, note } = pickBestGroupMatch(matches, trimmed);
      results.push({
        input,
        resolved: Boolean(best?.id),
        id: best?.id,
        name: best?.name,
        note,
      });
    } catch (err) {
      params.runtime?.error?.(`matrix resolve failed: ${String(err)}`);
      results.push({ input, resolved: false, note: "lookup failed" });
    }
  }
  return results;
}
