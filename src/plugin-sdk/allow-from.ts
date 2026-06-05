// Allow-from helpers parse and match plugin channel allowlist entries.
import { normalizeOptionalLowercaseString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeStringEntries } from "../../packages/normalization-core/src/string-normalization.js";
import { isAllowedParsedChatSender as isAllowedParsedChatSenderShared } from "../channels/plugins/chat-target-prefixes.js";

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

type ParsedChatAllowTarget =
  | { kind: "chat_id"; chatId: number }
  | { kind: "chat_guid"; chatGuid: string }
  | { kind: "chat_identifier"; chatIdentifier: string }
  | { kind: "handle"; handle: string };

/** Match allowlist entries against senders, with conversation targets requiring explicit opt-in. */
export function isAllowedParsedChatSender(params: {
  /** Raw allowlist entries, including handles, wildcard, or parsed chat targets. */
  allowFrom: Array<string | number>;
  /** Sender handle/id from the inbound message. */
  sender: string;
  /** Optional numeric conversation id for channel-specific chat target entries. */
  chatId?: number | null;
  /** Optional stable conversation guid for channel-specific chat target entries. */
  chatGuid?: string | null;
  /** Optional human/channel conversation identifier for chat target entries. */
  chatIdentifier?: string | null;
  /** Enables matching conversation targets in addition to sender handles. */
  allowConversationTargets?: boolean | null;
  /** Channel-specific sender normalization hook. */
  normalizeSender: (sender: string) => string;
  /** Channel-specific allowlist parser for handles and conversation targets. */
  parseAllowTarget: (entry: string) => ParsedChatAllowTarget;
}): boolean {
  return isAllowedParsedChatSenderShared(params);
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
