import { isAllowedParsedChatSender as isAllowedParsedChatSenderShared } from "../channels/plugins/chat-target-prefixes.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

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
  allowFrom: Array<string | number>;
  stripPrefixRe?: RegExp;
}): string[] {
  return params.allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => (params.stripPrefixRe ? entry.replace(params.stripPrefixRe, "") : entry))
    .map((entry) => normalizeOptionalLowercaseString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Normalize allowlist entries through a channel-provided parser or canonicalizer. */
export function formatNormalizedAllowFromEntries(params: {
  allowFrom: Array<string | number>;
  normalizeEntry: (entry: string) => string | undefined | null;
}): string[] {
  return params.allowFrom
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => params.normalizeEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
}

/** Check whether a sender id matches a simple normalized allowlist with wildcard support. */
export function isNormalizedSenderAllowed(params: {
  senderId: string | number;
  allowFrom: Array<string | number>;
  stripPrefixRe?: RegExp;
}): boolean {
  const normalizedAllow = formatAllowFromLowercase({
    allowFrom: params.allowFrom,
    stripPrefixRe: params.stripPrefixRe,
  });
  if (normalizedAllow.length === 0) {
    return false;
  }
  if (normalizedAllow.includes("*")) {
    return true;
  }
  const sender = normalizeOptionalLowercaseString(String(params.senderId));
  return sender ? normalizedAllow.includes(sender) : false;
}

type ParsedChatAllowTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string };

/** Match chat-aware allowlist entries against sender, chat id, guid, or identifier fields. */
export function isAllowedParsedChatSender(params: {
  allowFrom: Array<string | number>;
  sender: string;
  chatId?: number | null;
  chatGuid?: string | null;
  chatIdentifier?: string | null;
  normalizeSender: (sender: string) => string;
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean {
  return isAllowedParsedChatSenderShared(params);
}

export type BasicAllowlistResolutionEntry = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
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
  inputs: string[];
  mapInput: (input: string) => Promise<T> | T;
}): Promise<T[]> {
  const results: T[] = [];
  for (const input of params.inputs) {
    results.push(await params.mapInput(input));
  }
  return results;
}
