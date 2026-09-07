import type { ApplicationGateway } from "./gateway.ts";

type GatewayPresentationScope = { readonly key: number };
type OwnedPresentationScope = {
  scope: GatewayPresentationScope;
  revision: number;
  userId?: string;
};

const scopes = new WeakMap<ApplicationGateway, OwnedPresentationScope>();
let nextScopeKey = 0;

/** Shared by mounted pages and route loader caches for the same connection owner. */
export function gatewayPresentationScope(gateway: ApplicationGateway): GatewayPresentationScope {
  const revision = gateway.connectionRevision;
  const snapshot = gateway.snapshot;
  const userId = snapshot.phase === "connected" ? snapshot.selfUser?.id : undefined;
  const previous = scopes.get(gateway);
  if (
    !previous ||
    previous.revision !== revision ||
    (userId !== undefined && previous.userId !== undefined && previous.userId !== userId)
  ) {
    const next = { scope: { key: ++nextScopeKey }, revision, userId };
    scopes.set(gateway, next);
    return next.scope;
  }
  // First authentication completes the existing owner; reconnects may temporarily
  // clear selfUser without retiring that owner's mounted pages or loader results.
  previous.userId ??= userId;
  return previous.scope;
}
