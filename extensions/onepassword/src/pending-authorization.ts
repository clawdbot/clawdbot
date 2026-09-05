import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

// Correlates hook authorization with execute: session fields differ across
// that boundary in production and provider tool-call ids are not globally
// unique, so the hook mints a UUID returned via adjusted params (handed
// through unchanged by core); model-supplied values are always overwritten.
export const AUTHORIZATION_NONCE_PARAM = "authorizationNonce";

type PendingRequest = {
  agentId: string;
  toolCallId: string;
  slug: string;
  reason: string;
};

// Fallback when the nonce param was dropped: before_tool_call results merge
// last-writer-wins, so another plugin returning params can strip the nonce.
// A single unambiguous match on caller identity is safe to honor; anything
// ambiguous fails closed.
export function consumeUniquePendingAuthorization<T extends PendingRequest>(
  store: PluginStateSyncKeyedStore<T>,
  request: PendingRequest,
): T | undefined {
  let match: string | undefined;
  for (const entry of store.entries()) {
    const candidate = entry.value;
    if (
      candidate.agentId !== request.agentId ||
      candidate.toolCallId !== request.toolCallId ||
      candidate.slug !== request.slug ||
      candidate.reason !== request.reason
    ) {
      continue;
    }
    if (match !== undefined) {
      return undefined;
    }
    match = entry.key;
  }
  return match === undefined ? undefined : store.consume(match);
}
