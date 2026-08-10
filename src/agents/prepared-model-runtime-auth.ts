/** Secret-free successful-auth facts owned by an immutable prepared model generation. */
import type { RuntimeAuthMaterialization } from "./auth-profiles/runtime-materializations.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";

const materializationsBySnapshot = new WeakMap<
  PreparedModelRuntimeSnapshot,
  readonly RuntimeAuthMaterialization[]
>();

export function setPreparedModelRuntimeAuthMaterializations(
  snapshot: PreparedModelRuntimeSnapshot,
  materializations: readonly RuntimeAuthMaterialization[],
): void {
  materializationsBySnapshot.set(snapshot, materializations);
}

export function getPreparedModelRuntimeAuthMaterializations(
  snapshot: PreparedModelRuntimeSnapshot,
): readonly RuntimeAuthMaterialization[] {
  return materializationsBySnapshot.get(snapshot) ?? [];
}
