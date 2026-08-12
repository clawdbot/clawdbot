import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

/** Private auth facts owned by an immutable prepared model generation. */
const authStoreBySnapshot = new WeakMap<object, AuthProfileStore>();
const materializationsBySnapshot = new WeakMap<object, readonly RuntimeAuthMaterialization[]>();
const authStoreLoaderBySnapshot = new WeakMap<
  object,
  (providerIds: readonly string[]) => Promise<AuthProfileStore>
>();

// Secret-bearing state stays lifecycle-owned without becoming part of the public snapshot shape.
export function setPreparedModelRuntimeAuthStore(
  snapshot: object,
  authStore: AuthProfileStore,
): void {
  authStoreBySnapshot.set(snapshot, authStore);
}

export function getPreparedModelRuntimeAuthStore(snapshot: object): AuthProfileStore | undefined {
  return authStoreBySnapshot.get(snapshot);
}

export function setPreparedModelRuntimeAuthStoreLoader(
  snapshot: object,
  loader: (providerIds: readonly string[]) => Promise<AuthProfileStore>,
): void {
  authStoreLoaderBySnapshot.set(snapshot, loader);
}

export async function loadPreparedModelRuntimeAuthStore(
  snapshot: object,
  providerIds: readonly string[],
): Promise<AuthProfileStore | undefined> {
  const loader = authStoreLoaderBySnapshot.get(snapshot);
  return loader ? await loader(providerIds) : authStoreBySnapshot.get(snapshot);
}

export function setPreparedModelRuntimeAuthMaterializations(
  snapshot: object,
  materializations: readonly RuntimeAuthMaterialization[],
): void {
  materializationsBySnapshot.set(snapshot, materializations);
}

export function getPreparedModelRuntimeAuthMaterializations(
  snapshot: object,
): readonly RuntimeAuthMaterialization[] {
  return materializationsBySnapshot.get(snapshot) ?? [];
}
