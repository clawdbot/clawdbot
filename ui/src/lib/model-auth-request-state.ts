import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ModelAuthStatusResult } from "../api/types.ts";

type ModelAuthRequestState = {
  pending: Map<string, Promise<ModelAuthStatusResult>>;
  refreshes: number;
};

// Startup invalidation must not load auth presentation or provider helpers.
const authReads = new WeakMap<GatewayBrowserClient, ModelAuthRequestState>();

export function getModelAuthRequestState(client: GatewayBrowserClient): ModelAuthRequestState {
  let state = authReads.get(client);
  if (!state) {
    state = { pending: new Map(), refreshes: 0 };
    authReads.set(client, state);
  }
  return state;
}

/** Retire sharing eligibility without cancelling existing consumers' own reads. */
export function invalidateModelAuthStatusRequests(client: GatewayBrowserClient): void {
  authReads.get(client)?.pending.clear();
}
