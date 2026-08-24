import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";

// 24h/10k preserves the pre-drain logical-twin guard window across restarts.
const DEDUPE_NAMESPACE_PREFIX = "feishu.dedup";
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const STORE_MAX_ENTRIES = 10_000;

function createFeishuDedupeGuard() {
  return createChannelReplayGuard<string | null | undefined>({
    dedupe: {
      pluginId: "feishu",
      namespacePrefix: DEDUPE_NAMESPACE_PREFIX,
      ttlMs: DEDUP_TTL_MS,
      memoryMaxSize: MEMORY_MAX_SIZE,
      stateMaxEntries: STORE_MAX_ENTRIES,
    },
    buildReplayKey: (messageId) => messageId,
  });
}

export const feishuDedupeState = {
  guard: createFeishuDedupeGuard(),
  reset() {
    this.guard = createFeishuDedupeGuard();
  },
};
