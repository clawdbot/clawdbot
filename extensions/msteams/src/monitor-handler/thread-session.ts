import { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";

// Strip any trailing `:thread:<id>` segments from a session key. Thread ids are
// timestamps/uuids and never contain `:`, so the segment boundary is unambiguous;
// the `+` covers pathological keys with multiple compounded suffixes.
const TRAILING_THREAD_SUFFIX = /(?::thread:[^:]+)+$/;

export function resolveMSTeamsRouteSessionKey(params: {
  baseSessionKey: string;
  isChannel: boolean;
  conversationMessageId?: string;
  replyToId?: string;
}): string {
  const channelThreadId = params.isChannel
    ? (params.conversationMessageId ?? params.replyToId ?? undefined)
    : undefined;
  // Re-derive from a clean base. If a caller hands us a session key that is
  // already thread-qualified (e.g. a `route.sessionKey` mutated in place by a
  // prior turn whose object is still held in the resolved-route cache, see
  // src/routing/resolve-route.ts cache-miss return), naively appending the
  // current thread id would compound into `…:thread:OLD:thread:NEW` and route
  // the turn to a malformed lane that splits same-thread context across turns.
  // Stripping makes this helper idempotent regardless of caller hygiene. (#66771)
  const cleanBase = params.baseSessionKey.replace(TRAILING_THREAD_SUFFIX, "");
  return resolveThreadSessionKeys({
    baseSessionKey: cleanBase,
    threadId: channelThreadId,
    parentSessionKey: channelThreadId ? cleanBase : undefined,
  }).sessionKey;
}
