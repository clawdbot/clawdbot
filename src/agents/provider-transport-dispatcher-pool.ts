import { PinnedDispatcherPool } from "../infra/net/pinned-dispatcher-pool.js";
import { setProviderTransportDispatcherPoolActive } from "./provider-runtime-lifecycle.js";

const PROVIDER_DISPATCHER_POOL_MAX_ENTRIES = 16;
const PROVIDER_DISPATCHER_POOL_IDLE_TTL_MS = 60_000;

let activePool: PinnedDispatcherPool | undefined;

/** Returns the current process-lifecycle provider dispatcher pool generation. */
export function getProviderTransportDispatcherPool(): PinnedDispatcherPool {
  if (!activePool) {
    activePool = new PinnedDispatcherPool({
      maxEntries: PROVIDER_DISPATCHER_POOL_MAX_ENTRIES,
      idleTtlMs: PROVIDER_DISPATCHER_POOL_IDLE_TTL_MS,
    });
    setProviderTransportDispatcherPoolActive(true);
  }
  return activePool;
}

/** Closes the current generation while allowing an in-process Gateway restart to create another. */
export async function closeProviderTransportDispatcherPool(): Promise<void> {
  const pool = activePool;
  if (pool) {
    await pool.closeAll();
    if (activePool === pool) {
      activePool = undefined;
      setProviderTransportDispatcherPoolActive(false);
    }
  }
}
