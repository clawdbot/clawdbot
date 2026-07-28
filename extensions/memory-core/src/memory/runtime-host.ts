import { resolveGlobalSingleton } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { MemoryCoreAcquireLocalService } from "./embedding-local-service.js";

export type MemoryCoreRuntimeHost = {
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
};

const MEMORY_LEASE_HOST_IDENTITIES_KEY = Symbol.for("openclaw.memoryLeaseHostIdentities");

// Manager caches survive module reloads, so lease-host identities must survive too.
// Otherwise a new runtime can reuse a manager whose writes belong to another host.
const LEASE_HOST_IDENTITIES = resolveGlobalSingleton<{
  ids: WeakMap<PluginStateLeaseRunner, number>;
  nextId: number;
}>(MEMORY_LEASE_HOST_IDENTITIES_KEY, () => ({
  ids: new WeakMap(),
  nextId: 1,
}));

export function resolveMemoryCoreLeaseHostIdentity(
  withLease: PluginStateLeaseRunner | undefined,
): string {
  if (!withLease) {
    return "none";
  }
  let id = LEASE_HOST_IDENTITIES.ids.get(withLease);
  if (id === undefined) {
    id = LEASE_HOST_IDENTITIES.nextId;
    LEASE_HOST_IDENTITIES.nextId += 1;
    LEASE_HOST_IDENTITIES.ids.set(withLease, id);
  }
  return String(id);
}
