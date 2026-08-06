/**
 * Channel allowlist resolution helpers.
 *
 * Dedupes allowFrom entries and canonicalizes user lookups into stable id additions.
 */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { mapAllowFromEntries } from "openclaw/plugin-sdk/channel-config-helpers";
import type { RuntimeEnv } from "../../runtime.js";
import { summarizeStringEntries } from "../../shared/string-sample.js";

export type AllowlistUserResolutionLike = {
  input: string;
  resolved: boolean;
  id?: string;
};

function dedupeAllowlistEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of entries) {
    const normalized = entry.trim();
    if (!normalized) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(normalized);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(normalized);
  }
  return deduped;
}

export function mergeAllowlist(params: {
  existing?: Array<string | number>;
  additions: string[];
}): string[] {
  return dedupeAllowlistEntries([...mapAllowFromEntries(params.existing), ...params.additions]);
}

/** Splits lookup results into resolved mappings, unresolved display text, and id additions. */
export function buildAllowlistResolutionSummary<T extends AllowlistUserResolutionLike>(
  resolvedUsers: T[],
  opts?: {
    /** Return null to omit an entry from the logged mapping (e.g. identity lookups). */
    formatResolved?: (entry: T) => string | null;
    formatUnresolved?: (entry: T) => string;
  },
): {
  resolvedMap: Map<string, T>;
  mapping: string[];
  unresolved: string[];
  additions: string[];
} {
  const resolvedMap = new Map(resolvedUsers.map((entry) => [entry.input, entry]));
  const resolvedOk = (entry: T) => Boolean(entry.resolved && entry.id);
  // An id that "resolves" to itself carries no information; skip it so startup
  // summaries only mention lookups that actually translated something.
  const formatResolved =
    opts?.formatResolved ??
    ((entry: T) => (entry.id === entry.input ? null : `${entry.input}→${entry.id}`));
  const formatUnresolved = opts?.formatUnresolved ?? ((entry: T) => entry.input);
  const mapping = resolvedUsers
    .filter(resolvedOk)
    .map(formatResolved)
    .filter((label): label is string => label !== null);
  const additions = resolvedUsers
    .filter(resolvedOk)
    .map((entry) => entry.id)
    .filter((entry): entry is string => Boolean(entry));
  const unresolved = resolvedUsers.filter((entry) => !resolvedOk(entry)).map(formatUnresolved);
  return { resolvedMap, mapping, unresolved, additions };
}

function resolveAllowlistIdAdditions<T extends AllowlistUserResolutionLike>(params: {
  existing: Array<string | number>;
  resolvedMap: Map<string, T>;
}): string[] {
  const additions: string[] = [];
  for (const entry of params.existing) {
    const trimmed = normalizeOptionalString(entry) ?? "";
    const resolved = params.resolvedMap.get(trimmed);
    if (resolved?.resolved && resolved.id) {
      additions.push(resolved.id);
    }
  }
  return additions;
}

/** Replaces resolvable user entries with canonical ids while preserving unresolved entries and `*`. */
export function canonicalizeAllowlistWithResolvedIds<
  T extends AllowlistUserResolutionLike,
>(params: { existing?: Array<string | number>; resolvedMap: Map<string, T> }): string[] {
  const canonicalized: string[] = [];
  for (const entry of params.existing ?? []) {
    const trimmed = normalizeOptionalString(entry) ?? "";
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      // Wildcard allowlists are a policy value, not a lookup target.
      canonicalized.push(trimmed);
      continue;
    }
    const resolved = params.resolvedMap.get(trimmed);
    canonicalized.push(resolved?.resolved && resolved.id ? resolved.id : trimmed);
  }
  return dedupeAllowlistEntries(canonicalized);
}

/** Updates nested `{ users }` allowlist entries using merge or canonicalize semantics. */
export function patchAllowlistUsersInConfigEntries<
  T extends AllowlistUserResolutionLike,
  TEntries extends Record<string, unknown>,
>(params: {
  entries: TEntries;
  resolvedMap: Map<string, T>;
  strategy?: "merge" | "canonicalize";
}): TEntries {
  const nextEntries: Record<string, unknown> = { ...params.entries };
  for (const [entryKey, entryConfig] of Object.entries(params.entries)) {
    if (!entryConfig || typeof entryConfig !== "object") {
      continue;
    }
    const users = (entryConfig as { users?: Array<string | number> }).users;
    if (!Array.isArray(users) || users.length === 0) {
      continue;
    }
    // `merge` keeps original user text and appends resolved ids; `canonicalize` replaces it.
    const resolvedUsers =
      params.strategy === "canonicalize"
        ? canonicalizeAllowlistWithResolvedIds({
            existing: users,
            resolvedMap: params.resolvedMap,
          })
        : mergeAllowlist({
            existing: users,
            additions: resolveAllowlistIdAdditions({
              existing: users,
              resolvedMap: params.resolvedMap,
            }),
          });
    nextEntries[entryKey] = {
      ...entryConfig,
      users: resolvedUsers,
    };
  }
  return nextEntries as TEntries;
}

/** Collects concrete user lookup targets from one config entry, excluding wildcard policy entries. */
export function addAllowlistUserEntriesFromConfigEntry(target: Set<string>, entry: unknown): void {
  if (!entry || typeof entry !== "object") {
    return;
  }
  const users = (entry as { users?: Array<string | number> }).users;
  if (!Array.isArray(users)) {
    return;
  }
  for (const value of users) {
    const trimmed = normalizeOptionalString(value) ?? "";
    if (trimmed && trimmed !== "*") {
      target.add(trimmed);
    }
  }
}

/** Logs a compact resolved/unresolved allowlist lookup summary when there is anything to report. */
export function summarizeMapping(
  label: string,
  mapping: string[],
  unresolved: string[],
  runtime: RuntimeEnv,
): void {
  // One log call per line: the console logger only prefixes the first line of
  // a message with timestamp/subsystem, so a joined multi-line summary leaves
  // bare continuation lines in operator output.
  if (mapping.length > 0) {
    runtime.log?.(`${label} resolved: ${summarizeStringEntries({ entries: mapping, limit: 6 })}`);
  }
  if (unresolved.length > 0) {
    runtime.log?.(
      `${label} unresolved: ${summarizeStringEntries({ entries: unresolved, limit: 6 })}`,
    );
  }
}
