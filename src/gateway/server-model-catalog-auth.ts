import type { PreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { GatewayRequestContext } from "./server-methods/shared-types.js";

const pendingAuthBySnapshot = new WeakMap<object, Promise<PreparedModelRuntimeAuth | undefined>>();

export function setPendingGatewayModelCatalogAuth(
  snapshot: object,
  pending: Promise<PreparedModelRuntimeAuth | undefined>,
): void {
  pendingAuthBySnapshot.set(snapshot, pending);
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
  const pendingAuth = pendingAuthBySnapshot.get(snapshot);
  if (!pendingAuth) {
    return snapshot;
  }
  try {
    return { ...snapshot, ...(await pendingAuth) };
  } catch {
    // Auth refresh is opportunistic browse data. Preserve the exact prepared generation when
    // external credential discovery fails instead of failing the model catalog response.
    return snapshot;
  }
}
