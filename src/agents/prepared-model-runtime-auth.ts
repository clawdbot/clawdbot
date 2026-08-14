import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

export type PreparedModelRuntimeAuth = Readonly<{
  authStore: AuthProfileStore;
  authModes: PreparedAgentCredentialModes;
}>;

export type PreparedModelRuntimeAuthScope = Readonly<{
  providerIds: readonly string[];
  profileIds?: readonly string[];
}>;

/** Private auth facts owned by an immutable prepared model generation. */
const authStoreBySnapshot = new WeakMap<object, AuthProfileStore>();
const materializationsBySnapshot = new WeakMap<object, readonly RuntimeAuthMaterialization[]>();
const authLoaderBySnapshot = new WeakMap<
  object,
  (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>
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

export function setPreparedModelRuntimeAuthLoader(
  snapshot: object,
  loader: (scope: PreparedModelRuntimeAuthScope) => Promise<PreparedModelRuntimeAuth>,
): void {
  authLoaderBySnapshot.set(snapshot, loader);
}

export async function loadPreparedModelRuntimeAuth(
  snapshot: object & { authModes?: PreparedAgentCredentialModes },
  scope: PreparedModelRuntimeAuthScope,
): Promise<PreparedModelRuntimeAuth | undefined> {
  const loader = authLoaderBySnapshot.get(snapshot);
  if (loader) {
    return await loader(scope);
  }
  const authStore = authStoreBySnapshot.get(snapshot);
  return authStore ? { authStore, authModes: snapshot.authModes ?? {} } : undefined;
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
