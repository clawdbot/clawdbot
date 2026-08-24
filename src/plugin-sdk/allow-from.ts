// Allow-from helpers parse and match plugin channel allowlist entries.
import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "../../packages/normalization-core/src/string-normalization.js";
export { isAllowedParsedChatSender } from "../channels/plugins/chat-target-prefixes.js";

export type {
  AllowlistMatch,
  AllowlistMatchSource,
  CompiledAllowlist,
} from "../channels/allowlist-match.js";
export type { AllowlistUserResolutionLike } from "../channels/allowlists/resolve-utils.js";
export {
  compileAllowlist,
  formatAllowlistMatchMeta,
  resolveAllowlistCandidates,
  resolveAllowlistMatchByCandidates,
  resolveAllowlistMatchSimple,
  resolveCompiledAllowlistMatch,
} from "../channels/allowlist-match.js";
export {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
  resolveGroupAllowFromSources,
} from "../channels/allow-from.js";
export {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  mergeAllowlist,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "../channels/allowlists/resolve-utils.js";

/** Lowercase and optionally strip prefixes from allowlist entries before sender comparisons. */
export function formatAllowFromLowercase(params: {
  /** Raw allowlist entries from config or channel-specific overrides. */
  allowFrom: Array<string | number>;
  /** Optional prefix remover for channel aliases such as `tg:` or `zalo:`. */
  stripPrefixRe?: RegExp;
}): string[] {
  return normalizeStringEntries(params.allowFrom)
    .map((entry) => (params.stripPrefixRe ? entry.replace(params.stripPrefixRe, "") : entry))
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Normalize allowlist entries through a channel-provided parser or canonicalizer. */
export function formatNormalizedAllowFromEntries(params: {
  /** Raw allowlist entries from config or channel-specific overrides. */
  allowFrom: Array<string | number>;
  /** Channel-specific canonicalizer; empty results are omitted. */
  normalizeEntry: (entry: string) => string | undefined | null;
}): string[] {
  return normalizeStringEntries(params.allowFrom)
    .map((entry) => params.normalizeEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
}

type ParsedAllowFromEntry = { value: string } | { error: string };

/** Parse, validate, and deduplicate setup allow-from entries with wildcard support. */
export function parseAllowFromEntries(
  raw: string,
  parseEntry: (entry: string) => ParsedAllowFromEntry,
): { entries: string[]; error?: string } {
  const entries: string[] = [];
  for (const entry of normalizeStringEntries(raw.split(/[\n,;]+/g))) {
    if (entry === "*") {
      entries.push(entry);
      continue;
    }
    const parsed = parseEntry(entry);
    if ("error" in parsed) {
      return { entries: [], error: parsed.error };
    }
    entries.push(parsed.value);
  }
  return { entries: uniqueStrings(normalizeStringEntries(entries)) };
}

/** Resolve basic setup allow-from entries when a channel token is available. */
export async function resolveBasicAllowFromEntries(params: {
  token?: string | null;
  entries: string[];
  resolveEntries: (params: {
    token: string;
    entries: string[];
  }) => Promise<Array<{ input: string; resolved: boolean; id?: string | null }>>;
}): Promise<Array<{ input: string; resolved: boolean; id: string | null }>> {
  const token = params.token?.trim();
  if (!token) {
    return params.entries.map((input) => ({ input, resolved: false, id: null }));
  }
  return (await params.resolveEntries({ token, entries: params.entries })).map((entry) => ({
    input: entry.input,
    resolved: entry.resolved,
    id: entry.id ?? null,
  }));
}

/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
export function isNormalizedSenderAllowed(params: {
  /** Sender id or handle to compare after string coercion and lowercase normalization. */
  senderId: string | number;
  /** Raw allowlist entries; `*` allows every sender. */
  allowFrom: Array<string | number>;
  /** Optional prefix remover applied to allowlist entries before comparison. */
  stripPrefixRe?: RegExp;
}): boolean {
  const normalizedAllow = formatAllowFromLowercase({
    allowFrom: params.allowFrom,
    stripPrefixRe: params.stripPrefixRe,
  });
  if (normalizedAllow.length === 0) {
    // Empty allowlists deny by default; callers must opt into wildcard access explicitly.
    return false;
  }
  if (normalizedAllow.includes("*")) {
    return true;
  }
  const sender = normalizeOptionalLowercaseString(String(params.senderId));
  return sender ? normalizedAllow.includes(sender) : false;
}

/** Serializable allowlist resolution record used by setup/status UI surfaces. */
export type BasicAllowlistResolutionEntry = {
  /** Original allowlist input. */
  input: string;
  /** Whether resolution found a concrete account/user id. */
  resolved: boolean;
  /** Resolved id when available. */
  id?: string;
  /** Resolved display name when available. */
  name?: string;
  /** Optional resolver note for UI or docs output. */
  note?: string;
};

/** Clone allowlist resolution entries into a plain serializable shape for UI and docs output. */
export function mapBasicAllowlistResolutionEntries(
  entries: BasicAllowlistResolutionEntry[],
): BasicAllowlistResolutionEntry[] {
  return entries.map((entry) => ({
    input: entry.input,
    resolved: entry.resolved,
    id: entry.id,
    name: entry.name,
    note: entry.note,
  }));
}

/** Map allowlist inputs sequentially so resolver side effects stay ordered and predictable. */
export async function mapAllowlistResolutionInputs<T>(params: {
  /** Ordered allowlist inputs to resolve. */
  inputs: string[];
  /** Resolver callback invoked once per input in order. */
  mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]> {
  const results: T[] = [];
  for (const input of params.inputs) {
    results.push(await params.mapInput(input));
  }
  return results;
}
