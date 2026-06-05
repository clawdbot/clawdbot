/**
 * Channel allowlist matching primitives.
 *
 * Compiles normalized allowlists and records match metadata for diagnostics.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";

export type AllowlistMatchSource =
  | "wildcard"
  | "id"
  | "name"
  | "tag"
  | "username"
  | "prefixed-id"
  | "prefixed-user"
  | "prefixed-name"
  | "slug"
  | "localpart";

export type AllowlistMatch<TSource extends string = AllowlistMatchSource> = {
  allowed: boolean;
  matchKey?: string;
  matchSource?: TSource;
};

export type CompiledAllowlist = {
  set: ReadonlySet<string>;
  wildcard: boolean;
};

/** Formats match metadata for diagnostics without leaking channel-specific text. */
export function formatAllowlistMatchMeta(
  match?: { matchKey?: string; matchSource?: string } | null,
): string {
  return `matchKey=${match?.matchKey ?? "none"} matchSource=${match?.matchSource ?? "none"}`;
}

/** Compiles normalized allowlist entries and records wildcard presence. */
export function compileAllowlist(entries: ReadonlyArray<string>): CompiledAllowlist {
  const set = new Set(entries.filter(Boolean));
  return {
    set,
    wildcard: set.has("*"),
  };
}

function compileSimpleAllowlist(entries: ReadonlyArray<string | number>): CompiledAllowlist {
  return compileAllowlist(
    entries
      .map((entry) => normalizeOptionalLowercaseString(String(entry)))
      .filter((entry): entry is string => Boolean(entry)),
  );
}

export function resolveAllowlistCandidates<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  for (const candidate of params.candidates) {
    if (!candidate.value) {
      continue;
    }
    if (params.compiledAllowlist.set.has(candidate.value)) {
      return {
        allowed: true,
        matchKey: candidate.value,
        matchSource: candidate.source,
      };
    }
  }
  return { allowed: false };
}

/** Applies wildcard and empty-list semantics before candidate matching. */
export function resolveCompiledAllowlistMatch<TSource extends string>(params: {
  compiledAllowlist: CompiledAllowlist;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  if (params.compiledAllowlist.set.size === 0) {
    return { allowed: false };
  }
  if (params.compiledAllowlist.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" as TSource };
  }
  return resolveAllowlistCandidates(params);
}

/** Convenience wrapper for callers that do not need to reuse a compiled list. */
export function resolveAllowlistMatchByCandidates<TSource extends string>(params: {
  allowList: ReadonlyArray<string>;
  candidates: Array<{ value?: string; source: TSource }>;
}): AllowlistMatch<TSource> {
  return resolveCompiledAllowlistMatch({
    compiledAllowlist: compileAllowlist(params.allowList),
    candidates: params.candidates,
  });
}

/** Matches simple sender id/name allowlists used by legacy channel config. */
export function resolveAllowlistMatchSimple(params: {
  allowFrom: ReadonlyArray<string | number>;
  senderId: string;
  senderName?: string | null;
  allowNameMatching?: boolean;
}): AllowlistMatch<"wildcard" | "id" | "name"> {
  const allowFrom = compileSimpleAllowlist(params.allowFrom);

  if (allowFrom.set.size === 0) {
    return { allowed: false };
  }
  if (allowFrom.wildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }

  const senderId = normalizeLowercaseStringOrEmpty(params.senderId);
  const senderName = normalizeOptionalLowercaseString(params.senderName);
  return resolveAllowlistCandidates({
    compiledAllowlist: allowFrom,
    candidates: [
      { value: senderId, source: "id" },
      ...(params.allowNameMatching === true && senderName
        ? ([{ value: senderName, source: "name" as const }] satisfies Array<{
            value?: string;
            source: "id" | "name";
          }>)
        : []),
    ],
  });
}
