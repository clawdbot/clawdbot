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

export async function loadDeferredCatalog(
  context: Pick<GatewayRequestContext, "loadGatewayModelCatalogSnapshot">,
  agentId: string,
  readOnly: boolean,
) {
  // This timing control is Gateway-private; exposing it on GatewayRequestContext would turn an
  // implementation detail into a Plugin SDK contract.
  const snapshot = await context.loadGatewayModelCatalogSnapshot({
    agentId,
    deferAuthRefresh: true,
    readOnly,
  } as NonNullable<Parameters<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>[0]> & {
    deferAuthRefresh: true;
  });
  const pendingAuthStore = pendingAuthStoreBySnapshot.get(snapshot);
  if (!pendingAuthStore) {
    return snapshot;
  }
  try {
    return { ...snapshot, authStore: (await pendingAuthStore) ?? snapshot.authStore };
  } catch {
    // Auth refresh is opportunistic browse data. Preserve the exact prepared generation when
    // external credential discovery fails instead of failing the model catalog response.
    return snapshot;
  }
}
