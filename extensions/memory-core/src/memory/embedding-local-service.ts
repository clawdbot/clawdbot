import { resolveGlobalSingleton } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";

// Memory Core receives local-service acquisition from the host before provider creation.
export type MemoryCoreAcquireLocalService = (
  target: {
    providerId: string;
    baseUrl: string;
    headers?: HeadersInit;
  },
  signal?: AbortSignal | null,
) => Promise<{ release: () => void } | undefined>;

const MEMORY_LOCAL_SERVICE_HOST_IDENTITIES_KEY = Symbol.for(
  "openclaw.memoryLocalServiceHostIdentities",
);

// Manager caches survive module reloads, so hook identities must survive too.
// Otherwise a new runtime can collide with a cached manager owned by another host.
const LOCAL_SERVICE_HOST_IDENTITIES = resolveGlobalSingleton<{
  ids: WeakMap<MemoryCoreAcquireLocalService, number>;
  nextId: number;
}>(MEMORY_LOCAL_SERVICE_HOST_IDENTITIES_KEY, () => ({
  ids: new WeakMap(),
  nextId: 1,
}));

export function resolveMemoryCoreLocalServiceHostIdentity(
  acquireLocalService: MemoryCoreAcquireLocalService | undefined,
): string {
  if (!acquireLocalService) {
    return "none";
  }
  let id = LOCAL_SERVICE_HOST_IDENTITIES.ids.get(acquireLocalService);
  if (id === undefined) {
    id = LOCAL_SERVICE_HOST_IDENTITIES.nextId;
    LOCAL_SERVICE_HOST_IDENTITIES.nextId += 1;
    LOCAL_SERVICE_HOST_IDENTITIES.ids.set(acquireLocalService, id);
  }
  return String(id);
}
