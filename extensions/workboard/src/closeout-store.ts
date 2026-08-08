import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { CloseoutRecord, CloseoutTrackerStore } from "./closeout-tracker.js";

const CLOSEOUT_STORE_NAMESPACE = "closeouts-v1";
const CLOSEOUT_STORE_MAX_ENTRIES = 1_000;
const COMPLETED_CLOSEOUT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;

function recordKey(agentId: string, closeoutId: string): string {
  return `${agentId.length}:${agentId}${closeoutId}`;
}

/** Uses the host's existing plugin-state database; this extension owns no database or migrations. */
export function createCloseoutTrackerStore(runtime: PluginRuntime): CloseoutTrackerStore {
  const store = runtime.state.openKeyedStore<CloseoutRecord>({
    namespace: CLOSEOUT_STORE_NAMESPACE,
    maxEntries: CLOSEOUT_STORE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  return {
    get: (agentId, closeoutId) => store.lookup(recordKey(agentId, closeoutId)),
    create: (record) =>
      store.registerIfAbsent(recordKey(record.agentId, record.closeoutId), record),
    put: async (record) => {
      const key = recordKey(record.agentId, record.closeoutId);
      if (record.status === "completed") {
        await store.register(key, record, { ttlMs: COMPLETED_CLOSEOUT_TTL_MS });
        return;
      }
      await store.register(key, record);
    },
    list: async (agentId, limit) =>
      (await store.entries())
        .map((entry) => entry.value)
        .filter((record) => record.agentId === agentId)
        .toSorted((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, limit),
  };
}
