import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const pendingAuthStoreBySnapshot = new WeakMap<object, Promise<AuthProfileStore | undefined>>();

export function setPendingGatewayModelCatalogAuthStore(
  snapshot: object,
  pending: Promise<AuthProfileStore | undefined>,
): void {
  pendingAuthStoreBySnapshot.set(snapshot, pending);
  // A timed-out catalog read may abandon the snapshot before it reaches the auth projection.
  // Observe rejection here while preserving it for a caller that does resolve this snapshot.
  void pending.catch(() => undefined);
}

export async function resolveDeferredAuthStore(
  snapshot:
    | {
        authStore?: AuthProfileStore;
      }
    | undefined,
): Promise<AuthProfileStore | undefined> {
  return snapshot
    ? ((await pendingAuthStoreBySnapshot.get(snapshot)) ?? snapshot.authStore)
    : undefined;
}

export function loadDeferredCatalog(
  context: Pick<GatewayRequestContext, "loadGatewayModelCatalogSnapshot">,
  agentId: string,
  readOnly: boolean,
) {
  return context.loadGatewayModelCatalogSnapshot({
    agentId,
    deferAuthRefresh: true,
    readOnly,
  });
}
